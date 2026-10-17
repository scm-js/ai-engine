/**
 * ums-design: a scenario's design document from a prompt. This is the thinking step of
 * the plugin's Scenario workflow — the model decides the genre, the premise, who the
 * players are, which trigger *systems* the map runs on and how the ground should be laid
 * out — and the plugin then executes it: `map-plan` for the terrain and the named
 * locations, the toolkit for every system it has a kind for, the `triggers` recipe for
 * the rest. Spending the model's effort here, once, on a document the person can read
 * and edit before anything is built, is what makes "make a madness map" cheap and
 * predictable; the alternative was twenty rounds of the assistant discovering the genre.
 *
 * The toolkit's catalogue (`systemKinds`) comes in the request, so the server carries no
 * copy of what the plugin can build, and a kind the design names that the catalogue lacks
 * is a repair, not a guess.
 */
import { z } from "zod";
import type { BetaMessageParam } from "../claude.js";
import type { DesignSystem, UmsDesign, UmsDesignInput } from "../protocol.js";
import { RecipeOutputError, S, expect, parseJson, type Recipe } from "./types.js";

const TerrainVocab = z.object({ id: z.number().int(), name: z.string().min(1).max(64), height: z.union([z.literal(0), z.literal(1), z.literal(2)]), buildable: z.boolean() });

export const UmsDesignInputSchema: z.ZodType<UmsDesignInput, z.ZodTypeDef, unknown> = z.object({
  prompt: z.string().min(1).max(6000),
  width: z.number().int().min(16).max(256),
  height: z.number().int().min(16).max(256),
  tileset: z.string().min(1).max(32),
  players: z.number().int().min(1).max(8),
  terrains: z.array(TerrainVocab).min(1).max(64),
  unitNames: z.array(z.string().max(64)).max(300),
  systemKinds: z.array(z.object({
    kind: z.string().min(1).max(40),
    description: z.string().max(1000),
    params: z.array(z.object({ name: z.string().min(1).max(40), description: z.string().max(400), required: z.boolean(), type: z.enum(["location", "locations"]).optional(), owned: z.boolean().optional() })).max(20),
    creates: z.array(z.string().max(40)).max(8).optional(),
    ends: z.array(z.object({ result: z.enum(["win", "loss", "both"]), when: z.string().max(40).optional(), is: z.string().max(40).optional() })).max(8).optional(),
  })).max(40),
  scriptPlugin: z.boolean(),
  guide: z.string().max(40_000).optional(),
  presets: z.array(z.object({
    id: z.string().min(1).max(40),
    description: z.string().max(1000),
    params: z.array(z.object({ name: z.string().min(1).max(40), description: z.string().max(400), required: z.boolean() })).max(20),
    locations: z.array(z.string().max(60)).max(40),
  })).max(20).optional(),
}).strict();

