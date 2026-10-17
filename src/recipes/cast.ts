/**
 * cast: a broadcast cast of a StarCraft replay — what two commentators say over the game,
 * timed in seconds on screen. The plugin (Aftermath) sends the facts it measured from the
 * engine's playthrough, stretch by stretch: the whole game at normal speed (the quiet parts
 * marked as such; a plugin before Aftermath 0.14 played them fast), or the key fights alone. The answer is a plan
 * (the storyline and a beat for each stretch) and the lines, which the plugin voices and
 * plays against the game clock. Nothing is said about this game that the facts do not hold.
 */
import { z } from "zod";
import type { CastInput, CastLine, CastOutput } from "../protocol.js";
import { RecipeOutputError, S, expect, parseJson, type Recipe } from "./types.js";

/** Words a commentator says in a second, at broadcast pace. The plugin measures the real clips; this is the budget. */
export const WORDS_PER_SECOND = 3;
/**
 * How much of a stretch may be talk: most of a fight, most of the game played fast (Aftermath before 0.14), and
 * less of a quiet stretch at normal speed — a broadcast breathes between the fights.
 */
const FILL_LIVE = 0.85;
const FILL_FAST = 0.85;
const FILL_QUIET = 0.65;
/**
 * The last stretch's lines may start this long after it ends: the sign-off, over the last frame (which the player holds
 * until the last line is said). A game that ends with a player leaving has a last stretch of a few seconds, so this is
 * most of its room: the result from each and the banter's callbacks.
 */
export const SIGN_OFF_SECONDS = 30;
/** The delivery cues the caster may use: the gentle set (louder ones, `[excited]`, `[shocked]`, oversold). */
export const CUES = ["getting excited", "surprised", "chuckles", "impressed", "amused"] as const;
/** The least share of the words the analyst may have (a third is asked for; a little under passes). */
const ANALYST_SHARE = 0.28;
/** Lines may start this far outside their window and are moved in rather than refused. */
const SLACK_SECONDS = 2;
const MAX_LINE = 320;

/**
 * The commentators' interests: two drawn for each cast (from its \`seed\`), so whoever watches a few hears new ones.
 * Obscure and a little ridiculous on purpose — an easter egg the two take completely seriously.
 */
export const INTERESTS = [
  "competitive duck herding", "restoring antique pencil sharpeners", "extreme ironing", "grading the acoustics of public stairwells",
  "breeding show snails", "collecting airline sick bags", "lawnmower racing", "writing fan letters to lighthouses",
  "judging miniature horse dressage", "topiary shaped like famous bridges", "competitive whistling", "cataloguing the fonts on parking signs",
  "origami no bigger than a fingernail", "bog snorkelling", "rating municipal fountains", "mapping every vending machine in town",
  "knitting jumpers for garden gnomes", "competitive cloud spotting", "restoring 1970s answering machines", "training a hermit crab for agility trials",
  "carving chess sets out of soap", "ranking types of gravel", "worm charming championships", "collecting the stickers off fruit",
  "collecting bread bag clips", "recreating Victorian moustache wax recipes", "building ships inside light bulbs", "calligraphy on grains of rice",
  "competitive yodelling", "recording the hum of different microwaves", "ferret racing", "competitive pogo",
  "photographing every roundabout in the county", "competitive sandcastle engineering", "collecting toasters", "a decades-long feud with a local crossword setter",
] as const;

/** The two interests a seed draws: the same seed, the same pair. */
export function interestsFor(seed: number): { caster: string; analyst: string } {
  let x = (Math.abs(Math.floor(seed)) % 2147483647) || 1;
  const next = () => (x = (x * 48271) % 2147483647);
  const a = next() % INTERESTS.length;
  let b = next() % INTERESTS.length;
  if (b === a) b = (b + 1) % INTERESTS.length;
  return { caster: INTERESTS[a]!, analyst: INTERESTS[b]! };
}

