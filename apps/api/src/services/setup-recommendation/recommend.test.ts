import { beforeEach, describe, expect, it, vi } from "vitest"
import { createLLMModel, type ContentPart, type LLMModel, type StructuredTextBackend } from "@adt/llm"
import { createSetupRecommendationModelSchema, setupResultSchema, type SetupRecommendationOutput } from "@adt/types"
import { prepareSetupRecommendationEvidence, type SetupRecommendationPreparedEvidence } from "./evidence.js"
import { aggregateBookProfile } from "./profile.js"
import { buildPoCV1RecommendationInstructions, buildRecommendationTask, buildSampledPagePairContext, buildSampledPagesContext } from "./prompt.js"
import {
  createSetupRecommendationModel, recommendSetup,
  SETUP_RECOMMENDATION_MODEL, SETUP_RECOMMENDATION_MODEL_ID, SETUP_RECOMMENDATION_PROVIDER,
} from "./recommend.js"

vi.mock("@adt/llm", () => ({ createLLMModel: vi.fn() }))
vi.mock("@adt/types", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adt/types")>()
  return { ...actual, createSetupRecommendationModelSchema: vi.fn(actual.createSetupRecommendationModelSchema) }
})
vi.mock("./evidence.js", () => ({ prepareSetupRecommendationEvidence: vi.fn() }))

function evidence(): SetupRecommendationPreparedEvidence {
  return {
    pageCount: 52,
    observations: [],
    bookProfile: { ...aggregateBookProfile([]), pageCount: 52 },
    sampledPagePairs: [
      { pages: [{ pageNumber: 20, text: "First" }, { pageNumber: 21, text: "Second" }], imageBuffer: Buffer.from([0, 137, 255, 1]) },
      { pages: [{ pageNumber: 24, text: "Third" }, { pageNumber: 25, text: "Fourth" }], imageBuffer: Buffer.from([2, 254, 128, 0]) },
    ],
  }
}

function output(pages = [20, 21]): SetupRecommendationOutput {
  const common = { confidence: "high", reason: "Supported evidence", alternative: null, ambiguityReason: null, evidencePages: pages } as const
  return { recommendation: {
    preset: { ...common, choice: "textbook" },
    renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" },
    sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "enabled" },
    figureExtraction: { ...common, choice: "auto" },
  } }
}

const input = { pdfBuffer: Buffer.from("fake PDF"), userLanguage: "  pt-BR  ", range: { start: 20, end: 25 } }

function fakeModel() {
  const generateObject = vi.fn<LLMModel["generateObject"]>().mockResolvedValue({
    object: output(), usage: { inputTokens: 11, outputTokens: 12 },
  })
  const llmModel: LLMModel = { generateObject, renderPrompt: vi.fn() }
  return { llmModel, generateObject }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(prepareSetupRecommendationEvidence).mockReturnValue(evidence())
})