export const UMS_DESIGN_SYSTEM = `You design StarCraft: Brood War scenarios ("Use Map Settings" maps) for a map editor. The person says what they want in a sentence or two — "a madness map", "an RPG about a marine lost on a Zerg world", "a four-player tower defense" — and you answer with a complete *design document* in the JSON schema you were given. The editor then builds the map from it, step by step: the terrain and the named locations from your layout brief, the trigger systems from your list, the players and forces from your table, the objectives and briefing as you wrote them. Nothing you write is shown to players except the name, the description, the objectives and the briefing.

## What a scenario needs

- **Players.** Slots 1–8. A human slot is a person; a computer slot is what spawns and owns the enemies, the shop, the props; a rescuable slot hands its units over when touched; a neutral slot owns critters and resources (slot 12 is always neutral and needs no entry). Every human slot needs a start location — the layout brief must say where. A player who owns nothing when the game starts is defeated at once and its triggers never run, so a computer that only spawns things needs a unit of its own out of the way (the editor adds one when the design has none). Fewer computer slots than you think: one computer per force is usual; the game's AI is off in a scenario unless a trigger runs a script.
- **Forces.** Four at most. Humans in one force are allied and share victory when the force says so; the enemy computer in another. Name them for the story ("Survivors", "The Swarm"). Set \`alliedVictory\` for a team that wins together, \`sharedVision\` when they should see each other's map.
- **Locations.** Named rectangles the triggers read: spawn points, the arena, shops, beacons, the boss room, a "Kill zone" that removes units, "Anywhere" already exists. Give each a purpose; the layout brief must place every one of them and say what is near it. At most 254; a typical scenario uses 10–60.
- **Systems.** The map's mechanics, one entry each. Prefer the toolkit's kinds — the editor builds those without a model writing a trigger, correctly and instantly — and use \`"custom"\` only for what no kind can do (a boss fight's phases, a dialogue tree, a puzzle). For a custom system the \`description\` is the whole specification: what fires it, what it does, which locations, units and players it uses, what state it keeps. Every system's \`params\` refer to locations and units **by the names in your own \`locations\` list and the unit list you were given**; a parameter the kind requires must be present. A location parameter may hold \`{p}\` for the player number — \`Spawn {p}\`, \`Armory {p}\` — and one system then serves every player in its \`players\` (the editor builds it once per player with the number filled in), so write **one** spawn or shop system for "each player gets…" rather than one per player; the numbered locations (\`Spawn 1\`, \`Spawn 2\`, …) must be in your \`locations\`.
- **The layout.** When the request lists *layout presets*, prefer one: name it in \`layout.preset\` with its parameters, and the editor lays the terrain out itself in a second — camps, ramps, lanes, arena, and the locations the preset says it makes (use those names in your systems and list them in \`locations\` with their purpose). Presets fit most madness, arena, survival and defense maps. Choose \`layout.preset\` \`""\` only when no preset describes the ground the scenario needs; the brief then goes to a terrain designer.
- **What the players start with.** A layout preset places the start locations and nothing else: no worker, no hero, no building. Whatever a player must own from the first second — the SCV that builds the towers, the unit that stands on a shop's beacon, the hero whose death is a defeat — has to come from a system: \`start-units\` (when the kinds include it) at the player's own \`{p}\` location, or a \`respawn\`, \`spawn\` or \`checkpoints\` that makes it. The checker rejects a preset design in which a system waits on a unit no system gives. Without a preset the brief may ask the terrain designer to place them instead.
- **The layout brief** is a prompt for a terrain designer who never sees this document (write it even with a preset, briefly — it explains the intent): the tileset's feel, heights and walls, where each named location goes (with its rough size in tiles), which units to set the scene with and for which player, where start locations are, whether bases with minerals are wanted at all (most scenarios have none, or one hidden shop). Be concrete: "the arena is a 24×24 flat square in the centre ringed by cliffs; the four spawn locations are 6×6 squares at its corners; each human's start location is 8 tiles outside the arena on its own side".
- **Victory and defeat.** Every human player must be able to win and to lose. Say how in the systems (a last-standing system, a timer, a boss kill, an escape beacon) — the checker rejects a design where a human has no way to either. The toolkit's description of a kind says whether it ends the game; a custom system that does must say so in its description ("… then Victory for the players").
- **The target.** \`classic\` (the default) is a map of triggers alone: it plays in every version of the game, its trigger list runs every two seconds — or twelve times a second with a \`hyper\` system — and a custom system is written as ordinary triggers. \`remastered\` is for a map whose custom systems need what only a *program* can do (real loops and variables, arithmetic, reading a unit's fields, keys and the mouse): the saved map needs StarCraft: Remastered, every trigger runs each frame, and the editor counts the toolkit's timers at that rate. Choose \`remastered\` only when the request asks for it (Remastered, EUD) or a mechanic cannot be done without a program, and only with at least one custom system; never put a \`hyper\` system on a remastered design. The choice is made here, before any trigger exists, because every timer on the map is counted by it.
- **Objectives** are shown in the game's objectives box; three short lines. The **briefing** is narration before the map starts; three to six lines, in the voice of the world.

## The genres, briefly

- **Madness**: each player has a base with a hall; units spawn for every player every few seconds (by the computer, at their spawn location, owned by them); they auto-attack; kills or time bring upgrades; last player standing wins. Systems: spawn cycle per player, kill-to-cash or income, upgrades on a timer, last standing, hyper triggers.
- **Defense / Tower Defense**: waves of enemy units walk a path from a spawn to a goal; players build or place defenders; lives lost when enemies reach the goal; bounty per kill; victory after the last wave. Systems: \`waves\` — read what the toolkit says of its \`spawn\`: when it takes several locations, all the lanes are ONE system (a second would end the game on its own clock); when it takes one, a system per lane, and never a list in it — \`lives\`, kill-to-cash, what each player starts with (a builder, a few defenders), hyper. Keep lane waves to ground units: air units ignore the lanes and fly straight from the spawn to the goal, over the walls and out of the defenders' sight.
- **RPG**: one hero per player, a world to explore, quests at beacons, shops where a unit is bought for minerals, bosses, respawn or permadeath. Systems: kill-to-cash, shop, heal beacon, respawn, quest triggers (custom), boss (custom), victory on the final objective.
- **Bound**: a path of explosions the player's unit dodges, checkpoints, lives, respawn at the last checkpoint. Systems: one \`obstacles\` per stretch of the course, \`checkpoints\` (with its \`finish\` and \`lives\`), hyper. Not custom systems.
- **Diplomacy / Risk**: territories with income per building held, alliances players set in-game, elimination. Systems: income per territory, kill-to-cash, last standing.
- **Arena / Micro**: rounds in a walled arena, both sides get units, the survivor scores, first to N wins. Systems: round spawns, round reset (custom), score counter, victory on N.
- **Hero survival / Cat and mouse**: one side hunts, the other survives until a timer; victory for whoever is left when it runs out. Systems: countdown, spawn, last standing per force.
- **Capture the flag**: two teams, each with a flag at home; a unit entering the enemy flag room takes it, bringing it to your pad scores, a flag nobody holds returns home; first to N captures wins. Systems: one \`capture\` per flag (the takers are the other team; \`requireHome\` for "your own flag must be home"), hyper, spawn or respawn, kill-to-cash, a points leaderboard. Not a custom system.

## Rules

- Use the toolkit's kind names exactly; \`custom\` only when needed, and never a custom system for something a kind does. When the TrigScript plugin is off (\`scriptPlugin: false\`), design without custom systems. A custom system costs minutes and money to write: one per *mechanic*, never one per stretch or per stage of the same mechanic (three explosion patterns are one system with three parts; capture, respawn and finish of a course are one system).
- Every unit you name must be in the unit list; every location you use must be in your \`locations\`.
- Keep the design compact: a typical scenario is six to fourteen systems. A mechanic every player has is one system with \`players\` or a \`{p}\` location, not a copy per player; a copy per team only when its locations differ. A toolkit system's \`description\` is one sentence — the parameters are the specification; only a custom system's description is the whole specification. The premise, the brief and the briefing are as long as they need to be and no longer.
- Keep the scale sensible: the game holds 1700 units; a spawn system that adds units without a cap stalls the map.
- Hyper triggers are a system of their own (\`hyper\`, when the kinds include it); on a classic design include them when any system fires faster than once every two seconds, on a remastered one never.
- Answer with one JSON object in the schema, nothing else.`;

