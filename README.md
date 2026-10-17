# ai-engine

The AI behind [scmjs.dev](https://scmjs.dev): the prompt *recipes* that plan StarCraft maps,
write triggers, review maps and run the assistant in [scmJS](https://github.com/scm-js/scm-js),
the browser map editor for StarCraft: Brood War. Each recipe is a system prompt, a message
builder and a parser, and they all run on the Anthropic API.

This is the part of the scmjs.dev server that decides what the model is asked and what is
done with its answer. Sign-in, accounts, credit, rate limits and budgets stay in the
server, which is not public. If you bring your own Anthropic key to scmjs.dev, this is
the code your key runs.

The recipes know nothing about game data. The editor gathers what a recipe needs from the
open map (the tileset's terrain names, the map's statistics, a rendered picture, the
trigger script's declarations), and applies what comes back with its own tools. So a map
plan is a coarse grid of terrain names or a list of shapes, not tiles; a trigger request
comes back as a script the editor compiles; a review comes back as findings with tile
coordinates.

## Recipes

| Recipe | In | Out |
| --- | --- | --- |
| `map-plan` | a prompt, the map size and tileset vocabulary, a player count and symmetry; `language: "shapes"` with the tileset's ramp pairs and bridge pair | a layout: legend + grid of cells — or, in the shape language, statements in tiles (ground, rects, diamonds, strokes, plateaus with ramps, lanes, bridges) the plugin compiles — plus bases, ramps, doodads, units, locations, a name and description |
| `region-plan` | the same for one area, with the area as it is now | a layout for that area |
| `triggers` | a description and the map's generated `.d.ts` | a trigger script and a summary; repair rounds carry the compiler's diagnostics |
| `explain-triggers` | triggers in the editor's text format, optionally a question | Markdown, streamed |
| `describe` | the map's facts | a name and description plus two alternatives |
| `briefing` | the map's facts and triggers | objectives and narration lines |
| `review` | a picture of the map, its facts, the checker's issues | a Markdown summary and findings with coordinates |
| `strings` | the string table and an instruction | the table rewritten |
| `agent` | a conversation, the plugin's tool definitions, the map's facts and a per-map reference block | the assistant's turn: text and tool calls, streamed |
| `ums-design` | a prompt ("a madness map", "an RPG about …"), the map's size and vocabulary, the plugin's toolkit of trigger-system kinds and its layout presets | a design document: genre, premise, players and forces, systems, a layout preset with its parameters or the layout brief for `map-plan`, objectives and briefing |
| `cast` | a replay's players, map and moments (clip windows, what happened before and during each, how it came out) | timed lines for two commentators, a play-by-play caster and an analyst |

Each recipe is one file in `src/recipes/`. `src/recipes/plan.ts` and `src/recipes/shapes.ts`
are the two layout languages the plan recipes share. The inputs and outputs of every
recipe are in `src/protocol.ts`.

### When an answer does not fit

Every recipe checks what comes back before handing it over. What can be fixed without
asking is fixed and noted (a grid row a character short, a unit name in the wrong case).
When the answer is not valid JSON, does not match the schema, or breaks a rule the recipe
knows (a cast line outside its clip, a design nobody can win), the problems are listed
and sent back to the model once. That repair round runs at low effort, without thinking,
and with an output budget sized to the first answer. A second answer that still does not
fit is an error.

### The prompt cache

The assistant's requests are arranged for the prompt cache. The system prompt and the
plugin's reference (the editor's conventions, the unit table, the trigger vocabulary, the
tileset's terrains, the map's own names — the same text every turn) are cached system
blocks on the one-hour cache, since a person thinks for minutes between messages and a
five-minute entry lapsed between most of them. The reference comes as up to three layers,
each its own block, from the most shared to the most specific: what every map has in
common is one entry for everyone, the tileset's one per tileset, and only the map's own
block is rewritten when the map changes. A breakpoint sits on the last message the plugin
sent, before the map-state block that changes every turn, so a long conversation with
screenshots is read from the cache rather than re-billed each round. The answer carries
that map-state block back (`state`), and the client keeps it at the end of the message it
was added to: the 5.5 models check that a replayed thinking block's conversation is
unchanged and drop it otherwise, so a history that forgot the block lost the model's
reasoning on every round. The `triggers`
recipe does the same for a map's declarations and hand-made triggers when the request
comes from the Write Triggers dialog (`iterative`): they are the bulk of every call on
that map, and a person at the dialog asks again minutes later.

### Scenario designs

`ums-design` is the first step of the plugin's Scenario workflow: the model writes the
design once, at high effort, the person reads and edits it, and the plugin then builds
the map from it — the terrain through `map-plan`, the trigger systems through its own
toolkit where it has a kind for them and through `triggers` where it does not. The
toolkit's catalogue arrives with the request, so the engine never carries a copy of it.
The design is checked before it is returned, and what fails goes back to the model once:
kinds and parameters the toolkit has, a location for every name a system uses (a `{p}`
template needs one for every player the system is for; a preset's numbered locations stop
where its own parameters say), with a layout preset — which places no unit — a system that
gives the players every unit another system waits on, a way for the human players to win
and a way to lose (from what the catalogue says each kind ends, or a custom system whose
description says so), and a `target` — `classic`, triggers alone, or `remastered`, where
custom systems may be programs; a remastered design has its hyper triggers taken out, and
one with nothing to be a program is made classic.

## Using it

```ts
import { AnthropicClaudeClient, RECIPE_DEFAULTS, RECIPES, runRecipe } from "@scm-js/ai-engine";

const claude = new AnthropicClaudeClient({ apiKey: process.env.ANTHROPIC_API_KEY, maxRetries: 2, timeoutMs: 600_000, fallbacks: true });
const recipe = RECIPES.describe;
const input = recipe.input.parse({ facts });   // MapFacts, as the editor gathers them
const { effort, maxTokens } = RECIPE_DEFAULTS.describe;
const { output, calls } = await runRecipe(claude, { maxAgentMessages: 60 }, {
  recipe, input, model: "claude-opus-5-5", effort, maxTokens, thinking: effort !== "low",
});
```

`runRecipe` takes hooks for streaming (`onText`, `onThinking`, `onToolUse`), for each call
as it starts and ends (`beforeCall`, `onCall`, `onCallError` — where a server keeps its
spending in check and its call log), and an `AbortSignal`. `calls` lists every call the
recipe made, the repair round included, with its tokens; `costOf` and `DEFAULT_PRICES`
turn those into dollars.

Install it from a release:

```sh
npm install https://github.com/scm-js/ai-engine/releases/download/v0.1.0/scm-js-ai-engine-0.1.0.tgz
```

## Working on it

You need Node 22.

```sh
npm install
npm test          # vitest, no network: FakeClaudeClient answers from a script
npm run typecheck
npm run build     # dist/
```

To try a change in the scmjs.dev server before releasing it, run `npm install ../ai-engine`
in the server's checkout. That links this checkout in place of the release. Put the
release URL back before committing.

## Releasing

Bump `version` in `package.json`, merge, and push a `v<version>` tag. The release workflow
tests, builds and packs the package and attaches the tarball to a GitHub release. The
server's `package.json` points at that tarball.

## License

MIT
