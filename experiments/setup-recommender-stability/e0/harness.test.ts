import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { LLMModel } from "../../../packages/llm/src/types.js"
import { DECISION_IDS, type SetupRecommendationOutput } from "../../../packages/types/src/setup-recommendation.js"
import { recommendSetup } from "../../../apps/api/src/services/setup-recommendation/recommend.js"
import { canonical, hash, logicalRequest, prepare, verifyPreparation } from "./prepare.js"
import * as preparation from "./prepare.js"
import { main, runRepetitions, save } from "./run.js"

// Every test is offline; even accidentally-created real models cannot reach the API.
const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const pdf = () => readFile(new URL("../../../tests/fixtures/raven.pdf", import.meta.url))
async function frozen() { return prepare({ pdfBuffer: await pdf(), userLanguage: "pt-BR", range: { start: 2, end: 3 } }) }
const output = (): SetupRecommendationOutput => {
  const common = { confidence: "high" as const, reason: "Synthetic fixture", alternative: null, ambiguityReason: null, evidencePages: [] }
  return { recommendation: {
    preset: { ...common, choice: "storybook" }, renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" }, sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "disabled" }, figureExtraction: { ...common, choice: "auto" },
  } }
}
const metadata = { runId: "synthetic", caseId: "test", commit: "fixture" }

describe("E0 offline infrastructure", () => {
  it("canonicalizes key ordering, preserves array order, rejects opaque values", () => {
    expect(hash({ b: 2, a: 1 })).toBe(hash({ a: 1, b: 2 }))
    expect(hash([1, 2])).not.toBe(hash([2, 1]))
    for (const value of [new Set([1]), new Date(), Buffer.from("x"), undefined, NaN, () => 1]) {
      expect(() => canonical(value)).toThrow()
    }
  })

  it("captures exactly the production request and validates three preparations offline", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden") })
    const input = { pdfBuffer: await pdf(), userLanguage: "pt-BR", range: { start: 2, end: 3 } }
    const result = await verifyPreparation(input)
    expect(result.deterministic).toBe(true)
    expect(result.hashes).toHaveLength(3)
    let logical: unknown
    const model: LLMModel = {
      async generateObject<T>(request: Parameters<LLMModel["generateObject"]>[0]) { logical = logicalRequest(request); return { object: output() as T } },
      async renderPrompt() { throw new Error("Unexpected render") },
    }
    const production = await recommendSetup(input, { llmModel: model })
    expect(logical).toEqual(result.frozen.logical)
    expect(production.recommendation).toEqual(output().recommendation)
    expect(result.frozen.request.maxRetries).toBe(0)
    expect(result.frozen.request.temperature).toBeUndefined()
    expect(result.frozen.logical.schema).toHaveProperty("properties")
    expect(network).not.toHaveBeenCalled()
  })

  it("hashes all logical variables including image bytes, schema citations and generation options", async () => {
    const prepared = await frozen()
    const request = prepared.request
    for (const changed of [
      { ...request, system: request.system + " changed" }, { ...request, maxRetries: 1 },
      { ...request, temperature: 0.5 }, { ...request, messages: [{ role: "user" as const, content: [{ type: "image" as const, image: "changed" }] }] },
    ]) expect(hash(logicalRequest(changed))).not.toBe(prepared.hashes.request)
    const otherRange = await prepare({ pdfBuffer: await pdf(), userLanguage: "pt-BR", range: { start: 4, end: 5 } })
    expect(otherRange.hashes.request).not.toBe(prepared.hashes.request)
    expect(otherRange.hashes.pdf).toBe(prepared.hashes.pdf)
    expect(() => { prepared.request.messages![0]!.content = "mutation" }).toThrow()
  })

  it("makes ten sequential calls using the same request; excludes invalid/error choices and preserves usage", async () => {
    const prepared = await frozen()
    let active = false
    let calls = 0
    const requests: unknown[] = []
    const model: LLMModel = {
      async generateObject<T>(request: Parameters<LLMModel["generateObject"]>[0]) {
        expect(active).toBe(false); active = true
        requests.push(request)
        await Promise.resolve()
        active = false; calls++
        if (calls === 2) throw { statusCode: 429, message: "sensitive-test-message" }
        if (calls === 3) return { object: {} as T }
        return { object: output() as T, usage: { inputTokens: 0, outputTokens: 2 } }
      }, async renderPrompt() { throw new Error("Unexpected render") },
    }
    const persisted: unknown[] = []
    const records = await runRepetitions(prepared, model, metadata, async record => { persisted.push(record) })
    expect(calls).toBe(10)
    expect(requests.every(request => request === prepared.request)).toBe(true)
    expect(records.map(r => r.status)).toEqual(["success", "error", "invalid", ...Array(7).fill("success")])
    expect(records[0]!.usage?.inputTokens).toBe(0)
    expect(records[1]!.errorCategory).toBe("rate-limit-or-quota")
    expect(records[0]!.choices && Object.keys(records[0]!.choices)).toEqual(DECISION_IDS)
    expect(JSON.stringify(persisted)).not.toContain("sensitive-test-message")
    expect(records[2]!.choices).toBeUndefined()
  })

  it("default main performs preparation only even with credentials present; saves exclusive artifacts", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockImplementation(() => { throw new Error("Network forbidden") })
    vi.stubEnv("OPENAI_API_KEY", "unused-synthetic-key")
    const temporary = await mkdtemp(path.join(os.tmpdir(), "adt-e0-test-")); directories.push(temporary)
    const pdfPath = path.join(temporary, "fixture.pdf")
    await writeFile(pdfPath, await pdf())
    const manifest = path.join(temporary, "corpus.json")
    await writeFile(manifest, JSON.stringify({ cases: ["a", "b", "c"].map(id => ({ id, candidate: "synthetic", pdf: pdfPath,
      range: { start: 2, end: 3 }, userLanguage: "pt-BR" })) }))
    const snapshot = await frozen()
    const verified = { frozen: snapshot, hashes: [snapshot.hashes, snapshot.hashes, snapshot.hashes], deterministic: true }
    const verify = vi.spyOn(preparation, "verifyPreparation").mockResolvedValue(verified)
    try {
      const outputDir = await main(["--corpus", manifest], path.join(temporary, "results"))
      expect(JSON.parse(await readFile(path.join(outputDir, "run.json"), "utf8")).mode).toBe("prepare-only")
      expect(await readdir(path.join(outputDir, "a"))).toEqual(["evidence.json", "preparation.json", "request.json"])
      expect(network).not.toHaveBeenCalled()
      await expect(save(path.join(outputDir, "run.json"), {})).rejects.toThrow()
      await expect(main(["--corpus", manifest, "--allow-paid"], path.join(temporary, "results"))).rejects.toThrow("three distinct PDFs")
      verify.mockResolvedValue({ ...verified, deterministic: false })
      await expect(main(["--corpus", manifest, "--allow-paid"], path.join(temporary, "results"))).rejects.toThrow("Corpus/preparation blocked")
      expect(network).not.toHaveBeenCalled()
    } finally { vi.unstubAllEnvs() }
  })

  it("rejects malformed or repeated CLI options before preparing or creating a provider", async () => {
    for (const args of [["--paid"], ["--corpus"], ["--allow-paid", "--allow-paid"], ["--corpus", "--allow-paid"]]) {
      await expect(main(args)).rejects.toThrow("Usage")
    }
  })
})