const Output = z.object({
  target: z.enum(["classic", "remastered"]).optional(),
  layout: z.object({ preset: z.string(), params: z.array(z.object({ key: z.string(), value: z.string() })) }).optional(),
  name: z.string().min(1),
  description: z.string(),
  genre: z.string(),
  premise: z.string(),
  players: z.array(z.object({ slot: z.number(), type: z.enum(["human", "computer", "rescuable", "neutral"]), race: z.enum(["terran", "zerg", "protoss", "random", "userSelect"]), force: z.number(), role: z.string() })),
  forces: z.array(z.object({ index: z.number(), name: z.string(), allied: z.boolean(), alliedVictory: z.boolean(), sharedVision: z.boolean() })),
  layoutBrief: z.string().min(1),
  locations: z.array(z.object({ name: z.string().min(1), purpose: z.string() })),
  systems: z.array(z.object({ name: z.string().min(1), kind: z.string().min(1), params: z.array(z.object({ key: z.string(), value: z.string() })), description: z.string() })),
  objectives: z.string(),
  briefing: z.array(z.string()),
  notes: z.array(z.string()),
});

function presetsText(input: UmsDesignInput): string {
  if (!input.presets?.length) return "";
  const lines = ["## Layout presets: terrain the editor lays out itself from a few numbers", ""];
  for (const p of input.presets) {
    lines.push(`- \`${p.id}\`: ${p.description}`);
    for (const x of p.params) lines.push(`  - ${x.name}${x.required ? "" : " (optional)"}: ${x.description}`);
    lines.push(`  - makes the locations: ${p.locations.join(", ")} ({p} a player number, {n} a lane number)`);
  }
  return lines.join("\n");
}

