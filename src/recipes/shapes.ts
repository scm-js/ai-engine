/**
 * The shape language: what `map-plan` asks for when the plugin says `language:
 * "shapes"`. Instead of a grid of cells the model writes statements — ground, rects
 * with isometric corners, diamonds, ellipses, polygons, strokes, borders, plateaus
 * with ramps, lanes — in map tiles, which the plugin compiles and lays with the
 * game's brush. A plan is twenty statements rather than a thousand characters, so the
 * model's thinking is about the layout and not about drawing it, and the compiler
 * promises what a grid could not: a lane is continuous, and a plateau that asks for a
 * ramp gets an edge a ramp fits on.
 *
 * This file holds the prompt that teaches the language, the JSON Schema the model
 * answers in, and the normalisation of an answer — terrain ids the tileset has,
 * coordinates on the map, fields each op needs.
 */
import { z } from "zod";
import type { BridgePair, DoodadPlan, LayoutPlan, RampPair, Shape, TerrainVocab } from "../protocol.js";
import { DIRECTIONS, BASE_KINDS, HALL_H, HALL_W, LocationRect } from "./plan.js";
import { RecipeOutputError, S, clampInt } from "./types.js";

export const SHAPE_OPS = ["ground", "rect", "diamond", "ellipse", "polygon", "stroke", "border", "plateau", "lane", "ramp", "bridge"] as const;
export const RAMP_SIDES = ["sw", "se"] as const;

