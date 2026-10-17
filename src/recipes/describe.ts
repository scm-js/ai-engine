/** describe: a name and a description for the map, from its facts. */
import { z } from "zod";
import type { DescribeInput, DescribeOutput } from "../protocol.js";
import { MapFactsSchema } from "./facts.js";
import { S, expect, factsText, parseJson, type Recipe } from "./types.js";

export const DescribeInputSchema: z.ZodType<DescribeInput, z.ZodTypeDef, unknown> = z.object({
  facts: MapFactsSchema,
  prompt: z.string().max(2000).optional(),
}).strict();

export const DESCRIBE_SYSTEM = `You name and describe StarCraft: Brood War maps from what is on them. The editor sends the map's facts — size, tileset, players, statistics, units, locations, and sometimes its triggers — and any wishes from the map maker. Answer with one JSON object: \`name\`, \`description\`, and \`alternatives\`, a list of two more name/description pairs.

- The name is at most 40 characters, in the style of the game's own maps: a place, a mood, a thing ("Lost Temple", "Fighting Spirit", "Blood Bath"). A melee map's name usually carries the player count in parentheses at the front, as the game's do: "(4)Python". No emoji unless asked.
- The description is at most 300 characters. For a melee map: what the layout is like and how many players. For a scenario: what the player does, without spoiling the triggers. State facts you were given; invent nothing about play you cannot see.
- Keep the existing name's language when it is not English, and keep any author credit that is in the existing description.
- If the maker's wishes ask for a tone or a language, follow them.`;

const Output = z.object({
  name: z.string().min(1),
  description: z.string(),
  alternatives: z.array(z.object({ name: z.string().min(1), description: z.string() })),
});

export const describeRecipe: Recipe<"describe"> = {
  name: "describe",
  kind: "json",
  input: DescribeInputSchema,
  system: DESCRIBE_SYSTEM,
  build(input) {
    const text = `## The map\n\n${factsText(input.facts)}\n\n## Wishes\n\n${input.prompt?.trim() || "(none)"}`;
    const pair = S.obj({ name: S.str(), description: S.str() });
    return { messages: [{ role: "user", content: text }], outputSchema: S.obj({ name: S.str("at most 40 characters"), description: S.str("at most 300 characters"), alternatives: S.arr(pair, "two more") }) };
  },
  parse(result): DescribeOutput {
    const out = expect(Output, parseJson(result.text));
    const trim = (p: { name: string; description: string }) => ({ name: p.name.trim().slice(0, 40), description: p.description.trim().slice(0, 300) });
    return { ...trim(out), alternatives: out.alternatives.slice(0, 3).map(trim) };
  },
};
