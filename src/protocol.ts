/**
 * What each recipe takes and gives back: the inputs a caller sends and the outputs the
 * recipe's parser hands back. These are the recipe half of the scmjs.dev wire contract;
 * the server's HTTP envelope (requests, responses, stream events, errors, accounts) is
 * built around them and re-exports this module.
 *
 * Nothing here knows about game data. A recipe takes the facts the editor gathered
 * (terrain vocabulary, statistics, a rendered picture, the trigger script's
 * declarations) and returns a *plan* or *text* the editor applies.
 */

/* ── Recipes ────────────────────────────────────────────── */

export type RecipeName =
  /** A whole map from a prompt: terrain layout, bases, name and description. */
  | "map-plan"
  /** A layout for one area of an existing map. */
  | "region-plan"
  /** A TrigScript (TypeScript the editor runs to record triggers) from a description. */
  | "triggers"
  /** Plain-language explanation of triggers given as the editor's text format. */
  | "explain-triggers"
  /** A name and description for the map from its facts. */
  | "describe"
  /** Mission briefing text from the map's facts and triggers. */
  | "briefing"
  /** A critique of the map from a picture and its statistics. */
  | "review"
  /** Rewrite the string table under an instruction (translate, fix spelling, retone). */
  | "strings"
  /** One turn of the assistant: a tool-using conversation about the open map. */
  | "agent"
  /**
   * A scenario's design document from a prompt ("a madness map", "an RPG about …"):
   * genre, premise, players and forces, the systems it runs on, the layout brief for
   * `map-plan`, objectives and briefing. The plugin executes it step by step.
   */
  | "ums-design"
  /** A broadcast cast of a replay: lines for two commentators, timed to clips of the game. */
  | "cast";

export const RECIPE_NAMES: readonly RecipeName[] = [
  "map-plan", "region-plan", "triggers", "explain-triggers", "describe", "briefing", "review", "strings", "agent", "ums-design", "cast",
];

export interface RecipeInputs {
  "map-plan": MapPlanInput;
  "region-plan": RegionPlanInput;
  "triggers": TriggersInput;
  "explain-triggers": ExplainTriggersInput;
  "describe": DescribeInput;
  "briefing": BriefingInput;
  "review": ReviewInput;
  "strings": StringsInput;
  "agent": AgentInput;
  "ums-design": UmsDesignInput;
  "cast": CastInput;
}

export interface RecipeOutputs {
  "map-plan": MapPlan;
  "region-plan": LayoutPlan;
  "triggers": TriggersOutput;
  "explain-triggers": TextOutput;
  "describe": DescribeOutput;
  "briefing": BriefingOutput;
  "review": ReviewOutput;
  "strings": StringsOutput;
  "agent": AgentOutput;
  "ums-design": UmsDesign;
  "cast": CastOutput;
}

/* ── Shared shapes ──────────────────────────────────────── */

/** A terrain the tileset has — `api.terrain.types()` in the editor. */
export interface TerrainVocab {
  id: number;
  name: string;
  height: 0 | 1 | 2;
  buildable: boolean;
}

export type SymmetryMode = "none" | "mirror-x" | "mirror-y" | "rot180" | "rot90" | "diag" | "antidiag" | "quad" | "octo";

/** The most `map-plan` takes in its prompt (a scenario's layout brief with its locations runs to several thousand characters). */
export const MAP_PLAN_PROMPT_MAX = 12_000;

export const SYMMETRY_MODES: readonly SymmetryMode[] = ["none", "mirror-x", "mirror-y", "rot180", "rot90", "diag", "antidiag", "quad", "octo"];

export type Direction = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";

/** A player slot as the plugin sees it. */
export interface PlayerFact {
  /** 0-based. */
  slot: number;
  /** `Human`, `Computer`, `Neutral`, … (the editor's own labels). */
  type: string;
  race: string;
  /** 0-based force. */
  force: number;
  /** Whether the slot has a start location. */
  hasStart: boolean;
}

