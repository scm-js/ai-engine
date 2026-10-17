import { describe, expect, it } from "vitest";
import { FakeClaudeClient, ClaudeError, systemBlocks } from "../src/claude.js";
import { checkDesign } from "../src/recipes/umsDesign.js";
import { fromSdkContent, trimMessages } from "../src/recipes/agent.js";
import { RECIPES, runRecipe, repairMaxTokens } from "../src/recipes/index.js";
import { LocationRect, autoSymmetry, normalizeLayout } from "../src/recipes/plan.js";
import { SHAPE_OPS, shapeSchema } from "../src/recipes/shapes.js";
import { RecipeOutputError, factsText, parseJson } from "../src/recipes/types.js";
import type { AgentMessage, MapFacts, MapPlanInput, StringsInput, UmsDesignInput } from "../src/protocol.js";

const ctx6 = { maxAgentMessages: 6 };

const terrains = [
  { id: 1, name: "Water", height: 0 as const, buildable: false },
  { id: 2, name: "Dirt", height: 0 as const, buildable: true },
  { id: 3, name: "Mud", height: 0 as const, buildable: false },
  { id: 4, name: "High Dirt", height: 1 as const, buildable: true },
  { id: 5, name: "Very High Dirt", height: 2 as const, buildable: true },
];
const ctx = { cellSize: 4, columns: 4, rows: 3, width: 16, height: 12, terrains, doodadCategories: ["Trees", "Rocks"], unitNames: ["Terran Marine", "Mineral Field (Type 1)"] };

const goodRaw = {
  legend: [{ char: "W", terrain: 1 }, { char: "d", terrain: 2 }, { char: "h", terrain: 4 }],
  grid: ["WWWW", "dddd", "hhhh"],
  bases: [{ kind: "main", x: 2, y: 4, mineralDirection: "w", minerals: 8, geysers: 1, player: 1 }],
  ramps: [{ x: 8, y: 8, direction: "n" }],
  doodads: [{ category: "trees", on: "dx", density: 0.3 }],
  units: [{ unit: "terran marine", player: 1, x: 5, y: 5, amount: 0 }, { unit: "Zergling", player: 1, x: 1, y: 1, amount: 0 }],
  locations: [{ name: "Start", x0: 0, y0: 0, x1: 4, y1: 4 }, { name: "Empty", x0: 3, y0: 3, x1: 3, y1: 9 }],
  notes: ["hello"],
};

describe("layout normalisation", () => {
  it("accepts a clean plan and canonicalises what it can", () => {
    const { plan, repairs, warnings } = normalizeLayout(goodRaw, ctx);
    expect(plan.legend).toEqual({ W: 1, d: 2, h: 4 });
    expect(plan.grid).toEqual(["WWWW", "dddd", "hhhh"]);
    expect(plan.bases[0]).toMatchObject({ kind: "main", x: 2, y: 4, player: 1 });
    expect(plan.doodads).toEqual([{ category: "Trees", on: "d", density: 0.3 }]);
    expect(plan.units).toEqual([{ unit: "Terran Marine", player: 1, x: 5, y: 5 }]);
    expect(plan.locations).toEqual([{ name: "Start", x0: 0, y0: 0, x1: 4, y1: 4 }]);
    expect(repairs.join(" ")).toMatch(/Zergling/);
    expect(repairs.join(" ")).toMatch(/Empty/);
    expect(plan.notes[0]).toBe("hello");
    expect(warnings).toEqual([]);
  });

  it("pads short rows, trims long ones, repeats the last row, and warns on height jumps", () => {
    const raw = { ...goodRaw, grid: ["WWWWWW", "dd", "hh hh"], legend: [{ char: "W", terrain: 1 }, { char: "d", terrain: 2 }, { char: "h", terrain: 5 }] };
    const { plan, repairs, warnings } = normalizeLayout(raw, ctx);
    expect(plan.grid).toEqual(["WWWW", "dddd", "hhhh"]);
    expect(repairs.some((r) => r.includes("shorter"))).toBe(true);
    expect(repairs.some((r) => r.includes("longer"))).toBe(true);
    expect(warnings[0]).toMatch(/jump two height levels/);
    const few = normalizeLayout({ ...goodRaw, grid: ["WWWW", "dddd"] }, ctx);
    expect(few.plan.grid).toEqual(["WWWW", "dddd", "dddd"]);
  });

  it("refuses unknown legend characters, unknown terrain ids and bad enums", () => {
    expect(() => normalizeLayout({ ...goodRaw, grid: ["WWWW", "dddd", "hhxh"] }, ctx)).toThrow(RecipeOutputError);
    expect(() => normalizeLayout({ ...goodRaw, legend: [{ char: "W", terrain: 99 }, { char: "d", terrain: 2 }, { char: "h", terrain: 4 }] }, ctx)).toThrow(/does not have/);
    expect(() => normalizeLayout({ ...goodRaw, bases: [{ ...goodRaw.bases[0], mineralDirection: "up" }] }, ctx)).toThrow(/mineral direction/);
    expect(() => normalizeLayout({ ...goodRaw, ramps: [{ x: 1, y: 1, direction: "down" }] }, ctx)).toThrow(/ramp direction/);
    expect(() => normalizeLayout({ grid: [] }, ctx)).toThrow(RecipeOutputError);
  });

  it("clamps coordinates into the area", () => {
    const { plan, repairs } = normalizeLayout({ ...goodRaw, bases: [{ kind: "expansion", x: 40, y: -3, mineralDirection: "e", minerals: 30, geysers: 9, player: 0 }] }, ctx);
    expect(plan.bases[0]).toEqual({ kind: "expansion", x: 12, y: 0, mineralDirection: "e", minerals: 16, geysers: 4 });
    expect(repairs.some((r) => r.includes("outside the area"))).toBe(true);
    const region = normalizeLayout({ ...goodRaw, units: [{ unit: "Terran Marine", player: 1, x: 1, y: 1, amount: 0 }] }, { ...ctx, originX: 8, originY: 4, columns: 2, rows: 2, grid: undefined } as never);
    expect(region.plan.units).toEqual([]);
  });

  it("accepts a legend given as an object", () => {
    const { plan } = normalizeLayout({ ...goodRaw, legend: { W: 1, d: 2, h: 4 } }, ctx);
    expect(plan.legend).toEqual({ W: 1, d: 2, h: 4 });
  });

  it("picks a symmetry from the player count", () => {
    expect(autoSymmetry(2, 128, 128)).toBe("rot180");
    expect(autoSymmetry(4, 128, 128)).toBe("quad");
    expect(autoSymmetry(4, 128, 96)).toBe("rot180");
    expect(autoSymmetry(8, 256, 256)).toBe("octo");
  });
});

