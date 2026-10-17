/**
 * map-plan: a whole map from a prompt — terrain grid, bases, ramps, decoration, name and
 * description — in the layout language of `plan.ts`. A refinement round shows the model
 * its previous plan, what the editor found rendering it, and a picture of the result.
 */
import { z } from "zod";
import type { BetaMessageParam } from "../claude.js";
import type { MapPlan, MapPlanInput } from "../protocol.js";
import { MAP_PLAN_PROMPT_MAX, SYMMETRY_MODES } from "../protocol.js";
import { LAYOUT_LANGUAGE, autoSymmetry, layoutSchema, normalizeLayout, planText, symmetryOf, vocabText } from "./plan.js";
import { SHAPE_LANGUAGE, normalizeShapes, rampPairsText } from "./shapes.js";
import { parseJson, type Recipe } from "./types.js";

const TerrainVocab = z.object({ id: z.number().int(), name: z.string().min(1).max(64), height: z.union([z.literal(0), z.literal(1), z.literal(2)]), buildable: z.boolean() });
const Image = z.object({ mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().min(1) });

export const MapPlanInputSchema: z.ZodType<MapPlanInput, z.ZodTypeDef, unknown> = z.object({
  // A scenario's layout prompt is the design's brief plus every named location: 4–6k characters is normal.
  prompt: z.string().min(1).max(MAP_PLAN_PROMPT_MAX),
  width: z.number().int().min(16).max(256),
  height: z.number().int().min(16).max(256),
  tileset: z.string().min(1).max(32),
  terrains: z.array(TerrainVocab).min(1).max(64),
  doodadCategories: z.array(z.string().max(64)).max(64),
  unitNames: z.array(z.string().max(64)).max(300),
  players: z.number().int().min(1).max(8),
  symmetry: z.enum(["auto", ...SYMMETRY_MODES]).default("auto"),
  cellSize: z.number().int().min(1).max(16),
  language: z.enum(["grid", "shapes"]).optional(),
  rampPairs: z.array(z.object({ low: z.number().int(), high: z.number().int() })).max(16).optional(),
  bridgePair: z.object({ ground: z.number().int(), water: z.number().int() }).optional(),
  previous: z.object({
    plan: z.record(z.string(), z.unknown()) as unknown as z.ZodType<MapPlan>,
    findings: z.array(z.string().max(500)).max(200),
    image: Image.optional(),
  }).optional(),
}).strict() as unknown as z.ZodType<MapPlanInput, z.ZodTypeDef, unknown>;

export const MAP_PLAN_SYSTEM = `You design StarCraft: Brood War maps for a map editor. The editor asks you for a *plan* — a layout in a small language, taught in the block after this one — and renders it itself with the game's real tiles, cliffs and shores, so you never place tiles. Answer with one JSON object in the schema you were given, nothing else.

## How good melee maps are built

- **Mains** sit in corners or on edges, on high ground (height 2) with exactly one ramp down. The ramp should be narrow (one cell) and lead to the natural.
- **Naturals** are one height lower, just outside the main's ramp, with a choke — a passage 2–3 cells wide — between them and the rest of the map. The natural's minerals go against the map edge or the main's cliff.
- **Thirds and expansions** are spread so that each player has a nearer one and a contested one; the centre is open ground with some cover (doodads, small ponds) but wide paths (3 or more cells) so armies can move.
- Every walkable area must connect by ground to every other, except deliberate islands. Cliffs need ramps; list one for every crossing. Water and unwalkable ground make walls.
- Heights change by one level at a time. A base area is flat and buildable, with 2 cells of room around each hall.
- Symmetry: the grid is a whole and must be symmetric under the mode; the base and ramp lists hold only the canonical set (one main, its natural, and so on), and the editor mirrors them. For rot180, cell (c, r) mirrors to (columns−1−c, rows−1−r); for mirror-x, (columns−1−c, r); for mirror-y, (c, rows−1−r); rot90, quad and octo need a square map; diag and antidiag swap the axes.
- Rushes: main-to-main ground distance should be long (a third of the map's perimeter or more); air distance is what it is.
- Keep the picture readable: two or three ground terrains plus water; no single-cell speckles of a different height.

## For a scenario (UMS) prompt

Follow the prompt's story instead of the melee rules: bases are optional, locations name the places the triggers will use, units set the scene. Still keep heights stepped and areas reachable unless the prompt wants otherwise.

## Output

The JSON object in the schema you were given, with the map's name and description. Do not explain outside the JSON.`;