describe("setup recommendation service", () => {
  it("AC-7: performs one OpenAI mini multimodal call with zero retries", async () => {
    const { llmModel, generateObject } = fakeModel()
    const result = await recommendSetup(input, { llmModel })
    expect(generateObject).toHaveBeenCalledTimes(1)
    const request = generateObject.mock.calls[0][0]
    expect(Object.keys(request).sort()).toEqual(["schema", "system", "messages", "maxRetries", "signal"].sort())
    expect(request.maxRetries).toBe(0)
    expect(request.system).toBe(buildPoCV1RecommendationInstructions("pt-BR"))
    expect(prepareSetupRecommendationEvidence).toHaveBeenCalledExactlyOnceWith(input.pdfBuffer, input.range)
    expect(setupResultSchema.parse(result)).toEqual(result)
    expect(result).toMatchObject({
      provider: "openai", model: "gpt-5.4-mini", promptVersion: "adt-config-recommender-poc-v1",
      userLanguage: "pt-BR", recommendation: output().recommendation,
      usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 },
    })
    expect(Object.keys(result).sort()).toEqual(["provider", "model", "promptVersion", "userLanguage", "recommendation", "usage", "timing"].sort())
    expect(Object.keys(result.timing!).sort()).toEqual(["evidencePreparationMs", "inferenceMs", "totalMs"].sort())
    for (const duration of Object.values(result.timing!)) expect(duration).toBeGreaterThanOrEqual(0)
    expect(result.timing!.totalMs).toBeGreaterThanOrEqual(result.timing!.evidencePreparationMs! + result.timing!.inferenceMs!)
  })

  it("AC-13: preserves poc-v1 profile, pair text/image interleaving and final task", async () => {
    const { llmModel, generateObject } = fakeModel()
    const prepared = evidence()
    await recommendSetup(input, { llmModel })
    const messages = generateObject.mock.calls[0][0].messages!
    expect(messages).toEqual([{ role: "user", content: [
      { type: "text", text: buildSampledPagesContext(prepared.bookProfile) },
      { type: "text", text: buildSampledPagePairContext(prepared.sampledPagePairs[0].pages, 1) },
      { type: "image", image: prepared.sampledPagePairs[0].imageBuffer.toString("base64") },
      { type: "text", text: buildSampledPagePairContext(prepared.sampledPagePairs[1].pages, 2) },
      { type: "image", image: prepared.sampledPagePairs[1].imageBuffer.toString("base64") },
      { type: "text", text: buildRecommendationTask() },
    ] }])
    const parts = messages[0].content as ContentPart[]
    const images = parts.filter((part) => part.type === "image")
    images.forEach((part, index) => expect(Buffer.from(part.image, "base64")).toEqual(prepared.sampledPagePairs[index].imageBuffer))
  })

  it("AC-3: sends the shared dynamic schema restricted to sampled pages, not the range/profile", async () => {
    const { llmModel, generateObject } = fakeModel()
    await recommendSetup(input, { llmModel })
    const schema = generateObject.mock.calls[0][0].schema as ReturnType<typeof createSetupRecommendationModelSchema>
    expect(createSetupRecommendationModelSchema).toHaveBeenCalledExactlyOnceWith(new Set([20, 21, 24, 25]))
    expect(schema).toBe(vi.mocked(createSetupRecommendationModelSchema).mock.results[0].value)
    expect(schema.safeParse(output([20, 21, 24, 25])).success).toBe(true)
    expect(schema.safeParse(output([22])).success).toBe(false)
    expect(schema.safeParse(output([52])).success).toBe(false)
  })

  it("AC-3: supports a singleton with its physical page number", async () => {
    const prepared: SetupRecommendationPreparedEvidence = { ...evidence(),
      sampledPagePairs: [{ pages: [{ pageNumber: 52, text: "Last page" }, undefined], imageBuffer: Buffer.from([255]) }],
    }
    vi.mocked(prepareSetupRecommendationEvidence).mockReturnValue(prepared)
    const { llmModel, generateObject } = fakeModel()
    generateObject.mockResolvedValue({ object: output([52]) })
    const result = await recommendSetup({ ...input, range: { start: 52, end: 52 } }, { llmModel })
    const request = generateObject.mock.calls[0][0]
    const schema = request.schema as ReturnType<typeof createSetupRecommendationModelSchema>
    expect(schema.safeParse(output([52])).success).toBe(true)
    expect(schema.safeParse(output([51])).success).toBe(false)
    expect(request.messages).toEqual([{ role: "user", content: [
      { type: "text", text: buildSampledPagesContext(prepared.bookProfile) },
      { type: "text", text: buildSampledPagePairContext(prepared.sampledPagePairs[0].pages, 1) },
      { type: "image", image: "/w==" },
      { type: "text", text: buildRecommendationTask() },
    ] }])
    expect(result.recommendation).toEqual(output([52]).recommendation)
  })

  it("AC-7: propagates provider errors after exactly one call", async () => {
    const { llmModel, generateObject } = fakeModel()
    const error = new Error("provider failure")
    generateObject.mockRejectedValue(error)
    await expect(recommendSetup(input, { llmModel })).rejects.toBe(error)
    expect(generateObject).toHaveBeenCalledTimes(1)
  })

  it("AC-7: propagates structural parsing errors without repair or retry", async () => {
    const { llmModel, generateObject } = fakeModel()
    generateObject.mockImplementation(async (request) => {
      const schema = request.schema as ReturnType<typeof createSetupRecommendationModelSchema>
      schema.parse({ recommendation: {} })
      throw new Error("Expected structural parsing to fail")
    })
    await expect(recommendSetup(input, { llmModel })).rejects.toThrow()
    expect(generateObject).toHaveBeenCalledTimes(1)
  })

  it.each(["equal alternative", "unsorted pages", "duplicate pages", "unsampled page"])("AC-7: rejects %s locally without another generation", async (kind) => {
    const invalid = output()
    if (kind === "equal alternative") Object.assign(invalid.recommendation.preset, {
      confidence: "low", alternative: "textbook", ambiguityReason: "Competing evidence",
    })
    if (kind === "unsorted pages") invalid.recommendation.preset.evidencePages = [21, 20]
    if (kind === "duplicate pages") invalid.recommendation.preset.evidencePages = [20, 20]
    if (kind === "unsampled page") invalid.recommendation.preset.evidencePages = [22]
    const { llmModel, generateObject } = fakeModel()
    generateObject.mockResolvedValue({ object: invalid })
    await expect(recommendSetup(input, { llmModel })).rejects.toThrow()
    expect(generateObject).toHaveBeenCalledTimes(1)
    if (kind !== "unsampled page") {
      const schema = generateObject.mock.calls[0][0].schema as ReturnType<typeof createSetupRecommendationModelSchema>
      expect(schema.safeParse(invalid).success).toBe(true)
    }
  })

  it("AC-11: forwards AbortSignal and propagates cancellation without retry", async () => {
    const controller = new AbortController()
    const { llmModel, generateObject } = fakeModel()
    const error = new Error("cancelled")
    generateObject.mockImplementation(async (request) => {
      expect(request.signal).toBe(controller.signal)
      controller.abort(error)
      throw error
    })
    await expect(recommendSetup({ ...input, signal: controller.signal }, { llmModel })).rejects.toBe(error)
    expect(generateObject).toHaveBeenCalledTimes(1)
  })

  it("AC-11: stops a previously cancelled request before evidence and generation", async () => {
    const controller = new AbortController()
    const error = new Error("already cancelled")
    controller.abort(error)
    const { llmModel, generateObject } = fakeModel()
    await expect(recommendSetup({ ...input, signal: controller.signal }, { llmModel })).rejects.toBe(error)
    expect(generateObject).not.toHaveBeenCalled()
    expect(prepareSetupRecommendationEvidence).not.toHaveBeenCalled()
  })

  it.each(["", " \n\t "])("AC-8: rejects empty language %j before evidence and generation", async (userLanguage) => {
    const { llmModel, generateObject } = fakeModel()
    await expect(recommendSetup({ ...input, userLanguage }, { llmModel })).rejects.toThrow("userLanguage is required")
    expect(generateObject).not.toHaveBeenCalled()
    expect(prepareSetupRecommendationEvidence).not.toHaveBeenCalled()
  })

  it("AC-7: returns required empty usage when token usage is unavailable", async () => {
    const { llmModel, generateObject } = fakeModel()
    generateObject.mockResolvedValue({ object: output() })
    const result = await recommendSetup(input, { llmModel })
    expect(setupResultSchema.parse(result).usage).toEqual({})
  })

  it("AC-7: preserves reported zero token counts", async () => {
    const { llmModel, generateObject } = fakeModel()
    generateObject.mockResolvedValue({ object: output(), usage: { inputTokens: 0, outputTokens: 0 } })
    expect((await recommendSetup(input, { llmModel })).usage).toEqual({ inputTokens: 0, outputTokens: 0, totalTokens: 0 })
  })

  it("AC-7: creates only the fixed V1 model and forwards credentials without persistence options", () => {
    const credentials = { openai: { apiKey: "unused-test-key" } }
    const { llmModel, generateObject } = fakeModel()
    vi.mocked(createLLMModel).mockReturnValue(llmModel)
    expect(SETUP_RECOMMENDATION_PROVIDER).toBe("openai")
    expect(SETUP_RECOMMENDATION_MODEL).toBe("gpt-5.4-mini")
    expect(SETUP_RECOMMENDATION_MODEL_ID).toBe("openai:gpt-5.4-mini")
    expect(createSetupRecommendationModel(credentials)).toBe(llmModel)
    expect(createLLMModel).toHaveBeenCalledExactlyOnceWith({ modelId: "openai:gpt-5.4-mini", providerCredentials: credentials })
    expect(vi.mocked(createLLMModel).mock.calls[0][0].providerCredentials).toBe(credentials)
    expect(generateObject).not.toHaveBeenCalled()
  })

  it("AC-7: selects native-schema through the real client with one fake backend call", async () => {
    const actual = await vi.importActual<typeof import("@adt/llm")>("@adt/llm")
    const generateStructured = vi.fn<StructuredTextBackend["generateStructured"]>().mockResolvedValue({
      object: output(), usage: { inputTokens: 11, outputTokens: 12 },
    })
    const registry = actual.createProviderRegistry().register({
      ...actual.openaiProvider,
      createStructuredTextBackend: () => ({ generateStructured }),
    }).freeze()
    vi.mocked(createLLMModel).mockImplementation((options) => actual.createLLMModel({ ...options, registry, logLevel: "silent" }))
    const llmModel = createSetupRecommendationModel({ openai: { apiKey: "unused-test-key" } })
    await recommendSetup(input, { llmModel })
    expect(generateStructured).toHaveBeenCalledTimes(1)
    expect(generateStructured.mock.calls[0][0].strategy).toBe("native-schema")
    expect(generateStructured.mock.calls[0][0].temperature).toBeUndefined()
  })
})