/** What every fact-based recipe gets to know about the open map. */
export interface MapFacts {
  name: string;
  description: string;
  width: number;
  height: number;
  tileset: string;
  players: PlayerFact[];
  /** `api.query.statistics()` flattened to the lines the Statistics dialog shows. */
  statistics: string[];
  /** Units on the map by type and owner: "Terran Marine × 12 (Player 1)". */
  units: string[];
  /** Location names in slot order (Anywhere excluded). */
  locations: string[];
  /** Number of triggers, briefing triggers and named switches. */
  triggerCount: number;
  briefingCount: number;
  /** The triggers as the editor prints them, cut to the server's input limit by the plugin. */
  triggersText?: string;
  /** What the person has selected or marked right now, one line each (the assistant reads these). */
  selection?: string[];
  /** Where the person is looking: the visible tile rect, the zoom, the active layer, the cursor. */
  view?: string;
  /** The top of the undo and redo stacks. */
  history?: string;
}

/* ── ums-design ─────────────────────────────────────────── */

/**
 * One kind of trigger system the plugin can build without the model writing a trigger:
 * hyper triggers, a spawn cycle, kill-to-cash, a leaderboard, victory for the last one
 * standing… The plugin sends its catalogue with every design request, so the design
 * names only kinds that exist and the server carries no copy of the toolkit.
 */
export interface SystemKindSpec {
  kind: string;
  description: string;
  params: SystemParamSpec[];
  /**
   * How a system of this kind can end the game for the human players. Absent for a kind
   * that ends nothing. The design checker wants a win and a loss within reach. A plugin
   * that sends these is also one that reads the design's `target`; an older plugin sends
   * none, is not checked for endings, and is given classic designs only.
   */
  ends?: SystemEnding[];
  /**
   * The parameters that name units a system of this kind makes *for the players it is for*
   * (`start-units`' `units`, a `respawn`'s `unit`) — not while its `owner` parameter hands
   * them to someone else. With a layout preset nothing else puts a unit on the map, so
   * these are all a human can be counted on to own.
   */
  creates?: string[];
}

export interface SystemEnding {
  /** The humans can win by it, lose by it, or both. */
  result: "win" | "loss" | "both";
  /** Only when this parameter is given (and is not 0 or "none"): `checkpoints` ends the game only with a `finish`. */
  when?: string;
  /** And only when that parameter's value starts with this: a `countdown` whose `onEnd` starts with "victory". */
  is?: string;
}

export interface SystemParamSpec {
  name: string;
  description: string;
  required: boolean;
  /** The value names a location, or a comma-separated list of them — checked against the design's. An older plugin says so only in the description. */
  type?: "location" | "locations";
  /** The value names a unit the system's players must already own for the system to do anything: a shop's buyer on the beacon, the unit whose loss is a defeat. */
  owned?: boolean;
}

export interface UmsDesignInput {
  /** What the person asked for. */
  prompt: string;
  width: number;
  height: number;
  tileset: string;
  /** Playable slots the map may use, 1–8. */
  players: number;
  terrains: TerrainVocab[];
  unitNames: string[];
  /** The plugin's toolkit; a system whose `kind` is not here (or `"custom"`) is scripted by the `triggers` recipe. */
  systemKinds: SystemKindSpec[];
  /** Whether the TrigScript plugin is on, so `custom` systems can be written at all. */
  scriptPlugin: boolean;
  /** The genre guide the plugin picked for the prompt, when it has one. */
  guide?: string;
  /** The layouts the plugin can lay out by itself; the design picks one when it fits, else the planner writes the terrain. */
  presets?: LayoutPresetSpec[];
}

/**
 * A layout the plugin lays out itself from a few numbers — the terrain of a family of
 * scenarios (corner camps around an arena, lanes from spawns to a goal) as a stored
 * shape program, so a design that fits one needs no terrain call at all. Sent with the
 * design request like the toolkit's kinds; the design names one in `layout`.
 */