/** Seconds a stretch is on screen. */
export const onScreen = (m: CastInput["moments"][number]) => m.seconds ?? (m.to - m.from) / (m.speed ?? 1);

const Fact = z.string().max(400);
export const CastInputSchema: z.ZodType<CastInput, z.ZodTypeDef, unknown> = z.object({
  options: z.object({ format: z.enum(["game", "highlights"]), banter: z.enum(["off", "light", "lots"]) }).strict().optional(),
  seed: z.number().int().nonnegative().optional(),
  game: z.object({
    map: z.string().max(120),
    openings: z.array(z.string().max(2000)).max(8).optional(),
    length: z.number().nonnegative().max(6 * 3600),
    players: z.array(z.object({
      id: z.number().int().min(0).max(11),
      name: z.string().max(64),
      race: z.enum(["Zerg", "Terran", "Protoss"]),
      result: z.enum(["won", "lost", "left", "unknown"]),
    }).strict()).min(1).max(8),
  }).strict(),
  moments: z.array(z.object({
    from: z.number().nonnegative(),
    to: z.number().nonnegative(),
    speed: z.number().min(1).max(64).optional(),
    quiet: z.boolean().optional(),
    seconds: z.number().positive().max(6 * 3600).optional(),
    title: z.string().max(160),
    state: z.array(Fact).max(40).optional(),
    before: z.array(Fact).max(40),
    events: z.array(z.object({ at: z.number().nonnegative(), text: Fact }).strict()).max(160),
    after: z.array(Fact).max(20),
  }).strict().refine((m) => m.to > m.from, "a moment must end after it starts")).min(1).max(80),
  wishes: z.string().max(2000).optional(),
}).strict();