export const SHAPE_LANGUAGE = `## The shape language

You describe the terrain as a list of **shapes**, painted in order — a later shape covers an earlier one. Every coordinate is a map tile: x from 0 (west) to width−1, y from 0 (north) to height−1. Every shape names a \`terrain\` id from the vocabulary (except \`ramp\`).

- \`ground\` — \`terrain\`: the whole map. Always first.
- \`rect\` — \`x\`, \`y\` (top-left), \`w\`, \`h\`, optional \`cut\`: a rectangle with its corners cut on the diagonal (\`cut\` rows; 2 when omitted), which is how ground looks in this game.
- \`diamond\` — \`cx\`, \`cy\`, \`rx\`, \`ry\`: the isometric diamond |dx|/rx + |dy|/ry ≤ 1. Islands, pools, hills.
- \`ellipse\` — \`cx\`, \`cy\`, \`rx\`, \`ry\`.
- \`polygon\` — \`points\`: [[x, y], …], three or more.
- \`stroke\` — \`points\`, \`width\`: a band of that width along the polyline. Rivers, roads, walls of water. A river's bridges go on the stroke as \`bridges\`: [[x, y], …] — the editor bends the river onto the 2:1 diagonal a bridge spans through each site, narrows it to the channel its bridges fit, paints their banks and fits the bridge, so the water reaches the bridge from both sides. Optional \`bank\` (a terrain id) and \`bankWidth\` paint a band either side of the water, bent with it.
- \`border\` — \`width\`: a band around the map's edge.
- \`plateau\` — like \`rect\`, plus \`ramps\`: which of its lower corners get a ramp down, \`"sw"\` (the south-west corner) and/or \`"se"\`. The editor cuts that corner into a long diagonal edge, paints the ground the tileset has ramps for either side of it, and fits the ramp. **Ramps go down toward the south-west or the south-east and nowhere else** — the game has no other ramps — so a plateau's way out is always on its southern corners; leave low ground there that leads where the path should go.
- \`lane\` — \`points\`, \`width\`, optional \`wall\` (a terrain id) and \`wallWidth\`: a walkable band along the polyline with a band of \`wall\` either side. The band is continuous by construction: a lane from a spawn to a goal is a path the units will walk.
- \`ramp\` — \`x\`, \`y\`, \`side\` (\`"sw"\` or \`"se"\`): a ramp on a cliff you drew some other way, near that tile; the cliff there must run diagonally and face south.
- \`bridge\` — \`x\`, \`y\`, \`along\` (\`"se"\`: the water runs down-right, \`"sw"\`: down-left): a bridge stamped over whatever is there — a channel of the bridge's water along that 2:1 diagonal, about thirty tiles long, with eight tiles of the bridge's ground either side — then the bridge. A river drawn separately must be brought to both ends of that channel as water, or it stops at the stamp's banks; prefer a \`stroke\` with \`bridges\`, which does the joining itself. Bridges span only such a channel: no wider water, no straight north-south or east-west water.

Heights: terrains have a height 0, 1 or 2 and the editor draws a cliff wherever two heights meet. Ground of the same height meets without a cliff, whatever the terrain — a patch of Dirt in Jungle is just a patch. Water is impassable and is the wall to use where a cliff is not wanted. Keep any shape at least 4 tiles across; the brush works in two-tile diamonds and rounds smaller things away. Only certain terrain pairs have ramps (they are listed with the request); a plateau of another terrain still gets its ramp, because the editor paints that pair around the ramp.

Symmetry: write every base and every corner yourself — the plugin mirrors nothing under this language.

The lists after the shapes — \`bases\`, \`ramps\`, \`doodads\`, \`units\`, \`locations\`, \`notes\` — are as in the grid language, except \`doodads\` name \`terrains\` (ids) instead of legend characters, and \`ramps\` is usually empty (plateaus and \`ramp\` shapes carry them).

### A miniature example (64 × 64, two players)

\`\`\`json
{
  "shapes": [
    { "op": "ground", "terrain": 2 },
    { "op": "border", "terrain": 1, "width": 2 },
    { "op": "plateau", "terrain": 4, "x": 4, "y": 4, "w": 24, "h": 18, "ramps": ["se"] },
    { "op": "plateau", "terrain": 4, "x": 36, "y": 4, "w": 24, "h": 18, "ramps": ["sw"] },
    { "op": "diamond", "terrain": 1, "cx": 32, "cy": 40, "rx": 10, "ry": 5 },
    { "op": "stroke", "terrain": 2, "points": [[16, 24], [32, 30], [48, 24]], "width": 6 }
  ],
  "bases": [
    { "kind": "main", "x": 12, "y": 10, "mineralDirection": "w", "minerals": 8, "geysers": 1, "player": 1 },
    { "kind": "main", "x": 44, "y": 10, "mineralDirection": "e", "minerals": 8, "geysers": 1, "player": 2 }
  ],
  "ramps": [], "doodads": [ { "category": "Trees", "terrains": [2], "density": 0.12 } ], "units": [],
  "locations": [ { "name": "Arena", "x0": 22, "y0": 34, "x1": 42, "y1": 46 } ],
  "notes": [ "Two plateaus in the north, each with one ramp facing the middle; a pool splits the south." ]
}
\`\`\``;

/**
 * One closed object per op, with only the fields that op uses. A single object with
 * eighteen optional keys is what the API's grammar compiler refuses ("the compiled
 * grammar is too large"): every subset in every order has to be admitted. Per-op
 * variants keep each object to its required keys and at most three optional ones.
 */
const T = S.int("terrain id");
const XY = { x: S.int("tile"), y: S.int() };
const variant = (ops: readonly string[], fields: Record<string, unknown>, optional: string[] = []) =>
  S.obj({ op: S.enumOf(ops), ...fields }, ["op", ...Object.keys(fields).filter((k) => !optional.includes(k))]);
