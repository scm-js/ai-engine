import { describe, expect, it } from "vitest";
import { capabilitiesOf, effortFor, requestParams, type ClaudeCall } from "../src/claude.js";
import type { Effort } from "../src/defaults.js";

const call = (model: string, effort: Effort = "xhigh"): ClaudeCall => ({ model, maxTokens: 100, effort, system: "s", messages: [{ role: "user", content: "hi" }], thinking: true });
const params = (c: ClaudeCall, fallbacks = false) => requestParams(c, { fallbacks }) as unknown as Record<string, unknown>;

describe("the request per model", () => {
  it("sends effort and adaptive thinking to a model that takes them", () => {
    const p = params(call("claude-opus-5"), true);
    expect(p.output_config).toEqual({ effort: "xhigh" });
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized" });
    expect(p.fallbacks).toBe("default");
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01"]);
  });

  it("never asks a 5.5 model to stop thinking: a call without thinking runs adaptive with nothing shown", () => {
    for (const model of ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]) {
      expect(params(call(model)).thinking).toEqual({ type: "adaptive", display: "summarized" });
      expect(params({ ...call(model), thinking: false }).thinking).toEqual({ type: "adaptive", display: "omitted" });
    }
  });

  it("drops thinking that no longer matches a trimmed history rather than refusing the turn", () => {
    const history: ClaudeCall["messages"] = [
      { role: "user", content: "place a base" },
      { role: "assistant", content: [{ type: "thinking", thinking: "…", signature: "sig" }, { type: "text", text: "Done." }] },
      { role: "user", content: "and another" },
    ];
    const p = params({ ...call("claude-opus-5-5"), messages: history }, true);
    expect(p.thinking).toEqual({ type: "adaptive", display: "summarized", block_binding: { prefix_mismatch_behavior: "drop_block" } });
    expect(p.betas).toEqual(["server-side-fallback-2026-07-01", "thinking-binding-controls-2026-08-01"]);
    // Nothing replayed, nothing to bind; and Opus 5 does not run the check.
    expect(params(call("claude-opus-5-5")).betas).toBeUndefined();
    expect((params({ ...call("claude-opus-5"), messages: history }).thinking as Record<string, unknown>).block_binding).toBeUndefined();
  });

  it("leaves the refusal fallback off for Haiku 5.5, which has none", () => {
    const p = params(call("claude-haiku-5-5"), true);
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
    expect(p.output_config).toEqual({ effort: "xhigh" });
    expect(params(call("claude-sonnet-5-5"), true).fallbacks).toBe("default");
  });

  it("sends neither to Haiku 4.5, which refuses both", () => {
    const p = params(call("claude-haiku-4-5"));
    expect(p.output_config).toBeUndefined();
    expect(p.thinking).toBeUndefined();
    expect(p.fallbacks).toBeUndefined();
    expect(p.betas).toBeUndefined();
    // A schema still goes: structured output is older than effort.
    expect(params({ ...call("claude-haiku-4-5"), outputSchema: { type: "object" } }).output_config).toEqual({ format: { type: "json_schema", schema: { type: "object" } } });
  });

  it("lowers an effort a model does not know to the nearest it does", () => {
    expect(params(call("claude-opus-4-6")).output_config).toEqual({ effort: "high" });
    expect(effortFor(capabilitiesOf("claude-opus-4-5"), "max")).toBe("high");
    expect(effortFor(capabilitiesOf("claude-opus-4-5"), "low")).toBe("low");
    expect(effortFor(capabilitiesOf("claude-sonnet-5"), "xhigh")).toBe("xhigh");
    expect(effortFor(capabilitiesOf("claude-fable-5-1"), "max")).toBe("max");
    expect(capabilitiesOf("claude-opus-4-5").adaptiveThinking).toBe(false);
    expect(capabilitiesOf("claude-something-new").efforts).toHaveLength(5);
  });
});
