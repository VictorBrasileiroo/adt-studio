import { afterEach, describe, expect, it, vi } from "vitest"
import mupdf from "mupdf"
import { PNG } from "pngjs"
import { extractSetupRecommendationEvidence as extract } from "../setup-recommendation-evidence.js"
import { countPdfPages } from "../extract.js"

function syntheticPdf(): Buffer {
  const doc = new mupdf.PDFDocument()
  const font = new mupdf.Font("Helvetica")
  try {
    const fontRef = doc.addSimpleFont(font)
    const bold = new mupdf.Font("Helvetica-Bold")
    try {
      const boldRef = doc.addSimpleFont(bold)
      const image = doc.addStream(new Uint8Array([255, 0, 0]), {
        Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
        ColorSpace: "DeviceRGB", BitsPerComponent: 8,
      })
      const mask = doc.addStream(new Uint8Array([128]), {
        Type: "XObject", Subtype: "Image", Width: 1, Height: 1,
        ImageMask: true, BitsPerComponent: 1,
      })
      try {
        const resources = { Font: { F1: fontRef, F2: boldRef }, XObject: { Im: image, Mask: mask } }
        const contents = [
          "BT /F1 12 Tf 40 700 Td (  Raw text  ) Tj /F2 12 Tf (Bold) Tj ET",
          "q 20 0 0 20 0 0 cm /Im Do Q q 20 0 0 20 30 0 cm /Im Do Q q /Mask Do Q",
        ].join("\n")
        for (const [width, height] of [[600, 800], [800, 400], [600, 800]]) {
          const page = doc.addPage([0, 0, width, height], 0, resources, contents)
          try { doc.insertPage(-1, page) } finally { page.destroy() }
        }
        const saved = doc.saveToBuffer()
        try { return Buffer.from(saved.asUint8Array()) } finally { saved.destroy() }
      } finally { image.destroy(); mask.destroy(); boldRef.destroy() }
    } finally { bold.destroy(); fontRef.destroy() }
  } finally { font.destroy(); doc.destroy() }
}

afterEach(() => vi.restoreAllMocks())

