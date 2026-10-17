/**
 * The one place that talks to Anthropic. `ClaudeClient` is the seam: the real one wraps
 * the SDK's streaming beta call (adaptive thinking, effort, prompt caching on the system
 * prompt, structured output through `output_config.format`, server-side refusal
 * fallbacks), the fake one answers from a script so the routes and recipes test without
 * a network. Errors come back as `ClaudeError`s carrying an error code.
 */
import Anthropic from "@anthropic-ai/sdk";
import type {
  BetaContentBlock, BetaMessageParam, BetaRefusalStopDetails, BetaStopReason, BetaTextBlockParam, BetaTool, BetaToolChoice,
} from "@anthropic-ai/sdk/resources/beta/messages/messages";
import { EFFORTS, type Effort } from "./defaults.js";
import type { TokenCounts } from "./pricing.js";

export type { BetaContentBlock, BetaMessageParam, BetaTool };

/** The beta header the `fallbacks: "default"` form needs. */
const FALLBACK_BETA = "server-side-fallback-2026-07-01";
/** The beta header `thinking.block_binding` needs. */
const BINDING_BETA = "thinking-binding-controls-2026-08-01";

/**
 * What a model's API takes. Effort and adaptive thinking arrived with the 4.6 generation:
 * Haiku 4.5 and older take neither (a request naming them is refused outright), Opus 4.5
 * takes effort without `xhigh`/`max` and thinks by budget, and the 4.6 pair knows no
 * `xhigh`. Anything newer, or unknown, is assumed to take the full set.
 */
export interface ModelCapabilities {
  effort: boolean;
  adaptiveThinking: boolean;
  /** The effort levels the model accepts, lowest first. */
  efforts: readonly Effort[];
  /**
   * The model thinks whatever the request says (the Fable models, and the 5.5 generation): turning it off is refused,
   * so "no thinking" is sent as adaptive with nothing shown, and replayed thinking blocks are checked against the
   * conversation they were made in.
   */
  alwaysThinks?: boolean;
  /** The server-side refusal fallback is not offered for the model (Haiku 5.5): `fallbacks` is left out. */
  noFallbacks?: boolean;
}

export function capabilitiesOf(model: string): ModelCapabilities {
  if (/^claude-(haiku-4-5|sonnet-4-5|opus-4-1|haiku-3|sonnet-3|opus-3|3-)/.test(model)) return { effort: false, adaptiveThinking: false, efforts: [] };
  if (/^claude-opus-4-5/.test(model)) return { effort: true, adaptiveThinking: false, efforts: ["low", "medium", "high"] };
  if (/^claude-(opus|sonnet)-4-6/.test(model)) return { effort: true, adaptiveThinking: true, efforts: ["low", "medium", "high", "max"] };
  if (/^claude-haiku-5-5/.test(model)) return { effort: true, adaptiveThinking: true, efforts: EFFORTS, alwaysThinks: true, noFallbacks: true };
  if (/^claude-((opus|sonnet)-5-5|fable-5|mythos-5)/.test(model)) return { effort: true, adaptiveThinking: true, efforts: EFFORTS, alwaysThinks: true };
  return { effort: true, adaptiveThinking: true, efforts: EFFORTS };
}

/** The history carries thinking blocks from earlier turns. */
function replaysThinking(messages: readonly { content: unknown }[]): boolean {
  return messages.some((m) => Array.isArray(m.content) && m.content.some((b: { type?: string }) => b?.type === "thinking" || b?.type === "redacted_thinking"));
}

/** The effort to send: the one asked for, or the nearest below it the model takes; nothing for a model that takes none. */
export function effortFor(caps: ModelCapabilities, effort: Effort): Effort | undefined {
  if (!caps.effort || caps.efforts.length === 0) return undefined;
  let i = EFFORTS.indexOf(effort);
  while (i > 0 && !caps.efforts.includes(EFFORTS[i]!)) i--;
  return caps.efforts.includes(EFFORTS[i]!) ? EFFORTS[i] : caps.efforts[0];
}
/** The beta header that makes Anthropic say where two consecutive prompts diverged. */
const DIAGNOSIS_BETA = "cache-diagnosis-2026-04-07";

