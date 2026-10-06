import { describe, expect, it } from "vitest"
import {
  MAX_EXTRACTED_CHARS_PER_PAGE,
  MAX_EXTRACTED_CHARS_TOTAL,
  MAX_REPRESENTATIVE_PAGE_PAIRS,
  normalizeSampledPageWhitespace,
  selectRepresentativePagePairs,
  truncateSampledPageText,
} from "./sampling.js"

describe("selectRepresentativePagePairs", () => {
  it.each([
    { pageCount: 1, expected: [[1]] },
    { pageCount: 2, expected: [[1, 2]] },
    { pageCount: 3, expected: [[1, 2], [3]] },
    { pageCount: 4, expected: [[1, 2], [3, 4]] },
    { pageCount: 5, expected: [[1, 2], [3, 4], [5]] },
    { pageCount: 6, expected: [[1, 2], [3, 4], [5, 6]] },
    { pageCount: 7, expected: [[2, 3], [4, 5], [6]] },
    { pageCount: 10, expected: [[2, 3], [6, 7], [8, 9]] },
    { pageCount: 52, expected: [[2, 3], [26, 27], [50, 51]] },
    { pageCount: 100, expected: [[2, 3], [50, 51], [98, 99]] },
  ])("AC-5: preserves poc-v1 full-book sampling for N=$pageCount", ({ pageCount, expected }) => {
    expect(selectRepresentativePagePairs(pageCount)).toEqual(expected)
  })

  it("AC-5: keeps full-book pairs deterministic, unique, bounded and off physical edges for N >= 7", () => {
    for (let pageCount = 1; pageCount <= 150; pageCount++) {
      const pairs = selectRepresentativePagePairs(pageCount)
      const pages = pairs.flat().filter((page): page is number => page !== undefined)
      expect(pairs).toEqual(selectRepresentativePagePairs(pageCount))
      expect(pairs.length).toBeLessThanOrEqual(3)
      expect(pages.length).toBeLessThanOrEqual(6)
      expect(new Set(pages).size).toBe(pages.length)
      expect(pages.every((page) => page >= 1 && page <= pageCount)).toBe(true)
      for (const [first, second] of pairs) {
        if (second !== undefined) expect(second).toBe(first + 1)
      }
      if (pageCount >= 7) {
        expect(pages).not.toContain(1)
        expect(pages).not.toContain(pageCount)
      }
    }
  })

  it.each([
    { pageCount: 52, start: 1, end: 10, expected: [[2, 3], [6, 7], [10]] },
    { pageCount: 52, start: 20, end: 23, expected: [[20, 21], [22, 23]] },
    { pageCount: 52, start: 52, end: 52, expected: [[52]] },
    { pageCount: 52, start: 1, end: 1, expected: [[1]] },
    { pageCount: 52, start: 51, end: 52, expected: [[51]] },
    { pageCount: 52, start: 1, end: 2, expected: [[2]] },
    { pageCount: 52, start: 21, end: 25, expected: [[21, 22], [23, 24], [25]] },
    { pageCount: 52, start: 20, end: 20, expected: [[20]] },
    { pageCount: 52, start: 1, end: 52, expected: [[2, 3], [26, 27], [50, 51]] },
    { pageCount: 7, start: 6, end: 7, expected: [[6]] },
    { pageCount: 6, start: 5, end: 6, expected: [[5, 6]] },
    { pageCount: 1, start: 1, end: 1, expected: [[1]] },
  ])("AC-6: samples physical N=$pageCount range $start..$end", ({ pageCount, start, end, expected }) => {
    const range = Object.freeze({ start, end })
    expect(selectRepresentativePagePairs(pageCount, range)).toEqual(expected)
  })

  it("AC-6: keeps every valid N=52 range within the eligible intersection or empty-intersection fallback", () => {
    for (let start = 1; start <= 52; start++) {
      for (let end = start; end <= 52; end++) {
        const range = { start, end }
        const pairs = selectRepresentativePagePairs(52, range)
        const pages = pairs.flat().filter((page): page is number => page !== undefined)
        expect(pairs).toEqual(selectRepresentativePagePairs(52, range))
        expect(pairs.length).toBeGreaterThan(0)
        expect(pairs.length).toBeLessThanOrEqual(3)
        expect(pages.length).toBeLessThanOrEqual(6)
        expect(new Set(pages).size).toBe(pages.length)
        expect(pages.every((page) => page >= start && page <= end)).toBe(true)
        if (start <= 51 && end >= 2) {
          expect(pages).not.toContain(1)
          expect(pages).not.toContain(52)
        }
      }
    }
  })

  it.each([0, -1, 1.5, NaN, Infinity, -Infinity])("rejects invalid pageCount %s", (pageCount) => {
    expect(() => selectRepresentativePagePairs(pageCount)).toThrow("at least one valid page")
  })

  it.each([
    { start: 0, end: 10 },
    { start: -1, end: 10 },
    { start: 1, end: 53 },
    { start: 20, end: 19 },
    { start: 53, end: 53 },
    { start: 1, end: 0 },
    { start: 1.5, end: 10 },
    { start: 1, end: 10.5 },
    { start: NaN, end: 10 },
    { start: 1, end: NaN },
    { start: Infinity, end: 10 },
    { start: 1, end: Infinity },
    { start: -Infinity, end: 10 },
    { start: 1, end: -Infinity },
  ])("AC-6: rejects invalid range $start..$end without clamping", (range) => {
    expect(() => selectRepresentativePagePairs(52, range)).toThrow("Page range")
  })
})