export interface LayoutPresetSpec {
  id: string;
  description: string;
  params: { name: string; description: string; required: boolean }[];
  /** The locations the preset makes, with `{p}` for a player number and `{n}` for a lane number. */
  locations: string[];
}

/** The design's choice of preset and its parameters, or none for a layout the planner must write. */
export interface DesignLayout {
  preset: string;
  params: { key: string; value: string }[];
}

export interface DesignPlayer {
  /** 1–8. */
  slot: number;
  type: "human" | "computer" | "rescuable" | "neutral";
  race: "terran" | "zerg" | "protoss" | "random" | "userSelect";
  /** 1–4. */
  force: number;
  /** What this slot is for: "the hero player", "spawns the monsters", "holds the shop". */
  role: string;
}

export interface DesignForce {
  /** 1–4. */
  index: number;
  name: string;
  allied: boolean;
  alliedVictory: boolean;
  sharedVision: boolean;
}

export interface DesignSystem {
  /** A short name, unique in the design: "Zergling spawns", "Kill bounty". */
  name: string;
  /** One of the input's `systemKinds`, or `"custom"` for one the toolkit cannot build. */
  kind: string;
  /** The kind's parameters, as strings (a number is written as digits, a list comma-separated, a location or unit by name). */
  params: { key: string; value: string }[];
  /** What it does in play; for `custom`, the whole specification the trigger writer works from. */
  description: string;
}

/**
 * What the map is built for, chosen before a trigger exists. `classic`: triggers alone — it
 * plays in every version, the list runs every two seconds or, with a `hyper` system, twelve
 * times a second, and a custom system may not use `program()`. `remastered`: custom systems
 * may be programs, the saved map is built by eudplib and needs StarCraft: Remastered, every
 * trigger runs each frame, and the toolkit counts its timers at that rate — hyper triggers
 * have no place on it.
 */
export type DesignTarget = "classic" | "remastered";

/** The design document: everything the plugin needs to build the scenario, step by step. */
export interface UmsDesign {
  name: string;
  description: string;
  /** Absent in a design from an older server: classic. */
  target?: DesignTarget;
  /** "madness", "bound", "defense", "rpg", "diplomacy", "arena", "survival", "other". */
  genre: string;
  premise: string;
  players: DesignPlayer[];
  forces: DesignForce[];
  /** The prompt handed to `map-plan`: the terrain, and every location and unit the systems need, by name. */
  layoutBrief: string;
  /** A preset the plugin lays out from the parameters, when one fits; absent means the planner writes the terrain from the brief. */
  layout?: DesignLayout;
  /** The locations the brief must produce, with what each is for. */
  locations: { name: string; purpose: string }[];
  systems: DesignSystem[];
  /** The Set Mission Objectives text. */
  objectives: string;
  /** Mission briefing narration, one line each. */
  briefing: string[];
  notes: string[];
}

/* ── map-plan / region-plan ─────────────────────────────── */

/**
 * The layout language: a coarse grid of *cells*, each `cellSize` × `cellSize` tiles,
 * written as rows of single characters that a `legend` maps to terrain ids. It reads as
 * ASCII art, which is what makes the model good at it, and the plugin turns it into
 * isometric brush strokes, so cliffs and shores draw themselves. Ramps between heights
 * are listed separately because the tilesets keep them as doodads.
 */
export interface LayoutPlan {
  /** Tiles per cell, as requested. */
  cellSize: number;
  columns: number;
  rows: number;
  /** Character → terrain id from the vocabulary. */
  legend: Record<string, number>;
  /** `rows` strings of `columns` characters each. */
  grid: string[];
  bases: BasePlan[];
  ramps: RampPlan[];
  /** Bridges to fit over water, from the shape language's `bridge` statements. */
  bridges?: BridgePlan[];
  /** Decoration by category name, scattered over the cells whose legend characters are listed. */
  doodads: DoodadPlan[];
  /** Units by StarEdit name. */
  units: UnitPlan[];
  locations: LocationPlan[];
  /** What the designer intended, for the person reading the result. */
  notes: string[];
}