/**
 * How many of a preset's numbered (`{n}`) locations a layout makes, from its own
 * parameters: the largest whole number among them and the products of any two — `lanes: 3`
 * makes three, `stretches: 4` with `spotsPerStretch: 6` makes twenty-four. A guess on the
 * generous side of what the preset does, and far short of the 64 every `{n}` used to pass
 * for; without a number among the parameters, the preset's defaults are not known here
 * and 64 it stays.
 */
export function numberedLimit(params: { key: string; value: string }[]): number {
  const numbers = params.map((p) => Number(p.value.trim())).filter((n) => Number.isInteger(n) && n >= 1 && n <= 64);
  if (numbers.length === 0) return 64;
  let limit = Math.max(...numbers);
  for (let i = 0; i < numbers.length; i++) for (let j = i + 1; j < numbers.length; j++) limit = Math.max(limit, numbers[i]! * numbers[j]!);
  return Math.min(64, limit);
}

/** The locations a preset makes for these players, for the checker. */
function presetLocations(preset: { locations: string[] }, humans: number[], params: { key: string; value: string }[]): string[] {
  const out: string[] = [];
  const limit = numberedLimit(params);
  for (const name of preset.locations) {
    if (name.includes("{p}")) for (const p of humans) out.push(name.replace("{p}", String(p)));
    else if (name.includes("{n}")) for (let n = 1; n <= limit; n++) out.push(name.replace("{n}", String(n)));
    else out.push(name);
  }
  return out;
}

function kindsText(input: UmsDesignInput): string {
  if (input.systemKinds.length === 0) return "## Toolkit\n\n(none — every system is custom)";
  const lines = ["## Toolkit: the system kinds the editor builds itself", ""];
  for (const k of input.systemKinds) {
    lines.push(`- \`${k.kind}\`: ${k.description}`);
    for (const p of k.params) lines.push(`  - ${p.name}${p.required ? "" : " (optional)"}: ${p.description}`);
  }
  return lines.join("\n");
}

