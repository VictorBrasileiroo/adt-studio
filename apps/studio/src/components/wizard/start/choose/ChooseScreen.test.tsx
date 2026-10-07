// @vitest-environment jsdom
import React, { type ReactNode } from "react"
import { QueryClient, QueryClientProvider } from "@tanstack/react-query"
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { ProviderDescriptor } from "@adt/types"
import { getProviders } from "@/api/client"
import { ChooseScreen } from "./ChooseScreen"

vi.mock("@/api/client", () => ({ getProviders: vi.fn() }))
vi.mock("@lingui/react/macro", () => ({ Trans: ({ children }: { children: ReactNode }) => children, useLingui: () => ({ t: (s: TemplateStringsArray) => s.join("") }) }))
vi.mock("@tanstack/react-router", () => ({ Link: ({ children }: { children: ReactNode }) => <a>{children}</a> }))
vi.mock("@tanstack/react-form", () => ({ useStore: () => null }))
vi.mock("@/components/wizard/core/wizardForm", () => ({ useWizardForm: () => ({ store: {} }) }))
vi.mock("./useSampledPages", () => ({ useSampledPages: () => ({ pages: [], isLoading: false }) }))
vi.mock("./scenes", () => ({ AiPill: () => null, AutoScene: () => null, ManualScene: () => null }))
vi.mock("../../core/ui", () => ({
  ENTER: "", ScreenShell: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  BackButton: () => null, PrimaryButton: ({ children, onClick }: { children: ReactNode; onClick: () => void }) => <button onClick={onClick}>{children}</button>,
}))

function descriptor(id = "openai", server = false, imageInput = true): ProviderDescriptor {
  return {
    manifest: {
      id, displayName: id, modalities: ["structured-text"],
      credentialFields: [{ key: "apiKey", kind: "secret", required: true, header: `X-${id}-Key`, storageKey: `test-${id}-key`,
        legacyHeaders: [], legacyStorageKeys: [], label: { en: "Key", "pt-BR": "Key", es: "Key", fr: "Key", sq: "Key" } }],
      capabilities: { "structured-text": { strategies: ["native-schema"], recursiveSchemas: false, imageInput, temperature: true } },
      defaultModels: {},
    },
    configuredOnServer: server, fieldStatus: [{ key: "apiKey", configuredOnServer: server }],
  }
}

afterEach(() => {
  cleanup()
  window.localStorage.clear()
  vi.clearAllMocks()
})

describe("ChooseScreen OpenAI availability", () => {
  it.each([
    ["local OpenAI despite Anthropic global default", [descriptor()], true, true],
    ["server OpenAI without local key", [descriptor("openai", true)], false, true],
    ["only Anthropic", [descriptor("anthropic", true)], false, false],
    ["only Google", [descriptor("google", true)], false, false],
    ["only Codex CLI", [descriptor("codex", true)], false, false],
    ["only Custom", [descriptor("custom", true)], false, false],
    ["only Ollama", [descriptor("ollama", true)], false, false],
    ["OpenAI without credentials", [descriptor()], false, false],
    ["OpenAI without imageInput", [descriptor("openai", true, false)], false, false],
    ["OpenAI without structured-text", [{ ...descriptor("openai", true), manifest: { ...descriptor().manifest, modalities: [] } }], false, false],
    ["descriptor flag without fieldStatus", [{ ...descriptor(), configuredOnServer: true }], false, false],
  ] as const)("AC-12: exposes the initial recommender only through its supported OpenAI path: %s", async (_, providers, local, enabled) => {
    vi.mocked(getProviders).mockResolvedValue({ providers: [...providers], defaults: { "structured-text": "anthropic:claude" } })
    if (local) window.localStorage.setItem(descriptor().manifest.credentialFields[0].storageKey, "fixture-credential")
    const onAuto = vi.fn()
    const onManual = vi.fn()
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    render(<QueryClientProvider client={queryClient}><ChooseScreen onAuto={onAuto} onManual={onManual} onBack={vi.fn()} /></QueryClientProvider>)
    await waitFor(() => expect(queryClient.getQueryState(["providers"])?.status).toBe("success"))
    const auto = screen.getByRole("radio", { name: /Let AI set it up/ }) as HTMLInputElement
    await waitFor(() => expect(auto.disabled).toBe(!enabled))
    expect(auto.checked).toBe(enabled)
    fireEvent.click(auto)
    fireEvent.click(screen.getByRole("button", { name: "Continue" }))
    expect(onAuto).toHaveBeenCalledTimes(enabled ? 1 : 0)
    expect(onManual).toHaveBeenCalledTimes(enabled ? 0 : 1)
    if (enabled) {
      fireEvent.click(screen.getByRole("radio", { name: /Set it up myself/ }))
      fireEvent.click(screen.getByRole("button", { name: "Continue" }))
      expect(onManual).toHaveBeenCalledTimes(1)
    }
  })
})