const shape = {
  anyOf: [
    variant(["ground"], { terrain: T }),
    variant(["rect"], { terrain: T, ...XY, w: S.int(), h: S.int(), cut: S.int("corner cut in rows") }, ["cut"]),
    variant(["plateau"], { terrain: T, ...XY, w: S.int(), h: S.int(), ramps: S.arr(S.enumOf(RAMP_SIDES), "lower corners that get a ramp down"), cut: S.int("corner cut in rows") }, ["cut"]),
    variant(["diamond", "ellipse"], { terrain: T, cx: S.int(), cy: S.int(), rx: S.int(), ry: S.int() }),
    variant(["polygon"], { terrain: T, points: S.arr(S.arr(S.int()), "[[x, y], …], three or more") }),
    variant(["stroke"], { terrain: T, points: S.arr(S.arr(S.int()), "[[x, y], …]"), width: S.int(), bridges: S.arr(S.arr(S.int()), "the bridge sites [x, y] the river bends through"), bank: S.int("a terrain painted either side of the water"), bankWidth: S.int("the bank's width each side, 7 when omitted") }, ["bridges", "bank", "bankWidth"]),
    variant(["lane"], { terrain: T, points: S.arr(S.arr(S.int()), "[[x, y], …]"), width: S.int(), wall: S.int("a terrain either side of the lane"), wallWidth: S.int() }, ["wall", "wallWidth"]),
    variant(["border"], { terrain: T, width: S.int() }),
    variant(["ramp"], { ...XY, side: S.enumOf(RAMP_SIDES, "the way down") }),
    variant(["bridge"], { ...XY, along: S.enumOf(RAMP_SIDES, "the way the water runs") }),
  ],
};

export function shapeSchema(withMap: boolean): Record<string, unknown> {
  const base = S.obj({
    kind: S.enumOf(BASE_KINDS), x: S.int("tile of the hall's top-left corner"), y: S.int(), mineralDirection: S.enumOf(DIRECTIONS),
    minerals: S.int("patches"), geysers: S.int(), player: S.int("1-based for a main; 0 otherwise"),
  });
  return S.obj({
    ...(withMap ? { name: S.str("the map's name, at most 40 characters"), description: S.str("two sentences") } : {}),
    shapes: S.arr(shape, "painted in order"),
    bases: S.arr(base),
    ramps: S.arr(S.obj({ x: S.int(), y: S.int(), direction: S.enumOf(RAMP_SIDES, "the way down") })),
    doodads: S.arr(S.obj({ category: S.str(), terrains: S.arr(S.int(), "terrain ids to decorate"), density: S.num("0 to 1") })),
    units: S.arr(S.obj({ unit: S.str("StarEdit name"), player: S.int("1-based; 12 is neutral"), x: S.int(), y: S.int(), amount: S.int("resources; 0 otherwise") })),
    locations: S.arr(S.obj({ name: S.str(), x0: S.int(), y0: S.int(), x1: S.int(), y1: S.int() })),
    notes: S.arr(S.str()),
  });
}

const RawShape = z.object({
  op: z.string(),
  terrain: z.number().optional(), x: z.number().optional(), y: z.number().optional(), w: z.number().optional(), h: z.number().optional(),
  cx: z.number().optional(), cy: z.number().optional(), rx: z.number().optional(), ry: z.number().optional(),
  points: z.array(z.array(z.number())).optional(), width: z.number().optional(), cut: z.number().optional(),
  ramps: z.array(z.string()).optional(), side: z.string().optional(), along: z.string().optional(), wall: z.number().optional(), wallWidth: z.number().optional(),
  bridges: z.array(z.array(z.number())).optional(), bank: z.number().optional(), bankWidth: z.number().optional(),
});
const RawShapes = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  shapes: z.array(RawShape),
  bases: z.array(z.object({ kind: z.string(), x: z.number(), y: z.number(), mineralDirection: z.string(), minerals: z.number(), geysers: z.number(), player: z.number().optional() })).default([]),
  ramps: z.array(z.object({ x: z.number(), y: z.number(), direction: z.string() })).default([]),
  doodads: z.array(z.object({ category: z.string(), terrains: z.array(z.number()).default([]), density: z.number() })).default([]),
  units: z.array(z.object({ unit: z.string(), player: z.number(), x: z.number(), y: z.number(), amount: z.number().optional() })).default([]),
  locations: z.array(LocationRect).default([]),
  notes: z.array(z.string()).default([]),
});