export interface ClaudeCall {
  model: string;
  maxTokens: number;
  effort: Effort;
  /** Static per recipe; cached. */
  system: string;
  /** More system blocks after it, each with its own cache breakpoint (a per-map reference). */
  systemExtra?: string[];
  messages: BetaMessageParam[];
  /** JSON Schema the answer must follow; the text then parses as JSON. */
  outputSchema?: Record<string, unknown>;
  /** Fail rather than retry without the schema when the API refuses it (the schema probe). */
  noSchemaFallback?: boolean;
  tools?: BetaTool[];
  toolChoice?: BetaToolChoice;
  /** Ask for the reasoning summary (`onThinking`). */
  thinking: boolean;
  /** A caller's own key (BYOK) instead of the server's. */
  apiKey?: string;
  signal?: AbortSignal;
  /**
   * Ask Anthropic why the prompt cache missed, comparing against the previous response of
   * this conversation (`null` on its first call). Costs nothing; needs the beta header.
   */
  diagnose?: { previousMessageId: string | null };
  /** Keep the request as sent and the answer as received (`ClaudeResult.payload`). */
  capture?: boolean;
}

/** The request as the API takes it, shaped to what the model accepts (`capabilitiesOf`). */
export function requestParams(call: ClaudeCall, options: { fallbacks: boolean }): Parameters<Anthropic["beta"]["messages"]["stream"]>[0] {
  const system = systemBlocks(call);
  const caps = capabilitiesOf(call.model);
  const effort = effortFor(caps, call.effort);
  const outputConfig = { ...(effort ? { effort } : {}), ...(call.outputSchema ? { format: { type: "json_schema" as const, schema: call.outputSchema } } : {}) };
  const fallbacks = options.fallbacks && !caps.noFallbacks;
  // A model that always thinks checks replayed thinking against the conversation it was made in; where the history
  // was trimmed (the assistant drops its oldest turns), a mismatched block is dropped rather than the turn refused.
  const binding = !!caps.alwaysThinks && replaysThinking(call.messages);
  const thinking = caps.alwaysThinks
    ? { type: "adaptive" as const, display: call.thinking ? "summarized" as const : "omitted" as const, ...(binding ? { block_binding: { prefix_mismatch_behavior: "drop_block" as const } } : {}) }
    : call.thinking && caps.adaptiveThinking ? { type: "adaptive" as const, display: "summarized" as const } : null;
  const betas = [...(fallbacks ? [FALLBACK_BETA] : []), ...(call.diagnose ? [DIAGNOSIS_BETA] : []), ...(binding ? [BINDING_BETA] : [])];
  return {
    model: call.model,
    max_tokens: call.maxTokens,
    system,
    messages: call.messages,
    ...(Object.keys(outputConfig).length ? { output_config: outputConfig } : {}),
    ...(thinking ? { thinking } : {}),
    ...(call.tools?.length ? { tools: call.tools, tool_choice: call.toolChoice ?? { type: "auto" } } : {}),
    ...(fallbacks ? { fallbacks: "default" } : {}),
    ...(call.diagnose ? { diagnostics: { previous_message_id: call.diagnose.previousMessageId } } : {}),
    ...(betas.length ? { betas } : {}),
  };
}

export interface ClaudeEvents {
  onText?(delta: string): void;
  onThinking?(delta: string): void;
  /** A tool_use block began: the model has named the tool; its arguments come with the final message. */
  onToolUse?(id: string, name: string): void;
}

/**
 * The system blocks. They are the part of the prompt that is the same from one request
 * to the next — the recipe's prompt for every caller, the reference's layers for every
 * turn on a map — and the person on the other end thinks for minutes between messages,
 * so they sit on the one-hour cache: written once an hour instead of every time a
 * five-minute entry has lapsed. The conversation's own breakpoint (in the messages)
 * stays at five minutes; the rule that longer-lived entries come first is met because
 * system blocks render before messages.
 *
 * A request may carry four breakpoints, and the conversation needs one, so the blocks
 * get the last three: a breakpoint caches everything before it, so the recipe's prompt
 * is still covered by the first reference layer's when there are three layers.
 */
export function systemBlocks(call: Pick<ClaudeCall, "system" | "systemExtra">): BetaTextBlockParam[] {
  const ttl = { type: "ephemeral" as const, ttl: "1h" as const };
  const texts = [call.system, ...(call.systemExtra ?? []).filter((t) => t.trim())];
  const first = Math.max(0, texts.length - 3);
  return texts.map((text, i): BetaTextBlockParam => (i >= first ? { type: "text", text, cache_control: ttl } : { type: "text", text }));
}

