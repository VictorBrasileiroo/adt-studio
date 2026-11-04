import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { GenerateObjectOptions, GenerateObjectResult, LLMModel } from "../../../packages/llm/src/types.js"
import { DECISION_IDS, type SetupRecommendationOutput } from "../../../packages/types/src/setup-recommendation.js"
import * as recommender from "../../../apps/api/src/services/setup-recommendation/recommend.js"
import * as preparation from "./prepare.js"
import { analyze, analyzeDirectory } from "./analyze.js"
import { main } from "./run.js"
import { recordSchema } from "./schema.js"

const fixture = new URL("../../../tests/fixtures/raven.pdf", import.meta.url)
const common = { confidence: "high" as const, reason: "Synthetic fixture", alternative: null, ambiguityReason: null, evidencePages: [] }
const response: SetupRecommendationOutput = { recommendation: {
  preset: { ...common, choice: "storybook" }, renderStrategy: { ...common, choice: "llm" },
  pageGrouping: { ...common, choice: "single" }, sectioningMode: { ...common, choice: "page" },
  activitiesGenerator: { ...common, choice: "disabled" }, figureExtraction: { ...common, choice: "auto" },
} }
let temporary: string
let manifest: string
let results: string
let snapshot: Awaited<ReturnType<typeof preparation.prepare>>
let generate: ReturnType<typeof vi.fn<LLMModel["generateObject"]>>

beforeEach(async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden") })
  vi.stubEnv("OPENAI_API_KEY", "unused-synthetic-key")
  temporary = await mkdtemp(path.join(os.tmpdir(), "adt-e0-smoke-test-"))
  results = path.join(temporary, "results")
  manifest = path.join(temporary, "corpus.json")
  const pdfPath = path.join(temporary, "fixture.pdf")
  await writeFile(pdfPath, await readFile(fixture))
  snapshot = await preparation.prepare({ pdfBuffer: await readFile(fixture), userLanguage: "pt-BR", range: { start: 2, end: 3 } })
  vi.spyOn(preparation, "verifyPreparation").mockResolvedValue({ frozen: snapshot, hashes: Array(3).fill(snapshot.hashes), deterministic: true })
  await writeFile(manifest, JSON.stringify({ cases: ["storybook", "textbook", "complex"].map(id => ({
    id, candidate: "synthetic", pdf: id === "storybook" ? pdfPath : null, range: null, userLanguage: "pt-BR",
  })) }))
  generate = vi.fn<LLMModel["generateObject"]>().mockResolvedValue({ object: response, usage: { inputTokens: 10, outputTokens: 20 } })
  vi.spyOn(recommender, "createSetupRecommendationModel").mockReturnValue({
    async generateObject<T>(request: GenerateObjectOptions) { return await generate(request) as GenerateObjectResult<T> },
    renderPrompt: vi.fn(),
  })
})
afterEach(async () => {
  vi.restoreAllMocks(); vi.unstubAllEnvs()
  await rm(temporary, { recursive: true, force: true })
})
const args = () => ["--corpus", manifest, "--smoke", "--case", "storybook", "--allow-paid"]
async function savedSmoke() {
  const runs = await readdir(path.join(results, "smoke"))
  const directory = path.join(results, "smoke", runs[0]!)
  const record = recordSchema.parse(JSON.parse(await readFile(path.join(directory, "storybook/repetition-01.json"), "utf8")))
  return { directory, record }
}

describe("isolated E0 smoke (offline models only)", () => {
  it("calls once with the frozen request and only prepares the selected case", async () => {
    await main(args(), results)
    expect(generate).toHaveBeenCalledExactlyOnceWith(snapshot.request)
    expect(preparation.verifyPreparation).toHaveBeenCalledTimes(1)
    const { directory, record } = await savedSmoke()
    expect(record).toMatchObject({ experiment: "smoke", provider: "openai", status: "success", repetition: 1,
      hashes: snapshot.hashes, usage: { inputTokens: 10, outputTokens: 20 } })
    expect(Object.keys(record.choices!)).toEqual(DECISION_IDS)
    expect(await readdir(directory)).toEqual(["run.json", "storybook"])
    expect((await readdir(path.join(directory, "storybook"))).filter(name => name.startsWith("repetition-"))).toHaveLength(1)
    expect(JSON.stringify(record)).not.toContain("unused-synthetic-key")
    await expect(analyzeDirectory(directory)).rejects.toThrow("excluded")
    expect(analyze([record]).overall.total).toBe(0)
    // A copied smoke record still cannot enter an ordinary baseline directory.
    const baseline = path.join(temporary, "baseline")
    const { mkdir, copyFile } = await import("node:fs/promises")
    await mkdir(path.join(baseline, "storybook"), { recursive: true })
    await copyFile(path.join(directory, "storybook/repetition-01.json"), path.join(baseline, "storybook/repetition-01.json"))
    expect((await analyzeDirectory(baseline)).overall.total).toBe(0)
  })

  it.each(["provider error", "invalid output"])("persists %s after exactly one attempt with no retries", async kind => {
    if (kind === "provider error") generate.mockRejectedValue({ statusCode: 429, message: "sensitive-provider-body" })
    else generate.mockResolvedValue({ object: {} })
    await expect(main(args(), results)).rejects.toThrow("No retry executed")
    expect(generate).toHaveBeenCalledTimes(1)
    const { record } = await savedSmoke()
    expect(record.status).toBe(kind === "provider error" ? "error" : "invalid")
    expect(record.errorCategory).toBe(kind === "provider error" ? "rate-limit-or-quota" : "output-validation")
    expect(record.choices).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain("sensitive-provider-body")
  })

  it.each([
    ["--smoke", "--case", "storybook"], ["--smoke", "--allow-paid"],
    ["--case", "storybook", "--allow-paid"], ["--smoke", "--case", "unknown", "--allow-paid"],
    ["--smoke", "--smoke", "--case", "storybook", "--allow-paid"],
    ["--smoke", "--case", "storybook", "--case", "textbook", "--allow-paid"],
    ["--smoke", "--case", "--allow-paid"], ["--smoke", "--case", "storybook", "--allow-paid", "--retry"],
  ])("blocks invalid/unauthorized flags %j before preparation or provider creation", async (...flags) => {
    await expect(main(["--corpus", manifest, ...flags], results)).rejects.toThrow()
    expect(recommender.createSetupRecommendationModel).not.toHaveBeenCalled()
    expect(preparation.verifyPreparation).not.toHaveBeenCalled()
    expect(generate).not.toHaveBeenCalled()
  })

  it("retains three cases and ten calls per case in ordinary paid mode", async () => {
    const corpus = JSON.parse(await readFile(manifest, "utf8"))
    corpus.cases.forEach((entry: { pdf: string }) => { entry.pdf = path.join(temporary, "fixture.pdf") })
    await writeFile(manifest, JSON.stringify(corpus))
    let caseNumber = 0
    vi.mocked(preparation.verifyPreparation).mockImplementation(async () => {
      const frozen = { ...snapshot, hashes: { ...snapshot.hashes, pdf: `synthetic-distinct-pdf-${++caseNumber}` } }
      return { frozen, hashes: Array(3).fill(frozen.hashes), deterministic: true }
    })
    const directory = await main(["--corpus", manifest, "--allow-paid"], results)
    expect(generate).toHaveBeenCalledTimes(30)
    for (const entry of corpus.cases) {
      expect((await readdir(path.join(directory, entry.id))).filter(name => name.startsWith("repetition-"))).toHaveLength(10)
    }
    expect((await analyzeDirectory(directory)).overall.total).toBe(30)
  })
})
