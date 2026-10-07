// @vitest-environment jsdom
import { cleanup, renderHook, waitFor } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { ProviderDescriptor, SetupResult } from "@adt/types"
import { buildProviderCredentialHeaders } from "@/api/provider-credentials"
import { useSetupRun } from "./useSetupRun"

vi.mock("@/lib/utils", () => ({ isElectron: () => false }))
const provider: ProviderDescriptor = {
  manifest: {
    id: "openai", displayName: "OpenAI", modalities: ["structured-text"],
    credentialFields: [{ key: "apiKey", kind: "secret", required: true, header: "X-OpenAI-Key",
      storageKey: "test-openai-storage", legacyHeaders: [], legacyStorageKeys: [],
      label: { en: "Key", "pt-BR": "Key", es: "Key", fr: "Key", sq: "Key" } }],
    capabilities: { "structured-text": { strategies: ["native-schema"], recursiveSchemas: false, imageInput: true, temperature: true } },
    defaultModels: {},
  },
  configuredOnServer: false, fieldStatus: [{ key: "apiKey", configuredOnServer: false }],
}
const common = { confidence: "high", reason: "Evidence", alternative: null, ambiguityReason: null, evidencePages: [20] } as const
const answer: SetupResult = {
  provider: "openai", model: "gpt-5.4-mini", promptVersion: "adt-config-recommender-poc-v1", userLanguage: "pt-BR",
  recommendation: {
    preset: { ...common, choice: "textbook" }, renderStrategy: { ...common, choice: "llm" },
    pageGrouping: { ...common, choice: "single" }, sectioningMode: { ...common, choice: "page" },
    activitiesGenerator: { ...common, choice: "enabled" }, figureExtraction: { ...common, choice: "auto" },
  }, usage: {},
}
const file = new File(["%PDF-1.7"], "book.pdf", { type: "application/pdf" })
const secret = "fixture-secret-never-snapshot"
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })

beforeEach(() => {
  vi.resetModules()
  window.localStorage.clear()
})
afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
  window.localStorage.clear()
})

async function clients() {
  const apiModule = await import("@/api/client")
  const feature = await import("./client")
  const context = await import("./SetupClientContext")
  // Populate the manifest cache using the real request infrastructure.
  const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => json({ providers: [provider], defaults: {} }))
  await apiModule.api.recommendSetup(file, "en")
  fetchSpy.mockClear()
  fetchSpy.mockImplementation(async () => json(answer))
  return { ...apiModule, ...feature, ...context, fetchSpy }
}

describe("API SetupClient", () => {
  it.each([undefined, { start: 20, end: 30 }])("AC-1: sends the exact upload, locale, range %j, credentials and signal", async (pages) => {
    const { apiSetupClient, fetchSpy } = await clients()
    window.localStorage.setItem(provider.manifest.credentialFields[0].storageKey, secret)
    const controller = new AbortController()
    const result = await apiSetupClient.recommend({ file, userLanguage: "pt-BR", pages }, controller.signal)
    expect(result).toEqual(answer)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
    const [url, options] = fetchSpy.mock.calls[0]
    expect(url).toBe("/api/setup/recommendation")
    expect(options?.method).toBe("POST")
    expect(options?.signal).toBe(controller.signal)
    const form = options?.body as FormData
    expect(form.get("pdf")).toBe(file)
    expect(form.get("userLanguage")).toBe("pt-BR")
    expect(form.get("pages")).toBe(pages ? JSON.stringify(pages) : null)
    expect([...form.keys()]).toEqual(pages ? ["pdf", "userLanguage", "pages"] : ["pdf", "userLanguage"])
    const headers = new Headers(options?.headers)
    const expected = buildProviderCredentialHeaders([provider], { openai: { apiKey: secret } })
    // Boolean comparisons prevent a failing assertion from printing credentials.
    expect(headers.get("X-OpenAI-Key") === expected["X-OpenAI-Key"]).toBe(true)
    expect(headers.has("Content-Type")).toBe(false)
    expect(String(url).includes(secret)).toBe(false)
  })

  it("uses the API by default and needs no local header with server credentials", async () => {
    const { useSetupClient, apiSetupClient, fetchSpy } = await clients()
    const { result } = renderHook(() => useSetupClient())
    expect(result.current).toBe(apiSetupClient)
    await result.current.recommend({ file, userLanguage: "en" }, new AbortController().signal)
    expect(new Headers(fetchSpy.mock.calls[0][1]?.headers).has("X-OpenAI-Key")).toBe(false)
  })

  it.each([[401, "auth"], [403, "auth"], [429, "quota"], [500, "unknown"], [400, "unknown"]] as const)
  ("AC-11: preserves HTTP %s and classifies it as %s", async (status, kind) => {
    const { apiSetupClient, ApiRequestError, classifySetupError, fetchSpy } = await clients()
    fetchSpy.mockImplementation(async () => json({ error: "Provider rejected request" }, status))
    const error = await apiSetupClient.recommend({ file, userLanguage: "en" }, new AbortController().signal).catch((error: unknown) => error)
    expect(error).toBeInstanceOf(ApiRequestError)
    expect((error as InstanceType<typeof ApiRequestError>).status).toBe(status)
    expect(classifySetupError(error).kind).toBe(kind)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it("AC-11: keeps fetch rejection offline", async () => {
    const { apiSetupClient, classifySetupError, fetchSpy } = await clients()
    fetchSpy.mockRejectedValue(new TypeError("Failed to fetch"))
    const error = await apiSetupClient.recommend({ file, userLanguage: "en" }, new AbortController().signal).catch((error: unknown) => error)
    expect(classifySetupError(error).kind).toBe("offline")
  })

  it("AC-11: aborts the real adapter's fetch when the loader unmounts without another HTTP attempt", async () => {
    const { apiSetupClient, fetchSpy } = await clients()
    let signal: AbortSignal | undefined
    fetchSpy.mockImplementation((_, options) => {
      signal = options?.signal as AbortSignal
      return new Promise((_, reject) => signal!.addEventListener("abort", () => reject(signal!.reason), { once: true }))
    })
    const { unmount } = renderHook(() => useSetupRun(apiSetupClient, { file, userLanguage: "en" }, 0))
    await waitFor(() => expect(signal).toBeDefined())
    unmount()
    expect(signal?.aborted).toBe(true)
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })
})