/** Check a parsed design against the request: kinds that exist, params the kind requires, players and forces in range, a win and a loss for every human. */
export function checkDesign(raw: z.infer<typeof Output>, input: UmsDesignInput): UmsDesign {
  const problems: string[] = [];
  const kinds = new Map(input.systemKinds.map((k) => [k.kind, k]));
  const locationNames = new Set(raw.locations.map((l) => l.name.trim().toLowerCase()));
  // A preset's locations exist once it is laid out, whether or not the design listed them.
  let layout: UmsDesign["layout"] | undefined;
  let presetOnly: { id: string; made: string[]; extra: string[] } | null = null;
  if (raw.layout && raw.layout.preset.trim()) {
    const id = raw.layout.preset.trim();
    const preset = (input.presets ?? []).find((p) => p.id === id);
    if (!preset) problems.push(`layout names preset "${id}", which the editor does not have (use one of ${(input.presets ?? []).map((p) => p.id).join(", ") || "none"}, or "")`);
    else {
      const given = new Set(raw.layout.params.map((p) => p.key.trim()));
      for (const p of preset.params) if (p.required && !given.has(p.name)) problems.push(`layout preset ${id} lacks the required parameter "${p.name}"`);
      for (const p of raw.layout.params) if (!preset.params.some((k) => k.name === p.key.trim())) problems.push(`layout preset ${id} has a parameter "${p.key}" it does not take`);
      const humans = raw.players.filter((p) => p.type === "human").map((p) => p.slot);
      // With a preset the plugin lays out the preset's locations and no others: one the design adds of its own
      // ("Lane Heads") is never drawn, and the system that names it waits for ever. So only the preset's count.
      const own = [...locationNames];
      locationNames.clear();
      for (const name of presetLocations(preset, humans, raw.layout.params)) locationNames.add(name.toLowerCase());
      presetOnly = { id, made: preset.locations, extra: own.filter((n) => !locationNames.has(n)) };
      layout = { preset: id, params: raw.layout.params.map((p) => ({ key: p.key.trim(), value: p.value.trim() })) };
    }
  }
  const humanSlots = raw.players.filter((p) => p.type === "human").map((p) => p.slot);
  const computerSlots = raw.players.filter((p) => p.type === "computer").map((p) => p.slot);
  /** The players a system is built for, as the toolkit reads its `players` parameter: humans unless it says otherwise. */
  const playersOf = (s: DesignSystem): number[] => {
    const v = s.params.find((p) => p.key === "players")?.value.trim() ?? "";
    if (v === "" || /^humans?$/i.test(v)) return humanSlots;
    if (/^computers?$/i.test(v)) return computerSlots;
    if (/^all$/i.test(v)) return [...humanSlots, ...computerSlots];
    const list = v.split(/[,\s]+/).map((x) => Number(x.replace(/^p(?:layer)?\s*/i, ""))).filter((n) => Number.isInteger(n) && n >= 1 && n <= 12);
    return list.length ? list : humanSlots;
  };
  // "Spawn {p}" is the toolkit's per-player template (one trigger per player, {p} the player number): it names a
  // location when "Spawn 1", "Spawn 2", … do — one for *every* player the system is built for, since the editor
  // builds it for each and a missing one is a trigger on a location that is not there. The answer is the missing names.
  const missingLocations = (value: string, players: number[]): string[] => {
    const v = value.trim();
    if (v.toLowerCase() === "anywhere" || locationNames.has(v.toLowerCase())) return [];
    if (!v.includes("{p}")) return [v];
    return players.map((p) => v.replace(/\{p\}/g, String(p))).filter((name) => !locationNames.has(name.toLowerCase()));
  };
  const systems: DesignSystem[] = raw.systems.map((s) => ({ ...s, kind: s.kind.trim(), name: s.name.trim(), params: s.params.map((p) => ({ key: p.key.trim(), value: p.value.trim() })) }));
  for (const s of systems) {
    if (s.kind === "custom") {
      if (!input.scriptPlugin) problems.push(`system "${s.name}" is custom, but the TrigScript plugin is off; design it with the toolkit's kinds or leave it out`);
      if (s.description.trim().length < 40) problems.push(`system "${s.name}" is custom but its description is too short to write triggers from`);
      continue;
    }
    const kind = kinds.get(s.kind);
    if (!kind) { problems.push(`system "${s.name}" names kind "${s.kind}", which the toolkit does not have (use one of ${[...kinds.keys()].join(", ")}, or "custom")`); continue; }
    const given = new Set(s.params.map((p) => p.key));
    for (const p of kind.params) if (p.required && !given.has(p.name)) problems.push(`system "${s.name}" (${s.kind}) lacks the required parameter "${p.name}"`);
    for (const p of s.params) {
      const def = kind.params.find((k) => k.name === p.key);
      if (!def) problems.push(`system "${s.name}" (${s.kind}) has a parameter "${p.key}" the kind does not take`);
      else if (p.value) {
        // The plugin says which parameters name locations; an older one says so only in the description.
        const type = def.type ?? (/location/i.test(def.description) ? (/comma-separated|, comma/i.test(def.description) ? "locations" : "location") : undefined);
        if (!type) continue;
        const names = type === "locations" ? p.value.split(/\s*[,;]\s*/).filter(Boolean) : [p.value];
        const missing = names.flatMap((name) => missingLocations(name, playersOf(s)));
        if (missing.length) problems.push(`system "${s.name}": parameter "${p.key}" names ${missing.length === 1 ? "location" : "locations"} ${missing.map((m) => `"${m}"`).join(", ")}, which ${missing.length === 1 ? "is" : "are"} not ${presetOnly ? `among the locations the ${presetOnly.id} preset makes (${presetOnly.made.join(", ")}) — with a preset nothing else is drawn, so use those names, one location to a parameter unless it takes a list` : "in the design's locations"}${/\{p\}/.test(p.value) ? ` (a {p} template needs a numbered location for every player the system is for: ${playersOf(s).join(", ")})` : ""}`);
      }
    }
  }
  const players = raw.players.filter((p) => p.slot >= 1 && p.slot <= 8);
  if (players.length !== raw.players.length) problems.push("a player slot is outside 1–8");
  const slots = new Set<number>();
  for (const p of players) { if (slots.has(p.slot)) problems.push(`player slot ${p.slot} is listed twice`); slots.add(p.slot); if (p.force < 1 || p.force > 4) problems.push(`player ${p.slot} is in force ${p.force}; forces are 1–4`); }
  if (!players.some((p) => p.type === "human")) problems.push("no human player");
  if (players.filter((p) => p.type === "human").length > input.players) problems.push(`${players.filter((p) => p.type === "human").length} human players; the map allows ${input.players}`);
  const forces = raw.forces.filter((f) => f.index >= 1 && f.index <= 4);
  if (forces.length !== raw.forces.length) problems.push("a force index is outside 1–4");
  if (raw.locations.length > 200) problems.push(`${raw.locations.length} locations; keep it under 200`);
  if (systems.length === 0) problems.push("no systems: a scenario needs at least a way to win and to lose");
  const notes = raw.notes.map((n) => n.trim()).filter(Boolean);
  if (presetOnly?.extra.length) notes.push(`Left out, because the ${presetOnly.id} preset does not make ${presetOnly.extra.length === 1 ? "it" : "them"} and no system uses ${presetOnly.extra.length === 1 ? "it" : "them"}: ${raw.locations.filter((l) => presetOnly!.extra.includes(l.name.trim().toLowerCase())).map((l) => l.name.trim()).join(", ")}.`);

  // The target. A plugin that says how its kinds end the game is one that reads `target`; an older one builds every design as classic, so it is given nothing else.
  const readsTarget = input.systemKinds.some((k) => k.ends !== undefined);
  let target: UmsDesign["target"] = readsTarget ? raw.target ?? "classic" : undefined;
  if (target === "remastered" && !systems.some((s) => s.kind === "custom")) {
    target = "classic";
    notes.push("The design asked for a Remastered map but has no custom system to be a program, so it is a classic one.");
  }
  let kept = systems;
  if (target === "remastered" && systems.some((s) => s.kind === "hyper")) {
    kept = systems.filter((s) => s.kind !== "hyper");
    notes.push("Hyper triggers were left out: on a Remastered map with a program every trigger already runs each frame.");
  }

  // What the players own. A preset lays out ground, locations and start locations, and no unit: there, a system that
  // waits on a unit of the player's (a shop's buyer, the unit whose loss is a defeat) waits for ever — or, worse,
  // defeats everyone when the grace runs out — unless some system makes that unit. Only with a plugin that says
  // which kinds make units, and only with a preset: a planned layout may place them from the brief.
  if (layout && input.systemKinds.some((k) => k.creates !== undefined)) {
    const CLASSES = new Set(["any unit", "men", "buildings", "factories"]);
    const made = new Set<string>();
    for (const s of kept) {
      if (s.kind === "custom") continue;
      const owner = s.params.find((p) => p.key === "owner")?.value.trim() ?? "";
      if (owner !== "" && !/^each$/i.test(owner)) continue;
      for (const name of kinds.get(s.kind)?.creates ?? []) {
        for (const v of (s.params.find((p) => p.key === name)?.value ?? "").split(/\s*[,;]\s*/)) {
          const unit = v.trim().replace(/^\d+\s*(?:x|×)?\s+/i, "").toLowerCase();
          if (unit) made.add(unit);
        }
      }
    }
    const scripted = kept.filter((s) => s.kind === "custom").map((s) => s.description.toLowerCase()).join("\n");
    const givers = input.systemKinds.filter((k) => k.creates?.length).map((k) => k.kind).join(", ");
    for (const s of kept) {
      for (const def of kinds.get(s.kind)?.params ?? []) {
        if (!def.owned) continue;
        const given = s.params.find((p) => p.key === def.name)?.value.trim() ?? "";
        const value = given.toLowerCase();
        if (value === "" || CLASSES.has(value)) {
          // A class, or the kind's default (a class too): any unit at all will do, but there has to be one.
          if (made.size === 0 && !scripted) problems.push(`system "${s.name}" (${s.kind}) counts on the players owning units, and with the ${layout.preset} preset nothing is placed for them: add a system that gives each player what they start with (${givers})`);
          continue;
        }
        if (!made.has(value) && !scripted.includes(value)) problems.push(`system "${s.name}" (${s.kind}): parameter "${def.name}" needs each player to own a ${given}, and no system gives them one — the ${layout.preset} preset places start locations only. Add one that does (${givers}), at the player's own location`);
      }
    }
  }

  // Two systems of a kind that wait on the same unit at the same place (two shops with one buyer on one pad): the
  // triggers of the first always fire first and take the unit away, so the second never sells.
  const waitsAt = new Map<string, string>();
  for (const s of kept) {
    const def = kinds.get(s.kind);
    const owned = def?.params.find((p) => p.owned);
    const place = def?.params.find((p) => p.type === "location");
    if (!owned || !place) continue;
    const where = s.params.find((p) => p.key === place.name)?.value.trim().toLowerCase() ?? "";
    const who = s.params.find((p) => p.key === owned.name)?.value.trim().toLowerCase() ?? "";
    if (!where) continue;
    const key = `${s.kind}|${where}|${who}`;
    const first = waitsAt.get(key);
    if (first) problems.push(`systems "${first}" and "${s.name}" (${s.kind}) both wait for ${who || "any unit"} at ${s.params.find((p) => p.key === place.name)!.value}: the first always fires first and the second never does — give them different ${owned.name}s or different locations`);
    else waitsAt.set(key, s.name);
  }

  // A way to win and a way to lose. Only a plugin that says how its kinds end the game can be held to it.
  if (readsTarget && systems.length > 0) {
    const reach = { win: false, loss: false };
    for (const s of kept) {
      if (s.kind === "custom") {
        if (/\b(victory|wins?|won)\b/i.test(s.description)) reach.win = true;
        if (/\b(defeat(ed)?|loses?|lost|game over)\b/i.test(s.description)) reach.loss = true;
        continue;
      }
      for (const rule of kinds.get(s.kind)?.ends ?? []) {
        if (rule.when !== undefined) {
          const value = s.params.find((p) => p.key === rule.when)?.value.trim().toLowerCase() ?? "";
          if (value === "" || value === "0" || value === "none") continue;
          if (rule.is !== undefined && !value.startsWith(rule.is.toLowerCase())) continue;
        }
        if (rule.result !== "loss") reach.win = true;
        if (rule.result !== "win") reach.loss = true;
      }
    }
    const enders = input.systemKinds.filter((k) => k.ends?.length).map((k) => k.kind).join(", ");
    if (!reach.win) problems.push(`no system lets the human players win: add one that ends in victory (${enders}), or a custom system whose description says it gives Victory`);
    if (!reach.loss) problems.push(`no system lets the human players lose: add one that ends in defeat (${enders}), or a custom system whose description says it gives Defeat`);
  }
  if (problems.length > 0) throw new RecipeOutputError(problems);
  return {
    name: raw.name.trim().slice(0, 40) || "Untitled Scenario",
    description: raw.description.trim().slice(0, 1000),
    ...(target ? { target } : {}),
    genre: raw.genre.trim().toLowerCase().slice(0, 40) || "other",
    premise: raw.premise.trim(),
    players: players.map((p) => ({ ...p, role: p.role.trim() })),
    forces: forces.map((f) => ({ ...f, name: f.name.trim().slice(0, 60) })),
    layoutBrief: raw.layoutBrief.trim(),
    ...(layout ? { layout } : {}),
    // A preset draws its own locations only; the design's others would be reported as missing by a build nothing can complete.
    locations: raw.locations.filter((l) => !presetOnly?.extra.includes(l.name.trim().toLowerCase())).map((l) => ({ name: l.name.trim().slice(0, 60), purpose: l.purpose.trim() })),
    systems: kept,
    objectives: raw.objectives.trim(),
    briefing: raw.briefing.map((l) => l.trim()).filter(Boolean),
    notes,
  };
}