export interface MapPlan extends LayoutPlan {
  name: string;
  description: string;
  symmetry: SymmetryMode;
  /**
   * With language "shapes": the statements the terrain is compiled from. The server sends
   * them with an empty grid; the plugin compiles them at one tile per cell before rendering.
   */
  shapes?: Shape[];
}
/* ── The shape language (`map-plan` with language "shapes") ── */

/**
 * The way a ramp goes down. The game's ramps descend toward the south-west or the
 * south-east and nowhere else, so high ground must lie north of the ground it opens onto.
 */
export type RampSide = "sw" | "se";

/** A terrain pair a tileset has ramps for: `low` one height below `high`. */
export interface RampPair {
  low: number;
  high: number;
}

/**
 * One statement of the shape language, in map tiles; the plugin paints them in order,
 * later ones over earlier ones, and compiles the result to a one-tile grid. Which
 * fields matter depends on `op`:
 * - `ground`: `terrain` — the whole map.
 * - `rect`: `terrain`, `x`, `y`, `w`, `h`, optional `cut` (isometric corner cuts, in rows).
 * - `diamond` / `ellipse`: `terrain`, `cx`, `cy`, `rx`, `ry`.
 * - `polygon`: `terrain`, `points`.
 * - `stroke`: `terrain`, `points`, `width` — a band along a polyline: a river, a road, a wall.
 * - `border`: `terrain`, `width` — a band around the map's edge.
 * - `plateau`: like `rect`, plus `ramps`: the lower corners that carry a ramp down; the
 *   plugin cuts those corners into a diagonal edge, paints the pair the tileset has ramps
 *   for there, and fits the ramp doodad after painting.
 * - `lane`: `terrain`, `points`, `width`, optional `wall` and `wallWidth` — a walkable
 *   band with a band of `wall` either side.
 * - `ramp`: `x`, `y`, `side` — a ramp on an existing cliff near there.
 * - `bridge`: `x`, `y`, `along` — a bridge over water at that tile; the plugin paints a
 *   diagonal channel of water there (running the way `along` says, six tiles wide, the
 *   only channel the game's bridges span), its banks in the ground the bridges stand on,
 *   and fits the bridge doodad after painting.
 */
export interface Shape {
  op: "ground" | "rect" | "diamond" | "ellipse" | "polygon" | "stroke" | "border" | "plateau" | "lane" | "ramp" | "bridge";
  terrain?: number;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  points?: [number, number][];
  width?: number;
  cut?: number;
  ramps?: RampSide[];
  side?: RampSide;
  /** bridge: the diagonal the water runs along — "se" down-right, "sw" down-left. */
  along?: RampSide;
  wall?: number;
  wallWidth?: number;
  /**
   * stroke: the bridges the river carries. The compiler bends the river onto the 2:1
   * diagonal through each site, narrows it to the channel the tileset's bridges span,
   * paints their banks and fits the bridge — so the water reaches the bridge from both
   * sides by construction. `along` picks the diagonal; omitted, the one nearest the
   * river's own direction there.
   */
  bridges?: ([number, number] | { x: number; y: number; along?: RampSide })[];
  /** stroke: a band of this terrain either side of the water, `bankWidth` tiles wide (7 when omitted), bent with the river. */
  bank?: number;
  bankWidth?: number;
}

/** A bridge the plan wants near a tile, over water running along that diagonal. */
export interface BridgePlan {
  x: number;
  y: number;
  along: RampSide;
  /** The two ends of the channel the compiler painted for it, in tiles, when it painted one. */
  ends?: [[number, number], [number, number]];
}

/** What a tileset's bridges stand on and span, and how wide a channel (in tiles, across the diagonal) they fit. */
export interface BridgePair {
  ground: number;
  water: number;
  channel?: number;
}


