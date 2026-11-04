import { describe, expect, it } from "vitest"
import { DECISION_IDS, type SetupRecommendationOutput } from "../../../packages/types/src/setup-recommendation.js"
import { analyze } from "./analyze.js"
import type { runRepetitions } from "./run.js"

type Record = Awaited<ReturnType<typeof runRepetitions>>[number]
function record(repetition: number, preset: "storybook" | "textbook" = "storybook", extra: Partial<Record> = {}): Record {
  const common = { confidence: "high" as const, reason: "Synthetic only", alternative: null, ambiguityReason: null, evidencePages: [2] }
  const response: SetupRecommendationOutput = { recommendation: {
    preset: { ...common, choice: preset }, renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" }, sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "disabled" }, figureExtraction: { ...common, choice: "auto" },
  } }
  return { runId: "synthetic", caseId: "a", commit: "fixture", repetition,
    hashes: { pdf: "pdf", evidence: "evidence", request: "request" }, modelId: "fixture", promptVersion: "fixture",
    sampledPages: [2], status: "success", response,
    choices: Object.fromEntries(DECISION_IDS.map(id => [id, response.recommendation[id].choice])),
    latencyMs: 5, usage: { inputTokens: 0, outputTokens: 2 }, ...extra }
}
describe("E0 synthetic agreement metrics", () => {
  it("ten identical vectors yield 45/45 pairs", () => {
    const result = analyze(Array.from({ length: 10 }, (_, i) => record(i + 1)))
    expect(result.cases[0]!.fullVector).toMatchObject({ numerator: 45, denominator: 45, proportion: 1 })
    expect(result.cases[0]!.distinctVectors).toBe(1)
    expect(result.cases[0]!.inputTokens).toEqual({ reported: 10, total: 0, mean: 0 })
  })
  it("a 3/2 split yields 4/10 vector and preset agreement; other five dimensions stay unanimous", () => {
    const c = analyze([record(1), record(2), record(3), record(4, "textbook"), record(5, "textbook")]).cases[0]!
    expect(c.fullVector).toMatchObject({ numerator: 4, denominator: 10, proportion: 0.4 })
    expect(c.distinctVectors).toBe(2)
    expect(c.dimensions.preset).toMatchObject({ numerator: 4, frequencies: { storybook: 3, textbook: 2 } })
    expect(c.dimensions.renderStrategy!.proportion).toBe(1)
  })
  it("counts errors and invalid responses separately without choice divergence", () => {
    const c = analyze([record(1), record(2), record(3, "storybook", { status: "invalid", response: undefined }),
      record(4, "storybook", { status: "error", usage: undefined }), record(5, "storybook", { response: {} })]).cases[0]!
    expect(c).toMatchObject({ total: 5, valid: 2, invalid: 2, errors: 1 })
    expect(c.fullVector).toMatchObject({ numerator: 1, denominator: 1, proportion: 1 })
    expect(c.outputTokens.reported).toBe(4)
  })
  it("no pair means no agreement estimate; two different vectors yield zero", () => {
    expect(analyze([]).overall.fullVector.proportion).toBeNull()
    expect(analyze([record(1)]).cases[0]!.fullVector.proportion).toBeNull()
    expect(analyze([record(1), record(2, "textbook")]).overall.fullVector).toEqual({ numerator: 0, denominator: 1, proportion: 0 })
  })
  it("micro aggregation compares within PDF/request only, and refuses duplicate repetitions", () => {
    const records = [record(1), record(2), record(1, "storybook", { caseId: "b" }), record(2, "textbook", { caseId: "b" })]
    expect(analyze(records).overall.fullVector).toEqual({ numerator: 1, denominator: 2, proportion: 0.5 })
    expect(analyze(records).overall.dimensions.preset!.frequencies).toEqual({ storybook: 3, textbook: 1 })
    expect(() => analyze([record(1), record(1)])).toThrow("Duplicate repetition")
    const c = analyze([record(1), record(2, "storybook", { hashes: { pdf: "pdf", evidence: "evidence", request: "changed" } })])
    expect(c.cases).toHaveLength(2)
    expect(c.overall.fullVector.denominator).toBe(0)
  })
  it("rejects unsampled citations and records whose vector differs from the validated response", () => {
    const c = analyze([record(1, "storybook", { sampledPages: [3] }), record(2, "storybook", { choices: {} })]).cases[0]!
    expect(c).toMatchObject({ valid: 0, invalid: 2, errors: 0 })
    expect(c.fullVector.proportion).toBeNull()
  })
  it("rejects malformed artifact metadata rather than generating misleading metrics", () => {
    expect(() => analyze([record(1, "storybook", { latencyMs: -1 })])).toThrow()
    expect(() => analyze([record(1, "storybook", { repetition: 11 })])).toThrow()
  })
})