describe("recipes", () => {
  const facts: MapFacts = {
    name: "Test", description: "", width: 64, height: 64, tileset: "badlands",
    players: [{ slot: 0, type: "Human", race: "Terran", force: 0, hasStart: true }, { slot: 7, type: "Inactive", race: "Zerg", force: 0, hasStart: false }],
    statistics: ["Units: 3"], units: ["Terran Marine × 3 (Player 1)"], locations: ["Base"], triggerCount: 2, briefingCount: 0, triggersText: "Trigger(...)",
  };

  it("renders facts as text and drops inactive players", () => {
    const text = factsText(facts);
    expect(text).toContain("Players (1):");
    expect(text).toContain("Trigger(...)");
    expect(factsText(facts, { triggers: false })).not.toContain("Trigger(...)");
  });

  it("tolerates a fenced JSON answer", () => {
    expect(parseJson("```json\n{\"a\":1}\n```")).toEqual({ a: 1 });
    expect(() => parseJson("not json")).toThrow(RecipeOutputError);
  });

  it("map-plan builds a prompt with the vocabulary and parses a plan", async () => {
    const input: MapPlanInput = { prompt: "two player map", width: 16, height: 12, tileset: "badlands", terrains, doodadCategories: ["Trees"], unitNames: ["Terran Marine"], players: 2, symmetry: "auto", cellSize: 4 };
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ ...goodRaw, name: "A name that is far too long to keep whole here", description: "Nice.", symmetry: "mirror-x" }) });
    const { output } = await runRecipe(claude, ctx6, { recipe: RECIPES["map-plan"], input, model: "claude-opus-5", effort: "high", maxTokens: 1000, thinking: false });
    expect(output.name).toHaveLength(40);
    expect(output.symmetry).toBe("mirror-x");
    expect(output.columns).toBe(4);
    const call = claude.calls[0]!;
    expect(call.outputSchema).toBeTruthy();
    expect(JSON.stringify(call.messages)).toContain("High Dirt");
    expect(JSON.stringify(call.messages)).toContain("Symmetry: rot180");
  });

  it("map-plan in the shape language: the language is a system block, the answer is shapes, a plateau of low ground is refused", async () => {
    const input: MapPlanInput = { prompt: "a madness map", width: 64, height: 64, tileset: "badlands", terrains, doodadCategories: ["Trees"], unitNames: ["Terran Marine"], players: 4, symmetry: "auto", cellSize: 2, language: "shapes", rampPairs: [{ low: 2, high: 4 }], bridgePair: { ground: 2, water: 1 } };
    const good = {
      name: "Corners", description: "Four corners.",
      shapes: [
        { op: "ground", terrain: 2 },
        { op: "plateau", terrain: 4, x: 2, y: 2, w: 24, h: 18, ramps: ["se"] },
        { op: "lane", terrain: 2, points: [[10, 30], [50, 30]], width: 4, wall: 1, wallWidth: 2 },
        { op: "ramp", x: 40, y: 40, side: "up" },
        { op: "bridge", x: 50, y: 50, along: "sw" },
        { op: "stroke", terrain: 1, points: [[0, 60], [63, 60]], width: 8, bridges: [[30, 60], [99]], bank: 2, bankWidth: 5 },
      ],
      bases: [{ kind: "main", x: 8, y: 8, mineralDirection: "w", minerals: 8, geysers: 1, player: 1 }],
      ramps: [{ x: 5, y: 5, direction: "n" }], doodads: [{ category: "Trees", terrains: [2, 99], density: 0.2 }], units: [], locations: [{ name: "Arena", x0: 20, y0: 20, x1: 40, y1: 40 }], notes: ["ok"],
    };
    const bad = { ...good, shapes: [{ op: "ground", terrain: 2 }, { op: "plateau", terrain: 2, x: 2, y: 2, w: 24, h: 18, ramps: ["sw"] }] };
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify(bad) }, { text: JSON.stringify(good) });
    const { output, calls } = await runRecipe(claude, ctx6, { recipe: RECIPES["map-plan"], input, model: "claude-opus-5", effort: "high", maxTokens: 1000, thinking: false });
    expect(calls).toHaveLength(2);
    expect(JSON.stringify(claude.calls[1]!.messages[2])).toContain("high ground");
    expect(output.shapes).toHaveLength(6);
    expect(output.shapes![3]).toMatchObject({ op: "ramp", side: "sw" });
    expect(output.shapes![4]).toMatchObject({ op: "bridge", along: "sw" });
    expect(output.shapes![5]).toMatchObject({ op: "stroke", bridges: [[30, 60]], bank: 2, bankWidth: 5 });
    expect(JSON.stringify(call0Messages(claude))).toContain("Bridges: this tileset has bridges");
    expect(output.symmetry).toBe("none");
    expect(output.columns).toBe(64);
    expect(output.grid).toEqual([]);
    expect(output.ramps).toEqual([]);
    expect(output.doodads[0]).toMatchObject({ category: "Trees", terrains: [2], on: "" });
    expect(output.notes.some((n) => n.includes("Repaired"))).toBe(true);
    const call = claude.calls[0]!;
    expect(call.systemExtra?.[0]).toContain("The shape language");
    expect(call.systemExtra?.[0]).toContain("`bridge`");
    // No structured-output schema for shapes: the API's grammar compiler refuses it.
    expect(call.outputSchema).toBeUndefined();
    expect(call.system).not.toContain("legend");
    expect(JSON.stringify(call.messages[0])).toContain("ramps between Dirt (2) and High Dirt (4)");
  });

  it("gives the model one repair round and then gives up", async () => {
    const input: MapPlanInput = { prompt: "x", width: 16, height: 12, tileset: "badlands", terrains, doodadCategories: [], unitNames: [], players: 2, symmetry: "rot180", cellSize: 4 };
    const claude = new FakeClaudeClient().answer({ text: "{ \"legend\": [], \"grid\": [] }" }, { text: JSON.stringify(goodRaw) });
    const { output, calls } = await runRecipe(claude, ctx6, { recipe: RECIPES["map-plan"], input, model: "claude-opus-5", effort: "high", maxTokens: 1000, thinking: false });
    expect(calls).toHaveLength(2);
    expect(output.grid).toHaveLength(3);
    const repair = claude.calls[1]!.messages;
    expect(repair).toHaveLength(3);
    expect(JSON.stringify(repair[2])).toContain("could not be used");
    expect(JSON.stringify(repair[2])).toContain("Fix only what is listed");
    // The repair round is mechanical: low effort, no thinking, a budget sized by the first answer, never over the recipe's.
    expect(claude.calls[1]!.effort).toBe("low");
    expect(claude.calls[1]!.thinking).toBe(false);
    expect(claude.calls[1]!.maxTokens).toBe(1000);
    expect(repairMaxTokens(32_000, 5_730)).toBe(15_460);
    expect(repairMaxTokens(32_000, 500)).toBe(8_000);
    expect(repairMaxTokens(6_000, 5_000)).toBe(6_000);

    const stubborn = new FakeClaudeClient().answer({ text: "nope" }, { text: "still nope" });
    await expect(runRecipe(stubborn, ctx6, { recipe: RECIPES["map-plan"], input, model: "claude-opus-5", effort: "high", maxTokens: 1000, thinking: false })).rejects.toMatchObject({ code: "upstream" });
  });

  it("turns a refusal into the refused error", async () => {
    const claude = new FakeClaudeClient().answer({ refusal: "cyber" });
    await expect(runRecipe(claude, ctx6, { recipe: RECIPES.describe, input: { facts }, model: "claude-opus-5", effort: "low", maxTokens: 100, thinking: false })).rejects.toMatchObject({ code: "refused", message: /cyber/ });
    expect(new ClaudeError("refused", "x").code).toBe("refused");
  });

  it("strings keeps every index and fills in what the model left out", async () => {
    const input: StringsInput = { instruction: "Translate to German", strings: [{ index: 1, text: "Hello", usage: ["scenario name"] }, { index: 2, text: "<07>Go", usage: [] }, { index: 3, text: "Keep", usage: [] }] };
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ strings: [{ index: 2, text: "<07>Los" }, { index: 1, text: "Hallo" }, { index: 9, text: "stray" }] }) });
    const { output } = await runRecipe(claude, ctx6, { recipe: RECIPES.strings, input, model: "claude-opus-5", effort: "low", maxTokens: 100, thinking: false });
    expect(output.strings).toEqual([{ index: 1, text: "Hallo" }, { index: 2, text: "<07>Los" }, { index: 3, text: "Keep" }]);
    const lazy = new FakeClaudeClient().answer({ text: JSON.stringify({ strings: [] }) }, { text: JSON.stringify({ strings: [] }) });
    await expect(runRecipe(lazy, ctx6, { recipe: RECIPES.strings, input: { ...input, strings: Array.from({ length: 30 }, (_, i) => ({ index: i + 1, text: "t", usage: [] })) }, model: "claude-opus-5", effort: "low", maxTokens: 100, thinking: false })).rejects.toMatchObject({ code: "upstream" });
  });

  it("explain-triggers streams text and returns it whole", async () => {
    const claude = new FakeClaudeClient().answer({ text: "This map does things.  " });
    const pieces: string[] = [];
    const { output } = await runRecipe(claude, ctx6, { recipe: RECIPES["explain-triggers"], input: { text: "Trigger()" }, model: "claude-opus-5", effort: "low", maxTokens: 100, thinking: false, onText: (t) => pieces.push(t) });
    expect(pieces.join("")).toBe("This map does things.  ");
    expect(output.text).toBe("This map does things.");
    expect(claude.calls[0]!.outputSchema).toBeUndefined();
  });

  it("review sorts findings and drops coordinates outside the map", async () => {
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ summary: "ok", findings: [{ severity: "info", title: "a", detail: "d", x: -1, y: -1 }, { severity: "problem", title: "b", detail: "d", x: 3, y: 4 }, { severity: "warning", title: "c", detail: "d", x: 999, y: 1 }] }) });
    const { output } = await runRecipe(claude, ctx6, { recipe: RECIPES.review, input: { facts, image: { mediaType: "image/png", data: "AAAA" }, issues: ["x"] }, model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false });
    expect(output.findings.map((f) => f.severity)).toEqual(["problem", "warning", "info"]);
    expect(output.findings[0]).toMatchObject({ x: 3, y: 4 });
    expect(output.findings[1]).not.toHaveProperty("x");
    const content = claude.calls[0]!.messages[0]!.content as { type: string }[];
    expect(content[0]!.type).toBe("image");
  });

  it("a location written as x, y, w, h is taken as the rectangle it means", () => {
    expect(LocationRect.parse({ name: "Goal", x: 40, y: 60, w: 16, h: 4 })).toEqual({ name: "Goal", x0: 40, y0: 60, x1: 56, y1: 64 });
    expect(LocationRect.parse({ name: "Goal", x0: 1, y0: 2, x1: 3, y1: 4 })).toEqual({ name: "Goal", x0: 1, y0: 2, x1: 3, y1: 4 });
  });

  it("the shape schema is one closed object per op, none with more than three optional keys", () => {
    const schema = shapeSchema(true) as { properties: { shapes: { items: { anyOf: { properties: Record<string, unknown>; required: string[] }[] } } } };
    const variants = schema.properties.shapes.items.anyOf;
    expect(variants.length).toBeGreaterThanOrEqual(10);
    const ops = variants.flatMap((v) => (v.properties.op as { enum: string[] }).enum);
    expect([...ops].sort()).toEqual([...SHAPE_OPS].sort());
    for (const v of variants) {
      const optional = Object.keys(v.properties).filter((k) => !v.required.includes(k));
      expect(optional.length).toBeLessThanOrEqual(3);
      expect(v.required).toContain("op");
    }
  });

  it("triggers puts the declarations and the request under cache breakpoints and handles repair rounds", async () => {
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ script: "trigger([Players.Player1], [], [Victory()]);\r\n", summary: "wins" }) });
    const { output } = await runRecipe(claude, ctx6, { recipe: RECIPES.triggers, input: { prompt: "win", declarations: "declare function Victory(): Action;", existingTriggers: "Trigger(\"Player 1\"){}", script: "program(() => {});", repair: { script: "bad", diagnostics: [{ line: 1, column: 2, message: "oops" }] } }, model: "claude-opus-5", effort: "high", maxTokens: 100, thinking: false });
    expect(output.script).toBe("trigger([Players.Player1], [], [Victory()]);\n");
    const content = claude.calls[0]!.messages[0]!.content as { type: string; text?: string; cache_control?: unknown }[];
    // Declarations, hand-made triggers, current script, request, repair: the same order as
    // the first round, so the repair round reads the prefix the first round wrote.
    expect(content.map((c) => [c.text?.split("\n")[0], !!c.cache_control])).toEqual([
      ["## Declarations for this map", true],
      ["## Hand-made triggers already on the map (outside the script; do not recreate them)", false],
      ["## The map's current script (extend or edit it; return the whole script)", false],
      ["## The request", true],
      ["## Repair", false],
    ]);
    expect(content.some((c) => c.text?.includes("line 1, column 2: oops"))).toBe(true);
    // From the dialog, the map's blocks go on the one-hour cache, each its own breakpoint, before the five-minute request.
    claude.answer({ text: JSON.stringify({ script: "trigger([Players.Player1], [], [Victory()]);", summary: "wins" }) });
    await runRecipe(claude, ctx6, { recipe: RECIPES.triggers, input: { prompt: "win", declarations: "d", existingTriggers: "t", script: "s", iterative: true }, model: "claude-opus-5", effort: "high", maxTokens: 100, thinking: false });
    const hour = claude.calls[1]!.messages[0]!.content as { text?: string; cache_control?: { ttl?: string } }[];
    expect(hour.map((c) => [c.text?.split("\n")[0], c.cache_control?.ttl ?? (c.cache_control ? "5m" : null)])).toEqual([
      ["## Declarations for this map", "1h"],
      ["## Hand-made triggers already on the map (outside the script; do not recreate them)", "1h"],
      ["## The map's current script (extend or edit it; return the whole script)", null],
      ["## The request", "5m"],
    ]);
  });

  it("trims a brief followed by a long run of tool rounds from an assistant turn, so no tool result loses its tool_use", () => {
    const history: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "build the whole map" }] }];
    for (let i = 0; i < 40; i++) {
      history.push({ role: "assistant", content: [{ type: "tool_use", id: `t${i}`, name: "paint", input: { n: i } }] });
      history.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: "done" }] });
    }
    const trimmed = trimMessages(history, 60);
    expect(trimmed.length).toBeLessThanOrEqual(60);
    expect(trimmed[0]).toBe(history[0]);
    expect(trimmed[1]!.role).toBe("assistant");
    expect(trimmed[trimmed.length - 1]).toBe(history[history.length - 1]);
    for (let i = 1; i < trimmed.length; i++) {
      for (const c of trimmed[i]!.content) {
        if (c.type !== "tool_result") continue;
        expect(trimmed[i - 1]!.content.some((p) => p.type === "tool_use" && p.id === c.toolUseId)).toBe(true);
      }
    }
  });

  it("agent converts messages both ways, appends the map state, and trims history", async () => {
    const history: AgentMessage[] = [{ role: "user", content: [{ type: "text", text: "add marines" }] }];
    for (let i = 0; i < 5; i++) {
      history.push({ role: "assistant", content: [{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: `t${i}`, name: "place_units", input: { n: i } }] });
      history.push({ role: "user", content: [{ type: "tool_result", toolUseId: `t${i}`, content: [{ type: "text", text: "done" }, { type: "image", source: { mediaType: "image/png", data: "AA" } }] }] });
    }
    history.push({ role: "user", content: [{ type: "text", text: "now what?" }] });
    const trimmed = trimMessages(history, 6);
    expect(trimmed[0]!.content[0]).toEqual({ type: "text", text: "add marines" });
    expect(trimmed[1]!.role).toBe("user");
    expect(trimmed[1]!.content[0]!.type).toBe("text");

    const claude = new FakeClaudeClient().answer({
      text: "Placing.",
      stopReason: "tool_use",
      content: [
        { type: "thinking", thinking: "", signature: "s" } as never,
        { type: "text", text: "Placing.", citations: null } as never,
        { type: "tool_use", id: "t9", name: "place_units", input: { unit: "Terran Marine" } } as never,
        { type: "server_tool_use", id: "x", name: "web_search", input: {} } as never,
      ],
    });
    const { output } = await runRecipe(claude, ctx6, {
      recipe: RECIPES.agent,
      input: { messages: history, tools: [{ name: "place_units", description: "d", inputSchema: { properties: { unit: { type: "string" } }, required: ["unit"] } }], facts: { ...facts, selection: ["3 units: Terran Marine × 3 (Player 1)"], view: "tiles 0,0–32,24 at zoom 1", history: "undo: paint" }, reference: "## Terrains\n1 Dirt" },
      model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false,
    });
    expect(output.stopReason).toBe("tool_use");
    expect(output.content).toEqual([
      { type: "thinking", thinking: "", signature: "s" },
      { type: "text", text: "Placing." },
      { type: "tool_use", id: "t9", name: "place_units", input: { unit: "Terran Marine" } },
    ]);
    const call = claude.calls[0]!;
    expect(call.messages.length).toBeLessThanOrEqual(6);
    const last = call.messages[call.messages.length - 1]!.content as { type: string; text?: string }[];
    expect(last[last.length - 1]!.text).toContain("<map_state>");
    expect(last[last.length - 1]!.text).toContain("Selected right now:\n  3 units");
    expect(last[last.length - 1]!.text).toContain("View: tiles 0,0");
    // The breakpoint sits on the plugin's own last block, not on the state block that changes every turn.
    expect((last[last.length - 2] as { cache_control?: unknown }).cache_control).toEqual({ type: "ephemeral" });
    expect((last[last.length - 1] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect(call.systemExtra).toEqual(["<reference>\n## Terrains\n1 Dirt\n</reference>"]);
    expect(call.tools![0]).toEqual({ name: "place_units", description: "d", input_schema: { type: "object", properties: { unit: { type: "string" } }, required: ["unit"] } });
    // Trimming left the opening question and the last clean user message (plus the state block).
    expect(call.messages).toHaveLength(2);
    expect((call.messages[1]!.content as { type: string }[]).map((c) => c.type)).toEqual(["text", "text"]);
    expect(fromSdkContent([])).toEqual([]);

    // Without trimming, tool results convert to the SDK's shape, images included.
    const short = new FakeClaudeClient().answer({ text: "ok" });
    await runRecipe(short, ctx6, { recipe: RECIPES.agent, input: { messages: history.slice(0, 3), tools: [], facts }, model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false });
    const converted = short.calls[0]!.messages;
    expect(converted).toHaveLength(3);
    expect(converted[1]!.content).toEqual([{ type: "thinking", thinking: "", signature: "sig" }, { type: "tool_use", id: "t0", name: "place_units", input: { n: 0 } }]);
    const result = (converted[2]!.content as { type: string; tool_use_id?: string; content?: unknown }[])[0]!;
    expect(result.type).toBe("tool_result");
    expect(result.tool_use_id).toBe("t0");
    expect(result.content).toEqual([{ type: "text", text: "done" }, { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } }]);
  });

  it("agent streams its text and its tool-call starts; a json recipe streams its text too, so a client can show it growing", async () => {
    const claude = new FakeClaudeClient().answer({
      text: "On it.",
      stopReason: "tool_use",
      content: [{ type: "text", text: "On it.", citations: null } as never, { type: "tool_use", id: "t1", name: "list_units", input: {} } as never],
    });
    const text: string[] = [];
    const tools: [string, string][] = [];
    await runRecipe(claude, ctx6, {
      recipe: RECIPES.agent, input: { messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }], tools: [], facts },
      model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false,
      onText: (t) => text.push(t), onToolUse: (id, name) => tools.push([id, name]),
    });
    expect(text.join("")).toBe("On it.");
    expect(tools).toEqual([["t1", "list_units"]]);
    const quiet = new FakeClaudeClient().answer({ text: JSON.stringify({ name: "N", description: "d", alternatives: [] }) });
    const deltas: string[] = [];
    await runRecipe(quiet, ctx6, { recipe: RECIPES.describe, input: { facts }, model: "claude-opus-5", effort: "low", maxTokens: 100, thinking: false, onText: (t) => deltas.push(t) });
    expect(deltas.join("")).toContain('"name":"N"');
  });

  it("puts the system blocks on the one-hour cache, one breakpoint each, skipping blank extras, three breakpoints at most", () => {
    const blocks = systemBlocks({ system: "sys", systemExtra: ["ref", "  ", "more"] });
    expect(blocks.map((b) => [b.text, b.cache_control])).toEqual([
      ["sys", { type: "ephemeral", ttl: "1h" }],
      ["ref", { type: "ephemeral", ttl: "1h" }],
      ["more", { type: "ephemeral", ttl: "1h" }],
    ]);
    // Three layers: the prompt has no breakpoint of its own; the first layer's covers it.
    const four = systemBlocks({ system: "sys", systemExtra: ["game", "tileset", "map"] });
    expect(four.map((b) => [b.text, !!b.cache_control])).toEqual([["sys", false], ["game", true], ["tileset", true], ["map", true]]);
    expect(systemBlocks({ system: "sys" }).map((b) => !!b.cache_control)).toEqual([true]);
  });

  it("agent takes the reference as layers, one block each, and then leaves the map's identity out of the state block", async () => {
    const claude = new FakeClaudeClient().answer({ text: "ok" }).answer({ text: "ok" });
    const input = { messages: [{ role: "user" as const, content: [{ type: "text" as const, text: "hi" }] }], tools: [], facts: { ...facts, selection: ["1 unit selected"] } };
    await runRecipe(claude, ctx6, { recipe: RECIPES.agent, input: { ...input, reference: ["## Units", " ", "## This map\nName: T"] }, model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false });
    expect(claude.calls[0]!.systemExtra).toEqual(["<reference>\n## Units\n</reference>", "<reference>\n## This map\nName: T\n</reference>"]);
    const stateOf = (i: number) => { const c = claude.calls[i]!.messages[0]!.content as { text?: string }[]; return c[c.length - 1]!.text!; };
    expect(stateOf(0)).not.toContain("Name: T");
    expect(stateOf(0)).not.toContain("Players (");
    expect(stateOf(0)).toContain("Selected right now:");
    await runRecipe(claude, ctx6, { recipe: RECIPES.agent, input, model: "claude-opus-5", effort: "medium", maxTokens: 100, thinking: false });
    expect(claude.calls[1]!.systemExtra).toBeUndefined();
    expect(stateOf(1)).toContain("Name: T");
  });

  it("agent refuses a conversation that does not end with the user", () => {
    const r = RECIPES.agent.input.safeParse({ messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }, { role: "assistant", content: [{ type: "text", text: "yo" }] }], tools: [], facts });
    expect(r.success).toBe(false);
  });
});

