import { describe, expect, it } from "vitest";
import { FakeClaudeClient } from "../src/claude.js";
import type { CastInput } from "../src/protocol.js";
import { castText, checkLines, interestsFor, INTERESTS, spoken } from "../src/recipes/cast.js";
import { RECIPES, runRecipe } from "../src/recipes/index.js";
import { RecipeOutputError } from "../src/recipes/types.js";

const input: CastInput = {
  options: { format: "game", banter: "light" },
  game: {
    map: "Fighting Spirit",
    length: 900,
    players: [
      { id: 0, name: "Flash", race: "Terran", result: "won" },
      { id: 1, name: "Jaedong", race: "Zerg", result: "lost" },
    ],
  },
  // A minute and a half of opening at 5× (18 seconds on screen), then forty seconds of fight at normal speed.
  moments: [
    { from: 0, to: 90, speed: 5, seconds: 18, title: "The opening", before: [], events: [{ at: 4, text: "0:20 Flash orders Barracks at 10 supply [card c1]" }], after: ["Flash at 1:30: 12 workers"] },
    { from: 90, to: 130, speed: 1, seconds: 40, title: "Mutalisks at the Terran main", before: [], events: [{ at: 20, text: "1:50 Flash loses 3 SCV" }], after: ["Flash lost 150 minerals' worth"] },
  ],
};

const line = (moment: number, at: number, speaker: "caster" | "analyst", text: string, priority: 1 | 2 | 3 = 2) => ({ moment, at, speaker, text, priority });