export const CAST_SYSTEM = `You write the commentary for a broadcast of a StarCraft: Brood War game, the way a Korean-league broadcast with an English cast sounds: two commentators in a booth, one observer running the camera. The game has already been played; the editor's replay viewer measured what happened and sends it to you stretch by stretch. You plan the broadcast, then write what the two say.

## The two voices

- **caster** — play-by-play. Calls what is happening as it happens: armies meeting, units falling, a base going down. Relaxed and conversational, with dry wit; the energy lifts with the stakes, but he never oversells — no shouting, no hype words, at most one exclamation in a fight. Short sentences during action. Says player names often so the viewer always knows who is who.
- **analyst** — strategy. The reason people watch with commentary. He reads the builds, names them, and says what each player is going for; compares the economies (bases, workers, income, production) and the tech paths; explains what a choice commits a player to and what it is weak against; says what to watch for before a fight, and after it what it cost and what each player should do next. Dry, precise, occasionally wry, willing to have an opinion.

They are a pair and they like each other: they react to each other, finish each other's points, tease each other, disagree now and then. They are original characters — never name or imitate real commentators, and never name themselves.

## Delivery cues

The voices act out a cue in square brackets at the start of a caster's line or between its sentences. Use them only for the caster, only at moments that earn them (armies meeting, a big loss, the turn of the game, a good joke), at most two in a line and a handful in the whole cast, and only these: ${CUES.map((c) => `[${c}]`).join(", ")}. Never write any other bracketed text, and none in the analyst's lines.

## What you know, kept apart

- **This game** comes only from the facts: what each player built and when, what fell, bases, upgrades, economy, who leads. Never invent an event — micro, spell use, a scout, what a player saw or was thinking. Every number about this game is copied from the facts, never estimated or recounted. A player's whole army ("whole army, wherever it stands") is not the same as the units at a fight ("at the fight"): never mix them up.
- **The game in general** is yours to use, and the analyst should use it a lot: standard builds and their names, what a composition is good and bad against, the usual answers to it, what a tech path commits a player to, how the matchup tends to go, typical timings in general terms. Put the two together: "Charon Boosters — the Goliath range upgrade, the one you want against Carriers." State general knowledge as general ("usually", "the standard answer"), never as something that happened in this game.
- **The players are real people.** Say nothing about them beyond this game — no lives, habits, histories or personalities — and no jokes at their expense beyond their play.

## Reading the builds

The openings list each order with the supply it was given at, the way players write builds ("9 Supply Depot, 11 Barracks"). Name the build when the counts and the order make it clear, and say what it is aiming for and what it gives up. When it is not clear, describe it plainly ("an early Command Center", "a Forge before the Gateway") rather than force a name. Come back to the builds later when they explain what happens.

## Plan first: one story

Before any line, write the plan:
- \`storyline\`: a few sentences, not spoken — each player's plan, the decisions that mattered, why the winner won, and the question the broadcast will keep asking ("can the greedy Carrier build survive the tank push?").
- \`arc\`: one short beat for each stretch, in order — what it sets up, what it pays off, and any running bit that comes back there.

Then write the lines to that plan, as one broadcast rather than a string of separate scenes: raise the question early, keep coming back to it, answer it at the end. Refer back to what was said earlier; let the sign-off call back to the opening — the question, and the running bit if there is one.

## The stretches

The game arrives as stretches, each with how fast it plays and how many seconds it is on screen.
- **A quiet stretch** (at normal speed, no key fight): the game plays in real time and the viewer sees what you talk about as you say it. Follow it: an order is news when its \`at\` comes, not before; the analyst reads the builds and the economies as they come together, says what each player is preparing and what is coming; the caster picks up the small things on screen (a scout, a skirmish, a new base). Talk to each other in exchanges — a point, an answer, a follow-up — not separate remarks. This is where the analyst does most of his work and where the banter goes; leave the odd breath of silence.
- **Played fast** (2× and more): a lot of game passes in a few seconds. Talk about the picture as it develops rather than single events. These are the analyst's stretches, and where the banter goes.
- **At normal speed with a key fight**: the analyst sets it up in a line or two; the caster calls it (see Calling a fight); after it the analyst says what it cost against the whole game and what it changes.
- In a whole-game cast the stretches follow on with no cut: the talk runs on from one to the next. In a key-moments cast each stretch is a separate clip with time skipped between them: a later clip opens with the analyst on what has changed since.
- The first stretch opens with the welcome: the map, the players, their races, the builds.
- Speak as if live. You know how the game ends — point at what will matter ("keep an eye on that third base"), never say the result before the last stretch.
- Numbers are said the way a caster says them: "about twelve hundred minerals' worth", "eight minutes in", not "1187" or "08:12". Use the races' and units' usual names (Marines, Siege Tanks, Zerglings, Dragoons, Carriers…).
- The analyst speaks at least a third of the words of the whole cast, and most of the words in the quiet stretches.

## Banter

The options say how much the two chat about other things — each other, the map, the booth, and their interests. Banter only ever goes where little is happening (the opening, a quiet stretch), never over a fight, and stops the moment the game needs them.
- **off**: none; every line is about the game, and their interests never come up.
- **light**: a little, mostly in the opening — one running bit, set up there and called back once later (the sign-off is a good place).
- **lots**: plenty in the quiet stretches — both interests, a running joke that builds through the cast and pays off at the end, the two teasing each other. Still never over a fight, and still with the game's analysis in every quiet stretch.

**Their interests.** The input gives each commentator one: obscure and a little ridiculous, which is the joke — they take it completely seriously, and so does the other one, mostly. The viewer has never heard of it, so it is introduced the way a booth would before anything leans on it: one asks the other what he got up to this week, or teases him about it ("he spent the weekend at the regional finals of…, and I'm told he placed"), said plainly enough that someone who missed the joke still knows what it is. After that it comes back as callbacks, best when it meets the game (whatever the interest is, it has opinions about a late expansion). Never more than the banter level allows.

## Cards on screen

Some facts end with a tag like \`[card c12]\`: the broadcast can put that upgrade, research, unit or building on screen — its icon and how far along it is. When a line is about that one thing ("there's the Fleet Beacon", "air weapons level three is on the way"), give the line its \`card\`. Use them where the viewer gains from seeing it — tech choices, upgrades, a first unit of a kind — not on every line: never in a fight's rapid calls, never in banter, and not twice in a row for the same thing. Never say a tag aloud. A line with no card has \`card\` "".

## Calling a fight

A key fight is where a broadcast comes alive, and the caster's call is the show. The events give it blow by blow: what fell every second and a half and what killed it, the first of a kind of unit a player loses, where the heaviest exchange begins, where the fight moves.
- **Build-up**: armies closing, the caster says what is coming and who is where; the analyst gives the one thing to watch.
- **The heaviest exchange**: rapid-fire. Back-to-back lines of two to eight words, naming units and what is killing them, as fast as the events come: "Tanks unsieged!", "Interceptors all over the Goliaths!", "Two Carriers down, two!", "He's pulling back, no — he's going in again!". The caster carries it; the analyst cuts in with a word or three ("That's the upgrades!"). Lines may run almost into each other here, a breath apart. This is where the caster's cues belong, and where his energy is at its highest — still a real person, not shouting nonsense.
- **After**: a breath of silence, then the analyst on what it cost and what it changes.
- Everything called is in the events: a unit, a kill, a loss, a move. The events don't show micro, spells or decisions — call what fell and what killed it, not how it was controlled.

## Timing

A line is spoken from its \`at\`: seconds on screen from the start of its stretch. It lasts about one second for every ${WORDS_PER_SECOND} words, and nobody talks over the other — leave each line time to finish before the next \`at\`, in seconds on screen however fast the game plays. The events give each fact's \`at\` in the same seconds, with the game's clock.
- Talk fills most of a fight's heaviest exchange and leaves room either side of it; a quiet stretch is talked over about two thirds of the time. Silence while the game plays is part of a broadcast.
- During a fight, lines are short — under twelve words, mostly far less — and mostly the caster's.
- The last stretch closes the broadcast after it ends: who won and why, from each, starting within ${SIGN_OFF_SECONDS} seconds after its end.

## Priority

Each line has a priority the player uses when the voices run longer than the budget: 1 — must be said (the call of a fight, the welcome, the result); 2 — should be said; 3 — colour or banter that can be dropped.

## Answer

One JSON object: \`storyline\`, then \`arc\`, then \`lines\`, every line in order, each with \`moment\` (the index of its stretch, from 0), \`at\`, \`speaker\`, \`text\` and \`priority\`. Text is spoken aloud: no stage directions, no markdown, no emoji, no quotation marks around the whole line. If the wishes ask for a tone or a language, follow them.`;

