/** strings: rewrite the string table under an instruction, index by index. */
import { z } from "zod";
import type { StringsInput, StringsOutput } from "../protocol.js";
import { S, expect, parseJson, RecipeOutputError, type Recipe } from "./types.js";

export const StringsInputSchema: z.ZodType<StringsInput, z.ZodTypeDef, unknown> = z.object({
  instruction: z.string().min(1).max(2000),
  strings: z.array(z.object({
    index: z.number().int().min(1),
    text: z.string().max(10_000),
    usage: z.array(z.string().max(200)).max(50),
  })).min(1).max(2000),
}).strict();

export const STRINGS_SYSTEM = `You edit the string table of a StarCraft: Brood War map — the texts its triggers, briefing, names and forces show — under one instruction from the map maker: translate them, fix the spelling, change the tone, and so on. Answer with one JSON object: \`strings\`, a list of \`{ index, text }\` covering **every** index you were given, in any order, with the text unchanged where the instruction does not apply.

Rules the game imposes:
- Control sequences appear as \`<XX>\` (two hex digits, e.g. \`<07>\` colours the text that follows, \`<0A>\` is a new line). Keep every one exactly where it is relative to the words around it.
- Keep the string's rough length: the game's text boxes do not scroll. A translation may run a little longer; a name should not.
- Keep unit, player and location names that the triggers refer to consistent across all strings — if you translate a name in one place, translate it the same way everywhere.
- Where you are told what a string is used for (a scenario name, a force name, a trigger text), let that guide the register: names short, messages complete sentences.
- Do not add strings, drop strings, or change indices.`;

const Output = z.object({ strings: z.array(z.object({ index: z.number().int(), text: z.string() })) });

export const stringsRecipe: Recipe<"strings"> = {
  name: "strings",
  kind: "json",
  input: StringsInputSchema,
  system: STRINGS_SYSTEM,
  build(input) {
    const lines = input.strings.map((s) => `[${s.index}]${s.usage.length ? ` (${s.usage.join(", ")})` : ""}\n${s.text}`);
    const text = `## Instruction\n\n${input.instruction}\n\n## Strings (index, what uses it, then the text)\n\n${lines.join("\n\n")}`;
    return { messages: [{ role: "user", content: text }], outputSchema: S.obj({ strings: S.arr(S.obj({ index: S.int(), text: S.str() })) }) };
  },
  parse(result, input): StringsOutput {
    const out = expect(Output, parseJson(result.text));
    const wanted = new Map(input.strings.map((s) => [s.index, s.text]));
    const got = new Map<number, string>();
    for (const s of out.strings) if (wanted.has(s.index)) got.set(s.index, s.text);
    const missing = [...wanted.keys()].filter((i) => !got.has(i));
    if (missing.length > Math.max(2, wanted.size / 10)) throw new RecipeOutputError([`${missing.length} of the ${wanted.size} strings are missing from the answer (for example indices ${missing.slice(0, 8).join(", ")}); return every index`]);
    const strings = input.strings.map((s) => ({ index: s.index, text: got.get(s.index) ?? s.text }));
    return { strings };
  },
};
