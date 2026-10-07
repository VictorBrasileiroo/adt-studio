import fs from "node:fs"
import path from "node:path"
import { Hono } from "hono"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AiProviderError, getDefaultProviderRegistry, type LLMModel } from "@adt/llm"
import { setupResultSchema, type SetupResult } from "@adt/types"
import { errorHandler } from "../middleware/error-handler.js"
import { recommendSetup } from "../services/setup-recommendation/recommend.js"
import { createSetupRecommendationRoutes } from "./setup-recommendation.js"

const RAVEN_PDF = path.resolve(import.meta.dirname, "../../../../tests/fixtures/raven.pdf")
const common = { confidence: "high", reason: "Evidence", alternative: null, ambiguityReason: null, evidencePages: [1] } as const
const result: SetupResult = {
  provider: "openai", model: "gpt-5.4-mini", promptVersion: "adt-config-recommender-poc-v1", userLanguage: "pt-BR",
  recommendation: {
    preset: { ...common, choice: "textbook" }, renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" }, sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "enabled" }, figureExtraction: { ...common, choice: "auto" },
  },
  usage: { inputTokens: 11, outputTokens: 12, totalTokens: 23 }, timing: { totalMs: 5 }, bookProfile: { pageCount: 1 },
}
const secret = "test-credential-never-output"

function form() {
  const body = new FormData()
  body.append("pdf", new File(["%PDF-1.7"], "book.pdf", { type: "application/pdf" }))
  body.append("userLanguage", "pt-BR")
  return body
}

function harness(recommend = vi.fn<typeof recommendSetup>().mockResolvedValue(result)) {
  const llmModel: LLMModel = { generateObject: vi.fn(), renderPrompt: vi.fn() }
  const createModel = vi.fn(() => llmModel)
  const app = new Hono().onError(errorHandler)
  app.route("/api", createSetupRecommendationRoutes({ recommendSetup: recommend, createSetupRecommendationModel: createModel }))
  const send = (body = form()) => app.request("/api/setup/recommendation", { method: "POST", body, headers: { "X-OpenAI-Key": secret } })
  return { app, send, recommend, createModel, llmModel }
}

function pdfBytes(): Buffer {
  return fs.readFileSync(RAVEN_PDF)
}

beforeEach(() => {
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network is disabled in route tests"))
})
afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