export interface ShapeContext {
  width: number;
  height: number;
  terrains: TerrainVocab[];
  doodadCategories: string[];
  unitNames: string[];
  rampPairs: RampPair[];
  bridgePair?: BridgePair;
}

export interface NormalizedShapes {
  plan: LayoutPlan & { shapes: Shape[] };
  repairs: string[];
  warnings: string[];
}

/** Validate and repair a shape answer: ops the compiler knows, terrains the tileset has, fields each op needs, coordinates on the map. */
export function normalizeShapes(value: unknown, ctx: ShapeContext): NormalizedShapes {
  const parsed = RawShapes.safeParse(value);
  if (!parsed.success) throw new RecipeOutputError(parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  const raw = parsed.data;
  const problems: string[] = [];
  const repairs: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(ctx.terrains.map((t) => [t.id, t]));
  const maxX = ctx.width - 1, maxY = ctx.height - 1;
  const cx = (v: number) => clampInt(v, 0, maxX, 0), cy = (v: number) => clampInt(v, 0, maxY, 0);

  const shapes: Shape[] = [];
  raw.shapes.forEach((s, i) => {
    const what = `shape ${i + 1} (${s.op})`;
    if (!(SHAPE_OPS as readonly string[]).includes(s.op)) { problems.push(`${what}: not an op of the language (${SHAPE_OPS.join(", ")})`); return; }
    const op = s.op as Shape["op"];
    const out: Shape = { op };
    if (op !== "ramp" && op !== "bridge") {
      if (typeof s.terrain !== "number" || !byId.has(s.terrain)) { problems.push(`${what}: terrain ${s.terrain} is not in the vocabulary`); return; }
      out.terrain = s.terrain;
    }
    const pts = (s.points ?? []).filter((p) => p.length >= 2).map((p) => [cx(p[0]!), cy(p[1]!)] as [number, number]);
    switch (op) {
      case "ground": break;
      case "rect":
      case "plateau": {
        if ([s.x, s.y, s.w, s.h].some((v) => typeof v !== "number") || s.w! <= 0 || s.h! <= 0) { problems.push(`${what}: needs x, y, w, h`); return; }
        out.x = cx(s.x!); out.y = cy(s.y!);
        out.w = clampInt(s.w!, 1, ctx.width - out.x, 1); out.h = clampInt(s.h!, 1, ctx.height - out.y, 1);
        if (s.cut) out.cut = clampInt(s.cut, 0, 32, 0);
        if (op === "plateau") {
          const sides = [...new Set((s.ramps ?? []).filter((r): r is "sw" | "se" => r === "sw" || r === "se"))];
          out.ramps = sides;
          if (out.w < 16 || out.h < 12) if (sides.length) warnings.push(`${what} is small for a plateau with a ramp (${out.w}×${out.h}); the ramp needs a corner of 7 rows`);
          const h = byId.get(out.terrain!)!.height;
          if (sides.length && h === 0) problems.push(`${what}: a plateau with ramps must be high ground (height 1 or 2), and ${byId.get(out.terrain!)!.name} is height 0`);
          if (sides.length && ctx.rampPairs.length && !ctx.rampPairs.some((p) => byId.get(p.high)?.height === h)) problems.push(`${what}: this tileset has no ramp for height ${h} ground; use ${[...new Set(ctx.rampPairs.map((p) => byId.get(p.high)?.name))].join(" or ")}`);
        }
        break;
      }
      case "diamond":
      case "ellipse": {
        if ([s.cx, s.cy, s.rx, s.ry].some((v) => typeof v !== "number") || s.rx! <= 0 || s.ry! <= 0) { problems.push(`${what}: needs cx, cy, rx, ry`); return; }
        out.cx = cx(s.cx!); out.cy = cy(s.cy!); out.rx = clampInt(s.rx!, 1, ctx.width, 1); out.ry = clampInt(s.ry!, 1, ctx.height, 1);
        break;
      }
      case "polygon": {
        if (pts.length < 3) { problems.push(`${what}: needs three or more points`); return; }
        out.points = pts;
        break;
      }
      case "stroke":
      case "lane": {
        if (pts.length < 2) { problems.push(`${what}: needs two or more points`); return; }
        out.points = pts;
        out.width = clampInt(s.width ?? 4, 1, 64, 4);
        if (op === "lane" && s.wall) {
          if (!byId.has(s.wall)) { repairs.push(`${what}: wall terrain ${s.wall} is not in the vocabulary; laid without walls`); }
          else { out.wall = s.wall; if (s.wallWidth) out.wallWidth = clampInt(s.wallWidth, 1, 32, 3); }
        }
        if (op === "stroke" && s.bridges?.length) {
          if (!ctx.bridgePair) repairs.push(`${what}: this tileset has no bridges; the river is laid without them — leave a gap of ground for a crossing`);
          else out.bridges = s.bridges.filter((p) => p.length >= 2).map((p) => [cx(p[0]!), cy(p[1]!)] as [number, number]);
        }
        if (op === "stroke" && typeof s.bank === "number") {
          if (!byId.has(s.bank)) repairs.push(`${what}: bank terrain ${s.bank} is not in the vocabulary; laid without a bank`);
          else { out.bank = s.bank; if (s.bankWidth) out.bankWidth = clampInt(s.bankWidth, 1, 32, 7); }
        }
        break;
      }
      case "border": {
        out.width = clampInt(s.width ?? 2, 1, 32, 2);
        break;
      }
      case "ramp": {
        if (typeof s.x !== "number" || typeof s.y !== "number") { problems.push(`${what}: needs x, y`); return; }
        out.x = cx(s.x); out.y = cy(s.y);
        out.side = s.side === "se" ? "se" : "sw";
        if (s.side !== "sw" && s.side !== "se") repairs.push(`${what}: side ${JSON.stringify(s.side ?? "")} is not sw or se; taken as sw`);
        break;
      }
      case "bridge": {
        if (typeof s.x !== "number" || typeof s.y !== "number") { problems.push(`${what}: needs x, y`); return; }
        if (!ctx.bridgePair) { problems.push(`${what}: this tileset has no bridges; use a ramp, a ford of ground, or leave the water whole`); return; }
        out.x = cx(s.x); out.y = cy(s.y);
        out.along = s.along === "sw" ? "sw" : "se";
        if (s.along !== "sw" && s.along !== "se") repairs.push(`${what}: along ${JSON.stringify(s.along ?? "")} is not se or sw; taken as se`);
        break;
      }
    }
    shapes.push(out);
  });
  if (shapes.length === 0) problems.push("no shapes");
  else if (shapes[0]!.op !== "ground") warnings.push("the first shape is not `ground`; tiles no shape covers are left as they are");

  const bases = raw.bases.flatMap((b) => {
    if (!(BASE_KINDS as readonly string[]).includes(b.kind)) { problems.push(`base kind ${JSON.stringify(b.kind)} is not one of ${BASE_KINDS.join(", ")}`); return []; }
    if (!DIRECTIONS.includes(b.mineralDirection as never)) { problems.push(`mineral direction ${JSON.stringify(b.mineralDirection)} is not one of ${DIRECTIONS.join(", ")}`); return []; }
    const kind = b.kind as LayoutPlan["bases"][number]["kind"];
    const player = kind === "main" ? clampInt(b.player ?? 0, 0, 8, 0) : 0;
    const base: LayoutPlan["bases"][number] = { kind, x: clampInt(b.x, 0, maxX - HALL_W + 1, 0), y: clampInt(b.y, 0, maxY - HALL_H + 1, 0), mineralDirection: b.mineralDirection as never, minerals: clampInt(b.minerals, 0, 16, 8), geysers: clampInt(b.geysers, 0, 4, 1) };
    if (player > 0) base.player = player;
    return [base];
  });
  const ramps = raw.ramps.flatMap((r) => {
    if (r.direction !== "sw" && r.direction !== "se") { repairs.push(`ramp at (${r.x}, ${r.y}) goes ${JSON.stringify(r.direction)}; ramps go sw or se, so it was dropped`); return []; }
    return [{ x: cx(r.x), y: cy(r.y), direction: r.direction as "sw" | "se" }];
  });
  const categories = new Map(ctx.doodadCategories.map((c) => [c.toLowerCase(), c]));
  const doodads: DoodadPlan[] = raw.doodads.flatMap((d) => {
    const category = categories.get(d.category.trim().toLowerCase());
    if (!category) { repairs.push(`doodad category ${JSON.stringify(d.category)} is not in the tileset and was dropped`); return []; }
    const terrains = [...new Set(d.terrains.filter((id) => byId.has(id)))];
    if (!terrains.length) { repairs.push(`doodads in ${category} named no terrain of the tileset and were dropped`); return []; }
    const density = Math.max(0, Math.min(1, Number.isFinite(d.density) ? d.density : 0));
    return density > 0 ? [{ category, on: "", terrains, density }] : [];
  });
  const unitByName = new Map(ctx.unitNames.map((n) => [n.toLowerCase(), n]));
  const units = raw.units.flatMap((u) => {
    const unit = unitByName.get(u.unit.trim().toLowerCase());
    if (!unit) { repairs.push(`unit ${JSON.stringify(u.unit)} is not a unit name the editor knows and was dropped`); return []; }
    const out: LayoutPlan["units"][number] = { unit, player: clampInt(u.player, 1, 12, 12), x: cx(u.x), y: cy(u.y) };
    if (u.amount && u.amount > 0) out.amount = Math.round(u.amount);
    return [out];
  });
  const locations = raw.locations.flatMap((l) => {
    const x0 = clampInt(Math.min(l.x0, l.x1), 0, ctx.width, 0), x1 = clampInt(Math.max(l.x0, l.x1), 0, ctx.width, 0);
    const y0 = clampInt(Math.min(l.y0, l.y1), 0, ctx.height, 0), y1 = clampInt(Math.max(l.y0, l.y1), 0, ctx.height, 0);
    if (x1 <= x0 || y1 <= y0) { repairs.push(`location ${JSON.stringify(l.name)} has no area and was dropped`); return []; }
    return [{ name: l.name.trim().slice(0, 64) || "Location", x0, y0, x1, y1 }];
  });
  if (problems.length) throw new RecipeOutputError(problems);

  return {
    plan: {
      cellSize: 1, columns: ctx.width, rows: ctx.height, legend: {}, grid: [],
      shapes, bases, ramps, doodads, units, locations,
      notes: [...raw.notes.map((n) => n.trim()).filter(Boolean), ...repairs.map((r) => `Repaired: ${r}.`)],
    },
    repairs,
    warnings,
  };
}

/** The ramp pairs and the bridge pair as lines for the prompt. */
export function rampPairsText(pairs: RampPair[], terrains: TerrainVocab[], bridge?: BridgePair): string {
  const name = (id: number) => terrains.find((t) => t.id === id)?.name ?? String(id);
  const ramps = pairs.length
    ? `## Ramps: this tileset has ramps between ${pairs.map((p) => `${name(p.low)} (${p.low}) and ${name(p.high)} (${p.high})`).join("; ")}. A plateau of other ground at the same height still gets one: the editor paints that pair around the ramp.`
    : "## Ramps: this tileset's ramp pairs are not known; plateaus may get no ramp.";
  const bridges = bridge ? `## Bridges: this tileset has bridges, standing on ${name(bridge.ground)} (${bridge.ground}) over ${name(bridge.water)} (${bridge.water}).` : "## Bridges: this tileset has none; cross water with ground, not bridges.";
  return `${ramps}\n${bridges}`;
}
