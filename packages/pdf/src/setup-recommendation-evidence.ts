import mupdf, { type StructuredText } from "mupdf"
import { PNG } from "pngjs"
import { recordPageStream } from "./page-stream-recorder.js"

export interface SetupRecommendationTextItem {
  readonly text: string
  /** Baseline origin in MuPDF's displayed page coordinates, in points. */
  readonly x: number
}

export interface SetupRecommendationPageEvidence {
  readonly pageNumber: number
  readonly width: number
  readonly height: number
  readonly text: string
  readonly textItems: readonly SetupRecommendationTextItem[]
  readonly imageOperationCount: number
}

export type SetupRecommendationPagePair = readonly [number, number?]

export interface SetupRecommendationEvidenceInput {
  readonly pdfBuffer: Buffer
  /** One-based, inclusive physical page range. Defaults to the full PDF. */
  readonly startPage?: number
  readonly endPage?: number
  /** Already selected by the caller; no sampling policy lives here. */
  readonly sampledPagePairs: readonly SetupRecommendationPagePair[]
}

export interface SetupRecommendationRenderedPair {
  readonly pages: readonly [SetupRecommendationPageEvidence, SetupRecommendationPageEvidence?]
  readonly imageBuffer: Buffer
}

export interface SetupRecommendationEvidence {
  /** Count of the original PDF, independent of the inspection range. */
  readonly pageCount: number
  readonly pages: readonly SetupRecommendationPageEvidence[]
  readonly sampledPagePairs: readonly SetupRecommendationRenderedPair[]
}

const RENDER_MAX_PAGE_SIDE_PX = 1100
const CONTACT_SHEET_GAP_PX = 12

/**
 * Raw runs within StructuredText lines, split on font/size changes. PDF.js's
 * getTextContent items have no exact MuPDF equivalent; runs retain more of that
 * granularity than whole lines without treating individual glyphs as items.
 * No OCR, font remapping, deduplication or ADT text cleanup is applied.
 */
function collectTextItems(stext: StructuredText): SetupRecommendationTextItem[] {
  const items: SetupRecommendationTextItem[] = []
  let text = ""
  let x = 0
  let fontPointer = 0
  let fontSize = 0
  const flush = (): void => {
    const trimmed = text.trim()
    if (trimmed) items.push({ text: trimmed, x })
    text = ""
  }
  stext.walk({
    beginLine() { flush() },
    onChar(char, origin, font, size) {
      // walk creates a retained Font wrapper per callback in MuPDF 1.27.
      try {
        if (text && (font.pointer !== fontPointer || size !== fontSize)) flush()
        if (!text) {
          x = origin[0]
          fontPointer = font.pointer
          fontSize = size
        }
        text += char
      } finally {
        font.destroy()
      }
    },
    endLine() { flush() },
  })
  return items
}

function composeContactSheet(buffers: readonly Buffer[]): Buffer {
  const pages = buffers.map((buffer) => PNG.sync.read(buffer))
  const width = pages.reduce((sum, page) => sum + page.width, 0)
    + CONTACT_SHEET_GAP_PX * (pages.length - 1)
  const height = Math.max(...pages.map((page) => page.height))
  const sheet = new PNG({ width, height })
  sheet.data.fill(238)
  for (let offset = 3; offset < sheet.data.length; offset += 4) sheet.data[offset] = 255
  let x = 0
  for (const page of pages) {
    for (let y = 0; y < page.height; y++) {
      page.data.copy(sheet.data, (y * width + x) * 4, y * page.width * 4, (y + 1) * page.width * 4)
    }
    x += page.width + CONTACT_SHEET_GAP_PX
  }
  return PNG.sync.write(sheet, { colorType: 2 })
}

/** Lightweight, transient factual evidence. Only sampled pages are rasterized. */
export function extractSetupRecommendationEvidence(
  input: SetupRecommendationEvidenceInput,
): SetupRecommendationEvidence {
  const doc = mupdf.Document.openDocument(input.pdfBuffer, "application/pdf")
  try {
    const pageCount = doc.countPages()
    const start = input.startPage ?? 1
    const end = input.endPage ?? pageCount
    if (!Number.isInteger(start) || !Number.isInteger(end)
      || start < 1 || end > pageCount || start > end) {
      throw new Error(`Page range must satisfy 1 <= start <= end <= ${pageCount}`)
    }
    if (input.sampledPagePairs.length > 3) throw new Error("At most three sampled page pairs are allowed")
    const sampledNumbers = new Set<number>()
    for (const pair of input.sampledPagePairs) {
      if (pair.length < 1 || pair.length > 2) throw new Error("Sampled pairs require one or two pages")
      for (const pageNumber of pair) {
        if (pageNumber === undefined && pair.length === 2 && pair[0] !== undefined) continue
        if (pageNumber === undefined || !Number.isInteger(pageNumber) || pageNumber < start || pageNumber > end) {
          throw new Error(`Sampled page ${pageNumber} is outside physical page range ${start}-${end}`)
        }
        if (sampledNumbers.has(pageNumber)) throw new Error(`Duplicate sampled page ${pageNumber}`)
        sampledNumbers.add(pageNumber)
      }
    }
    const pages: SetupRecommendationPageEvidence[] = []
    const byNumber = new Map<number, SetupRecommendationPageEvidence>()
    const renders = new Map<number, Buffer>()
    for (let pageNumber = start; pageNumber <= end; pageNumber++) {
      const page = doc.loadPage(pageNumber - 1)
      try {
        const [x0, y0, x1, y1] = page.getBounds()
        const width = x1 - x0
        const height = y1 - y0
        const stext = page.toStructuredText()
        let textItems: SetupRecommendationTextItem[]
        try { textItems = collectTextItems(stext) } finally { stext.destroy() }
        const evidence: SetupRecommendationPageEvidence = {
          pageNumber, width, height, textItems,
          text: textItems.map(({ text }) => text).join("\n"),
          // Image masks were excluded from the frozen PDF.js operator set.
          imageOperationCount: recordPageStream(page).filter((op) => op.kind === "image").length,
        }
        pages.push(evidence)
        byNumber.set(pageNumber, evidence)
        if (sampledNumbers.has(pageNumber)) {
          const scale = RENDER_MAX_PAGE_SIDE_PX / Math.max(width, height)
          const pixmap = page.toPixmap(mupdf.Matrix.scale(scale, scale), mupdf.ColorSpace.DeviceRGB, false)
          try { renders.set(pageNumber, Buffer.from(pixmap.asPNG())) } finally { pixmap.destroy() }
        }
      } finally {
        page.destroy()
      }
    }
    return {
      pageCount, pages,
      sampledPagePairs: input.sampledPagePairs.map(([first, second]) => ({
        pages: second === undefined ? [byNumber.get(first)!] : [byNumber.get(first)!, byNumber.get(second)!],
        imageBuffer: composeContactSheet(second === undefined
          ? [renders.get(first)!] : [renders.get(first)!, renders.get(second)!]),
      })),
    }
  } finally {
    doc.destroy()
  }
}