export interface BasePlan {
  kind: "main" | "natural" | "third" | "expansion" | "island";
  /** Tile of the town hall's top-left corner. */
  x: number;
  y: number;
  /** Where the mineral line lies, seen from the hall. */
  mineralDirection: Direction;
  minerals: number;
  geysers: number;
  /**
   * 1-based player for a `main` (its start location); omitted for expansions. Under a
   * symmetry the plugin mirrors every base and numbers the mains in order, so a plan
   * lists only the canonical set.
   */
  player?: number;
}

export interface RampPlan {
  /** Tile at the ramp's centre. */
  x: number;
  y: number;
  /** Which way the ramp goes *down*. */
  direction: Direction;
  /** The terrains the ramp joins, when the plan knows them (a compiled shape plan does); the renderer samples the ground otherwise. */
  low?: number;
  high?: number;
}

export interface DoodadPlan {
  /** A category the plugin listed — `Trees`, `Rocks`, … */
  category: string;
  /** Legend characters of the cells to decorate. */
  on: string;
  /** Under the shape language, which has no legend: the terrains to decorate, by id. */
  terrains?: number[];
  /** 0 (none) … 1 (as many as fit). */
  density: number;
}

export interface UnitPlan {
  /** StarEdit's unit name. */
  unit: string;
  /** 1-based player; 12 is neutral. */
  player: number;
  /** Tile coordinates of the unit's centre. */
  x: number;
  y: number;
  /** For resources. */
  amount?: number;
}

