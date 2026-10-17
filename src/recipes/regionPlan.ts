/**
 * region-plan: redo one area of an existing map in the layout language. The model sees
 * the area and a margin around it as it is now, so what it draws meets the edges.
 */
import { z } from "zod";
import type { BetaMessageParam } from "../claude.js";
import type { RegionPlanInput } from "../protocol.js";
import { LAYOUT_LANGUAGE, layoutSchema, normalizeLayout, vocabText } from "./plan.js";
import { parseJson, type Recipe } from "./types.js";

const TerrainVocab = z.object({ id: z.number().int(), name: z.string().min(1).max(64), height: z.union([z.literal(0), z.literal(1), z.literal(2)]), buildable: z.boolean() });
const Image = z.object({ mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().min(1) });

export const RegionPlanInputSchema = z.object({
  prompt: z.string().min(1).max(4000),
  width: z.number().int().min(16).max(256),
  height: z.number().int().min(16).max(256),
  tileset: z.string().min(1).max(32),
  terrains: z.array(TerrainVocab).min(1).max(64),
  doodadCategories: z.array(z.string().max(64)).max(64),
  unitNames: z.array(z.string().max(64)).max(300),
  rect: z.object({ x0: z.number().int().min(0), y0: z.number().int().min(0), x1: z.number().int().min(1), y1: z.number().int().min(1) }),
  cellSize: z.number().int().min(1).max(16),
  current: z.object({
    legend: z.record(z.string(), z.number().int()),
    grid: z.array(z.string()).min(1).max(256),
    originX: z.number().int(),
    originY: z.number().int(),
  }),
  image: Image.optional(),
}).strict().refine((v) => v.rect.x1 > v.rect.x0 && v.rect.y1 > v.rect.y0 && v.rect.x1 <= v.width && v.rect.y1 <= v.height, "rect must lie inside the map") as unknown as z.ZodType<RegionPlanInput, z.ZodTypeDef, unknown>;

export const REGION_PLAN_SYSTEM = `You redesign one area of a StarCraft: Brood War map for a map editor. The editor sends the area (and a margin around it) as it is now, in a small layout language, and asks for a new layout of the area in the same language; it renders the result itself with the game's real tiles, so you never place tiles. Answer with one JSON object in the schema you were given, nothing else.

${LAYOUT_LANGUAGE}

## Editing an area

- Your grid covers **only the area**: \`columns\` × \`rows\` cells starting at the area's top-left tile (the origin you are given). The current picture you receive is larger — it includes a margin — and its own origin is given, so you can see what borders the area.
- Match the edges: a cell on the area's border should step at most one height from the neighbouring cell outside it, and paths that enter the area should continue.
- Coordinates of bases, ramps, units and locations are map tiles as always; keep them inside the area.
- Keep what the request does not ask you to change. If the request is "make this a lake", the surroundings stay; if it is "add an expansion here", the ground around the base stays walkable.
- Bases here are usually expansions (player 0). List a main only when asked for a start location.`;

export const regionPlanRecipe: Recipe<"region-plan"> = {
  name: "region-plan",
  kind: "json",
  input: RegionPlanInputSchema,
  system: REGION_PLAN_SYSTEM,
  build(input) {
    const w = input.rect.x1 - input.rect.x0, h = input.rect.y1 - input.rect.y0;
    const columns = Math.ceil(w / input.cellSize), rows = Math.ceil(h / input.cellSize);
    const legend = Object.entries(input.current.legend).map(([c, id]) => `${c} = ${id} (${input.terrains.find((t) => t.id === id)?.name ?? "?"})`).join(", ");
    const head = [
      `Map: ${input.width} × ${input.height} tiles, tileset ${input.tileset}.`,
      `Area: tiles x ${input.rect.x0}…${input.rect.x1 - 1}, y ${input.rect.y0}…${input.rect.y1 - 1} (${w} × ${h}). Grid: cellSize ${input.cellSize}, columns ${columns}, rows ${rows}, origin (${input.rect.x0}, ${input.rect.y0}).`,
      "",
      vocabText(input.terrains, input.doodadCategories, input.unitNames),
      "",
      `## The area now, with its margin (origin (${input.current.originX}, ${input.current.originY}), same cell size; legend: ${legend})`,
      "```",
      ...input.current.grid,
      "```",
      "",
      "## The request",
      input.prompt,
    ];
    const content: Extract<BetaMessageParam["content"], unknown[]> = [{ type: "text", text: head.join("\n") }];
    if (input.image) content.push({ type: "image", source: { type: "base64", media_type: input.image.mediaType, data: input.image.data } }, { type: "text", text: "That picture is the area with its margin as rendered; north is up." });
    return { messages: [{ role: "user", content }], outputSchema: layoutSchema(false) };
  },
  parse(result, input) {
    const raw = parseJson(result.text);
    const w = input.rect.x1 - input.rect.x0, h = input.rect.y1 - input.rect.y0;
    const { plan, warnings } = normalizeLayout(raw, {
      cellSize: input.cellSize, columns: Math.ceil(w / input.cellSize), rows: Math.ceil(h / input.cellSize),
      width: input.width, height: input.height, originX: input.rect.x0, originY: input.rect.y0,
      terrains: input.terrains, doodadCategories: input.doodadCategories, unitNames: input.unitNames,
    });
    return { ...plan, notes: [...plan.notes, ...warnings.map((x) => `Note: ${x}.`)] };
  },
};