describe("cast recipe", () => {
  it("lays the game out stretch by stretch, with how fast each plays and the room it has", () => {
    const text = castText(input);
    expect(text).toContain("Format: the whole game, the quiet parts played fast, no cuts\nBanter: light");
    expect(text).toContain("Map: Fighting Spirit");
    expect(text).toContain("Flash — Terran, won (do not reveal before the last stretch)");
    expect(text).toContain("## Stretch 0: The opening\n\nGame 0:00 to 1:30, played at 5×: 18 seconds on screen; about 46 words of speech fit");
    expect(text).toContain("## Stretch 1: Mutalisks at the Terran main\n\nGame 1:30 to 2:10, at normal speed: 40 seconds on screen, then the last frame is held for the sign-off (up to 30 seconds more); about 179 words of speech fit, the sign-off included");
    expect(text).toContain("+20 s: 1:50 Flash loses 3 SCV");
  });

  it("gives a quiet stretch at normal speed less to say than a fight, and says the whole game plays at normal speed", () => {
    const quiet: CastInput = { ...input, moments: [{ ...input.moments[0]!, speed: 1, seconds: 150, quiet: true }, input.moments[1]!] };
    const text = castText(quiet);
    expect(text).toContain("Format: the whole game at normal speed, no cuts");
    expect(text).toContain("## Stretch 0: The opening\n\nGame 0:00 to 1:30, a quiet stretch at normal speed: 150 seconds on screen; about 293 words of speech fit");
    expect(castText(input)).toContain("Format: the whole game, the quiet parts played fast, no cuts");
  });

  it("gives the two a fresh pair of interests for each seed, and none without banter", () => {
    const a = interestsFor(7), b = interestsFor(8);
    expect(interestsFor(7)).toEqual(a);
    expect(a.caster).not.toBe(a.analyst);
    expect([a.caster, a.analyst]).not.toEqual([b.caster, b.analyst]);
    expect(INTERESTS.every((i) => !/\bbees?\b|\btrains?\b|timetable/i.test(i))).toBe(true);
    expect(castText({ ...input, seed: 7 })).toContain(`## The commentators' interests\n\nCaster: ${a.caster}\nAnalyst: ${a.analyst}`);
    expect(castText({ ...input, seed: 7, options: { format: "game", banter: "off" } })).not.toContain("interests");
  });

  it("keeps lines in their stretches in seconds on screen, moves near misses in, and lets the last sign off after its end", () => {
    const out = checkLines([
      line(1, 55, "analyst", "And that is the game."),
      line(0, -1, "caster", "Welcome to Fighting Spirit!"),
      line(0, 10, "analyst", "Barracks first, the usual."),
    ], input);
    expect(out.map((l) => [l.moment, l.at])).toEqual([[0, 0], [0, 10], [1, 55]]);
  });

  it("asks again when a line is outside its stretch, a stretch does not exist, one voice is missing or a stretch is overfull", () => {
    const fails = (lines: ReturnType<typeof line>[]) => { try { checkLines(lines, input); return []; } catch (e) { return (e as RecipeOutputError).problems; } };
    expect(fails([line(0, 30, "caster", "Hi"), line(0, 10, "analyst", "Hi")])[0]).toMatch(/outside stretch 0 \(0 to 18 seconds on screen\)/);
    expect(fails([line(5, 4, "caster", "Hi"), line(0, 10, "analyst", "Hi")])[0]).toMatch(/no stretch 5/);
    expect(fails([line(0, 10, "caster", "Hi")])).toEqual(["both the caster and the analyst must speak"]);
    const long = Array.from({ length: 35 }, () => "word").join(" ");
    expect(fails([...Array.from({ length: 2 }, (_, i) => line(0, i * 5, "analyst", long, 1)), line(0, 15, "caster", "Hi")])[0]).toMatch(/stretch 0 has 70 words of priority 1 lines for 18 seconds on screen/);
  });

  it("drops an overfull stretch's priority 3 lines, then its priority 2, the latest first, rather than asking again", () => {
    const long = Array.from({ length: 25 }, () => "word").join(" ");
    const out = checkLines([
      line(0, 0, "caster", long, 1),
      line(0, 4, "analyst", long, 3),
      line(0, 8, "analyst", long, 2),
      line(0, 12, "analyst", long, 3),
      line(1, 0, "analyst", "Fine.", 3),
    ], input);
    // 18 seconds carry about 54 words (62 with the slack): both priority 3 lines go, the priority 2 stays.
    expect(out.map((l) => [l.moment, l.at, l.priority])).toEqual([[0, 0, 1], [0, 8, 2], [1, 0, 3]]);
  });

  it("lets the sign-off run long and late: the player holds the last frame for it", () => {
    const out = checkLines([line(0, 0, "caster", "Welcome!"), line(1, 75, "analyst", "And that is the game.")], input);
    expect(out.map((l) => [l.moment, l.at])).toEqual([[0, 0], [1, 70]]);
  });

  it("keeps a line's card when the facts have it, and drops one they don't", () => {
    const out = checkLines([
      { ...line(0, 0, "caster", "There's the Barracks."), card: "c1" },
      { ...line(0, 5, "analyst", "And a Factory next, surely."), card: "c9" },
      { ...line(0, 10, "analyst", "On time, too."), card: "[card c1]" },
      { ...line(0, 14, "caster", "Quiet start."), card: "" },
    ], input);
    expect(out.map((l) => l.card)).toEqual(["c1", undefined, "c1", undefined]);
  });

  it("asks again when the analyst barely speaks", () => {
    const fails = () => { try { checkLines([line(1, 0, "caster", "Here they come, the whole army, straight up the ramp and into the natural."), line(1, 10, "analyst", "Risky.")], input); return []; } catch (e) { return (e as RecipeOutputError).problems; } };
    expect(fails()[0]).toMatch(/^the analyst says 7% of the words; give him at least a third/);
  });

  it("keeps the caster's gentle cues, at most two a line, and takes every other bracket out", () => {
    const out = checkLines([
      line(1, 0, "caster", "[Getting excited] Here they come! [chuckles] Oh no. [laughs] Gone."),
      line(1, 10, "analyst", "[dryly] Tanks don't shoot up."),
      line(1, 20, "caster", "[shocked] [surprised] That is the game."),
    ], input);
    expect(out.map((l) => l.text)).toEqual(["[getting excited] Here they come! [chuckles] Oh no. Gone.", "Tanks don't shoot up.", "[surprised] That is the game."]);
    expect(spoken(out[0]!.text)).toBe("Here they come! Oh no. Gone.");
  });

  it("runs through the recipe runner, with one repair round", async () => {
    const good = { storyline: "Terran held; the Mutalisks found nothing.", arc: ["Welcome and builds", "The Mutalisks arrive"], lines: [line(0, 0, "caster", "Welcome!", 1), line(0, 5, "analyst", "Two bases for the Zerg.")] };
    const claude = new FakeClaudeClient().answer({ text: JSON.stringify({ storyline: "", arc: [], lines: [line(0, 900, "caster", "Too late")] }) }, { text: JSON.stringify(good) });
    const out = await runRecipe(claude, { maxAgentMessages: 60 }, { recipe: RECIPES.cast, input, model: "claude-opus-5", effort: "medium", maxTokens: 16000, thinking: true });
    expect(out.output.lines).toHaveLength(2);
    expect(out.output.storyline).toBe("Terran held; the Mutalisks found nothing.");
    expect(out.output.arc).toEqual(["Welcome and builds", "The Mutalisks arrive"]);
    expect(claude.calls).toHaveLength(2);
    expect(String(claude.calls[1]!.messages.at(-1)!.content)).toMatch(/outside stretch 0/);
  });
});