export interface LocationPlan {
  name: string;
  /** Tiles, exclusive at the far edges. */
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export interface MapPlanInput {
  prompt: string;
  width: number;
  height: number;
  tileset: string;
  terrains: TerrainVocab[];
  /** Doodad category names the tileset offers. */
  doodadCategories: string[];
  /** Unit names the plugin can resolve, for `units`. */
  unitNames: string[];
  /** How many players to lay mains for (2 … 8). */
  players: number;
  symmetry: SymmetryMode | "auto";
  /** Tiles per cell; the plugin picks 4 for a 128 map. */
  cellSize: number;
  /**
   * "grid" (the default): the model paints a grid of cells. "shapes": it writes shape
   * statements — far fewer tokens, and ramps and lanes drawn by the plugin's compiler.
   */
  language?: "grid" | "shapes";
  /** With "shapes": the terrain pairs this tileset has ramps for, so plateaus that need a way down use them. */
  rampPairs?: RampPair[];
  /** With "shapes": what this tileset's bridges stand on and span; absent when it has none. */
  bridgePair?: BridgePair;
  /** A refinement round: the previous plan, what the plugin found rendering it, and a picture. */
  previous?: {
    plan: MapPlan;
    /** Problems the editor found — placement refusals, validation issues, unresolved ramps. */
    findings: string[];
    image?: ImageInput;
  };
}

export interface RegionPlanInput {
  prompt: string;
  width: number;
  height: number;
  tileset: string;
  terrains: TerrainVocab[];
  doodadCategories: string[];
  unitNames: string[];
  /** The area to redo, in tiles (exclusive far edges). */
  rect: { x0: number; y0: number; x1: number; y1: number };
  cellSize: number;
  /** The area and a margin around it, as it is now, in the same legend language. */
  current: { legend: Record<string, number>; grid: string[]; originX: number; originY: number };
  image?: ImageInput;
}

export interface ImageInput {
  mediaType: "image/png" | "image/jpeg" | "image/webp";
  /** Base64, no data-URL prefix. */
  data: string;
}

/* ── triggers ───────────────────────────────────────────── */

export interface TriggersInput {
  prompt: string;
  /** The editor's generated `.d.ts` for this map (the compact variant): the library, every unit, location, switch and player by name. */
  declarations: string;
  /** The map's current script, when it has one; the model extends or edits it. */
  script?: string;
  /** The hand triggers outside the script, printed, so the model does not duplicate them. */
  existingTriggers?: string;
  /** A repair round: the script the model wrote and what the compiler said. */
  repair?: {
    script: string;
    diagnostics: { line: number; column: number; message: string }[];
  };
  /**
   * The person is at the Write Triggers dialog and will likely ask again on this map
   * within the hour: the map's blocks (the declarations, the hand-made triggers) go on
   * the one-hour cache instead of the five-minute one. Off for a one-shot build.
   */
  iterative?: boolean;
}

export interface TriggersOutput {
  /** The complete script to build. */
  script: string;
  /** What it does, in a few sentences. */
  summary: string;
}

/* ── explain-triggers ───────────────────────────────────── */

export interface ExplainTriggersInput {
  /** Triggers in the editor's text format. */
  text: string;
  /** What the person wants to know; a walkthrough when absent. */
  question?: string;
  briefing?: boolean;
}

export interface TextOutput {
  /** Markdown. */
  text: string;
}

/* ── cast ───────────────────────────────────────────────── */

/** The play-by-play caster and the analyst. */
export type CastSpeaker = "caster" | "analyst";

export interface CastInput {
  /** How it is made: the whole game (the quiet parts played fast, no cuts) or the key moments alone, and how much banter. */
  options?: { format: "game" | "highlights"; banter: "off" | "light" | "lots" };
  /** Draws the commentators' two interests (any number; send a new one for a new pair). */
  seed?: number;
  game: {
    map: string;
    /** Seconds of game time, at Fastest. */
    length: number;
    players: { id: number; name: string; race: "Zerg" | "Terran" | "Protoss"; result: "won" | "lost" | "left" | "unknown" }[];
    /** Each player's opening as ordered, with the supply each step was ordered at, one player a line. */
    openings?: string[];
  };
  /** The clips shown, in order: a highlights cast has a few, a whole-game cast one after another. */
  moments: CastMoment[];
  /** Tone, language, anything. */
  wishes?: string;
}

export interface CastMoment {
  /** Seconds of game time: where the stretch starts and ends. */
  from: number;
  to: number;
  /** How fast it plays (1: normal speed), and so how many seconds it is on screen. */
  speed?: number;
  seconds?: number;
  /** A stretch with no key fight in it, at normal speed: talked over less, and the analyst's (Aftermath 0.14 on). */
  quiet?: boolean;
  /** What the clip is, in a few words. */
  title: string;
  /** Where each player stands when the clip starts: economy, buildings, upgrades, the whole army. */
  state?: string[];
  /** What happened since the clip before (or since the start), one fact a line. */
  before: string[];
  /** What happens while it plays, by seconds on screen from its start (each text starts with the game clock). */
  events: { at: number; text: string }[];
  /** How it came out, one fact a line. */
  after: string[];
}

export interface CastLine {
  /** Index into the input's `moments`. */
  moment: number;
  /** Seconds on screen from the start of its stretch (the last stretch's may run past its end: the sign-off). */
  at: number;
  speaker: CastSpeaker;
  text: string;
  /** 1: must be said (the call of the fight); 2: should; 3: colour that can go when time is short. */
  priority: 1 | 2 | 3;
  /** The card shown on screen while it is said: one tagged \`[card c12]\` in the facts the line is about. */
  card?: string;
}

export interface CastOutput {
  /** The model's reading of the game, written before the lines and not spoken: the plans, the decisions, why it was won. */
  storyline: string;
  /** One beat for each stretch, in order: what it sets up or pays off. Not spoken. */
  arc: string[];
  lines: CastLine[];
  /** The interests the two were given, when there is banter. */
  interests?: { caster: string; analyst: string };
}

/* ── describe / briefing ────────────────────────────────── */

export interface DescribeInput {
  facts: MapFacts;
  /** Tone, length, language, anything. */
  prompt?: string;
}

export interface DescribeOutput {
  name: string;
  description: string;
  /** Two more pairs to pick from. */
  alternatives: { name: string; description: string }[];
}

export interface BriefingInput {
  facts: MapFacts;
  prompt?: string;
}

export interface BriefingOutput {
  /** One objective line per entry, shown in the briefing's objectives box. */
  objectives: string[];
  /** The narration, one text message each. */
  lines: string[];
}

/* ── review ─────────────────────────────────────────────── */

export interface ReviewInput {
  facts: MapFacts;
  image: ImageInput;
  /** `api.query.validate()` as text lines. */
  issues: string[];
  /** Melee balance, a UMS's readability, or a free question. */
  prompt?: string;
}

export interface ReviewFinding {
  severity: "info" | "warning" | "problem";
  title: string;
  detail: string;
  /** A tile to look at, when the finding is somewhere in particular. */
  x?: number;
  y?: number;
}

export interface ReviewOutput {
  /** Markdown. */
  summary: string;
  findings: ReviewFinding[];
}

/* ── strings ────────────────────────────────────────────── */

export interface StringsInput {
  /** "Translate to German", "fix the spelling", … */
  instruction: string;
  strings: {
    index: number;
    /** Bytes below 0x20 shown as `<XX>`, exactly as the String Editor does; the model keeps them. */
    text: string;
    /** Where it is used: "scenario name", "trigger 4 text", … */
    usage: string[];
  }[];
}

export interface StringsOutput {
  strings: { index: number; text: string }[];
}

/* ── agent ──────────────────────────────────────────────── */

/**
 * The assistant is a plain tool-use loop with the tools defined — and run — by the
 * plugin. The server adds the system prompt, forwards the conversation, and hands back
 * the assistant's turn; the plugin executes any tool calls and sends the results as the
 * next user message. The plugin keeps the history and trims it.
 */
export interface AgentTool {
  name: string;
  description: string;
  /** JSON Schema for the input. */
  inputSchema: Record<string, unknown>;
}

export type AgentContent =
  | { type: "text"; text: string }
  | { type: "image"; source: ImageInput }
  | { type: "tool_use"; id: string; name: string; input: Record<string, unknown> }
  | { type: "tool_result"; toolUseId: string; content: string | ({ type: "text"; text: string } | { type: "image"; source: ImageInput })[]; isError?: boolean }
  /**
   * The model's reasoning, opaque: `thinking` is a summary or empty, `signature` binds it to
   * the conversation. The plugin keeps these in the history and sends them back unchanged —
   * a tool-using turn is refused by the API without them — and never shows `signature`.
   */
  | { type: "thinking"; thinking: string; signature: string }
  | { type: "redacted_thinking"; data: string };

export interface AgentMessage {
  role: "user" | "assistant";
  content: AgentContent[];
}

export interface AgentInput {
  /** The conversation so far, ending with a user message (a question or tool results). */
  messages: AgentMessage[];
  tools: AgentTool[];
  /** Facts about the open map, refreshed every turn. */
  facts: MapFacts;
  /**
   * The reference the plugin built — the editor's conventions, the unit table, the
   * trigger vocabulary, the tileset's terrains, the map's own names. Stable from turn to
   * turn (the server caches it as part of the prompt), so send the same text until the
   * map or the tileset changes. As a list, each entry is its own cached block, in order
   * from the most widely shared to the most specific: what is the same for every map
   * first (cached once for everyone), then the tileset's, then this map's, so a change
   * to the map rewrites only the last. Up to three entries.
   */
  reference?: string | string[];
}

export interface AgentOutput {
  content: AgentContent[];
  stopReason: "end_turn" | "tool_use" | "max_tokens" | "refusal";
  /**
   * The map-state block the server added at the end of the last user message, exactly as
   * the model saw it. Keep it in the history, as a text block at the end of that message,
   * so the next request sends the message unchanged: a model that checks replayed thinking
   * (the 5.5 generation) drops every thinking block after a message that changed.
   */
  state?: string;
}
