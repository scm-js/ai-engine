/**
 * explain-triggers: prose about triggers given in the editor's text format. The only
 * recipe whose answer streams to the client as it is written.
 */
import { z } from "zod";
import type { ExplainTriggersInput } from "../protocol.js";
import type { Recipe } from "./types.js";

export const ExplainTriggersInputSchema: z.ZodType<ExplainTriggersInput, z.ZodTypeDef, unknown> = z.object({
  text: z.string().min(1).max(300_000),
  question: z.string().max(2000).optional(),
  briefing: z.boolean().optional(),
}).strict();

export const EXPLAIN_TRIGGERS_SYSTEM = `You explain StarCraft: Brood War map triggers to the person editing the map. The triggers arrive in the editor's text format: each begins with \`Trigger(\` and the players it runs for, then \`Conditions:\` and \`Actions:\`, with the condition and action names of the classic trigger editor (Bring, Command, Deaths, Switch, CreateUnit, DisplayText, SetDeaths, PreserveTrigger, …). Death counters (\`Deaths\` / \`SetDeaths\` on an unused unit) are how map makers keep variables; switches are booleans; \`PreserveTrigger\` keeps a trigger running every cycle; hyper triggers (many \`Wait(0)\` actions) speed the trigger loop up.

Write in plain language, in Markdown, for someone who knows the game but may not know triggers. Group triggers by what they do together rather than going one by one when there are many. Point out things a map maker would want to know: what starts the map off, what the win and loss conditions are, timers, counters and what they count, anything that looks like a bug (a trigger that can never fire, a counter that is never reset, a text that never shows). When there is a question, answer it first, then add only what helps. Keep numbers (location names, unit names, amounts) exact. No hype, no filler, no closing summary.`;

export const explainTriggersRecipe: Recipe<"explain-triggers"> = {
  name: "explain-triggers",
  kind: "text",
  input: ExplainTriggersInputSchema,
  system: EXPLAIN_TRIGGERS_SYSTEM,
  build(input) {
    const parts = [
      `## ${input.briefing ? "Mission briefing triggers" : "Triggers"}\n\n\`\`\`\n${input.text}\n\`\`\``,
      input.question ? `## Question\n\n${input.question}` : "## Task\n\nWalk me through what these triggers do.",
    ];
    return { messages: [{ role: "user", content: parts.join("\n\n") }] };
  },
  parse(result) {
    return { text: result.text.trim() };
  },
};