describe("setup recommendation PDF evidence", () => {
  it("AC-4: reads raw text runs, baseline x, geometry and image paints without counting masks", () => {
    const pdfBuffer = syntheticPdf()
    expect(countPdfPages(pdfBuffer)).toBe(3)
    const result = extract({ pdfBuffer, sampledPagePairs: [] })
    expect(result.pageCount).toBe(3)
    expect(result.pages.map(({ pageNumber, width, height }) => ({ pageNumber, width, height })))
      .toEqual([{ pageNumber: 1, width: 600, height: 800 }, { pageNumber: 2, width: 800, height: 400 }, { pageNumber: 3, width: 600, height: 800 }])
    expect(result.pages[0].textItems).toHaveLength(2)
    expect(result.pages[0].textItems[0]).toEqual({ text: "Raw text", x: 40 })
    expect(result.pages[0].textItems[1].text).toBe("Bold")
    expect(result.pages[0].textItems[1].x).toBeGreaterThan(40)
    expect(result.pages[0].text).toBe("Raw text\nBold")
    expect(result.pages[0].imageOperationCount).toBe(2)
    expect(result.sampledPagePairs).toEqual([])
  })

  it("AC-4: rasterizes only sampled pages as opaque PNGs with a longest side of 1100", () => {
    const render = vi.spyOn(mupdf.PDFPage.prototype, "toPixmap")
    const result = extract({ pdfBuffer: syntheticPdf(), sampledPagePairs: [[2]] })
    expect(render).toHaveBeenCalledTimes(1)
    expect(render.mock.calls[0].slice(1)).toEqual([mupdf.ColorSpace.DeviceRGB, false])
    const sheet = PNG.sync.read(result.sampledPagePairs[0].imageBuffer)
    expect([sheet.width, sheet.height]).toEqual([1100, 550])
    expect([...sheet.data.subarray(0, 4)]).toEqual([255, 255, 255, 255])
    expect(sheet.alpha).toBe(false)
    expect(result.sampledPagePairs[0].pages.map((page) => page?.pageNumber)).toEqual([2])
  })

  it("AC-4: composes a pair with exactly 12 gray pixels and top-aligned unequal page heights", () => {
    const result = extract({ pdfBuffer: syntheticPdf(), sampledPagePairs: [[1, 2]] })
    const sheet = PNG.sync.read(result.sampledPagePairs[0].imageBuffer)
    expect([sheet.width, sheet.height]).toEqual([825 + 12 + 1100, 1100])
    const pixel = (x: number, y: number) => [...sheet.data.subarray((y * sheet.width + x) * 4, (y * sheet.width + x) * 4 + 4)]
    expect(pixel(824, 0)).toEqual([255, 255, 255, 255])
    for (let x = 825; x < 837; x++) expect(pixel(x, 0)).toEqual([238, 238, 238, 255])
    expect(pixel(837, 0)).toEqual([255, 255, 255, 255])
    expect(pixel(937, 549)).toEqual([255, 255, 255, 255])
    expect(pixel(837, 550)).toEqual([238, 238, 238, 255])
    expect(pixel(825, 1099)).toEqual([238, 238, 238, 255])
  })

  it("AC-6: inspects an inclusive physical range and preserves supplied pair order", () => {
    const load = vi.spyOn(mupdf.PDFDocument.prototype, "loadPage")
    const result = extract({ pdfBuffer: syntheticPdf(), startPage: 2, endPage: 3, sampledPagePairs: [[3, 2]] })
    expect(load.mock.calls).toEqual([[1], [2]])
    expect(result.pageCount).toBe(3)
    expect(result.pages.map(({ pageNumber }) => pageNumber)).toEqual([2, 3])
    expect(result.sampledPagePairs[0].pages.map((page) => page?.pageNumber)).toEqual([3, 2])
  })

  it.each([0, 4, 1.5, NaN, 1])("AC-6: rejects sampled page %s outside physical range 2..3", (pageNumber) => {
    expect(() => extract({ pdfBuffer: syntheticPdf(), startPage: 2, endPage: 3, sampledPagePairs: [[pageNumber]] }))
      .toThrow("outside physical page range")
  })

  it("AC-4: rejects invalid ranges, duplicates and more than three pairs", () => {
    const pdfBuffer = syntheticPdf()
    for (const range of [{ startPage: 0 }, { endPage: 4 }, { startPage: 3, endPage: 2 }, { startPage: 1.5 }]) {
      expect(() => extract({ pdfBuffer, ...range, sampledPagePairs: [] })).toThrow("Page range")
    }
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[1], [1]] })).toThrow("Duplicate")
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[1], [2], [3], [1]] })).toThrow("three")
  })

  it("AC-4: destroys page, StructuredText and document when text traversal fails", () => {
    const pdfBuffer = syntheticPdf()
    const page = vi.spyOn(mupdf.Page.prototype, "destroy")
    const st = vi.spyOn(mupdf.StructuredText.prototype, "destroy")
    const doc = vi.spyOn(mupdf.Document.prototype, "destroy")
    vi.spyOn(mupdf.StructuredText.prototype, "walk").mockImplementation(() => { throw new Error("walk failed") })
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[1]] })).toThrow("walk failed")
    expect(st).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledTimes(1)
    expect(doc).toHaveBeenCalledTimes(1)
    expect(st.mock.invocationCallOrder[0]).toBeLessThan(page.mock.invocationCallOrder[0])
    expect(page.mock.invocationCallOrder[0]).toBeLessThan(doc.mock.invocationCallOrder[0])
  })

  it("AC-4: destroys pixmap, page and document when PNG encoding fails", () => {
    const pdfBuffer = syntheticPdf()
    const px = vi.spyOn(mupdf.Pixmap.prototype, "destroy")
    const page = vi.spyOn(mupdf.Page.prototype, "destroy")
    const doc = vi.spyOn(mupdf.Document.prototype, "destroy")
    vi.spyOn(mupdf.Pixmap.prototype, "asPNG").mockImplementation(() => { throw new Error("PNG failed") })
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[1]] })).toThrow("PNG failed")
    expect(px).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledTimes(1)
    expect(doc).toHaveBeenCalledTimes(1)
    expect(px.mock.invocationCallOrder[0]).toBeLessThan(page.mock.invocationCallOrder[0])
    expect(page.mock.invocationCallOrder[0]).toBeLessThan(doc.mock.invocationCallOrder[0])
  })

  it("AC-4: closes and destroys the recorder Device when the page stream fails", () => {
    const pdfBuffer = syntheticPdf()
    const close = vi.spyOn(mupdf.Device.prototype, "close")
    const device = vi.spyOn(mupdf.Device.prototype, "destroy")
    const page = vi.spyOn(mupdf.Page.prototype, "destroy")
    const doc = vi.spyOn(mupdf.Document.prototype, "destroy")
    vi.spyOn(mupdf.PDFPage.prototype, "run").mockImplementation(() => { throw new Error("stream failed") })
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[1]] })).toThrow("stream failed")
    expect(close).toHaveBeenCalledTimes(1)
    expect(device).toHaveBeenCalledTimes(1)
    expect(page).toHaveBeenCalledTimes(1)
    expect(doc).toHaveBeenCalledTimes(1)
    expect(close.mock.invocationCallOrder[0]).toBeLessThan(device.mock.invocationCallOrder[0])
    expect(device.mock.invocationCallOrder[0]).toBeLessThan(page.mock.invocationCallOrder[0])
  })

  it("AC-6: destroys the document before rejecting an invalid sampled page without loading pages", () => {
    const pdfBuffer = syntheticPdf()
    const doc = vi.spyOn(mupdf.Document.prototype, "destroy")
    const load = vi.spyOn(mupdf.PDFDocument.prototype, "loadPage")
    expect(() => extract({ pdfBuffer, sampledPagePairs: [[4]] })).toThrow("outside physical page range")
    expect(doc).toHaveBeenCalledTimes(1)
    expect(load).not.toHaveBeenCalled()
  })
})
