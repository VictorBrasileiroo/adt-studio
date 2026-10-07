import { performance } from "node:perf_hooks"
import { createLLMModel, type ContentPart, type LLMModel, type ResolvedCredentials } from "@adt/llm"
import {
  createSetupRecommendationModelSchema,
  validateSetupRecommendationOutput,
  type SetupResult,
} from "@adt/types"
import { prepareSetupRecommendationEvidence } from "./evidence.js"
import {
  buildPoCV1RecommendationInstructions,
  buildRecommendationTask,
  buildSampledPagePairContext,
  buildSampledPagesContext,
  POC_V1_PROMPT_VERSION,
} from "./prompt.js"

export const SETUP_RECOMMENDATION_PROVIDER = "openai"
export const SETUP_RECOMMENDATION_MODEL = "gpt-5.4-mini"
export const SETUP_RECOMMENDATION_MODEL_ID = `${SETUP_RECOMMENDATION_PROVIDER}:${SETUP_RECOMMENDATION_MODEL}`

/** Fixed V1 model; credential resolution/merging stays in @adt/llm, outside HTTP. */
export function createSetupRecommendationModel(providerCredentials: ResolvedCredentials): LLMModel {
  return createLLMModel({ modelId: SETUP_RECOMMENDATION_MODEL_ID, providerCredentials })
}

/**
 * Transient pre-Create recommendation: one generation, then local validation.
 * Inject the fixed V1 model (or a fake in tests); no book cache/log persistence.
 */
export async function recommendSetup(
  input: {
    pdfBuffer: Buffer
    userLanguage: string
    range?: Parameters<typeof prepareSetupRecommendationEvidence>[1]
    signal?: AbortSignal
  },
  deps: { llmModel: LLMModel },
): Promise<SetupResult> {
  const startedAt = performance.now()
  const userLanguage = input.userLanguage.trim()
  const system = buildPoCV1RecommendationInstructions(userLanguage)
  input.signal?.throwIfAborted()

  const evidenceStartedAt = performance.now()
  const { bookProfile, sampledPagePairs } = prepareSetupRecommendationEvidence(input.pdfBuffer, input.range)
  const evidencePreparationMs = performance.now() - evidenceStartedAt
  const sampledPageNumbers = new Set(sampledPagePairs.flatMap(({ pages }) =>
    pages.flatMap((page) => page === undefined ? [] : [page.pageNumber]),
  ))
  const schema = createSetupRecommendationModelSchema(sampledPageNumbers)
  const content: ContentPart[] = [{ type: "text", text: buildSampledPagesContext(bookProfile) }]
  sampledPagePairs.forEach((pair, index) => {
    content.push({ type: "text", text: buildSampledPagePairContext(pair.pages, index + 1) })
    // PoC used Responses input_image/detail: high. ImagePart exposes no detail;
    // transport/image-detail parity is evaluated separately in the live gate.
    content.push({ type: "image", image: pair.imageBuffer.toString("base64") })
  })
  content.push({ type: "text", text: buildRecommendationTask() })

  input.signal?.throwIfAborted()
  const inferenceStartedAt = performance.now()
  const generated = await deps.llmModel.generateObject<unknown>({
    schema,
    system,
    messages: [{ role: "user", content }],
    maxRetries: 0,
    signal: input.signal,
  })
  const inferenceMs = performance.now() - inferenceStartedAt
  // Intentionally outside @adt/llm's validation-feedback/retry infrastructure.
  const validated = validateSetupRecommendationOutput(generated.object, sampledPageNumbers)
  const { inputTokens, outputTokens } = generated.usage ?? {}
  const usage: SetupResult["usage"] = {}
  if (inputTokens !== undefined) usage.inputTokens = inputTokens
  if (outputTokens !== undefined) usage.outputTokens = outputTokens
  if (inputTokens !== undefined && outputTokens !== undefined) usage.totalTokens = inputTokens + outputTokens

  return {
    provider: SETUP_RECOMMENDATION_PROVIDER,
    model: SETUP_RECOMMENDATION_MODEL,
    promptVersion: POC_V1_PROMPT_VERSION,
    userLanguage,
    recommendation: validated.recommendation,
    usage,
    timing: { evidencePreparationMs, inferenceMs, totalMs: performance.now() - startedAt },
  }
}