/** The size of what went up, for the call log: what the cache had to cover and what could not be cached. */
export interface CallShape {
  /** What the call actually ran at — a repair runs at low effort without thinking whatever the request asked. */
  effort: Effort;
  thinking: boolean;
  messages: number;
  /** Characters of the recipe's system prompt, and of the extra blocks (the per-map reference). */
  systemChars: number;
  extraChars: number;
  /** Bytes of base64 image data in the messages. */
  imageBytes: number;
  tools: number;
}

export interface ClaudeResult {
  /** The text blocks joined. */
  text: string;
  content: BetaContentBlock[];
  stopReason: BetaStopReason;
  refusal: BetaRefusalStopDetails | null;
  tokens: TokenCounts;
  /** The model that actually answered (a fallback may have). */
  model: string;
  durationMs: number;
  /** Anthropic's id for the response (`msg_…`); the next call's `diagnose.previousMessageId`. */
  messageId: string;
  /** What the request looked like, for the call log. */
  shape: CallShape;
  /** The names of the tools the model called, in order. */
  toolUses: string[];
  /** Why the cache missed, when `diagnose` asked; `null` when it did not miss or Anthropic did not say. */
  cacheMiss: CacheMiss | null;
  /** The request and answer, when `capture` asked. Images are replaced by their byte counts. */
  payload?: { request: unknown; content: BetaContentBlock[] };
}

export interface CacheMiss {
  type: string;
  /** Tokens that had to be re-read because of it, when the reason carries that. */
  tokens?: number;
}

/** What the request weighs, from the call. Shared by the real client and the fake so the log means the same in tests. */
export function shapeOf(call: ClaudeCall): CallShape {
  return {
    effort: call.effort,
    thinking: call.thinking,
    messages: call.messages.length,
    systemChars: call.system.length,
    extraChars: (call.systemExtra ?? []).reduce((n, t) => n + t.length, 0),
    imageBytes: imageBytesIn(call.messages),
    tools: call.tools?.length ?? 0,
  };
}

function imageBytesIn(value: unknown, depth = 0): number {
  if (depth > 12 || !value || typeof value !== "object") return 0;
  if (Array.isArray(value)) return value.reduce((n: number, v) => n + imageBytesIn(v, depth + 1), 0);
  const o = value as Record<string, unknown>;
  if (o.type === "base64" && typeof o.data === "string") return Math.floor((o.data.length * 3) / 4);
  let n = 0;
  for (const v of Object.values(o)) n += imageBytesIn(v, depth + 1);
  return n;
}

/** A copy of a request with every base64 image replaced by its size, so a captured prompt stays small. */
export function withoutImages<T>(value: T, depth = 0): T {
  if (depth > 12 || !value || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => withoutImages(v, depth + 1)) as T;
  const o = value as Record<string, unknown>;
  if (o.type === "base64" && typeof o.data === "string") return { ...o, data: `[${Math.floor((o.data.length * 3) / 4)} bytes]` } as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) out[k] = withoutImages(v, depth + 1);
  return out as T;
}

export function toolUsesOf(content: BetaContentBlock[]): string[] {
  return content.filter((b): b is Extract<BetaContentBlock, { type: "tool_use" }> => b.type === "tool_use").map((b) => b.name);
}

export interface ClaudeClient {
  run(call: ClaudeCall, events?: ClaudeEvents): Promise<ClaudeResult>;
  /**
   * Read the call's prefix into the cache without generating (`max_tokens: 0`, not
   * streamed): what a keep-alive or a pre-warm sends. The result has the usage and no content.
   */
  warm(call: ClaudeCall): Promise<ClaudeResult>;
  /** Whether Anthropic takes a caller's own key: a model listing, which costs nothing. Throws the mapped error when not. */
  checkKey(apiKey: string): Promise<void>;
}

/**
 * What went wrong, in the words of the scmjs.dev server's error codes (a subset of them).
 * `task_ceiling` is for a `beforeCall` hook that stops a run before its next call.
 */
