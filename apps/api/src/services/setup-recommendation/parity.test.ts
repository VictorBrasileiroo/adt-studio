import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import http from "node:http"
import https from "node:https"
import net from "node:net"
import tls from "node:tls"
import { afterEach, describe, expect, it, vi } from "vitest"
import { z } from "zod"
import type { ContentPart, GenerateObjectOptions, LLMModel } from "@adt/llm"
import { extractSetupRecommendationEvidence } from "@adt/pdf"
import type { createSetupRecommendationModelSchema } from "@adt/types"
import baseline from "./__fixtures__/poc-v1/raven.json"
import { prepareSetupRecommendationEvidence } from "./evidence.js"
import { recommendSetup, SETUP_RECOMMENDATION_MODEL_ID } from "./recommend.js"

// Observe the real extractor's return values; never replace PDF preparation.
vi.mock("@adt/pdf", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@adt/pdf")>()
  return { ...actual, extractSetupRecommendationEvidence: vi.fn(actual.extractSetupRecommendationEvidence) }
})

const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex")
const dimensions = (buffer: Buffer) => ({ width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) })
function literalPages(schema: z.ZodType<number>): number[] {
  if (schema instanceof z.ZodLiteral && typeof schema.value === "number") return [schema.value]
  if (schema instanceof z.ZodUnion) return schema.options.flatMap((option: z.ZodType<number>) => literalPages(option))
  throw new Error("Expected sampled physical page literals in the captured schema")
}

afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks() })

