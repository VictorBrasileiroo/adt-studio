import { createHash } from "node:crypto"
import { createRequire } from "node:module"
import type { GenerateObjectOptions, LLMModel } from "../../../packages/llm/src/types.js"
import { recommendSetup, SETUP_RECOMMENDATION_MODEL_ID } from "../../../apps/api/src/services/setup-recommendation/recommend.js"
import { prepareSetupRecommendationEvidence } from "../../../apps/api/src/services/setup-recommendation/evidence.js"
import { POC_V1_PROMPT_VERSION, buildSampledPagesContext, buildSampledPagePairContext, buildRecommendationTask } from "../../../apps/api/src/services/setup-recommendation/prompt.js"
import { createSetupRecommendationModelSchema } from "../../../packages/types/src/setup-recommendation.js"

// Reuse the converter already installed for the production LLM transport.
const require = createRequire(new URL("../../../packages/llm/package.json", import.meta.url))
const { zodToJsonSchema } = require("zod-to-json-schema") as typeof import("../../../packages/llm/node_modules/zod-to-json-schema/dist/types/index.js")

/** Canonical JSON only: reject opaque instances/functions rather than silently hash {}. */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`
  if (typeof value === "object" && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(",")}}`
  }
  throw new Error("Non-canonical value; explicitly project buffers, schemas, sets and signals")
}
export const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
export const hash = (value: unknown) => sha256(canonical(value))

export function logicalRequest(request: GenerateObjectOptions) {
  const { schema, signal, ...options } = request
  if (signal !== undefined) throw new Error("E0 captures requests without cancellation signals")
  // signal: undefined is an operational handle, not part of the logical payload.
  // JSON Schema is a logical projection, not a claim of byte-identical HTTP transport.
  return { format: "e0-canonical-v1", modelId: SETUP_RECOMMENDATION_MODEL_ID,
    promptVersion: POC_V1_PROMPT_VERSION, options,
    schema: zodToJsonSchema(schema as Parameters<typeof zodToJsonSchema>[0], { target: "jsonSchema7" }),
    defaults: { temperature: "provider default (omitted)", maxTokens: "provider default (omitted)",
      seed: "not exposed", timeoutMs: 90000, strategy: "native-schema", cache: false } }
}

export async function prepare(input: Parameters<typeof recommendSetup>[0]) {
  if (input.signal !== undefined) throw new Error("E0 does not accept signal in preparation")
  // Independent evidence snapshot for inspectability. No reconstruction of product rules.
  const evidence = prepareSetupRecommendationEvidence(input.pdfBuffer, input.range)
  let request: GenerateObjectOptions | undefined
  const captured = new Error("E0 capture completed")
  const model: LLMModel = {
    async generateObject(options) { request = options; throw captured },
    async renderPrompt() { throw new Error("Unexpected template rendering") },
  }
  try { await recommendSetup(input, { llmModel: model }) }
  catch (error) { if (error !== captured) throw error }
  if (!request) throw new Error("V1 did not produce a request")
  const evidenceJson = { ...evidence, sampledPagePairs: evidence.sampledPagePairs.map(pair => ({
    pages: pair.pages.filter(page => page !== undefined), imageBase64: pair.imageBuffer.toString("base64"),
  })) }
  const logical = logicalRequest(request)
  const pages = new Set(evidence.sampledPagePairs.flatMap(pair => pair.pages.flatMap(page => page ? [page.pageNumber] : [])))
  // The independent evidence pass must describe exactly the captured production input.
  const content = [
    { type: "text", text: buildSampledPagesContext(evidence.bookProfile) },
    ...evidence.sampledPagePairs.flatMap((pair, index) => [
      { type: "text", text: buildSampledPagePairContext(pair.pages, index + 1) },
      { type: "image", image: pair.imageBuffer.toString("base64") },
    ]),
    { type: "text", text: buildRecommendationTask() },
  ]
  if (canonical(request.messages) !== canonical([{ role: "user", content }]) ||
    canonical(logical.schema) !== canonical(logicalRequest({ ...request, schema: createSetupRecommendationModelSchema(pages) }).schema)) {
    throw new Error("Independent evidence and captured V1 payload differ")
  }
  // Freeze plain content, keeping the real Zod instance usable by the V1 transport.
  request.messages?.forEach(message => {
    if (Array.isArray(message.content)) { message.content.forEach(Object.freeze); Object.freeze(message.content) }
    Object.freeze(message)
  })
  Object.freeze(request.messages)
  Object.freeze(request)
  return { request, logical, evidence: evidenceJson, pages,
    hashes: { pdf: sha256(input.pdfBuffer), evidence: hash(evidenceJson), request: hash(logical) } }
}

export async function verifyPreparation(input: Parameters<typeof recommendSetup>[0]) {
  const trials = []
  for (let i = 0; i < 3; i++) trials.push(await prepare(input))
  const frozen = trials[0]!
  const hashes = trials.map(trial => trial.hashes)
  return { frozen, hashes, deterministic: hashes.every(value => canonical(value) === canonical(frozen.hashes)) }
}
