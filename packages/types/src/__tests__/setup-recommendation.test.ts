import { describe, expect, it } from "vitest"
import { z } from "zod"
import {
  ACTIVITIES_IDS, CONFIDENCE, DECISION_IDS, FIGURE_EXTRACTION_IDS,
  PAGE_GROUPING_IDS, PRESET_IDS, RENDER_STRATEGY_IDS, SECTIONING_MODE_IDS,
  createSetupRecommendationModelSchema, recommendationSchema, setupResultSchema,
  validateSetupRecommendationOutput, type Recommendation,
} from "../setup-recommendation.js"

function recommendation(evidencePages: number[] = [2, 3]): Recommendation {
  const common = { confidence: "high" as const, reason: "Supported by sampled pages", alternative: null, ambiguityReason: null, evidencePages }
  return {
    preset: { ...common, choice: "textbook" },
    renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" },
    sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "enabled" },
    figureExtraction: { ...common, choice: "auto" },
  }
}

function output(patch: object = {}, pages?: number[]) {
  const base = recommendation(pages)
  return { recommendation: { ...base, renderStrategy: { ...base.renderStrategy, ...patch } } }
}

describe("setup recommendation runtime contract", () => {
  it("AC-2: accepts a valid six-decision recommendation", () => {
    expect(recommendationSchema.parse(recommendation())).toEqual(recommendation())
  })

  it("AC-2: preserves exactly the stable poc-v1 option IDs", () => {
    expect(CONFIDENCE).toEqual(["low", "medium", "high"])
    expect(PRESET_IDS).toEqual(["textbook", "storybook", "reference"])
    expect(RENDER_STRATEGY_IDS).toEqual(["llm", "llm-overlay", "single_column", "two_column_story", "fixed_layout"])
    expect(PAGE_GROUPING_IDS).toEqual(["single", "spread"])
    expect(SECTIONING_MODE_IDS).toEqual(["page", "dynamic"])
    expect(ACTIVITIES_IDS).toEqual(["enabled", "disabled"])
    expect(FIGURE_EXTRACTION_IDS).toEqual(["off", "auto", "all"])
    expect(DECISION_IDS).toEqual(["preset", "renderStrategy", "pageGrouping", "sectioningMode", "activitiesGenerator", "figureExtraction"])
  })

  it.each(DECISION_IDS)("AC-2: requires decision %s and rejects invalid IDs and extra fields", (id) => {
    const base = recommendation()
    const { [id]: omitted, ...missing } = base
    expect(omitted).toBeDefined()
    expect(recommendationSchema.safeParse(missing).success).toBe(false)
    for (const patch of [{ choice: "invalid" }, { alternative: "invalid" }, { extra: true }]) {
      expect(recommendationSchema.safeParse({ ...base, [id]: { ...base[id], ...patch } }).success).toBe(false)
    }
    expect(recommendationSchema.safeParse({ ...base, extra: base[id] }).success).toBe(false)
  })

  it.each([
    ["two_column is excluded", { choice: "two_column" }],
    ["empty reason", { reason: "" }],
    ["reason over 500 characters", { reason: "x".repeat(501) }],
    ["alternative equal to choice", { confidence: "medium", alternative: "llm", ambiguityReason: "Other option" }],
    ["high confidence with alternative", { alternative: "llm-overlay", ambiguityReason: "Other option" }],
    ["alternative without ambiguityReason", { confidence: "low", alternative: "llm-overlay" }],
    ["ambiguityReason without alternative", { ambiguityReason: "Other option" }],
    ["empty ambiguityReason", { confidence: "low", alternative: "llm-overlay", ambiguityReason: "" }],
    ["ambiguityReason over 500 characters", { confidence: "low", alternative: "llm-overlay", ambiguityReason: "x".repeat(501) }],
    ["missing alternative", { alternative: undefined }],
    ["missing ambiguityReason", { ambiguityReason: undefined }],
    ["invalid confidence", { confidence: "certain" }],
    ["unsorted evidence pages", { evidencePages: [3, 2] }],
    ["duplicate evidence pages", { evidencePages: [2, 2] }],
    ["zero evidence page", { evidencePages: [0] }],
    ["negative evidence page", { evidencePages: [-1] }],
    ["fractional evidence page", { evidencePages: [2.5] }],
  ])("AC-2: rejects %s", (_name, patch) => {
    expect(recommendationSchema.safeParse(output(patch as object).recommendation).success).toBe(false)
  })

  it("AC-2: accepts empty evidence and inclusive string length boundaries", () => {
    expect(recommendationSchema.safeParse(recommendation([])).success).toBe(true)
    for (const length of [1, 500]) {
      expect(recommendationSchema.safeParse(output({ reason: "x".repeat(length), confidence: "low", alternative: "llm-overlay", ambiguityReason: "x".repeat(length) }).recommendation).success).toBe(true)
    }
  })

  it("AC-2: keeps application metadata extensible and provider/model unrestricted", () => {
    const result = { provider: "another-provider", model: "another-model", promptVersion: "v1", userLanguage: "pt-BR", recommendation: recommendation(), usage: {}, bookProfile: { pageCount: 52 } }
    expect(setupResultSchema.parse(result)).toEqual(result)
    expect(setupResultSchema.safeParse({ ...result, usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, timing: { totalMs: 10 } }).success).toBe(true)
  })
})