export const umsDesignRecipe: Recipe<"ums-design"> = {
  name: "ums-design",
  kind: "json",
  input: UmsDesignInputSchema,
  system: UMS_DESIGN_SYSTEM,
  build(input) {
    const content: Extract<BetaMessageParam["content"], unknown[]> = [];
    const head = [
      `Map: ${input.width} × ${input.height} tiles, tileset ${input.tileset}, up to ${input.players} human player${input.players === 1 ? "" : "s"}. TrigScript plugin: ${input.scriptPlugin ? "on (custom systems allowed)" : "off (no custom systems)"}.`,
      "",
      "## Terrain vocabulary (id: name — height, buildable?)",
      ...input.terrains.map((t) => `${t.id}: ${t.name} — height ${t.height}${t.buildable ? ", buildable" : ", not buildable"}`),
      "",
      `## Unit names: ${input.unitNames.length ? input.unitNames.join("; ") : "(none)"}`,
      "",
      kindsText(input),
      "",
      presetsText(input),
    ];
    content.push({ type: "text", text: head.join("\n") });
    if (input.guide) content.push({ type: "text", text: `## Genre guide\n\n${input.guide}` });
    content.push({ type: "text", text: `## The request\n\n${input.prompt}` });
    const kv = S.obj({ key: S.str(), value: S.str() });
    return {
      messages: [{ role: "user", content }],
      outputSchema: S.obj({
        name: S.str("at most 40 characters"),
        target: S.enumOf(["classic", "remastered"]),
        description: S.str("two sentences, for the map's description"),
        genre: S.enumOf(["madness", "bound", "defense", "rpg", "diplomacy", "arena", "survival", "other"]),
        premise: S.str("a paragraph: the story and how it plays"),
        players: S.arr(S.obj({ slot: S.int("1–8"), type: S.enumOf(["human", "computer", "rescuable", "neutral"]), race: S.enumOf(["terran", "zerg", "protoss", "random", "userSelect"]), force: S.int("1–4"), role: S.str() })),
        forces: S.arr(S.obj({ index: S.int("1–4"), name: S.str(), allied: S.bool(), alliedVictory: S.bool(), sharedVision: S.bool() })),
        layout: S.obj({ preset: S.str("a layout preset's id, or \"\" for none"), params: S.arr(kv) }),
        layoutBrief: S.str("the prompt for the terrain designer: heights, walls, every named location with its size and place, scene units, start locations"),
        locations: S.arr(S.obj({ name: S.str(), purpose: S.str() })),
        systems: S.arr(S.obj({ name: S.str(), kind: S.str("a toolkit kind, or custom"), params: S.arr(kv), description: S.str() })),
        objectives: S.str("the Set Mission Objectives text, a few lines"),
        briefing: S.arr(S.str(), "narration lines"),
        notes: S.arr(S.str(), "for the map maker"),
      }),
    };
  },
  parse(result, input): UmsDesign {
    return checkDesign(expect(Output, parseJson(result.text)), input);
  },
};