function call0Messages(claude: FakeClaudeClient): unknown { return claude.calls[0]!.messages[0]; }

describe("ums-design", () => {
  const input: UmsDesignInput = {
    prompt: "a madness map", width: 128, height: 128, tileset: "jungle", players: 4,
    terrains, unitNames: ["Terran Marine", "Zerg Zergling"],
    systemKinds: [
      { kind: "hyper", description: "Hyper triggers.", params: [] },
      { kind: "spawn", description: "Spawn units at a location on a timer.", params: [{ name: "location", description: "the spawn location", required: true }, { name: "unit", description: "unit name", required: true }, { name: "every", description: "seconds", required: false }] },
      { kind: "last-standing", description: "Victory for the last force with units.", params: [] },
    ],
    scriptPlugin: false,
  };
  const good = {
    name: "Jungle Madness", description: "Four players, endless spawns.", genre: "madness", premise: "Spawns.",
    players: [{ slot: 1, type: "human" as const, race: "userSelect" as const, force: 1, role: "player" }, { slot: 5, type: "computer" as const, race: "zerg" as const, force: 2, role: "spawner" }],
    forces: [{ index: 1, name: "Players", allied: false, alliedVictory: false, sharedVision: false }, { index: 2, name: "Swarm", allied: true, alliedVictory: false, sharedVision: false }],
    layoutBrief: "An arena.", locations: [{ name: "Spawn 1", purpose: "player 1's spawn" }],
    systems: [
      { name: "Hypers", kind: "hyper", params: [], description: "" },
      { name: "Spawns", kind: "spawn", params: [{ key: "location", value: "Spawn 1" }, { key: "unit", value: "Zerg Zergling" }], description: "zerglings" },
      { name: "Win", kind: "last-standing", params: [], description: "" },
    ],
    objectives: "Survive.", briefing: ["Go."], notes: [],
  };

  it("accepts a design that uses the toolkit's kinds and trims it", () => {
    const d = checkDesign({ ...good, name: "  Jungle Madness  " }, input);
    expect(d.name).toBe("Jungle Madness");
    expect(d.systems.map((s) => s.kind)).toEqual(["hyper", "spawn", "last-standing"]);
    expect(d.players).toHaveLength(2);
  });

  it("takes a layout preset, adds its locations to the known names, and refuses one the editor lacks", () => {
    const withPresets = { ...input, presets: [{ id: "corner-camps", description: "Camps.", params: [{ name: "camps", description: "how many", required: false }], locations: ["Base {p}", "Spawn {p}", "Arena"] }] };
    const design = { ...good, layout: { preset: "corner-camps", params: [{ key: "camps", value: "4" }] }, locations: [], systems: [good.systems[0]!, { ...good.systems[1]!, params: [{ key: "location", value: "Spawn {p}" }, { key: "unit", value: "Zerg Zergling" }] }, good.systems[2]!] };
    const d = checkDesign(design, withPresets);
    expect(d.layout).toEqual({ preset: "corner-camps", params: [{ key: "camps", value: "4" }] });
    expect(() => checkDesign({ ...design, layout: { preset: "castle", params: [] } }, withPresets)).toThrow(/preset "castle"/);
    expect(() => checkDesign({ ...design, layout: { preset: "corner-camps", params: [{ key: "moat", value: "1" }] } }, withPresets)).toThrow(/"moat"/);
    expect(checkDesign({ ...design, layout: { preset: "", params: [] }, locations: [{ name: "Spawn 1", purpose: "" }] }, withPresets).layout).toBeUndefined();
  });

  it("checks a comma-separated location list one name at a time, and knows a preset's numbered locations far past four", () => {
    const withBound = { ...input, presets: [{ id: "bound", description: "A course.", params: [], locations: ["Start", "Finish", "Checkpoint {n}", "Spot {n}"] }], systemKinds: [...input.systemKinds, { kind: "obstacles", description: "Explosions.", params: [{ name: "spots", description: "the spot locations in firing order, comma-separated", required: true }] }] };
    const design = { ...good, layout: { preset: "bound", params: [] }, locations: [], systems: [good.systems[0]!, { name: "Sweep", kind: "obstacles", params: [{ key: "spots", value: "Spot 17, Spot 18, Spot 24" }], description: "" }, good.systems[2]!] };
    expect(checkDesign(design, withBound).systems[1]!.params[0]!.value).toBe("Spot 17, Spot 18, Spot 24");
    expect(() => checkDesign({ ...design, systems: [good.systems[0]!, { name: "Sweep", kind: "obstacles", params: [{ key: "spots", value: "Spot 1, Pit 9" }], description: "" }, good.systems[2]!] }, withBound)).toThrow(/Pit 9/);
  });

  it("takes a {p} location template when a numbered location backs it", () => {
    const withTemplate = { ...good, locations: [{ name: "Spawn 1", purpose: "" }, { name: "Spawn 2", purpose: "" }], systems: [good.systems[0]!, { ...good.systems[1]!, params: [{ key: "location", value: "Spawn {p}" }, { key: "unit", value: "Zerg Zergling" }] }, good.systems[2]!] };
    expect(checkDesign(withTemplate, input).systems[1]!.params[0]!.value).toBe("Spawn {p}");
    const unbacked = { ...withTemplate, systems: [good.systems[0]!, { ...good.systems[1]!, params: [{ key: "location", value: "Pit {p}" }, { key: "unit", value: "Zerg Zergling" }] }, good.systems[2]!] };
    expect(() => checkDesign(unbacked, input)).toThrow(/names location "Pit 1".*numbered location for every player/);
  });

  it("names every problem the plugin could not build from", () => {
    const bad = {
      ...good,
      players: [{ slot: 9, type: "human" as const, race: "terran" as const, force: 5, role: "" }],
      systems: [
        { name: "Mystery", kind: "wave", params: [], description: "" },
        { name: "Spawns", kind: "spawn", params: [{ key: "location", value: "Nowhere" }, { key: "speed", value: "3" }], description: "" },
        { name: "Boss", kind: "custom", params: [], description: "short" },
      ],
    };
    try {
      checkDesign(bad, input);
      throw new Error("accepted");
    } catch (err) {
      expect(err).toBeInstanceOf(RecipeOutputError);
      const problems = (err as RecipeOutputError).problems;
      expect(problems.some((p) => p.includes('kind "wave"'))).toBe(true);
      expect(problems.some((p) => p.includes('lacks the required parameter "unit"'))).toBe(true);
      expect(problems.some((p) => p.includes('"Nowhere"'))).toBe(true);
      expect(problems.some((p) => p.includes('parameter "speed"'))).toBe(true);
      expect(problems.some((p) => p.includes("TrigScript plugin is off"))).toBe(true);
      expect(problems.some((p) => p.includes("outside 1–8"))).toBe(true);
      expect(problems.some((p) => p.includes("no human player"))).toBe(true);
    }
    // Custom is fine when the script plugin is on and the spec is written out.
    const d = checkDesign({ ...good, systems: [...good.systems, { name: "Boss", kind: "custom", params: [], description: "When Player 1 brings a unit to Spawn 1, create a Zerg Ultralisk there for the computer and show a message." }] }, { ...input, scriptPlugin: true });
    expect(d.systems.at(-1)?.kind).toBe("custom");
  });

  it("runs as a recipe with the toolkit in the prompt and repairs a bad first answer", async () => {
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ ...good, systems: [{ name: "X", kind: "wave", params: [], description: "" }] }) }, { text: JSON.stringify(good) });
    const { output, calls } = await runRecipe(claude, ctx6, { recipe: RECIPES["ums-design"], input, model: "claude-opus-5", effort: "high", maxTokens: 1000, thinking: false });
    expect(calls).toHaveLength(2);
    expect(output.genre).toBe("madness");
    const prompt = (claude.calls[0]!.messages[0]!.content as { text: string }[]).map((c) => c.text).join("\n");
    expect(prompt).toContain("`spawn`: Spawn units at a location on a timer.");
    expect(prompt).toContain("- location: the spawn location");
    expect(prompt).toContain("## The request\n\na madness map");
    expect((claude.calls[1]!.messages[2]!.content as string)).toContain('kind "wave"');
  });
});
