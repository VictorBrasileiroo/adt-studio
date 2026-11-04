import { createRequire } from "node:module"

// Private experiment artifacts only; no addition to the product's shared protocols.
const require = createRequire(new URL("../../../apps/api/package.json", import.meta.url))
export const { z } = require("zod") as typeof import("../../../apps/api/node_modules/zod/index.js")
export const corpusSchema = z.object({ cases: z.array(z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9-]*$/), candidate: z.string().min(1),
  pdf: z.string().min(1).nullable(), userLanguage: z.string().trim().min(1),
  range: z.object({ start: z.number().int().positive(), end: z.number().int().positive() }).strict()
    .refine(range => range.start <= range.end).nullable(),
}).strict()).length(3) }).strict().refine(value => new Set(value.cases.map(c => c.id)).size === 3)

export const recordSchema = z.object({
  runId: z.string().min(1), caseId: z.string().min(1), commit: z.string().min(1),
  repetition: z.number().int().min(1).max(10),
  hashes: z.object({ pdf: z.string().min(1), evidence: z.string().min(1), request: z.string().min(1) }).strict(),
  modelId: z.string().min(1), promptVersion: z.string().min(1),
  experiment: z.literal("smoke").optional(), provider: z.string().min(1).optional(),
  sampledPages: z.array(z.number().int().positive()).min(1),
  status: z.enum(["success", "invalid", "error"]), response: z.unknown().optional(),
  choices: z.record(z.string()).optional(), errorCategory: z.string().optional(),
  usage: z.object({ inputTokens: z.number().int().nonnegative(), outputTokens: z.number().int().nonnegative() }).optional(),
  latencyMs: z.number().finite().nonnegative(),
  parameters: z.object({ maxRetries: z.literal(0), temperature: z.literal("omitted"), maxTokens: z.literal("omitted"), seed: z.literal("not exposed") }).optional(),
}).strict()
