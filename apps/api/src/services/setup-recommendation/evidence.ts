import { countPdfPages, extractSetupRecommendationEvidence } from "@adt/pdf"
import { aggregateBookProfile, detectActivitySignals, detectLikelyMultiColumn,
  type BookProfile, type PageObservation } from "./profile.js"
import type { SampledPageTextPair } from "./prompt.js"
import { normalizeSampledPageWhitespace, selectRepresentativePagePairs,
  truncateSampledPageText } from "./sampling.js"

export interface SetupRecommendationPreparedEvidence {
  readonly pageCount: number
  readonly observations: readonly PageObservation[]
  readonly bookProfile: BookProfile
  readonly sampledPagePairs: readonly {
    readonly pages: SampledPageTextPair
    readonly imageBuffer: Buffer
  }[]
}

/** PDF reader facts are adapted here; all poc-v1 heuristics stay in the API. */
export function prepareSetupRecommendationEvidence(
  pdfBuffer: Buffer,
  range?: { start: number; end: number },
): SetupRecommendationPreparedEvidence {
  const pageCount = countPdfPages(pdfBuffer)
  const raw = extractSetupRecommendationEvidence({
    pdfBuffer,
    startPage: range?.start,
    endPage: range?.end,
    sampledPagePairs: selectRepresentativePagePairs(pageCount, range),
  })
  const observations = raw.pages.map((page): PageObservation => {
    const charCount = page.textItems.reduce((sum, { text }) => sum + text.length, 0)
    return {
      pageNumber: page.pageNumber, width: page.width, height: page.height,
      charCount, textItemCount: page.textItems.length,
      imageOperationCount: page.imageOperationCount,
      isLandscape: page.width > page.height,
      isLikelyMultiColumn: detectLikelyMultiColumn(page.textItems, charCount, page.width),
      hasActivitySignals: detectActivitySignals(page.text),
    }
  })
  const sampledText = (page: { pageNumber: number; text: string }) => ({
    pageNumber: page.pageNumber,
    text: truncateSampledPageText(normalizeSampledPageWhitespace(page.text)),
  })
  return {
    pageCount, observations,
    bookProfile: aggregateBookProfile(observations),
    sampledPagePairs: raw.sampledPagePairs.map(({ pages: [first, second], imageBuffer }) => ({
      pages: second === undefined ? [sampledText(first)] : [sampledText(first), sampledText(second)],
      imageBuffer,
    })),
  }
}
