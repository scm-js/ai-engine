/**
 * What `checkDesign` holds a design to beyond its shape: a way to win and to lose, a
 * location for every player a `{p}` template is built for, a target the map can have.
 *
 * `owed` is for a claim the checker does not meet yet: written the way it will be true, it
 * has to fail *as an assertion* until then, and says so the day it holds. Nothing is owed
 * at the moment.
 */
import { describe, expect, it } from "vitest";
import { checkDesign, numberedLimit } from "../src/recipes/umsDesign.js";
import type { UmsDesignInput } from "../src/protocol.js";

export function owed<T>(name: string, fix: string, arrange: () => T, claim: (got: T) => void) {
  it(`${name} [owed: ${fix}]`, () => {
    const got = arrange();
    let failure: unknown = null;
    try { claim(got); } catch (err) { failure = err; }
    if (failure === null) throw new Error(`This holds now — make it a plain test (${fix}).`);
    if ((failure as Error).name !== "AssertionError") throw failure;
  });
}

const P = (name: string, type?: "location" | "locations") => ({ name, description: name, required: false, ...(type ? { type } : {}) });
const input: UmsDesignInput = {
  prompt: "a bound", width: 96, height: 96, tileset: "jungle", players: 3,
  terrains: [{ id: 1, name: "Jungle", height: 0, buildable: true }], unitNames: ["Zerg Zergling"],
  systemKinds: [
    { kind: "message", description: "Show a text to the players.", params: [P("text")] },
    { kind: "hyper", description: "Hyper triggers.", params: [] },
    { kind: "waves", description: "Waves.", params: [P("spawn", "location")], ends: [{ result: "win" }] },
    { kind: "lives", description: "Lives.", params: [P("goal", "location")], ends: [{ result: "loss" }] },
    { kind: "checkpoints", description: "A course.", params: [P("start", "location"), P("checkpoints", "locations"), P("finish", "location"), P("lives")], ends: [{ result: "both", when: "finish" }, { result: "loss", when: "lives" }] },
    { kind: "countdown", description: "A timer.", params: [P("onEnd")], ends: [{ result: "win", when: "onEnd", is: "victory" }, { result: "loss", when: "onEnd", is: "defeat" }] },
    { kind: "spawn", description: "Spawns.", params: [P("where", "location"), P("players"), P("unit"), P("owner")], creates: ["unit"] },
    { kind: "start-units", description: "Starting units.", params: [P("units"), P("location", "location")], creates: ["units"] },
    { kind: "shop", description: "A shop.", params: [P("location", "location"), { ...P("buyer"), owned: true }] },
    { kind: "last-standing", description: "Last one standing.", params: [{ ...P("unit"), owned: true }], ends: [{ result: "both" }] },
  ],
  presets: [{ id: "lanes", description: "Lanes.", params: [P("lanes")], locations: ["Lane {n}", "Base {p}", "Goal"] }],
  scriptPlugin: true,
};

const human = (slot: number) => ({ slot, type: "human" as const, race: "terran" as const, force: 1, role: "runner" });
const system = (kind: string, params: Record<string, string> = {}, description = "") => ({ name: `${kind} ${Object.values(params).join(" ")}`.trim(), kind, params: Object.entries(params).map(([key, value]) => ({ key, value })), description });
const design = (systems: ReturnType<typeof system>[], more: Record<string, unknown> = {}) => ({
  name: "A design", description: "", genre: "bound", premise: "",
  players: [human(1), human(2), { slot: 8, type: "computer" as const, race: "zerg" as const, force: 2, role: "enemy" }],
  forces: [{ index: 1, name: "Runners", allied: true, alliedVictory: false, sharedVision: true }],
  layoutBrief: "A course.", locations: [{ name: "Start", purpose: "" }, { name: "End", purpose: "" }, { name: "Spot 1", purpose: "" }],
  systems, objectives: "Finish.", briefing: [], notes: [],
  ...more,
});
const BOSS = "When the Overmind at End dies every human player gets Victory; when the last runner dies they are all Defeated and the game is over.";