/** The grid language's block, with what its output must respect. */
const GRID_BLOCK = `${LAYOUT_LANGUAGE}

Use the exact cellSize, columns and rows you were given.`;

export const mapPlanRecipe: Recipe<"map-plan"> = {
  name: "map-plan",
  kind: "json",
  input: MapPlanInputSchema,
  system: MAP_PLAN_SYSTEM,
  build(input) {
    const shapes = input.language === "shapes";
    const columns = Math.ceil(input.width / input.cellSize);
    const rows = Math.ceil(input.height / input.cellSize);
    const symmetry = input.symmetry === "auto" ? autoSymmetry(input.players, input.width, input.height) : input.symmetry;
    const head = [
      `Map: ${input.width} × ${input.height} tiles, tileset ${input.tileset}, ${input.players} player${input.players === 1 ? "" : "s"}.`,
      ...(shapes
        ? [rampPairsText(input.rampPairs ?? [], input.terrains, input.bridgePair)]
        : [`Grid: cellSize ${input.cellSize}, columns ${columns}, rows ${rows}.`, `Symmetry: ${symmetry}${input.symmetry === "auto" ? " (chosen from the player count; you may pick another that fits the map's shape)" : ""}.`]),
      "",
      vocabText(input.terrains, input.doodadCategories, input.unitNames),
      "",
      "## The request",
      input.prompt,
    ];
    const content: Extract<BetaMessageParam["content"], unknown[]> = [{ type: "text", text: head.join("\n") }];
    if (input.previous) {
      content.push({ type: "text", text: `## Refinement\n\nThis is a second round. Your previous plan was:\n\n${planText(input.previous.plan)}\n\nRendering it, the editor found:\n${input.previous.findings.length ? input.previous.findings.map((f) => `- ${f}`).join("\n") : "- nothing wrong"}\n\nRevise the plan to address the findings and the request. Answer with the complete revised plan.` });
      if (input.previous.image) content.push({ type: "image", source: { type: "base64", media_type: input.previous.image.mediaType, data: input.previous.image.data } }, { type: "text", text: "That picture is the previous plan as rendered; north is up." });
    }
    // The language is a system block of its own: the shared part caches the same for both.
    // The shape language answers as plain JSON: the API's grammar compiler refuses its
    // schema in every form tried (one object with optional keys, one variant per op —
    // `POST /v1/admin/schema-probe` says so), and the prose plus `normalizeShapes` carry
    // the format on their own. The grid schema compiles and stays.
    return { messages: [{ role: "user", content }], ...(shapes ? {} : { outputSchema: layoutSchema(true) }), systemExtra: [shapes ? SHAPE_LANGUAGE : GRID_BLOCK] };
  },
  parse(result, input) {
    const raw = parseJson(result.text) as Record<string, unknown>;
    if (input.language === "shapes") {
      const { plan, warnings } = normalizeShapes(raw, { width: input.width, height: input.height, terrains: input.terrains, doodadCategories: input.doodadCategories, unitNames: input.unitNames, rampPairs: input.rampPairs ?? [], bridgePair: input.bridgePair });
      return {
        ...plan,
        name: String(raw.name ?? "").trim().slice(0, 40) || "Untitled Scenario",
        description: String(raw.description ?? "").trim().slice(0, 1000),
        symmetry: "none",
        notes: [...plan.notes, ...warnings.map((w) => `Note: ${w}.`)],
      };
    }
    const columns = Math.ceil(input.width / input.cellSize);
    const rows = Math.ceil(input.height / input.cellSize);
    const { plan, warnings } = normalizeLayout(raw, {
      cellSize: input.cellSize, columns, rows, width: input.width, height: input.height,
      terrains: input.terrains, doodadCategories: input.doodadCategories, unitNames: input.unitNames,
    });
    const fallback = input.symmetry === "auto" ? autoSymmetry(input.players, input.width, input.height) : input.symmetry;
    const out: MapPlan = {
      ...plan,
      name: String(raw.name ?? "").trim().slice(0, 40) || "Untitled Scenario",
      description: String(raw.description ?? "").trim().slice(0, 1000),
      symmetry: symmetryOf(typeof raw.symmetry === "string" ? raw.symmetry : undefined, fallback),
      notes: [...plan.notes, ...warnings.map((w) => `Note: ${w}.`)],
    };
    return out;
  },
};