export type ClaudeErrorCode = "unauthorized" | "task_ceiling" | "refused" | "upstream" | "internal";

export class ClaudeError extends Error {
  readonly code: ClaudeErrorCode;
  readonly retryAfterSec: number | undefined;
  /**
   * What the call had used when it broke off — the prefix read or written at the start
   * of the stream, the output up to the last delta — when the stream got that far. An
   * interrupted call is still paid for; the record should say what it cost.
   */
  tokens: TokenCounts | undefined;
  constructor(code: ClaudeErrorCode, message: string, retryAfterSec?: number, tokens?: TokenCounts) {
    super(message);
    this.name = "ClaudeError";
    this.code = code;
    this.retryAfterSec = retryAfterSec;
    this.tokens = tokens;
  }
}

export interface AnthropicClientOptions {
  apiKey?: string;
  baseUrl?: string;
  maxRetries: number;
  timeoutMs: number;
  fallbacks: boolean;
  /** Where a retried call is noted; pino-shaped. */
  log?: { warn(obj: Record<string, unknown>, msg: string): void };
}

export class AnthropicClaudeClient implements ClaudeClient {
  private readonly options: AnthropicClientOptions;
  private serverClient: Anthropic | null = null;

  constructor(options: AnthropicClientOptions) {
    this.options = options;
  }

  private clientFor(apiKey: string | undefined): Anthropic {
    const { baseUrl, maxRetries, timeoutMs } = this.options;
    if (apiKey) return new Anthropic({ apiKey, baseURL: baseUrl, maxRetries, timeout: timeoutMs });
    if (!this.options.apiKey) throw new ClaudeError("upstream", "This server has no Anthropic key of its own; send yours in X-Anthropic-Key.");
    this.serverClient ??= new Anthropic({ apiKey: this.options.apiKey, baseURL: baseUrl, maxRetries, timeout: timeoutMs });
    return this.serverClient;
  }

  async checkKey(apiKey: string): Promise<void> {
    try {
      await this.clientFor(apiKey).models.list({ limit: 1 });
    } catch (err) {
      throw mapError(err, true);
    }
  }

  /** The request as the API takes it; the same shape for a streamed run and a warm-up. */
  private params(call: ClaudeCall): Parameters<Anthropic["beta"]["messages"]["stream"]>[0] {
    return requestParams(call, { fallbacks: this.options.fallbacks });
  }

  async warm(call: ClaudeCall): Promise<ClaudeResult> {
    const client = this.clientFor(call.apiKey);
    const started = Date.now();
    const params = this.params({ ...call, maxTokens: 0 });
    try {
      const message = await client.beta.messages.create({ ...params, stream: false });
      return {
        text: "",
        content: message.content,
        stopReason: message.stop_reason ?? "max_tokens",
        refusal: null,
        tokens: tokensOf(message.usage),
        model: message.model,
        durationMs: Date.now() - started,
        messageId: message.id,
        shape: shapeOf(call),
        toolUses: [],
        cacheMiss: cacheMissOf(message),
      };
    } catch (err) {
      throw mapError(err, !!call.apiKey);
    }
  }

  async run(call: ClaudeCall, events: ClaudeEvents = {}): Promise<ClaudeResult> {
    try {
      return await this.runOnce(call, events);
    } catch (err) {
      // A schema the API's grammar compiler will not take: the call is worth more than
      // the guarantee, so it goes again as plain JSON, which the recipe validates anyway.
      if (call.outputSchema && !call.noSchemaFallback && err instanceof ClaudeError && GRAMMAR_TOO_LARGE.test(err.message)) {
        this.options.log?.warn({ model: call.model, schemaChars: JSON.stringify(call.outputSchema).length }, "structured output schema refused; retrying without it");
        return await this.runOnce({ ...call, outputSchema: undefined }, events);
      }
      throw err;
    }
  }

