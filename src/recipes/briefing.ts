/** briefing: mission objectives and narration lines from the map's facts and triggers. */
import { z } from "zod";
import type { BriefingInput, BriefingOutput } from "../protocol.js";
import { MapFactsSchema } from "./facts.js";
import { S, expect, factsText, parseJson, type Recipe } from "./types.js";

export const BriefingInputSchema: z.ZodType<BriefingInput, z.ZodTypeDef, unknown> = z.object({
  facts: MapFactsSchema,
  prompt: z.string().max(2000).optional(),
}).strict();

export const BRIEFING_SYSTEM = `You write mission briefings for StarCraft: Brood War scenarios — the screen before the map starts, where an adjutant, a cerebrate or an executor tells the player what is going on and what to do. The editor sends the map's facts and, when it has them, its triggers; the win and loss conditions and the objectives are in those triggers, so read them and brief what they actually require.

Answer with one JSON object: \`objectives\` (the lines shown in the objectives box; at most 5, each a short imperative: "Destroy the Zerg hive cluster.") and \`lines\` (the narration, 4 to 10 entries, each one message). Write in the voice the game uses for the player's race when you can tell it — Terran clipped and military, Protoss formal, Zerg hungry — and in the second person. No headings, no bullet marks inside the strings, no meta talk about triggers or the editor. Keep names of units, locations and players exactly as given. If wishes ask for a tone or a language, follow them.`;

const Output = z.object({ objectives: z.array(z.string()), lines: z.array(z.string()) });

export const briefingRecipe: Recipe<"briefing"> = {
  name: "briefing",
  kind: "json",
  input: BriefingInputSchema,
  system: BRIEFING_SYSTEM,
  build(input) {
    const text = `## The map\n\n${factsText(input.facts)}\n\n## Wishes\n\n${input.prompt?.trim() || "(none)"}`;
    return { messages: [{ role: "user", content: text }], outputSchema: S.obj({ objectives: S.arr(S.str(), "at most 5"), lines: S.arr(S.str(), "4 to 10") }) };
  },
  parse(result): BriefingOutput {
    const out = expect(Output, parseJson(result.text));
    const clean = (s: string) => s.replace(/\s+/g, " ").trim();
    return {
      objectives: out.objectives.map(clean).filter(Boolean).slice(0, 5),
      lines: out.lines.map(clean).filter(Boolean).slice(0, 12),
    };
  },
};
