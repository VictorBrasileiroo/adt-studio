import { describe, expect, it } from "vitest"
import { createRequire } from "node:module"
import { pathToFileURL } from "node:url"
import { prepareSetupRecommendationEvidence as prepare } from "./evidence.js"

// Synthetic fixtures use the PDF package's existing dependency, without
// declaring MuPDF as an API dependency or assuming a node_modules layout.
const requirePdf = createRequire(import.meta.resolve("@adt/pdf"))
const { default: mupdf } = await import(pathToFileURL(requirePdf.resolve("mupdf")).href)

function syntheticPdf(): Buffer {
  const doc = new mupdf.PDFDocument()
  const font = new mupdf.Font("Helvetica")
  try {
    const fontRef = doc.addSimpleFont(font)
    try {
      for (let number = 1; number <= 8; number++) {
        let content = ""
        if (number === 1 || number === 8) content = "BT /F1 10 Tf 30 700 Td (Why? How?) Tj ET"
        if (number === 4) {
          for (const x of [30, 360]) {
            for (let line = 0; line < 5; line++) {
              content += `BT /F1 8 Tf ${x} ${700 - line * 20} Td (${line + 1}. ${"Raw content ".repeat(5)}) Tj ET\n`
            }
          }
        }
        const page = doc.addPage([0, 0, 600, 800], 0, { Font: { F1: fontRef } }, content)
        try { doc.insertPage(-1, page) } finally { page.destroy() }
      }
      const buffer = doc.saveToBuffer()
      try { return Buffer.from(buffer.asUint8Array()) } finally { buffer.destroy() }
    } finally { fontRef.destroy() }
  } finally { font.destroy(); doc.destroy() }
}

describe("recommendation evidence adapter", () => {
  it("AC-4: maps real PDF facts through unchanged activity and column heuristics into BookProfile", () => {
    const result = prepare(syntheticPdf())
    expect(result.pageCount).toBe(8)
    expect(result.bookProfile.pageCount).toBe(8)
    expect(result.observations[3]).toMatchObject({ pageNumber: 4, textItemCount: 10, isLikelyMultiColumn: true, hasActivitySignals: true })
    expect(result.bookProfile.layout.multiColumnPageRatio).toBe(1 / 8)
    expect(result.bookProfile.activities.activitySignalPageRatio).toBe(3 / 8)
    expect(result.sampledPagePairs.map(({ pages }) => pages.map((page) => page?.pageNumber)))
      .toEqual([[2, 3], [4, 5], [6, 7]])
    for (const { pages, imageBuffer } of result.sampledPagePairs) {
      expect(Buffer.isBuffer(imageBuffer)).toBe(true)
      for (const page of pages) if (page) {
        expect(page.text.length).toBeLessThanOrEqual(300)
        expect(page.text).not.toMatch(/\s{2,}|\n/)
      }
    }
    expect(result.sampledPagePairs[1].pages[0].text.length).toBeGreaterThan(240)
  })

  it("AC-6: restricts the profile to physical range 3..5 and excludes all outside activity signals", () => {
    const result = prepare(syntheticPdf(), { start: 3, end: 5 })
    expect(result.pageCount).toBe(8)
    expect(result.bookProfile.pageCount).toBe(3)
    expect(result.observations.map(({ pageNumber }) => pageNumber)).toEqual([3, 4, 5])
    expect(result.sampledPagePairs.map(({ pages }) => pages.map((page) => page?.pageNumber))).toEqual([[3, 4], [5]])
    expect(result.bookProfile.layout.multiColumnPageRatio).toBe(1 / 3)
    expect(result.bookProfile.activities.activitySignalPageRatio).toBe(1 / 3)
    expect(result.bookProfile.text.totalChars).toBe(result.observations[1].charCount)
  })

  it.each([1, 8])("AC-6: uses physical edge-only range %s without inventing cover exclusions", (page) => {
    const result = prepare(syntheticPdf(), { start: page, end: page })
    expect(result.bookProfile.pageCount).toBe(1)
    expect(result.observations.map(({ pageNumber }) => pageNumber)).toEqual([page])
    expect(result.sampledPagePairs[0].pages).toEqual([{ pageNumber: page, text: "Why? How?" }])
  })
})