const LineSchema = z.object({
  moment: z.number().int().nonnegative(),
  at: z.number(),
  speaker: z.enum(["caster", "analyst"]),
  text: z.string(),
  priority: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  card: z.string().optional(),
});
const Output = z.object({ storyline: z.string(), arc: z.array(z.string()), lines: z.array(LineSchema).min(1) });

const clock = (s: number) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

/** The input as the model reads it. */
export function castText(input: CastInput): string {
  const g = input.game, o = input.options ?? { format: "highlights", banter: "light" };
  const out: string[] = [];
  out.push("## Options", "", `Format: ${o.format === "game" ? (input.moments.some((m) => (m.speed ?? 1) > 1) ? "the whole game, the quiet parts played fast, no cuts" : "the whole game at normal speed, no cuts") : "the key moments only, with cuts between them"}`, `Banter: ${o.banter}`);
  if (o.banter !== "off") {
    const h = interestsFor(input.seed ?? 1);
    out.push("", "## The commentators' interests", "", `Caster: ${h.caster}`, `Analyst: ${h.analyst}`);
  }
  out.push("", "## The game", "");
  out.push(`Map: ${g.map || "(unnamed)"}`);
  out.push(`Length: ${clock(g.length)}`);
  out.push("Players:");
  for (const p of g.players) out.push(`  ${p.name} — ${p.race}${p.result === "unknown" ? "" : `, ${p.result === "left" ? "left the game" : p.result} (do not reveal before the last stretch)`}`);
  if (g.openings?.length) { out.push("Openings (supply and time of each order; workers left out):"); for (const op of g.openings) out.push(`  ${op}`); }
  input.moments.forEach((m, i) => {
    const secs = onScreen(m), speed = m.speed ?? 1, fill = speed > 1 ? FILL_FAST : m.quiet ? FILL_QUIET : FILL_LIVE, last = i === input.moments.length - 1;
    // (The last stretch's room is mostly the sign-off: told as a few seconds alone, the model wrote the sign-off anyway, over it.)
    const room = last
      ? `${Math.round(secs)} seconds on screen, then the last frame is held for the sign-off (up to ${SIGN_OFF_SECONDS} seconds more); about ${Math.round((secs + SIGN_OFF_SECONDS) * WORDS_PER_SECOND * fill)} words of speech fit, the sign-off included`
      : `${Math.round(secs)} seconds on screen; about ${Math.round(secs * WORDS_PER_SECOND * fill)} words of speech fit`;
    out.push("", `## Stretch ${i}: ${m.title}`, "",
      `Game ${clock(m.from)} to ${clock(m.to)}, ${speed > 1 ? `played at ${speed}×` : m.quiet ? "a quiet stretch at normal speed" : "at normal speed"}: ${room}`);
    if (m.before.length) { out.push(i ? "Since the last stretch:" : "Before this stretch:"); for (const f of m.before) out.push(`  - ${f}`); }
    if (m.state?.length) { out.push("Where things stand when it starts:"); for (const f of m.state) out.push(`  - ${f}`); }
    if (m.events.length) { out.push("While it plays (seconds on screen from its start, then the game's clock):"); for (const e of m.events) out.push(`  +${Math.round(e.at)} s: ${e.text}`); }
    if (m.after.length) { out.push(speed > 1 ? "Where things stand at its end:" : "How it came out:"); for (const f of m.after) out.push(`  - ${f}`); }
  });
  out.push("", "## Wishes", "", input.wishes?.trim() || "(none)");
  return out.join("\n");
}

