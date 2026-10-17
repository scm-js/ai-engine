/** review: a critique of the map from a rendered picture, its facts and the editor's own checks. */
import { z } from "zod";
import type { BetaMessageParam } from "../claude.js";
import type { ReviewInput, ReviewOutput } from "../protocol.js";
import { ImageSchema, MapFactsSchema } from "./facts.js";
import { S, expect, factsText, parseJson, type Recipe } from "./types.js";

export const ReviewInputSchema: z.ZodType<ReviewInput, z.ZodTypeDef, unknown> = z.object({
  facts: MapFactsSchema,
  image: ImageSchema,
  issues: z.array(z.string().max(500)).max(500),
  prompt: z.string().max(2000).optional(),
}).strict();

export const REVIEW_SYSTEM = `You review StarCraft: Brood War maps for the person making them. You get a picture of the whole map (north up; it spans the map's full width and height in tiles, so a point at a fraction of the picture's width is at that fraction of the map's width in tiles), the map's facts, and what the editor's own checker found. Answer with one JSON object: \`summary\` (Markdown) and \`findings\` (a list).

What to look at, for a melee map: main and natural positions and their distance from each other; whether every main has one ramp and a defensible natural; choke widths and whether armies can move through the centre; expansion count and fairness under the symmetry; mineral lines that face the wrong way or sit in the path; islands and dead ends; rush distance by air versus ground; readability — can a player tell high ground from low at a glance. For a scenario: whether the units and locations match what the triggers do, players and forces, start positions, anything the checker flagged.

The summary is a short review in plain language: what works, what does not, what to change first. Findings are specific: \`severity\` info, warning or problem; a \`title\` of a few words; \`detail\` of one or two sentences; and, when the finding is somewhere in particular, \`x\` and \`y\` in tiles (−1 when it is not). Order them problems first. Be concrete and be fair; do not pad with praise or with generic advice. No emoji.`;

const Output = z.object({
  summary: z.string(),
  findings: z.array(z.object({ severity: z.enum(["info", "warning", "problem"]), title: z.string(), detail: z.string(), x: z.number(), y: z.number() })),
});

export const reviewRecipe: Recipe<"review"> = {
  name: "review",
  kind: "json",
  input: ReviewInputSchema,
  system: REVIEW_SYSTEM,
  build(input) {
    const head = [
      `## The map\n\n${factsText(input.facts, { triggers: true })}`,
      `## What the editor's checker found\n\n${input.issues.length ? input.issues.map((i) => `- ${i}`).join("\n") : "- nothing"}`,
      `## What the maker asks\n\n${input.prompt?.trim() || "A general review."}`,
    ];
    const content: Extract<BetaMessageParam["content"], unknown[]> = [
      { type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } },
      { type: "text", text: `That is the whole map, ${input.facts.width} × ${input.facts.height} tiles, north up.\n\n${head.join("\n\n")}` },
    ];
    const finding = S.obj({ severity: S.enumOf(["info", "warning", "problem"]), title: S.str(), detail: S.str(), x: S.int("tile, or -1"), y: S.int("tile, or -1") });
    return { messages: [{ role: "user", content }], outputSchema: S.obj({ summary: S.str("Markdown"), findings: S.arr(finding) }) };
  },
  parse(result, input): ReviewOutput {
    const out = expect(Output, parseJson(result.text));
    const order = { problem: 0, warning: 1, info: 2 };
    const findings = out.findings.map((f) => {
      const inMap = f.x >= 0 && f.y >= 0 && f.x < input.facts.width && f.y < input.facts.height;
      const base = { severity: f.severity, title: f.title.trim().slice(0, 120), detail: f.detail.trim() };
      return inMap ? { ...base, x: Math.round(f.x), y: Math.round(f.y) } : base;
    }).sort((a, b) => order[a.severity] - order[b.severity]);
    return { summary: out.summary.trim(), findings };
  },
};