describe("frozen poc-v1 Raven parity (local/provisional SPEC-0016)", () => {
  it("AC-13: compares integrated evidence and logical request with the independent poc-v1 baseline offline", async () => {
    const forbidden = () => { throw new Error("Network is forbidden in deterministic parity") }
    const network = [
      vi.spyOn(globalThis, "fetch").mockImplementation(forbidden),
      vi.spyOn(http, "request").mockImplementation(forbidden),
      vi.spyOn(http, "get").mockImplementation(forbidden),
      vi.spyOn(https, "request").mockImplementation(forbidden),
      vi.spyOn(https, "get").mockImplementation(forbidden),
      vi.spyOn(net.Socket.prototype, "connect").mockImplementation(forbidden),
      vi.spyOn(tls, "connect").mockImplementation(forbidden),
    ]
    const pdfBuffer = await readFile(new URL("../../../../../tests/fixtures/raven.pdf", import.meta.url))
    // Verify the canonical input before invoking either preparation path.
    expect(sha256(pdfBuffer)).toBe(baseline.pdf.sha256)
    expect(baseline.pdf.path).toBe("tests/fixtures/raven.pdf")
    expect(baseline.pocCommit).toBe("fd367428b5ca9bf1c2d7df1d980fe02788c02d17")
    const poc = baseline.pocBaseline
    const delta = baseline.knownEngineDeltas
    // Each exception names both the independently measured PoC value and the
    // precise MuPDF result. Everything else remains strict PoC equality.
    expect(poc.observations[11].charCount).toBe(delta.page12.charCount.poc)
    expect(poc.observations[11].textItemCount).toBe(delta.page12.textItemCount.poc)
    expect(poc.bookProfile.text.totalChars).toBe(delta.bookProfileText.totalChars.poc)
    expect(poc.bookProfile.text.avgCharsPerPage).toBe(delta.bookProfileText.avgCharsPerPage.poc)
    expect(poc.request.parts[0]).toEqual(delta.requestProfile.poc)
    const expectedObservations = poc.observations.map(page => page.pageNumber === 12
      ? { ...page, charCount: delta.page12.charCount.adt, textItemCount: delta.page12.textItemCount.adt }
      : page)
    const expectedProfile = { ...poc.bookProfile, text: {
      ...poc.bookProfile.text, totalChars: delta.bookProfileText.totalChars.adt,
      avgCharsPerPage: delta.bookProfileText.avgCharsPerPage.adt,
    } }

    // Compare consumer-visible render evidence. Individual raster dimensions in
    // poc.render.pages remain provenance; rasterization is covered in @adt/pdf.
    const prepared = prepareSetupRecommendationEvidence(pdfBuffer)
    expect(prepared.pageCount).toBe(baseline.pdf.pageCount)
    expect(prepared.observations).toEqual(expectedObservations)
    expect(prepared.bookProfile).toEqual(expectedProfile)
    expect(prepared.sampledPagePairs.map(({ pages }) => pages.map(page => page?.pageNumber))).toEqual(poc.pairs)
    expect(prepared.sampledPagePairs.flatMap(({ pages }) => pages.map(page => page?.pageNumber))).toEqual(poc.sampledPages)
    expect(prepared.sampledPagePairs.flatMap(({ pages }) => pages.filter(page => page !== undefined)
      .map(page => ({ pageNumber: page.pageNumber, length: page.text.length, sha256: sha256(page.text) }))))
      .toEqual(poc.sampledText)
    expect(prepared.sampledPagePairs.map(pair => ({ pages: pair.pages.map(page => page?.pageNumber), ...dimensions(pair.imageBuffer) })))
      .toEqual(poc.render.sheets)

    // Tokens identify real contact sheets with equal dimensions. Spies attach
    // only to these returned buffer instances, never to a global prototype.
    const images = new Map<string, { kind: string; pairNumber: number; pages: number[]; dimensions: ReturnType<typeof dimensions> }>()
    const projectPart = (part: ContentPart) => {
      if (part.type === "image") {
        expect(images.has(part.image)).toBe(true)
        return images.get(part.image)
      }
      const pair = /^Pair (\d+) — pages (\d+(?: and \d+)?)\n/.exec(part.text)
      return { kind: part.text.startsWith("GLOBAL STRUCTURAL PROFILE\n") ? "profile" : pair ? "pairText" : "task",
        length: part.text.length, sha256: sha256(part.text),
        ...(pair ? { pairNumber: Number(pair[1]), pages: pair[2].split(" and ").map(Number) } : {}) }
    }
    // Synthetic response, not a saved PoC/model recommendation. Existing suites
    // cover retries and semantic rejection; this test captures the real request.
    const common = { confidence: "high", reason: "Offline parity harness", alternative: null, ambiguityReason: null, evidencePages: [] }
    const object = { recommendation: Object.fromEntries(poc.request.schema.decisions.map(({ id, choices }) => [id, { ...common, choice: choices[0] }])) }
    const generateObject = vi.fn<LLMModel["generateObject"]>().mockResolvedValue({ object })
    const llmModel: LLMModel = {
      generateObject: async <T>(options: GenerateObjectOptions) => ({ object: (await generateObject(options)).object as T }),
      renderPrompt: vi.fn(),
    }
    const { extractSetupRecommendationEvidence: extract } = await vi.importActual<typeof import("@adt/pdf")>("@adt/pdf")
    let result!: Awaited<ReturnType<typeof recommendSetup>>
    await vi.mocked(extractSetupRecommendationEvidence).withImplementation(input => {
      const evidence = extract(input)
      evidence.sampledPagePairs.forEach((pair, index) => {
        const toString = pair.imageBuffer.toString.bind(pair.imageBuffer)
        vi.spyOn(pair.imageBuffer, "toString").mockImplementation((encoding, start, end) => {
          if (encoding === "base64") {
            const token = `parity-contact-sheet-${index}`
            images.set(token, { kind: "pairImage", pairNumber: index + 1,
              pages: pair.pages.flatMap(page => page ? [page.pageNumber] : []),
              dimensions: dimensions(pair.imageBuffer) })
            return token
          }
          return toString(encoding, start, end)
        })
      })
      return evidence
    }, async () => {
      result = await recommendSetup({ pdfBuffer, userLanguage: poc.request.userLanguage }, { llmModel })
    })
    expect(generateObject).toHaveBeenCalledTimes(1)
    expect(llmModel.renderPrompt).not.toHaveBeenCalled()
    expect(images.size).toBe(poc.render.sheets.length)
    expect(SETUP_RECOMMENDATION_MODEL_ID).toBe(`${poc.request.provider}:${poc.request.model}`)
    expect({ provider: result.provider, model: result.model, promptVersion: result.promptVersion, userLanguage: result.userLanguage })
      .toEqual({ provider: poc.request.provider, model: poc.request.model, promptVersion: poc.request.promptVersion, userLanguage: poc.request.userLanguage })
    const request = generateObject.mock.calls[0][0]
    const system = request.system ?? ""
    expect(sha256(system)).toBe(poc.request.promptSha256)
    expect(sha256(system.slice(system.indexOf("ADT DECISION KNOWLEDGE"), system.lastIndexOf("\n\nUser language:"))))
      .toBe(poc.request.decisionKnowledgeSha256)
    expect(request.messages?.map(message => ({ role: message.role,
      parts: Array.isArray(message.content) ? message.content.map(projectPart) : message.content })))
      .toEqual([{ role: poc.request.role, parts: poc.request.parts.map((part, index) => index === 0 ? delta.requestProfile.adt : part) }])

    // Project the captured model schema into PoC-derived logical fields, avoiding
    // Zod-version / provider JSON Schema / AI SDK object comparisons.
    const schema = request.schema as ReturnType<typeof createSetupRecommendationModelSchema>
    expect(Object.keys(schema.shape)).toEqual(["recommendation"])
    expect(Object.entries(schema.shape.recommendation.shape).map(([id, decision]) => ({ id, choices: decision.options[0].shape.choice.options })))
      .toEqual(poc.request.schema.decisions)
    for (const decision of Object.values(schema.shape.recommendation.shape)) {
      expect(decision.options.map(branch => {
        expect(Object.keys(branch.shape)).toEqual(poc.request.schema.fields)
        expect(Object.entries(branch.shape).filter(([, field]) => !field.isOptional()).map(([name]) => name))
          .toEqual(poc.request.schema.fields)
        const pageSchema = branch.shape.evidencePages.element
        expect(literalPages(pageSchema)).toEqual(poc.request.schema.sampledPages)
        const alternative = branch.shape.alternative
        if (alternative instanceof z.ZodEnum) expect(alternative.options).toEqual(branch.shape.choice.options)
        return { confidence: branch.shape.confidence.options,
          alternative: alternative instanceof z.ZodNull ? "null" : "choice",
          ambiguityReason: branch.shape.ambiguityReason instanceof z.ZodNull ? "null" : "string",
          reasonMinLength: branch.shape.reason.minLength, reasonMaxLength: branch.shape.reason.maxLength }
      })).toEqual(poc.request.schema.branches)
    }
    for (const spy of network) expect(spy).not.toHaveBeenCalled()
  })
})