  private async runOnce(call: ClaudeCall, events: ClaudeEvents): Promise<ClaudeResult> {
    const client = this.clientFor(call.apiKey);
    const started = Date.now();
    const params = this.params(call);
    // The usage as the stream reports it: the input side comes with `message_start`, the
    // output count grows with each `message_delta`. Kept so a call that breaks off can
    // still say what it had used.
    let partial: TokenCounts | undefined;
    try {
      const stream = client.beta.messages.stream(params, { signal: call.signal });
      if (events.onText) stream.on("text", (delta) => events.onText!(delta));
      if (events.onThinking) stream.on("thinking", (delta) => events.onThinking!(delta));
      stream.on("streamEvent", (event) => {
        if (event.type === "message_start") partial = tokensOf(event.message.usage);
        else if (event.type === "message_delta" && partial) partial = { ...partial, outputTokens: event.usage.output_tokens };
        else if (event.type === "content_block_start" && event.content_block.type === "tool_use") events.onToolUse?.(event.content_block.id, event.content_block.name);
      });
      const message = await stream.finalMessage();
      const text = message.content.filter((b): b is Extract<BetaContentBlock, { type: "text" }> => b.type === "text").map((b) => b.text).join("");
      return {
        text,
        content: message.content,
        stopReason: message.stop_reason ?? "end_turn",
        refusal: message.stop_reason === "refusal" ? message.stop_details ?? { type: "refusal", category: null, explanation: null } as BetaRefusalStopDetails : null,
        tokens: tokensOf(message.usage),
        model: message.model,
        durationMs: Date.now() - started,
        messageId: message.id,
        shape: shapeOf(call),
        toolUses: toolUsesOf(message.content),
        cacheMiss: cacheMissOf(message),
        ...(call.capture ? { payload: { request: withoutImages(params), content: message.content } } : {}),
      };
    } catch (err) {
      const mapped = mapError(err, !!call.apiKey);
      if (partial && !mapped.tokens) mapped.tokens = partial;
      throw mapped;
    }
  }
}

function tokensOf(usage: { input_tokens: number; output_tokens: number; cache_read_input_tokens?: number | null; cache_creation_input_tokens?: number | null; cache_creation?: { ephemeral_5m_input_tokens: number; ephemeral_1h_input_tokens: number } | null }): TokenCounts {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens ?? 0,
    cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
    cacheWrite5mTokens: usage.cache_creation?.ephemeral_5m_input_tokens ?? 0,
    cacheWrite1hTokens: usage.cache_creation?.ephemeral_1h_input_tokens ?? 0,
  };
}

function cacheMissOf(message: { diagnostics?: { cache_miss_reason: { type: string; cache_missed_input_tokens?: number } | null } | null }): CacheMiss | null {
  const reason = message.diagnostics?.cache_miss_reason;
  if (!reason) return null;
  return { type: reason.type, ...(typeof reason.cache_missed_input_tokens === "number" ? { tokens: reason.cache_missed_input_tokens } : {}) };
}

/** SDK exceptions → protocol error codes. A caller's bad key is their problem; the server's is ours. */
const GRAMMAR_TOO_LARGE = /compiled grammar is too large/i;

export function mapError(err: unknown, byok: boolean): ClaudeError {
  if (err instanceof ClaudeError) return err;
  if (err instanceof Anthropic.APIUserAbortError) return new ClaudeError("internal", "The request was cancelled.");
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
    return byok
      ? new ClaudeError("unauthorized", `Anthropic rejected the key you sent (${err.status}).`)
      : new ClaudeError("upstream", `Anthropic rejected the server's key (${err.status}); the operator needs to look at this.`);
  }
  if (err instanceof Anthropic.RateLimitError) {
    const retry = Number(err.headers?.get("retry-after")) || 30;
    return new ClaudeError("upstream", "Anthropic is rate-limiting this server; try again shortly.", retry);
  }
  if (err instanceof Anthropic.BadRequestError || err instanceof Anthropic.NotFoundError || err instanceof Anthropic.UnprocessableEntityError) {
    return new ClaudeError("upstream", `Anthropic refused the request: ${err.message}`);
  }
  if (err instanceof Anthropic.APIConnectionTimeoutError) return new ClaudeError("upstream", "The model took too long to answer.", 30);
  if (err instanceof Anthropic.APIConnectionError) return new ClaudeError("upstream", "Could not reach Anthropic.", 15);
  if (err instanceof Anthropic.APIError) return new ClaudeError("upstream", `Anthropic answered ${err.status ?? "an error"}: ${err.message}`, 15);
  return new ClaudeError("internal", err instanceof Error ? err.message : String(err));
}

/* ── Test double ────────────────────────────────────────── */

