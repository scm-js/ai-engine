/**
 * The layout language shared by `map-plan` and `region-plan`: a coarse grid of cells
 * written as rows of characters, a legend from character to terrain id, and lists of
 * bases, ramps, doodads, units and locations in map tiles. This file holds the part of
 * the prompt that teaches it, the JSON Schema the model answers in, and the
 * normalisation that turns an answer into a `LayoutPlan` the plugin can render —
 * repairing what can be repaired (a short row, a stray coordinate) and refusing what
 * cannot (an unknown legend character, a terrain id the tileset does not have).
 */
import { z } from "zod";
import type { BasePlan, Direction, LayoutPlan, SymmetryMode, TerrainVocab } from "../protocol.js";
import { SYMMETRY_MODES } from "../protocol.js";
import { RecipeOutputError, S, clampInt } from "./types.js";

export const DIRECTIONS: readonly Direction[] = ["n", "ne", "e", "se", "s", "sw", "w", "nw"];
export const BASE_KINDS = ["main", "natural", "third", "expansion", "island"] as const;

/** Tile footprints the plugin lays a base with (hall, mineral line of eight, geyser). */
export const HALL_W = 4, HALL_H = 3;

export const LAYOUT_LANGUAGE = `## The layout language

You describe terrain as a grid of cells. Every cell is \`cellSize\` × \`cellSize\` map tiles. The grid has \`columns\` cells across and \`rows\` cells down; cell (column c, row r) covers tiles x = c·cellSize … (c+1)·cellSize−1 and y = r·cellSize … (r+1)·cellSize−1. Row 0 is the top (north) of the map, column 0 the left (west).

- \`legend\` maps one character to one terrain id from the vocabulary. Use letters and digits; never a space. Pick memorable characters (\`W\` for water, \`h\` for high ground).
- \`grid\` is \`rows\` strings of exactly \`columns\` characters, top row first. Every character must be in the legend.
- Terrains have a height: 0 (low), 1 (mid) or 2 (high). The editor draws cliffs where heights differ. **Neighbouring cells may differ by at most one level**, so put a band of mid ground between low and high. Water and other unwalkable ground is height 0 and is impassable — use it as a wall, not as a path.
- Buildable terrain is what bases stand on; unbuildable terrain (most decorative ground) is fine for paths and edges.
- Coordinates in the lists below are **map tiles**, not cells: x from 0 to width−1, y from 0 to height−1.

- \`bases\`: each has a \`kind\` (main, natural, third, expansion, island), the tile of the town hall's **top-left corner** (\`x\`, \`y\`; the hall is 4 tiles wide and 3 tall), \`mineralDirection\` — which side of the hall the mineral line lies on, seen from the hall (n, ne, e, se, s, sw, w, nw) — \`minerals\` (patches, usually 7–9) and \`geysers\` (usually 1, sometimes 2). A \`main\` carries \`player\` (1-based) and gets that player's start location; every other kind has \`player\` 0. The mineral line needs about 9 tiles along that side and 3 tiles of depth, all buildable and the same height as the hall, and the base needs 2 free tiles around it. Put the minerals against the map edge or a cliff so the line is behind the hall, away from the way in.
- \`ramps\`: where a path crosses a cliff. \`x\`, \`y\` is the tile at the ramp's centre and \`direction\` the way the ramp goes **down**. A ramp needs the high cell on one side and the lower cell straight across on the other. Every base must be reachable by ground from every other one that is not an island: list a ramp for each cliff a path crosses.
- \`doodads\`: decoration. \`category\` is one from the list you were given, \`on\` is a string of legend characters naming which cells to decorate, \`density\` 0…1 (0.15 is sparse, 0.5 is thick). Do not decorate cells that hold bases or paths heavily.
- \`units\`: extra units by StarEdit name (from the list you were given), 1-based \`player\` (12 is neutral), tile \`x\`, \`y\` of the unit's centre, and \`amount\` for resources (0 otherwise). Start locations and base resources are NOT listed here — bases produce them.
- \`locations\`: named rectangles in tiles: \`name\`, \`x0\`, \`y0\` (the top-left tile) and \`x1\`, \`y1\` (the far edges, exclusive) — \`{ "name": "Goal", "x0": 40, "y0": 60, "x1": 56, "y1": 64 }\`. Only for maps that need them (scenarios); a melee map has none.
- \`notes\`: a few short lines on what you intended, for the person reading the result.

### A miniature example (16 × 16 cells, cellSize 4 → a 64 × 64 map, two players, rot180)

\`\`\`json
{
  "cellSize": 4, "columns": 16, "rows": 16,
  "legend": [ { "char": "W", "terrain": 1 }, { "char": "d", "terrain": 2 }, { "char": "h", "terrain": 4 } ],
  "grid": [
    "WWWWWWWWWWWWWWWW",
    "WhhhhhhddddWWWWW",
    "WhhhhhhddddddWWW",
    "WhhhhhhddddddddW",
    "WhhhhhhddddddddW",
    "WddddddddddddddW",
    "WddddddddddddddW",
    "WddddddWWddddddW",
    "WddddddWWddddddW",
    "WddddddddddddddW",
    "WddddddddddddddW",
    "WddddddddhhhhhhW",
    "WddddddddhhhhhhW",
    "WWWddddddhhhhhhW",
    "WWWWWddddhhhhhhW",
    "WWWWWWWWWWWWWWWW"
  ],
  "bases": [
    { "kind": "main", "x": 8, "y": 6, "mineralDirection": "w", "minerals": 8, "geysers": 1, "player": 1 },
    { "kind": "natural", "x": 10, "y": 24, "mineralDirection": "w", "minerals": 7, "geysers": 1, "player": 0 }
  ],
  "ramps": [ { "x": 26, "y": 14, "direction": "e" } ],
  "doodads": [ { "category": "Trees", "on": "d", "density": 0.12 } ],
  "units": [],
  "locations": [],
  "notes": [ "Player 1 on the high ground top-left, natural below it, one ramp east.", "Water rings the map; a pond blocks the centre." ]
}
\`\`\`

Under a symmetry only the **canonical** set of bases, ramps, units and locations is listed — the editor mirrors them (and numbers the mirrored mains 2, 3, …). The grid itself is written in full and must be symmetric.`;

