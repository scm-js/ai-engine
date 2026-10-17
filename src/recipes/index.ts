/**
 * The recipe registry and the runner: build the call, make it, parse the answer, and
 * when the answer does not fit, tell the model what was wrong and let it try once more.
 */
import { ClaudeError, type ClaudeCall, type ClaudeClient, type ClaudeResult } from "../claude.js";
import type { Effort } from "../defaults.js";
import type { TokenCounts } from "../pricing.js";
import type { RecipeInputs, RecipeName, RecipeOutputs } from "../protocol.js";
import { agentRecipe } from "./agent.js";
import { briefingRecipe } from "./briefing.js";
import { castRecipe } from "./cast.js";
import { describeRecipe } from "./describe.js";
import { explainTriggersRecipe } from "./explainTriggers.js";
import { mapPlanRecipe } from "./mapPlan.js";
import { regionPlanRecipe } from "./regionPlan.js";
import { reviewRecipe } from "./review.js";
import { stringsRecipe } from "./strings.js";
import { triggersRecipe } from "./triggers.js";
import { umsDesignRecipe } from "./umsDesign.js";
import { RecipeOutputError, type BuildContext, type Recipe } from "./types.js";

export const RECIPES: { [N in RecipeName]: Recipe<N> } = {
  "map-plan": mapPlanRecipe,
  "region-plan": regionPlanRecipe,
  "triggers": triggersRecipe,
  "explain-triggers": explainTriggersRecipe,
  "describe": describeRecipe,
  "briefing": briefingRecipe,
  "review": reviewRecipe,
  "strings": stringsRecipe,
  "agent": agentRecipe,
  "ums-design": umsDesignRecipe,
  "cast": castRecipe,
};

export function recipeByName(name: string): Recipe | null {
  return Object.prototype.hasOwnProperty.call(RECIPES, name) ? (RECIPES as Record<string, Recipe>)[name]! : null;
}

export interface RunParams<N extends RecipeName> {
  recipe: Recipe<N>;
  input: RecipeInputs[N];
  model: string;
  effort: Effort;
  maxTokens: number;
  thinking: boolean;
  apiKey?: string;
  signal?: AbortSignal;
  onText?: (delta: string) => void;
  onThinking?: (delta: string) => void;
  onToolUse?: (id: string, name: string) => void;
  /** Diagnose the cache against this message id (`null`: a first call); absent leaves diagnostics off. */
  previousMessageId?: string | null;
  /** Keep each call's request and answer on its result. */
  capture?: boolean;
  /** Before each call starts (a task ceiling's reservation); throwing stops the request there. */
  beforeCall?: (index: number, call: ClaudeCall) => void;
  /** Every completed call, as it completes — the call log's hook. */
  onCall?: (result: ClaudeResult, index: number, call: ClaudeCall) => void;
  /** A call that failed, with what the SDK said, and what it had used before it broke off when the stream got that far. */
  onCallError?: (message: string, index: number, call: ClaudeCall, tokens?: TokenCounts) => void;
}

export interface RunOutcome<N extends RecipeName> {
  output: RecipeOutputs[N];
  /** Every call made, the repair round included. */
  calls: ClaudeResult[];
}

const REPAIR_PROMPT = (problems: string[]) =>
  `Your answer could not be used:\n${problems.map((p) => `- ${p}`).join("\n")}\n\nFix only what is listed and keep everything else exactly as it was; answer with the complete corrected output, in the same schema, and nothing else.`;

/**
 * The output budget of a repair round: the corrected answer is the first one with a few
 * fields changed, so it needs about what the first took, not the recipe's whole allowance
 * — a map plan's repair once ran to 22,000 tokens ($0.60) for a 600-character complaint.
 * Twice the first answer plus room to think, never under 8,000, never over the recipe's.
 */
export function repairMaxTokens(recipeMax: number, firstOutput: number): number {
  return Math.min(recipeMax, Math.max(8_000, firstOutput * 2 + 4_000));
}

export async function runRecipe<N extends RecipeName>(claude: ClaudeClient, ctx: BuildContext, p: RunParams<N>): Promise<RunOutcome<N>> {
  const built = p.recipe.build(p.input, ctx);
  const call: ClaudeCall = {
    model: p.model,
    maxTokens: p.maxTokens,
    effort: p.effort,
    system: p.recipe.system,
    systemExtra: built.systemExtra,
    messages: built.messages,
    outputSchema: built.outputSchema,
    tools: built.tools,
    thinking: p.thinking,
    apiKey: p.apiKey,
    signal: p.signal,
    ...(p.previousMessageId !== undefined ? { diagnose: { previousMessageId: p.previousMessageId } } : {}),
    ...(p.capture ? { capture: true } : {}),
  };
  // A JSON recipe's text streams too: the client cannot use a half-written object, but it can show the
  // answer growing — which, when the model reasons without a summary, is the only sign of life it has.
  const events = { onText: p.onText, onThinking: p.onThinking, onToolUse: p.recipe.kind === "agent" ? p.onToolUse : undefined };
  const calls: ClaudeResult[] = [];
  const run = async (c: ClaudeCall): Promise<ClaudeResult> => {
    const index = calls.length;
    p.beforeCall?.(index, c);
    let r: ClaudeResult;
    try {
      r = await claude.run(c, events);
    } catch (err) {
      p.onCallError?.(err instanceof Error ? err.message : String(err), index, c, err instanceof ClaudeError ? err.tokens : undefined);
      throw err;
    }
    calls.push(r);
    p.onCall?.(r, index, c);
    return r;
  };

  const first = await run(call);
  refused(first);
  try {
    return { output: p.recipe.parse(first, p.input, ctx), calls };
  } catch (err) {
    if (!(err instanceof RecipeOutputError)) throw err;
    const problems = first.stopReason === "max_tokens" ? ["the answer was cut off at the output limit; make it shorter", ...err.problems] : err.problems;
    // A repair is mechanical — the complaint names the fields — so it runs at low effort,
    // without thinking, with a capped budget; the first answer's reasoning is not repeated.
    const repair: ClaudeCall = {
      ...call,
      effort: "low",
      thinking: false,
      maxTokens: repairMaxTokens(call.maxTokens, first.tokens.outputTokens),
      ...(call.diagnose ? { diagnose: { previousMessageId: first.messageId } } : {}),
      messages: [
        ...call.messages,
        { role: "assistant", content: first.text || "(empty)" },
        { role: "user", content: REPAIR_PROMPT(problems) },
      ],
    };
    const second = await run(repair);
    refused(second);
    try {
      return { output: p.recipe.parse(second, p.input, ctx), calls };
    } catch (err2) {
      if (!(err2 instanceof RecipeOutputError)) throw err2;
      throw new ClaudeError("upstream", `The model's answer could not be used, twice: ${err2.problems.join("; ")}`);
    }
  }
}

function refused(r: ClaudeResult) {
  if (r.stopReason !== "refusal") return;
  const category = r.refusal?.category;
  throw new ClaudeError("refused", category ? `The model declined this request (${category}).` : "The model declined this request.");
}
