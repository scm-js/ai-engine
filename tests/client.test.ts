import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { AnthropicClaudeClient, type ClaudeCall } from "../src/claude.js";

/**
 * The real client against a local stand-in for Anthropic: one canned stream per request, so
 * what the SDK hands back from a real response shape is what is tested, not the fake's idea of it.
 */
let server: Server;
let baseUrl = "";
let transformations: unknown;
const bodies: Record<string, unknown>[] = [];

function sse(events: [string, unknown][]): string {
  return events.map(([event, data]) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    req.on("end", () => {
      bodies.push(JSON.parse(raw) as Record<string, unknown>);
      const usage = { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
      const message = { id: "msg_1", type: "message", role: "assistant", model: "claude-opus-5-5", content: [], stop_reason: null, stop_sequence: null, usage, ...(transformations !== undefined ? { input_transformations: transformations } : {}) };
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(sse([
        ["message_start", { type: "message_start", message }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Done." } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 3 } }],
        ["message_stop", { type: "message_stop" }],
      ]));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

const client = () => new AnthropicClaudeClient({ apiKey: "sk-test", baseUrl, maxRetries: 0, timeoutMs: 5000, fallbacks: false });
const history: ClaudeCall["messages"] = [
  { role: "user", content: "place a base" },
  { role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "text", text: "Done." }] },
  { role: "user", content: "and another" },
];
const call: ClaudeCall = { model: "claude-opus-5-5", maxTokens: 100, effort: "medium", system: "s", messages: history, thinking: false };

describe("the real client", () => {
  it("reports the thinking blocks Anthropic dropped from a replayed history", async () => {
    transformations = [
      { type: "thinking_dropped", path: "messages.1.content.0", reason: "prefix_binding_mismatch" },
      { type: "something_newer", path: "messages.1.content.1", reason: "x" },
    ];
    const r = await client().run(call);
    expect(r.text).toBe("Done.");
    expect(r.thinkingDrops).toEqual([{ path: "messages.1.content.0", reason: "prefix_binding_mismatch" }]);
    expect(bodies.at(-1)!.thinking).toEqual({ type: "adaptive", display: "omitted", block_binding: { prefix_mismatch_behavior: "drop_block" } });
  });

  it("says nothing was dropped when the list is empty, and that nobody asked when it is absent", async () => {
    transformations = [];
    expect((await client().run(call)).thinkingDrops).toEqual([]);
    transformations = undefined;
    expect((await client().run({ ...call, messages: [{ role: "user", content: "hi" }] })).thinkingDrops).toBeNull();
  });
});