/** A line without its cues: what is said, and what the captions show. */
export const spoken = (text: string) => text.replace(/\[[^\]]*\]\s*/g, "").replace(/\s+/g, " ").trim();
const words = (text: string) => spoken(text).split(/\s+/).filter(Boolean).length;

/** The cues a line may keep: the caster's from the gentle set, at most two; any other bracketed text goes. */
function cued(text: string, speaker: "caster" | "analyst"): string {
  let kept = 0;
  return text.replace(/\[([^\]]*)\]\s*/g, (_all, cue: string) => {
    if (speaker !== "caster" || kept > 1 || !(CUES as readonly string[]).includes(cue.trim().toLowerCase())) return "";
    kept++;
    return `[${cue.trim().toLowerCase()}] `;
  }).replace(/\s+/g, " ").trim();
}

/**
 * The lines, checked against the moments: each in a moment that exists and inside its clip
 * (a line just outside is moved in), and no moment holding much more speech than its clip
 * can carry. Lines come back sorted by moment and time.
 */
export function checkLines(lines: z.infer<typeof LineSchema>[], input: CastInput): CastLine[] {
  const problems: string[] = [];
  // The cards there are: every \`[card …]\` tag in the facts. A line's card that is not one of them is dropped.
  const cards = new Set([...JSON.stringify(input.moments).matchAll(/\[card (c\d+)\]/g)].map((m) => m[1]!));
  const last = input.moments.length - 1;
  const out: CastLine[] = [];
  lines.forEach((l, i) => {
    const m = input.moments[l.moment];
    if (!m) { problems.push(`lines.${i}.moment: there is no stretch ${l.moment} (0 to ${last})`); return; }
    const text = cued(l.text, l.speaker);
    if (!spoken(text)) { problems.push(`lines.${i}.text is empty`); return; }
    if (text.length > MAX_LINE) problems.push(`lines.${i}.text is ${text.length} characters; keep a line under ${MAX_LINE}`);
    const end = onScreen(m) + (l.moment === last ? SIGN_OFF_SECONDS : 0);
    // (Late in the last stretch is only a longer sign-off: the player holds the last frame for it.)
    if (l.at < -SLACK_SECONDS || (l.at > end + SLACK_SECONDS && l.moment !== last)) {
      problems.push(`lines.${i}.at ${l.at} is outside stretch ${l.moment} (0 to ${Math.round(end)} seconds on screen)`);
      return;
    }
    const card = l.card?.trim().replace(/^\[?card\s*/i, "").replace(/\]$/, "");
    out.push({ moment: l.moment, at: Math.round(Math.min(end, Math.max(0, l.at)) * 10) / 10, speaker: l.speaker, text, priority: l.priority, ...(card && cards.has(card) ? { card } : {}) });
  });
  // A stretch with more than it can carry loses its priority 3 lines, then its priority 2, the latest first — what the
  // player would drop anyway. Only a stretch still overfull with what must be said is sent back: a second answer costs
  // about a minute and a quarter of the first's price, and at low effort it seldom cut enough.
  input.moments.forEach((m, i) => {
    const span = onScreen(m) + (i === last ? SIGN_OFF_SECONDS : 0);
    const room = Math.round(span * WORDS_PER_SECOND);
    const mine = out.filter((l) => l.moment === i);
    let said = mine.reduce((n, l) => n + words(l.text), 0);
    for (const priority of [3, 2] as const) {
      for (const l of [...mine].reverse()) {
        if (said <= room * 1.15) break;
        if (l.priority !== priority) continue;
        out.splice(out.indexOf(l), 1);
        said -= words(l.text);
      }
    }
    if (said > room * 1.15) problems.push(`stretch ${i} has ${said} words of priority 1 lines for ${Math.round(span)} seconds on screen; at most about ${room} can be said — shorten them`);
  });
  if (!out.some((l) => l.speaker === "caster") || !out.some((l) => l.speaker === "analyst")) problems.push("both the caster and the analyst must speak");
  else {
    const all = out.reduce((k, l) => k + words(l.text), 0), analyst = out.filter((l) => l.speaker === "analyst").reduce((k, l) => k + words(l.text), 0);
    if (all > 0 && analyst / all < ANALYST_SHARE) problems.push(`the analyst says ${Math.round((analyst / all) * 100)}% of the words; give him at least a third — the quiet stretches are his, and he reads the builds, the economies and what each fight changes`);
  }
  if (problems.length) throw new RecipeOutputError(problems);
  return out.sort((a, b) => a.moment - b.moment || a.at - b.at);
}