describe("a way to win and a way to lose", () => {
  it("a design nobody can win or lose is a problem, named both ways", () => {
    expect(() => checkDesign(design([system("message", { text: "Hello" })]), input)).toThrow(/no system lets the human players win.*no system lets the human players lose/s);
  });

  it("a kind's endings count, by the parameters that switch them on", () => {
    expect(() => checkDesign(design([system("waves", { spawn: "Start" })]), input)).toThrow(/players lose/);
    expect(() => checkDesign(design([system("waves", { spawn: "Start" })]), input)).not.toThrow(/players win/);
    expect(checkDesign(design([system("waves", { spawn: "Start" }), system("lives", { goal: "End" })]), input).systems).toHaveLength(2);
    expect(() => checkDesign(design([system("checkpoints", { start: "Start", checkpoints: "Spot 1" })]), input)).toThrow(/players win/);
    expect(() => checkDesign(design([system("checkpoints", { start: "Start", checkpoints: "Spot 1", lives: "0" })]), input)).toThrow(/players lose/);
    expect(checkDesign(design([system("checkpoints", { start: "Start", checkpoints: "Spot 1", finish: "End" })]), input).systems).toHaveLength(1);
    expect(() => checkDesign(design([system("countdown", { onEnd: "victory:humans" })]), input)).toThrow(/players lose/);
    expect(() => checkDesign(design([system("countdown", { onEnd: "draw" })]), input)).toThrow(/players win/);
  });

  it("a custom system ends the game when its description says so", () => {
    expect(checkDesign(design([system("custom", {}, BOSS)]), input).systems).toHaveLength(1);
    expect(() => checkDesign(design([system("custom", {}, "A dialogue tree at the beacon: three lines from the elder, one each time a hero steps on it.")]), input)).toThrow(/players win/);
  });

  it("a plugin that does not say how its kinds end is not held to it", () => {
    const older = { ...input, systemKinds: input.systemKinds.map(({ ends: _ends, ...k }) => k) };
    expect(checkDesign(design([system("message", { text: "Hello" })]), older).systems).toHaveLength(1);
  });
});

describe("locations", () => {
  it("a {p} template needs a location for every player the system is for", () => {
    const some = design([system("spawn", { where: "Base {p}" }), system("custom", {}, BOSS)], { locations: [{ name: "Base 1", purpose: "" }] });
    expect(() => checkDesign(some, input)).toThrow(/names location "Base 2".*every player the system is for: 1, 2/);
    const narrowed = design([system("spawn", { where: "Base {p}", players: "1" }), system("custom", {}, BOSS)], { locations: [{ name: "Base 1", purpose: "" }] });
    expect(checkDesign(narrowed, input).systems).toHaveLength(2);
  });

  it("a list parameter is checked name by name, by its type and not its description", () => {
    expect(() => checkDesign(design([system("checkpoints", { start: "Start", checkpoints: "Spot 1, Spot 2; Spot 3", finish: "End" })]), input)).toThrow(/names locations "Spot 2", "Spot 3"/);
  });

  it("a preset's numbered locations stop where its parameters say", () => {
    expect(numberedLimit([{ key: "lanes", value: "3" }])).toBe(3);
    expect(numberedLimit([{ key: "stretches", value: "4" }, { key: "spotsPerStretch", value: "6" }, { key: "pattern", value: "sweep" }])).toBe(24);
    expect(numberedLimit([{ key: "pattern", value: "sweep" }])).toBe(64);
    const lanes = (where: string) => design([system("spawn", { where }), system("custom", {}, BOSS)], { layout: { preset: "lanes", params: [{ key: "lanes", value: "3" }] } });
    expect(checkDesign(lanes("Lane 3"), input).layout?.preset).toBe("lanes");
    expect(() => checkDesign(lanes("Lane 4"), input)).toThrow(/"Lane 4"/);
    expect(checkDesign(lanes("Base {p}"), input).systems).toHaveLength(2);
  });
});

describe("the target", () => {
  it("is classic unless the design says otherwise, and absent for a plugin that would not read it", () => {
    const d = design([system("custom", {}, BOSS)]);
    expect(checkDesign(d, input).target).toBe("classic");
    expect(checkDesign({ ...d, target: "remastered" as const }, input).target).toBe("remastered");
    const older = { ...input, systemKinds: input.systemKinds.map(({ ends: _ends, ...k }) => k) };
    expect(checkDesign({ ...d, target: "remastered" as const }, older).target).toBeUndefined();
  });

  it("a remastered design loses its hyper triggers, and one with nothing to be a program is classic", () => {
    const d = checkDesign({ ...design([system("hyper"), system("custom", {}, BOSS)]), target: "remastered" as const }, input);
    expect(d.systems.map((s) => s.kind)).toEqual(["custom"]);
    expect(d.notes.join(" ")).toMatch(/Hyper triggers were left out/);
    const toolkitOnly = checkDesign({ ...design([system("hyper"), system("waves", { spawn: "Start" }), system("lives", { goal: "End" })]), target: "remastered" as const }, input);
    expect(toolkitOnly.target).toBe("classic");
    expect(toolkitOnly.systems.map((s) => s.kind)).toEqual(["hyper", "waves", "lives"]);
    expect(toolkitOnly.notes.join(" ")).toMatch(/no custom system to be a program/);
  });
});