export type FakeAnswer =
  | { text: string; stopReason?: BetaStopReason; model?: string; tokens?: Partial<TokenCounts>; thinking?: string; content?: BetaContentBlock[]; cacheMiss?: CacheMiss }
  | { refusal: BetaRefusalStopDetails["category"] }
  | { error: Error; tokens?: Partial<TokenCounts> };

/** Answers each call from a queue (or a function of the call) and remembers the calls. */
export class FakeClaudeClient implements ClaudeClient {
  readonly calls: ClaudeCall[] = [];
  /** The warm-ups asked for, in order. */
  readonly warmed: ClaudeCall[] = [];
  /** What a warm-up answers with; the default is a full cache read of a made-up size. */
  warmTokens: Partial<TokenCounts> = { cacheReadTokens: 20_000 };
  warmError: Error | null = null;
  /** The keys `checkKey` was asked about, and the error it answers with (none: the key is good). */
  readonly checkedKeys: string[] = [];
  keyError: Error | null = null;
  private readonly queue: FakeAnswer[] = [];
  handler: ((call: ClaudeCall, index: number) => FakeAnswer) | null = null;
  /** Milliseconds to wait before answering, for heartbeat tests. */
  delayMs = 0;

  answer(...answers: FakeAnswer[]): this {
    this.queue.push(...answers);
    return this;
  }

  async warm(call: ClaudeCall): Promise<ClaudeResult> {
    this.warmed.push(call);
    if (this.warmError) throw this.warmError;
    return { text: "", content: [], stopReason: "max_tokens", refusal: null, tokens: { ...zeroTokens(), ...this.warmTokens }, model: call.model, durationMs: 1, messageId: `msg_warm_${this.warmed.length}`, shape: shapeOf(call), toolUses: [], cacheMiss: null };
  }

  async checkKey(apiKey: string): Promise<void> {
    this.checkedKeys.push(apiKey);
    if (this.keyError) throw this.keyError;
  }

  async run(call: ClaudeCall, events: ClaudeEvents = {}): Promise<ClaudeResult> {
    const index = this.calls.length;
    this.calls.push(call);
    if (this.delayMs) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, this.delayMs);
        call.signal?.addEventListener("abort", () => { clearTimeout(t); reject(new ClaudeError("internal", "The request was cancelled.")); }, { once: true });
      });
    }
    const a = this.handler ? this.handler(call, index) : this.queue.shift();
    if (!a) throw new ClaudeError("internal", "FakeClaudeClient has no answer queued.");
    if ("error" in a) {
      if (a.tokens && a.error instanceof ClaudeError) a.error.tokens = { ...zeroTokens(), ...a.tokens };
      throw a.error;
    }
    const common = { messageId: `msg_fake_${index}`, shape: shapeOf(call), cacheMiss: null, ...(call.capture ? { payload: { request: withoutImages({ system: systemBlocks(call), messages: call.messages, tools: call.tools }), content: [] as BetaContentBlock[] } } : {}) };
    if ("refusal" in a) {
      return { ...common, text: "", content: [], stopReason: "refusal", refusal: { type: "refusal", category: a.refusal, explanation: null } as BetaRefusalStopDetails, tokens: zeroTokens(), model: call.model, durationMs: 1, toolUses: [] };
    }
    if (a.thinking && events.onThinking) events.onThinking(a.thinking);
    if (events.onText) for (const piece of a.text.match(/.{1,40}/gs) ?? []) events.onText(piece);
    const content: BetaContentBlock[] = a.content ?? (a.text ? [{ type: "text", text: a.text, citations: null } as BetaContentBlock] : []);
    if (events.onToolUse) for (const b of content) if (b.type === "tool_use") events.onToolUse(b.id, b.name);
    return {
      ...common,
      text: a.text,
      content,
      stopReason: a.stopReason ?? "end_turn",
      refusal: null,
      tokens: { ...zeroTokens(), inputTokens: 1000, outputTokens: 200, ...a.tokens },
      model: a.model ?? call.model,
      durationMs: 1,
      toolUses: toolUsesOf(content),
      cacheMiss: a.cacheMiss ?? null,
      ...(common.payload ? { payload: { ...common.payload, content } } : {}),
    };
  }
}

export function zeroTokens(): TokenCounts {
  return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheWrite5mTokens: 0, cacheWrite1hTokens: 0 };
}
