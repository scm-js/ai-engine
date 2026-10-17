/** The `MapFacts` input schema the fact-based recipes share. */
import { z } from "zod";
import type { MapFacts } from "../protocol.js";

export const MapFactsSchema: z.ZodType<MapFacts, z.ZodTypeDef, unknown> = z.object({
  name: z.string().max(200),
  description: z.string().max(4000),
  width: z.number().int().min(1).max(256),
  height: z.number().int().min(1).max(256),
  tileset: z.string().max(32),
  players: z.array(z.object({
    slot: z.number().int().min(0).max(11),
    type: z.string().max(32),
    race: z.string().max(32),
    force: z.number().int().min(0).max(3),
    hasStart: z.boolean(),
  })).max(12),
  statistics: z.array(z.string().max(300)).max(200),
  units: z.array(z.string().max(200)).max(1000),
  locations: z.array(z.string().max(200)).max(255),
  triggerCount: z.number().int().min(0),
  briefingCount: z.number().int().min(0),
  triggersText: z.string().max(300_000).optional(),
  selection: z.array(z.string().max(300)).max(50).optional(),
  view: z.string().max(300).optional(),
  history: z.string().max(300).optional(),
}).strict();

export const ImageSchema = z.object({ mediaType: z.enum(["image/png", "image/jpeg", "image/webp"]), data: z.string().min(1) }).strict();
