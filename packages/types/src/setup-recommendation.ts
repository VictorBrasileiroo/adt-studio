import { z } from "zod"
import type { FigureExtractionMode } from "./config.js"

/** Shared setup protocol from the stable `poc-v1` recommender. */
export const CONFIDENCE = ["low", "medium", "high"] as const
const confidenceSchema = z.enum(CONFIDENCE)
export type Confidence = z.infer<typeof confidenceSchema>

export const PRESET_IDS = ["textbook", "storybook", "reference"] as const
export const RENDER_STRATEGY_IDS = ["llm", "llm-overlay", "single_column", "two_column_story", "fixed_layout"] as const
export const PAGE_GROUPING_IDS = ["single", "spread"] as const
export const SECTIONING_MODE_IDS = ["page", "dynamic"] as const
export const ACTIVITIES_IDS = ["enabled", "disabled"] as const
export const FIGURE_EXTRACTION_IDS = [
  "off",
  "auto",
  "all",
] as const satisfies readonly FigureExtractionMode[]

function decision<const T extends readonly [string, ...string[]]>(ids: T) {
  const choice = z.enum(ids)
  return z
    .object({
      choice,
      confidence: confidenceSchema,
      reason: z.string().min(1).max(500),
      alternative: choice.nullable(),
      ambiguityReason: z.string().min(1).max(500).nullable(),
      evidencePages: z.array(z.number().int().positive()),
    })
    .strict()
    .superRefine((d, ctx) => {
      if (d.alternative !== null && d.alternative === d.choice) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "alternative equals choice" })
      if (d.alternative !== null && d.confidence === "high") ctx.addIssue({ code: z.ZodIssueCode.custom, message: "high confidence cannot have an alternative" })
      if ((d.alternative === null) !== (d.ambiguityReason === null)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "ambiguityReason goes with an alternative" })
      if (d.evidencePages.some((p, i) => i > 0 && d.evidencePages[i - 1] >= p)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: "evidencePages must be unique and sorted" })
    })
}

/** Static runtime contract, including semantic relationships. */
export const recommendationSchema = z
  .object({
    preset: decision(PRESET_IDS),
    renderStrategy: decision(RENDER_STRATEGY_IDS),
    pageGrouping: decision(PAGE_GROUPING_IDS),
    sectioningMode: decision(SECTIONING_MODE_IDS),
    activitiesGenerator: decision(ACTIVITIES_IDS),
    figureExtraction: decision(FIGURE_EXTRACTION_IDS),
  })
  .strict()

/** Application metadata is supplied outside the model's structured output. */
export const setupResultSchema = z
  .object({
    provider: z.string(),
    model: z.string(),
    promptVersion: z.string(),
    userLanguage: z.string(),
    recommendation: recommendationSchema,
    usage: z.object({ inputTokens: z.number().optional(), outputTokens: z.number().optional(), totalTokens: z.number().optional() }).partial(),
    timing: z.object({ analyzerMs: z.number(), evidencePreparationMs: z.number(), inferenceMs: z.number(), totalMs: z.number() }).partial().optional(),
  })
  .passthrough()

export type Recommendation = z.infer<typeof recommendationSchema>
export type DecisionId = keyof Recommendation
export type Decision<K extends DecisionId = DecisionId> = Recommendation[K]
export type SetupResult = z.infer<typeof setupResultSchema>

export const DECISION_IDS: DecisionId[] = ["preset", "renderStrategy", "pageGrouping", "sectioningMode", "activitiesGenerator", "figureExtraction"]

function modelDecision<const T extends readonly [string, ...string[]]>(ids: T, sampledPages: z.ZodType<number>) {
  const choice = z.enum(ids)
  const reason = z.string().min(1).max(500)
  const evidencePages = z.array(sampledPages)
  return z.union([
    z.object({
      choice,
      confidence: confidenceSchema,
      reason,
      alternative: z.null(),
      ambiguityReason: z.null(),
      evidencePages,
    }).strict(),
    z.object({
      choice,
      confidence: z.enum(["low", "medium"]),
      reason,
      alternative: choice,
      ambiguityReason: reason,
      evidencePages,
    }).strict(),
  ])
}

/**
 * Request-specific model output. Numeric literals and ambiguity branches are
 * structural so JSON Schema conversion preserves them. Relations such as
 * alternative !== choice and sorted/unique citations still need post-parse validation.
 */
export function createSetupRecommendationModelSchema(sampledPageNumbers: ReadonlySet<number>) {
  const pages = [...sampledPageNumbers].sort((a, b) => a - b)
  if (pages.length === 0 || pages.some((page) => !Number.isSafeInteger(page) || page < 1)) {
    throw new Error("Setup recommendation structured output requires at least one valid sampled page")
  }
  // Zod 3 has single-value literals; z.union requires at least two schemas.
  const sampledPages = pages.length === 1
    ? z.literal(pages[0])
    : z.union([z.literal(pages[0]), z.literal(pages[1]), ...pages.slice(2).map((page) => z.literal(page))])

  return z.object({
    recommendation: z.object({
      preset: modelDecision(PRESET_IDS, sampledPages),
      renderStrategy: modelDecision(RENDER_STRATEGY_IDS, sampledPages),
      pageGrouping: modelDecision(PAGE_GROUPING_IDS, sampledPages),
      sectioningMode: modelDecision(SECTIONING_MODE_IDS, sampledPages),
      activitiesGenerator: modelDecision(ACTIVITIES_IDS, sampledPages),
      figureExtraction: modelDecision(FIGURE_EXTRACTION_IDS, sampledPages),
    }).strict(),
  }).strict()
}

const setupRecommendationOutputSchema = z.object({ recommendation: recommendationSchema }).strict()
export type SetupRecommendationOutput = z.infer<typeof setupRecommendationOutputSchema>

/**
 * Validate model output after parsing: apply all runtime semantic checks and
 * independently verify citations against this request's sampled physical pages.
 * Do not rely on providers translating superRefine into Structured Outputs.
 */
export function validateSetupRecommendationOutput(value: unknown, sampledPageNumbers: ReadonlySet<number>): SetupRecommendationOutput {
  const parsed = setupRecommendationOutputSchema.parse(value)
  for (const id of DECISION_IDS) {
    for (const page of parsed.recommendation[id].evidencePages) {
      if (!sampledPageNumbers.has(page)) {
        throw new Error(`Setup recommendation response for ${id} cites unsampled page ${page}`)
      }
    }
  }
  return parsed
}