/** The vocabulary block: what the tileset offers. */
export function vocabText(terrains: TerrainVocab[], doodadCategories: string[], unitNames: string[]): string {
  const lines: string[] = ["## Terrain vocabulary (id: name — height, buildable?)"];
  for (const t of terrains) lines.push(`${t.id}: ${t.name} — height ${t.height}${t.buildable ? ", buildable" : ", not buildable"}`);
  lines.push("", `## Doodad categories: ${doodadCategories.length ? doodadCategories.join(", ") : "(none)"}`);
  lines.push("", `## Unit names: ${unitNames.length ? unitNames.join("; ") : "(none)"}`);
  return lines.join("\n");
}

/* ── The shape the model answers in ─────────────────────── */

export function layoutSchema(withMap: boolean): Record<string, unknown> {
  const base = S.obj({
    kind: S.enumOf(BASE_KINDS),
    x: S.int("tile of the hall's top-left corner"),
    y: S.int(),
    mineralDirection: S.enumOf(DIRECTIONS),
    minerals: S.int("patches"),
    geysers: S.int(),
    player: S.int("1-based for a main; 0 otherwise"),
  });
  const props: Record<string, unknown> = {
    ...(withMap ? { name: S.str("the map's name, at most 40 characters"), description: S.str("two sentences"), symmetry: S.enumOf(SYMMETRY_MODES) } : {}),
    cellSize: S.int(),
    columns: S.int(),
    rows: S.int(),
    legend: S.arr(S.obj({ char: S.str("one character"), terrain: S.int("terrain id") })),
    grid: S.arr(S.str(), "rows strings of columns characters, top row first"),
    bases: S.arr(base),
    ramps: S.arr(S.obj({ x: S.int(), y: S.int(), direction: S.enumOf(DIRECTIONS, "the way down") })),
    doodads: S.arr(S.obj({ category: S.str(), on: S.str("legend characters"), density: S.num("0 to 1") })),
    units: S.arr(S.obj({ unit: S.str("StarEdit name"), player: S.int("1-based; 12 is neutral"), x: S.int(), y: S.int(), amount: S.int("resources; 0 otherwise") })),
    locations: S.arr(S.obj({ name: S.str(), x0: S.int(), y0: S.int(), x1: S.int(), y1: S.int() })),
    notes: S.arr(S.str()),
  };
  return S.obj(props);
}