describe("setup recommendation model-facing schema", () => {
  const sampled = new Set([2, 3, 26, 27, 50, 51])
  const schema = createSetupRecommendationModelSchema(sampled)

  it.each(DECISION_IDS)("AC-3: restricts %s citations to the sampled physical pages", (id) => {
    for (const pages of [[], [2], [...sampled]]) {
      expect(schema.safeParse({ recommendation: recommendation(pages) }).success).toBe(true)
    }
    const base = recommendation()
    expect(schema.safeParse({ recommendation: { ...base, [id]: { ...base[id], evidencePages: [14] } } }).success).toBe(false)
  })

  it.each([[52], [2, 3], [51, 2, 26]])("AC-3: represents sampled set %j using numeric literals", (...pages) => {
    const requestSchema = createSetupRecommendationModelSchema(new Set(pages))
    const element = requestSchema.shape.recommendation.shape.preset.options[0].shape.evidencePages.element
    if (pages.length === 1) {
      expect(element).toBeInstanceOf(z.ZodLiteral)
      if (element instanceof z.ZodLiteral) expect(element.value).toBe(pages[0])
    } else {
      expect(element).toBeInstanceOf(z.ZodUnion)
      if (element instanceof z.ZodUnion) {
        expect(element.options.every((option: z.ZodTypeAny) => option instanceof z.ZodLiteral)).toBe(true)
        expect(element.options.map((option: z.ZodLiteral<number>) => option.value)).toEqual([...pages].sort((a, b) => a - b))
      }
    }
    expect(requestSchema.safeParse({ recommendation: recommendation([...pages].sort((a, b) => a - b)) }).success).toBe(true)
    expect(requestSchema.safeParse({ recommendation: recommendation([]) }).success).toBe(true)
    expect(requestSchema.safeParse({ recommendation: recommendation([99]) }).success).toBe(false)
  })

  it("AC-3: rejects an empty sampled set", () => {
    expect(() => createSetupRecommendationModelSchema(new Set())).toThrow("at least one valid sampled page")
  })

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])("AC-3: rejects invalid sampled page %s", (page) => {
    expect(() => createSetupRecommendationModelSchema(new Set([2, page]))).toThrow("at least one valid sampled page")
  })

  it("AC-3: structurally separates the two ambiguity branches", () => {
    for (const confidence of CONFIDENCE) expect(schema.safeParse(output({ confidence })).success).toBe(true)
    for (const confidence of ["low", "medium"]) expect(schema.safeParse(output({ confidence, alternative: "llm-overlay", ambiguityReason: "Other option" })).success).toBe(true)
    for (const patch of [
      { alternative: "llm-overlay", ambiguityReason: "Other option" },
      { confidence: "low", alternative: "llm-overlay" },
      { ambiguityReason: "Other option" },
    ]) expect(schema.safeParse(output(patch)).success).toBe(false)
  })

  it("AC-3: accepts only the model envelope with strict recommendations and decisions", () => {
    expect(schema.safeParse({ ...output(), provider: "openai" }).success).toBe(false)
    expect(schema.safeParse({ recommendation: { ...recommendation(), extra: true } }).success).toBe(false)
    expect(schema.safeParse(output({ extra: true })).success).toBe(false)
    const { preset: omitted, ...missing } = recommendation()
    expect(omitted).toBeDefined()
    expect(schema.safeParse({ recommendation: missing }).success).toBe(false)
  })

  it("AC-3: validates a correct output semantically", () => {
    expect(validateSetupRecommendationOutput(schema.parse(output()), sampled)).toEqual(output())
    expect(validateSetupRecommendationOutput(output({}, []), sampled)).toEqual(output({}, []))
  })

  it.each([
    ["alternative equal to choice", { confidence: "low", alternative: "llm", ambiguityReason: "Other option" }],
    ["unsorted evidence pages", { evidencePages: [3, 2] }],
    ["duplicate evidence pages", { evidencePages: [2, 2] }],
  ])("AC-3: semantic validator rejects %s after structural parsing", (_name, patch) => {
    const parsed = schema.parse(output(patch as object))
    expect(() => validateSetupRecommendationOutput(parsed, sampled)).toThrow()
  })

  it("AC-3: semantic validator independently rejects unsampled citations", () => {
    expect(() => validateSetupRecommendationOutput(output({ evidencePages: [14] }), sampled)).toThrow("unsampled page 14")
  })
})