export const castRecipe: Recipe<"cast"> = {
  name: "cast",
  kind: "json",
  input: CastInputSchema,
  system: CAST_SYSTEM,
  build(input) {
    const line = S.obj({
      moment: S.int("index of the stretch, from 0"),
      at: S.num("seconds on screen from the start of its stretch"),
      speaker: S.enumOf(["caster", "analyst"]),
      text: S.str("spoken aloud"),
      priority: S.int("1 must, 2 should, 3 can be dropped"),
      card: S.str("the [card …] id from the facts this line is about, like c12; empty for none"),
    });
    return { messages: [{ role: "user", content: castText(input) }], outputSchema: S.obj({
      storyline: S.str("not spoken: the plans, the decisions that mattered, why the winner won, the question the broadcast keeps asking"),
      arc: S.arr(S.str(), "not spoken: one beat for each stretch, in order"),
      lines: S.arr(line, "in order"),
    }) };
  },
  parse(result, input): CastOutput {
    const out = expect(Output, parseJson(result.text));
    const banter = (input.options?.banter ?? "light") !== "off";
    return { storyline: out.storyline.trim(), arc: out.arc.map((b) => b.trim()), lines: checkLines(out.lines, input), ...(banter ? { interests: interestsFor(input.seed ?? 1) } : {}) };
  },
};