/** A location as the schema asks for it, or as a model writes it without the schema (x, y, w, h). */
export const LocationRect = z.preprocess(
  (v) => {
    const o = v as { name?: unknown; x?: unknown; y?: unknown; w?: unknown; h?: unknown; x0?: unknown } | null;
    if (!o || typeof o !== "object" || "x0" in o || typeof o.x !== "number" || typeof o.y !== "number" || typeof o.w !== "number" || typeof o.h !== "number") return v;
    return { name: o.name, x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h };
  },
  z.object({ name: z.string(), x0: z.number(), y0: z.number(), x1: z.number(), y1: z.number() }),
);

const RawLayout = z.object({
  name: z.string().optional(),
  description: z.string().optional(),
  symmetry: z.string().optional(),
  cellSize: z.number().optional(),
  columns: z.number().optional(),
  rows: z.number().optional(),
  legend: z.union([z.array(z.object({ char: z.string(), terrain: z.number() })), z.record(z.string(), z.number())]),
  grid: z.array(z.string()),
  bases: z.array(z.object({ kind: z.string(), x: z.number(), y: z.number(), mineralDirection: z.string(), minerals: z.number(), geysers: z.number(), player: z.number().optional() })).default([]),
  ramps: z.array(z.object({ x: z.number(), y: z.number(), direction: z.string() })).default([]),
  doodads: z.array(z.object({ category: z.string(), on: z.string(), density: z.number() })).default([]),
  units: z.array(z.object({ unit: z.string(), player: z.number(), x: z.number(), y: z.number(), amount: z.number().optional() })).default([]),
  locations: z.array(LocationRect).default([]),
  notes: z.array(z.string()).default([]),
});
export type RawLayout = z.infer<typeof RawLayout>;

export interface LayoutContext {
  cellSize: number;
  columns: number;
  rows: number;
  /** Map size in tiles, for clamping coordinates. */
  width: number;
  height: number;
  /** For a region: where the grid's cell (0, 0) sits on the map, in tiles. */
  originX?: number;
  originY?: number;
  terrains: TerrainVocab[];
  doodadCategories: string[];
  unitNames: string[];
}

export interface Normalized {
  plan: LayoutPlan;
  /** What was repaired, appended to the plan's notes. */
  repairs: string[];
  /** Advice for the designer, not errors. */
  warnings: string[];
}

function mostCommon(row: string): string {
  const counts = new Map<string, number>();
  for (const c of row) counts.set(c, (counts.get(c) ?? 0) + 1);
  let best = row[0] ?? "";
  let n = -1;
  for (const [c, k] of counts) if (k > n) { best = c; n = k; }
  return best;
}