describe("sampled page text", () => {
  it("AC-5: freezes the three-pair, 300-per-page and 1800-total limits", () => {
    expect(MAX_REPRESENTATIVE_PAGE_PAIRS).toBe(3)
    expect(MAX_EXTRACTED_CHARS_PER_PAGE).toBe(300)
    expect(MAX_EXTRACTED_CHARS_TOTAL).toBe(1800)
  })

  it.each([
    { text: "one   two", expected: "one two" },
    { text: "one\t\ttwo", expected: "one two" },
    { text: "one\n\r\ntwo", expected: "one two" },
    { text: " \t\none \t two\r\n ", expected: "one two" },
    { text: " \t\r\n", expected: "" },
    { text: "  café\u00a0ação  ", expected: "café ação" },
  ])("AC-5: normalizes whitespace in $text", ({ text, expected }) => {
    expect(normalizeSampledPageWhitespace(text)).toBe(expected)
  })

  it.each(["", "short text ", "x".repeat(299), `${"x".repeat(299)} `])(
    "AC-5: preserves text of at most 300 characters verbatim",
    (text) => expect(truncateSampledPageText(text)).toBe(text),
  )

  it.each([240, 275, 299])("AC-5: cuts at a last space with index %s >= 240", (boundary) => {
    const text = `${"a".repeat(boundary)} ${"b".repeat(100)}`
    expect(truncateSampledPageText(text)).toBe("a".repeat(boundary))
  })

  it("AC-5: keeps 300 characters when the last space is just below 240", () => {
    const text = `${"a".repeat(239)} ${"b".repeat(100)}`
    expect(truncateSampledPageText(text)).toBe(`${"a".repeat(239)} ${"b".repeat(60)}`)
  })

  it("AC-5: keeps 300 characters without a space, without adding ellipsis", () => {
    expect(truncateSampledPageText("x".repeat(500))).toBe("x".repeat(300))
  })

  it("AC-5: trims the end after truncation even when no reasonable space boundary exists", () => {
    const text = `${"a".repeat(238)} ${"\t".repeat(61)}more`
    expect(truncateSampledPageText(text)).toBe("a".repeat(238))
  })

  it("AC-5: retains the PoC's UTF-16 slice behavior", () => {
    expect(truncateSampledPageText(`${"a".repeat(299)}😀tail`)).toBe(`${"a".repeat(299)}\ud83d`)
  })

  it("AC-5: limits normalized text for six sampled pages to 1800 characters", () => {
    const pages = selectRepresentativePagePairs(100).flat()
    const texts = pages.map(() => truncateSampledPageText(normalizeSampledPageWhitespace(" word\n".repeat(150))))
    expect(texts.every((text) => text.length <= 300 && !text.endsWith("…") && !text.endsWith("..."))).toBe(true)
    expect(texts.reduce((sum, text) => sum + text.length, 0)).toBeLessThanOrEqual(1800)
  })
})
