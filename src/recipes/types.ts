/**
 * What a recipe is: an input schema, a static system prompt (cached), a message builder
 * and a parser that turns the model's answer into the protocol's output type — or throws
 * a `RecipeOutputError` naming what was wrong, which earns the model one repair turn.
 */
import type { z } from "zod";
import type { BetaMessageParam, BetaTool, ClaudeResult } from "../claude.js";
import type { MapFacts, RecipeInputs, RecipeName, RecipeOutputs } from "../protocol.js";

/** What the caller decides for every recipe, beyond the call's own settings. */
export interface BuildContext {
  /** The most messages of an assistant conversation sent to the model; older turns are trimmed. */
  maxAgentMessages: number;
}

export interface Built {
  messages: BetaMessageParam[];
  /** Further system blocks, each cached on its own — a reference that is the same from turn to turn. */
  systemExtra?: string[];
  /** JSON Schema for a structured answer; absent for prose. */
  outputSchema?: Record<string, unknown>;
  tools?: BetaTool[];
}

export interface Recipe<N extends RecipeName = RecipeName> {
  name: N;
  /** `text` streams its deltas to the client; `json` answers whole; `agent` streams its text and its tool-call starts and is parsed as blocks. */
  kind: "json" | "text" | "agent";
  input: z.ZodType<RecipeInputs[N], z.ZodTypeDef, unknown>;
  system: string;
  build(input: RecipeInputs[N], ctx: BuildContext): Built;
  parse(result: ClaudeResult, input: RecipeInputs[N], ctx: BuildContext): RecipeOutputs[N];
}

/** The answer did not fit: the listed problems go back to the model once. */
export class RecipeOutputError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.join("; "));
    this.name = "RecipeOutputError";
    this.problems = problems;
  }
}

/** The answer's text as JSON, or a `RecipeOutputError`. Tolerates a fenced block around it. */
export function parseJson(text: string): unknown {
  let s = text.trim();
  const fence = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(s);
  if (fence) s = fence[1]!;
  try {
    return JSON.parse(s);
  } catch (err) {
    throw new RecipeOutputError([`the answer is not valid JSON: ${(err as Error).message}`]);
  }
}

/** Validate a parsed answer with a zod schema, turning issues into a repair list. */
export function expect<T>(schema: z.ZodType<T, z.ZodTypeDef, unknown>, value: unknown): T {
  const r = schema.safeParse(value);
  if (r.success) return r.data;
  throw new RecipeOutputError(r.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
}

/* ── JSON Schema helpers (structured outputs need every object closed) ── */

export const S = {
  obj(properties: Record<string, unknown>, required: string[] = Object.keys(properties), description?: string): Record<string, unknown> {
    return { type: "object", properties, required, additionalProperties: false, ...(description ? { description } : {}) };
  },
  arr(items: unknown, description?: string): Record<string, unknown> {
    return { type: "array", items, ...(description ? { description } : {}) };
  },
  str(description?: string): Record<string, unknown> {
    return { type: "string", ...(description ? { description } : {}) };
  },
  int(description?: string): Record<string, unknown> {
    return { type: "integer", ...(description ? { description } : {}) };
  },
  num(description?: string): Record<string, unknown> {
    return { type: "number", ...(description ? { description } : {}) };
  },
  bool(description?: string): Record<string, unknown> {
    return { type: "boolean", ...(description ? { description } : {}) };
  },
  enumOf(values: readonly string[], description?: string): Record<string, unknown> {
    return { type: "string", enum: [...values], ...(description ? { description } : {}) };
  },
};

/* ── Facts → prose ─────────────────────────────────────── */

/**
 * The map's facts as the block every fact-based recipe reads. `identity: false` leaves
 * out the name, description, size and players — for the assistant, whose reference
 * block carries them already, so the state block it pays for every turn stays short.
 */
export function factsText(f: MapFacts, options: { triggers?: boolean; identity?: boolean } = {}): string {
  const lines: string[] = [];
  if (options.identity !== false) {
    lines.push(`Name: ${f.name || "(none)"}`);
    lines.push(`Description: ${f.description || "(none)"}`);
    lines.push(`Size: ${f.width} × ${f.height} tiles, tileset ${f.tileset}`);
    const players = f.players.filter((p) => p.type !== "Inactive" && p.type !== "Unused");
    lines.push(`Players (${players.length}):`);
    for (const p of players) lines.push(`  ${p.slot + 1}: ${p.type}, ${p.race}, force ${p.force + 1}${p.hasStart ? ", has a start location" : ""}`);
  }
  if (f.statistics.length) {
    lines.push("Statistics:");
    for (const s of f.statistics) lines.push(`  ${s}`);
  }
  if (f.units.length) {
    lines.push("Units on the map:");
    for (const u of f.units) lines.push(`  ${u}`);
  }
  if (f.locations.length) lines.push(`Locations: ${f.locations.join(", ")}`);
  lines.push(`Triggers: ${f.triggerCount}; briefing triggers: ${f.briefingCount}`);
  if (f.selection && f.selection.length) { lines.push("Selected right now:"); for (const l of f.selection) lines.push(`  ${l}`); }
  if (f.view) lines.push(`View: ${f.view}`);
  if (f.history) lines.push(`History: ${f.history}`);
  if (options.triggers !== false && f.triggersText) {
    lines.push("Triggers (the editor's text format):");
    lines.push(f.triggersText);
  }
  return lines.join("\n");
}

export function clampInt(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof v === "number" && Number.isFinite(v) ? Math.round(v) : fallback;
  return Math.max(lo, Math.min(hi, n));
}
