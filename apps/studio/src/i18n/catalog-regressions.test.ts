import { readFileSync } from "node:fs"
import { createCompiledCatalog } from "@lingui/cli/api"
import { setupI18n, type Messages } from "@lingui/core"
import { formatter } from "@lingui/format-po"
import { describe, expect, it } from "vitest"

const catalogs = Object.fromEntries(
  ["en", "es", "fr", "sq"].map((locale) => [
    locale,
    formatter().parse(
      readFileSync(new URL(`../locales/${locale}.po`, import.meta.url), "utf8"),
      { locale },
    ),
  ]),
)

function translation(locale: string, msgid: string, msgctxt?: string) {
  const entries = Object.values(catalogs[locale]).filter(
    (entry) => entry.message === msgid && entry.context === msgctxt,
  )
  expect(entries).toHaveLength(1)
  expect(entries[0].translation).not.toBe("")
  return entries[0].translation
}

function compile(locale: string, message: string) {
  const { source, errors } = createCompiledCatalog(
    locale,
    { regression: message },
    { namespace: "json", strict: true },
  )
  expect(errors).toEqual([])
  return (JSON.parse(source) as { messages: Messages }).messages
}

// These specific messages only use simple interpolation. Read the ICU arguments
// from Lingui's compiled tokens, keeping numeric names (e.g. "0") intact.
function argumentsOf(messages: Messages) {
  const message = messages.regression
  if (typeof message === "string") return []
  return [...new Set(message.flatMap((token) => {
    if (typeof token === "string") return []
    expect(token).toHaveLength(1)
    return [String(token[0])]
  }))].sort()
}

function formatTranslation(locale: string, msgid: string) {
  const english = compile("en", translation("en", msgid))
  const localized = compile(locale, translation(locale, msgid))
  const args = argumentsOf(english)
  const values = Object.fromEntries(
    args.map((arg) => [arg, `__catalog_${arg}__`]),
  )
  const i18n = setupI18n({ locale, messages: { [locale]: localized } })
  const rendered = i18n._("regression", values)

  expect.soft(argumentsOf(localized)).toEqual(args)
  for (const sentinel of Object.values(values)) {
    expect.soft(rendered).toContain(sentinel)
  }
  return rendered
}

describe("#937 Spanish named placeholders", () => {
  it.each([
    "Cover of {title}",
    'No matches for "{search}"',
    "Open page preview for {pageId}",
    "Page {pageId}",
    "Pruned: {reason}",
    "Re-run {stageLabel}",
    "Run {stageLabel}",
    "Selected: {styleImageId}",
    "Styleguide Preview — {styleguide}",
    "Unknown step slug: {step}",
    "Unknown step: {step}",
  ])("preserves and interpolates the English arguments: %s", (msgid) => {
    formatTranslation("es", msgid)
  })
})

const escapeCases = [
  { locales: ["es", "fr"], msgid: '"A landscape forged by fire."' },
  { locales: ["fr"], msgid: 'No matches for "{search}"' },
  {
    locales: ["es", "fr"],
    msgid: 'Optional. Tell the model what kinds of terms to focus on or avoid (e.g. "skip proper nouns", "include scientific names").',
  },
  {
    locales: ["es", "fr"],
    msgid: 'Selecting "None" lets the LLM choose its own styling for each page.',
  },
  { locales: ["es", "fr"], msgid: 'This book is titled "{0}".' },
  {
    locales: ["es", "fr", "sq"],
    msgid: 'To replace an image, use "Edit layout" and click the image.',
  },
].flatMap(({ locales, msgid }) => locales.map((locale) => ({ locale, msgid })))

describe("#937 known overescaped translations", () => {
  it.each(escapeCases)("$locale displays ordinary quotes: $msgid", ({ locale, msgid }) => {
    const rendered = formatTranslation(locale, msgid)

    // Check only these known quote occurrences, allowing backslashes elsewhere.
    expect(rendered).not.toContain('\\"')
    expect(rendered.match(/"/g)).toHaveLength(msgid.match(/"/g)!.length)
  })
})