describe("setup recommendation route", () => {
  it("AC-1: returns the six-decision setup recommendation contract", async () => {
    const { send, recommend, createModel, llmModel } = harness()
    const body = form()
    body.set("userLanguage", "  pt-BR  ")
    body.set("pages", JSON.stringify({ start: 20, end: 30 }))
    body.set("provider", "anthropic")
    body.set("model", "ignored")
    const res = await send(body)
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(setupResultSchema.parse(json)).toEqual(result)
    expect(Object.keys(json.recommendation)).toHaveLength(6)
    expect(recommend).toHaveBeenCalledExactlyOnceWith({
      pdfBuffer: Buffer.from("%PDF-1.7"), userLanguage: "pt-BR", range: { start: 20, end: 30 }, signal: expect.any(AbortSignal),
    }, { llmModel })
    expect(createModel).toHaveBeenCalledExactlyOnceWith({ openai: { apiKey: secret } })
    expect(JSON.stringify(json).includes(secret)).toBe(false)
  })

  it("accepts no range and PDF extension when MIME is absent", async () => {
    const { send, recommend } = harness()
    const body = form()
    body.set("pdf", new File(["%PDF-1.7"], "BOOK.PDF"))
    expect((await send(body)).status).toBe(200)
    expect(recommend.mock.calls[0][0].range).toBeUndefined()
  })

  it.each([
    ["missing pdf", (body: FormData) => body.delete("pdf")],
    ["string pdf", (body: FormData) => body.set("pdf", "book.pdf")],
    ["non-PDF", (body: FormData) => body.set("pdf", new File(["text"], "book.txt", { type: "text/plain" }))],
    ["missing language", (body: FormData) => body.delete("userLanguage")],
    ["blank language", (body: FormData) => body.set("userLanguage", "  ")],
    ["file language", (body: FormData) => body.set("userLanguage", new File(["en"], "language.txt"))],
    ...["{", "null", "[]", '{"start":1.5,"end":2}', '{"start":0,"end":2}', '{"start":2,"end":1}',
      '{"start":1,"end":0}', '{"start":1,"end":2.5}', '{"start":1,"end":2,"extra":true}', '{"start":"1","end":2}', '{"start":1}']
      .map((pages) => [`pages ${pages}`, (body: FormData) => body.set("pages", pages)] as const),
    ["file pages", (body: FormData) => body.set("pages", new File(["{}"], "pages.json"))],
  ] as const)("rejects %s at the HTTP boundary", async (_, change) => {
    const { send, recommend, createModel } = harness()
    const body = form()
    change(body)
    expect((await send(body)).status).toBe(400)
    expect(recommend).not.toHaveBeenCalled()
    expect(createModel).not.toHaveBeenCalled()
  })

  it("rejects non-multipart and malformed multipart without invoking the model", async () => {
    const { app, recommend } = harness()
    for (const headers of [{ "Content-Type": "application/json" }, { "Content-Type": "multipart/form-data; boundary=missing" }]) {
      const res = await app.request("/api/setup/recommendation", { method: "POST", headers, body: "{}" })
      expect(res.status).toBe(400)
    }
    expect(recommend).not.toHaveBeenCalled()
  })

  it("AC-11: propagates cancel and classifies recoverable setup failures", async () => {
    const controller = new AbortController()
    let serviceSignal: AbortSignal | undefined
    const recommend = vi.fn<typeof recommendSetup>((input) => {
      serviceSignal = input.signal
      return new Promise((_, reject) => input.signal!.addEventListener("abort", () => reject(input.signal!.reason), { once: true }))
    })
    const { app } = harness(recommend)
    const raw = new Request("http://localhost/api/setup/recommendation", { method: "POST", body: form(), signal: controller.signal })
    const pending = app.request(raw)
    await vi.waitFor(() => expect(serviceSignal).toBe(raw.signal))
    controller.abort()
    expect((await pending).status).toBe(500)
    expect(serviceSignal?.aborted).toBe(true)
    expect(recommend).toHaveBeenCalledTimes(1)
  })

  it.each([401, 403, 429])("preserves upstream HTTP %s without exposing request data", async (statusCode) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const upstream = Object.assign(new Error(`Rejected ${secret}`), {
      statusCode,
      requestBodyValues: { image: "image-base64-never-output" }, responseHeaders: { authorization: secret },
    })
    const { send } = harness(vi.fn<typeof recommendSetup>().mockRejectedValue(upstream))
    const res = await send()
    expect(res.status).toBe(statusCode)
    const text = await res.text()
    expect(text.includes(secret)).toBe(false)
    expect(text.includes("image-base64-never-output")).toBe(false)
    expect(log).not.toHaveBeenCalled()
  })

  it("also preserves numeric status while ignoring string status", async () => {
    for (const [status, expected] of [[403, 403], ["429", 500]] as const) {
      const { send } = harness(vi.fn<typeof recommendSetup>().mockRejectedValue(Object.assign(new Error(secret), { status })))
      expect((await send()).status).toBe(expected)
    }
  })

  it.each(["PDF unreadable", "Page range must contain integers satisfying 1 <= start <= end <= 1", "Invalid structured output", "quota authentication"])
  ("keeps untyped failure unknown: %s", async (message) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {})
    const { send } = harness(vi.fn<typeof recommendSetup>().mockRejectedValue(new Error(`${message} ${secret}`)))
    const res = await send()
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: "Setup recommendation failed" })
    expect(log).not.toHaveBeenCalled()
  })

  it("keeps AiProviderError handling in the global middleware", async () => {
    const { send, createModel, recommend } = harness()
    createModel.mockImplementation(() => { throw new AiProviderError("missing-credential", "OpenAI API key is required", { providerId: "openai", credentialKey: "apiKey" }) })
    const res = await send()
    expect(res.status).toBe(400)
    expect(await res.json()).toMatchObject({ code: "missing-credential", provider: "openai" })
    expect(recommend).not.toHaveBeenCalled()
  })

  it("rejects an invalid service result at the response boundary", async () => {
    const { send } = harness(vi.fn<typeof recommendSetup>().mockResolvedValue({ ...result, recommendation: {} } as SetupResult))
    expect((await send()).status).toBe(500)
  })

  it.each([false, true])("AC-12: resolves OpenAI server credentials with request override %s through the real service", async (override) => {
    vi.stubEnv("OPENAI_API_KEY", "server-test-credential")
    const info = vi.spyOn(console, "log").mockImplementation(() => {})
    const error = vi.spyOn(console, "error").mockImplementation(() => {})
    const generateStructured = vi.fn().mockResolvedValue({ object: { recommendation: result.recommendation }, usage: { inputTokens: 0, outputTokens: 0 } })
    const backend = vi.spyOn(getDefaultProviderRegistry().get("openai"), "createStructuredTextBackend").mockImplementation((context) => {
      expect(context.modelId).toBe("gpt-5.4-mini")
      expect(context.credentials.apiKey === (override ? secret : "server-test-credential")).toBe(true)
      return { generateStructured }
    })
    const app = new Hono().onError(errorHandler).route("/api", createSetupRecommendationRoutes())
    const body = form()
    body.set("pdf", new File([new Uint8Array(pdfBytes())], "real.pdf", { type: "application/pdf" }))
    // Keep the real PDF inspection to one physical page, matching the fake's citations.
    body.set("pages", JSON.stringify({ start: 1, end: 1 }))
    const res = await app.request("/api/setup/recommendation", { method: "POST", body, headers: override ? { "X-OpenAI-Key": secret } : {} })
    expect(res.status).toBe(200)
    expect((await res.text()).includes(secret)).toBe(false)
    expect(backend).toHaveBeenCalledTimes(1)
    expect(generateStructured).toHaveBeenCalledTimes(1)
    for (const log of [info, error]) {
      expect(JSON.stringify(log.mock.calls).includes(secret)).toBe(false)
      expect(JSON.stringify(log.mock.calls).includes("server-test-credential")).toBe(false)
    }
  })

  it("AC-14: recommendation does not create persistent book state before Create", async () => {
    const bytes = pdfBytes()
    const writes = [vi.spyOn(fs, "mkdirSync"), vi.spyOn(fs, "writeFileSync"), vi.spyOn(fs, "appendFileSync"),
      vi.spyOn(fs.promises, "mkdir"), vi.spyOn(fs.promises, "writeFile"), vi.spyOn(fs.promises, "appendFile")]
    const { send, llmModel } = harness(vi.fn(recommendSetup))
    vi.mocked(llmModel.generateObject).mockResolvedValue({ object: { recommendation: result.recommendation } })
    const body = form()
    body.set("pdf", new File([new Uint8Array(bytes)], "real.pdf", { type: "application/pdf" }))
    body.set("pages", JSON.stringify({ start: 1, end: 1 }))
    expect((await send(body)).status).toBe(200)
    expect(llmModel.generateObject).toHaveBeenCalledTimes(1)
    for (const write of writes) expect(write).not.toHaveBeenCalled()
  })
})