/** Validate and repair a raw answer against the request it was for. */
export function normalizeLayout(value: unknown, ctx: LayoutContext): Normalized {
  const parsed = RawLayout.safeParse(value);
  if (!parsed.success) throw new RecipeOutputError(parsed.error.issues.slice(0, 20).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`));
  const raw = parsed.data;
  const problems: string[] = [];
  const repairs: string[] = [];
  const warnings: string[] = [];
  const byId = new Map(ctx.terrains.map((t) => [t.id, t]));

  // Legend.
  const legend: Record<string, number> = {};
  const entries = Array.isArray(raw.legend) ? raw.legend : Object.entries(raw.legend).map(([char, terrain]) => ({ char, terrain }));
  for (const e of entries) {
    if (e.char.length !== 1 || e.char === " ") { problems.push(`legend character ${JSON.stringify(e.char)} must be exactly one non-space character`); continue; }
    if (e.char in legend) { problems.push(`legend character ${e.char} is listed twice`); continue; }
    if (!byId.has(e.terrain)) { problems.push(`legend character ${e.char} names terrain ${e.terrain}, which the tileset does not have`); continue; }
    legend[e.char] = e.terrain;
  }
  if (Object.keys(legend).length === 0) problems.push("the legend is empty");

  // Grid.
  let grid = raw.grid.map((r) => r.replace(/\s+/g, ""));
  if (grid.length !== ctx.rows) {
    if (grid.length > ctx.rows) { grid = grid.slice(0, ctx.rows); repairs.push(`the grid had ${raw.grid.length} rows; the last ${raw.grid.length - ctx.rows} were dropped`); }
    else if (grid.length > 0) { const last = grid[grid.length - 1]!; while (grid.length < ctx.rows) grid.push(last); repairs.push(`the grid had ${raw.grid.length} rows; the last row was repeated to make ${ctx.rows}`); }
    else problems.push("the grid is empty");
  }
  const unknown = new Set<string>();
  let shortRows = 0, longRows = 0;
  grid = grid.map((row) => {
    let r = row;
    if (r.length < ctx.columns) { shortRows++; r = r + mostCommon(r || Object.keys(legend)[0] || "?").repeat(ctx.columns - r.length); }
    else if (r.length > ctx.columns) { longRows++; r = r.slice(0, ctx.columns); }
    for (const c of r) if (!(c in legend)) unknown.add(c);
    return r;
  });
  if (shortRows) repairs.push(`${shortRows} row${shortRows === 1 ? " was" : "s were"} shorter than ${ctx.columns} characters and padded`);
  if (longRows) repairs.push(`${longRows} row${longRows === 1 ? " was" : "s were"} longer than ${ctx.columns} characters and trimmed`);
  if (unknown.size) problems.push(`the grid uses characters that are not in the legend: ${[...unknown].map((c) => JSON.stringify(c)).join(", ")}`);
  if (problems.length) throw new RecipeOutputError(problems);

  // Height steps.
  const heightAt = (c: number, r: number) => byId.get(legend[grid[r]![c]!]!)!.height;
  let jumps = 0;
  for (let r = 0; r < ctx.rows; r++) {
    for (let c = 0; c < ctx.columns; c++) {
      const h = heightAt(c, r);
      if (c + 1 < ctx.columns && Math.abs(heightAt(c + 1, r) - h) > 1) jumps++;
      if (r + 1 < ctx.rows && Math.abs(heightAt(c, r + 1) - h) > 1) jumps++;
    }
  }
  if (jumps) warnings.push(`${jumps} cell border${jumps === 1 ? "" : "s"} jump two height levels; the editor will draw a step of the middle terrain there`);

  const ox = ctx.originX ?? 0, oy = ctx.originY ?? 0;
  const spanW = ctx.columns * ctx.cellSize, spanH = ctx.rows * ctx.cellSize;
  const maxX = Math.min(ctx.width, ox + spanW) - 1, maxY = Math.min(ctx.height, oy + spanH) - 1;
  const inSpan = (x: number, y: number) => x >= ox && x <= maxX && y >= oy && y <= maxY;

  // Bases.
  const bases: BasePlan[] = [];
  let movedBases = 0;
  for (const b of raw.bases) {
    if (!(BASE_KINDS as readonly string[]).includes(b.kind)) { problems.push(`base kind ${JSON.stringify(b.kind)} is not one of ${BASE_KINDS.join(", ")}`); continue; }
    if (!DIRECTIONS.includes(b.mineralDirection as Direction)) { problems.push(`mineral direction ${JSON.stringify(b.mineralDirection)} is not one of ${DIRECTIONS.join(", ")}`); continue; }
    const x = clampInt(b.x, ox, maxX - HALL_W + 1, ox), y = clampInt(b.y, oy, maxY - HALL_H + 1, oy);
    if (x !== Math.round(b.x) || y !== Math.round(b.y)) movedBases++;
    const kind = b.kind as BasePlan["kind"];
    const player = kind === "main" ? clampInt(b.player ?? 0, 0, 8, 0) : 0;
    const base: BasePlan = { kind, x, y, mineralDirection: b.mineralDirection as Direction, minerals: clampInt(b.minerals, 0, 16, 8), geysers: clampInt(b.geysers, 0, 4, 1) };
    if (player > 0) base.player = player;
    else if (kind === "main") warnings.push(`a main at (${x}, ${y}) has no player number; the editor will number it`);
    bases.push(base);
  }
  if (movedBases) repairs.push(`${movedBases} base${movedBases === 1 ? " was" : "s were"} outside the area and moved inside`);

  // Ramps.
  const ramps = raw.ramps.flatMap((r) => {
    if (!DIRECTIONS.includes(r.direction as Direction)) { problems.push(`ramp direction ${JSON.stringify(r.direction)} is not one of ${DIRECTIONS.join(", ")}`); return []; }
    const x = clampInt(r.x, ox, maxX, ox), y = clampInt(r.y, oy, maxY, oy);
    return [{ x, y, direction: r.direction as Direction }];
  });

  // Doodads.
  const categories = new Map(ctx.doodadCategories.map((c) => [c.toLowerCase(), c]));
  const doodads = raw.doodads.flatMap((d) => {
    const category = categories.get(d.category.trim().toLowerCase());
    if (!category) { repairs.push(`doodad category ${JSON.stringify(d.category)} is not in the tileset and was dropped`); return []; }
    const on = [...new Set([...d.on].filter((c) => c in legend))].join("");
    if (!on) { repairs.push(`doodads in ${category} named no legend character and were dropped`); return []; }
    const density = Math.max(0, Math.min(1, Number.isFinite(d.density) ? d.density : 0));
    return density > 0 ? [{ category, on, density }] : [];
  });

  // Units.
  const unitByName = new Map(ctx.unitNames.map((n) => [n.toLowerCase(), n]));
  const units = raw.units.flatMap((u) => {
    const unit = unitByName.get(u.unit.trim().toLowerCase());
    if (!unit) { repairs.push(`unit ${JSON.stringify(u.unit)} is not a unit name the editor knows and was dropped`); return []; }
    if (!inSpan(Math.round(u.x), Math.round(u.y))) { repairs.push(`${unit} at (${u.x}, ${u.y}) is outside the area and was dropped`); return []; }
    const out: LayoutPlan["units"][number] = { unit, player: clampInt(u.player, 1, 12, 12), x: Math.round(u.x), y: Math.round(u.y) };
    if (u.amount && u.amount > 0) out.amount = Math.round(u.amount);
    return [out];
  });

  // Locations.
  const locations = raw.locations.flatMap((l) => {
    const x0 = clampInt(Math.min(l.x0, l.x1), ox, maxX + 1, ox), x1 = clampInt(Math.max(l.x0, l.x1), ox, maxX + 1, ox);
    const y0 = clampInt(Math.min(l.y0, l.y1), oy, maxY + 1, oy), y1 = clampInt(Math.max(l.y0, l.y1), oy, maxY + 1, oy);
    if (x1 <= x0 || y1 <= y0) { repairs.push(`location ${JSON.stringify(l.name)} has no area and was dropped`); return []; }
    return [{ name: l.name.trim().slice(0, 64) || "Location", x0, y0, x1, y1 }];
  });

  if (problems.length) throw new RecipeOutputError(problems);

  const plan: LayoutPlan = {
    cellSize: ctx.cellSize,
    columns: ctx.columns,
    rows: ctx.rows,
    legend,
    grid,
    bases,
    ramps,
    doodads,
    units,
    locations,
    notes: [...raw.notes.map((n) => n.trim()).filter(Boolean), ...repairs.map((r) => `Repaired: ${r}.`)],
  };
  return { plan, repairs, warnings };
}

export function symmetryOf(value: string | undefined, fallback: SymmetryMode): SymmetryMode {
  return value && (SYMMETRY_MODES as readonly string[]).includes(value) ? (value as SymmetryMode) : fallback;
}

/** The symmetry `auto` picks from a player count. */
export function autoSymmetry(players: number, width: number, height: number): SymmetryMode {
  if (players >= 8) return width === height ? "octo" : "quad";
  if (players >= 3) return width === height ? "quad" : "rot180";
  return "rot180";
}

/** Squash a plan back into the text the model reads on a refinement round. */
export function planText(plan: LayoutPlan & Partial<{ name: string; description: string; symmetry: SymmetryMode }>): string {
  const legend = Object.entries(plan.legend).map(([char, terrain]) => ({ char, terrain }));
  return JSON.stringify({ ...plan, legend }, null, 1);
}
