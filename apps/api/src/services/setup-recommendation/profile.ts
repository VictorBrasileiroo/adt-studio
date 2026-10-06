export interface BookProfile {
  pageCount: number
  text: {
    totalChars: number
    avgCharsPerPage: number
    medianCharsPerPage: number
    lowTextPageRatio: number
    highTextPageRatio: number
  }
  images: {
    totalImageOperations: number
    pagesWithImagesRatio: number
    avgImagesPerPage: number
  }
  layout: {
    landscapePageRatio: number
    multiColumnPageRatio: number
  }
  activities: {
    activitySignalPageRatio: number
  }
}

export interface PageObservation {
  pageNumber: number
  width: number
  height: number
  charCount: number
  textItemCount: number
  imageOperationCount: number
  isLandscape: boolean
  isLikelyMultiColumn: boolean
  hasActivitySignals: boolean
}

export interface PositionedTextItem {
  text: string
  x: number
}

// Frozen poc-v1 proxies, not semantic classifiers or official ADT rules.
export const LOW_TEXT_CHAR_THRESHOLD = 250
export const HIGH_TEXT_CHAR_THRESHOLD = 1_200
export const MIN_CHARS_FOR_COLUMN_ANALYSIS = 400
export const MIN_TEXT_ITEMS_FOR_COLUMN_ANALYSIS = 8
export const LEFT_COLUMN_BOUNDARY = 0.45
export const RIGHT_COLUMN_BOUNDARY = 0.55
export const MIN_COLUMN_ITEM_RATIO = 0.25

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0

  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle]!
    : (sorted[middle - 1]! + sorted[middle]!) / 2
}

function ratio(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.min(1, Math.max(0, numerator / denominator))
}

export function detectLikelyMultiColumn(
  items: readonly PositionedTextItem[],
  charCount: number,
  pageWidth: number,
): boolean {
  if (
    charCount < MIN_CHARS_FOR_COLUMN_ANALYSIS ||
    items.length < MIN_TEXT_ITEMS_FOR_COLUMN_ANALYSIS ||
    pageWidth <= 0
  ) {
    return false
  }

  const leftCount = items.filter(({ x }) => x / pageWidth < LEFT_COLUMN_BOUNDARY).length
  const rightCount = items.filter(({ x }) => x / pageWidth > RIGHT_COLUMN_BOUNDARY).length
  return (
    ratio(leftCount, items.length) >= MIN_COLUMN_ITEM_RATIO &&
    ratio(rightCount, items.length) >= MIN_COLUMN_ITEM_RATIO
  )
}

/** Structural exercise-like signals only, matching the poc-v1 proxy. */
export function detectActivitySignals(text: string): boolean {
  const questionCount = text.match(/\?/g)?.length ?? 0
  const alternativeCount = text.match(/(?:^|\s)[A-Za-z][).](?=\s)/gm)?.length ?? 0
  const enumerationCount = text.match(/(?:^|\n)\s*\d+[.)]\s+/gm)?.length ?? 0
  return (
    alternativeCount >= 2 ||
    questionCount >= 2 ||
    enumerationCount >= 3 ||
    (questionCount >= 1 && enumerationCount >= 2)
  )
}

/** Aggregates all supplied observations; the analyzer determines their scope. */
export function aggregateBookProfile(observations: readonly PageObservation[]): BookProfile {
  const pageCount = observations.length
  const charCounts = observations.map(({ charCount }) => charCount)
  const totalChars = charCounts.reduce((sum, count) => sum + count, 0)
  const totalImageOperations = observations.reduce(
    (sum, { imageOperationCount }) => sum + imageOperationCount,
    0,
  )
  const countWhere = (predicate: (page: PageObservation) => boolean): number =>
    observations.filter(predicate).length

  return {
    pageCount,
    text: {
      totalChars,
      avgCharsPerPage: pageCount === 0 ? 0 : totalChars / pageCount,
      medianCharsPerPage: median(charCounts),
      lowTextPageRatio: ratio(
        countWhere(({ charCount }) => charCount <= LOW_TEXT_CHAR_THRESHOLD),
        pageCount,
      ),
      highTextPageRatio: ratio(
        countWhere(({ charCount }) => charCount >= HIGH_TEXT_CHAR_THRESHOLD),
        pageCount,
      ),
    },
    images: {
      totalImageOperations,
      pagesWithImagesRatio: ratio(
        countWhere(({ imageOperationCount }) => imageOperationCount > 0),
        pageCount,
      ),
      avgImagesPerPage: pageCount === 0 ? 0 : totalImageOperations / pageCount,
    },
    layout: {
      landscapePageRatio: ratio(countWhere(({ isLandscape }) => isLandscape), pageCount),
      multiColumnPageRatio: ratio(countWhere(({ isLikelyMultiColumn }) => isLikelyMultiColumn), pageCount),
    },
    activities: {
      activitySignalPageRatio: ratio(countWhere(({ hasActivitySignals }) => hasActivitySignals), pageCount),
    },
  }
}