describe("what the players own", () => {
  const preset = { layout: { preset: "lanes", params: [{ key: "lanes", value: "2" }] } };
  const ending = system("custom", {}, "When the gate at End falls every human player is Defeated; when the last wave is dead they get Victory.");
  const shop = system("shop", { location: "Base {p}", buyer: "Terran SCV" });

  it("with a preset, a unit a system waits on has to come from a system", () => {
    expect(() => checkDesign(design([shop, ending], preset), input)).toThrow(/parameter "buyer" needs each player to own a Terran SCV.*start-units/);
    expect(checkDesign(design([shop, ending, system("start-units", { units: "1 Terran SCV, 4 Terran Marine", location: "Base {p}" })], preset), input).systems).toHaveLength(3);
    expect(checkDesign(design([shop, ending, system("spawn", { where: "Base {p}", unit: "terran scv" })], preset), input).systems).toHaveLength(3);
    // Spawned for the computer, it is not the players'.
    expect(() => checkDesign(design([shop, ending, system("spawn", { where: "Base {p}", unit: "Terran SCV", owner: "computer" })], preset), input)).toThrow(/own a Terran SCV/);
  });

  it("a custom system that names the unit is taken at its word", () => {
    const giver = system("custom", {}, "At the start each human player is given a Terran SCV at their base; when all are dead they are Defeated, and at the last wave's end they get Victory.");
    expect(checkDesign(design([shop, giver], preset), input).systems).toHaveLength(2);
  });

  it("a class of units needs the players to own something at all", () => {
    expect(() => checkDesign(design([system("last-standing")], preset), input)).toThrow(/counts on the players owning units/);
    expect(() => checkDesign(design([system("last-standing", { unit: "Buildings" })], preset), input)).toThrow(/counts on the players owning units/);
    expect(checkDesign(design([system("last-standing"), system("start-units", { units: "Terran Marine", location: "Base {p}" })], preset), input).systems).toHaveLength(2);
  });

  it("is not asked of a planned layout, which may place units from the brief, or of an older plugin", () => {
    const planned = { locations: [{ name: "Base 1", purpose: "" }, { name: "Base 2", purpose: "" }, { name: "End", purpose: "" }] };
    expect(checkDesign(design([shop, ending], planned), input).systems).toHaveLength(2);
    const older = { ...input, systemKinds: input.systemKinds.map(({ creates: _creates, ...k }) => k) };
    expect(checkDesign(design([shop, ending], preset), older).systems).toHaveLength(2);
  });
});

describe("a preset's locations are the only ones", () => {
  const lanes = { layout: { preset: "lanes", params: [{ key: "lanes", value: "2" }] } };
  it("a location the design adds of its own is not one a system may use", () => {
    // What a model wrote when told its list was not a location: a name of its own, which nothing would ever draw.
    const d = design([system("waves", { spawn: "Lane Heads" }), system("lives", { goal: "Goal" })], { ...lanes, locations: [{ name: "Lane Heads", purpose: "both spawns" }, { name: "Goal", purpose: "" }] });
    expect(() => checkDesign(d, input)).toThrow(/"Lane Heads", which is not among the locations the lanes preset makes \(Lane \{n\}, Base \{p\}, Goal\)/);
  });

  it("one it adds and does not use is left out, with a note", () => {
    const d = checkDesign(design([system("waves", { spawn: "Lane 1" }), system("lives", { goal: "Goal" })], { ...lanes, locations: [{ name: "Goal", purpose: "" }, { name: "Scenic Overlook", purpose: "" }] }), input);
    expect(d.locations.map((l) => l.name)).toEqual(["Goal"]);
    expect(d.notes.join(" ")).toMatch(/Left out, because the lanes preset does not make it.*Scenic Overlook/);
  });

  it("without a preset the design's own locations stand", () => {
    const d = checkDesign(design([system("waves", { spawn: "Lane Heads" }), system("lives", { goal: "End" })], { locations: [{ name: "Lane Heads", purpose: "" }, { name: "End", purpose: "" }] }), input);
    expect(d.locations).toHaveLength(2);
  });
});

describe("two shops on one pad", () => {
  it("need different buyers, or the second never sells", () => {
    const kit = system("start-units", { units: "Terran SCV, Terran Marine", location: "Base {p}" });
    const ending = system("custom", {}, "When the gate falls every human player is Defeated; when the last wave is dead they get Victory.");
    const lanes = { layout: { preset: "lanes", params: [{ key: "lanes", value: "2" }] } };
    const marine = { ...system("shop", { location: "Base {p}", buyer: "Terran SCV" }), name: "Marines" };
    const tank = { ...system("shop", { location: "Base {p}", buyer: "Terran SCV" }), name: "Tanks" };
    expect(() => checkDesign(design([kit, ending, marine, tank], lanes), input)).toThrow(/"Marines" and "Tanks" \(shop\) both wait for terran scv at Base \{p\}/);
    expect(checkDesign(design([kit, ending, marine, { ...tank, params: [{ key: "location", value: "Base {p}" }, { key: "buyer", value: "Terran Marine" }] }], lanes), input).systems).toHaveLength(4);
  });
});
