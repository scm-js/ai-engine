/**
 * The knobs a recipe call turns, and each recipe's starting point for them. A server's
 * own configuration goes over these; they are what the recipes were tuned at.
 */
import type { RecipeName } from "./protocol.js";

export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** Per-recipe defaults: effort tuned to what the recipe is for, and room for its output. */
export const RECIPE_DEFAULTS: Record<RecipeName, { effort: Effort; maxTokens: number }> = {
  "map-plan": { effort: "high", maxTokens: 32000 },
  "region-plan": { effort: "medium", maxTokens: 16000 },
  "triggers": { effort: "high", maxTokens: 32000 },
  "explain-triggers": { effort: "low", maxTokens: 8000 },
  "describe": { effort: "low", maxTokens: 2000 },
  "briefing": { effort: "medium", maxTokens: 4000 },
  "review": { effort: "medium", maxTokens: 8000 },
  "strings": { effort: "low", maxTokens: 16000 },
  "agent": { effort: "medium", maxTokens: 16000 },
  "ums-design": { effort: "high", maxTokens: 16000 },
  "cast": { effort: "medium", maxTokens: 64000 },
};
