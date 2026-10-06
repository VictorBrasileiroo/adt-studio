export const MAX_REPRESENTATIVE_PAGE_PAIRS = 3
export const MAX_EXTRACTED_CHARS_PER_PAGE = 300
export const MAX_EXTRACTED_CHARS_TOTAL =
  MAX_REPRESENTATIVE_PAGE_PAIRS * 2 * MAX_EXTRACTED_CHARS_PER_PAGE

/**
 * Stable poc-v1 consecutive pairs. Range eligibility uses the physical document
 * edges; an empty intersection falls back to the requested range itself.
 */
export function selectRepresentativePagePairs(
  pageCount: number,
  range?: { start: number; end: number },
): Array<readonly [number, number?]> {
  if (!Number.isInteger(pageCount) || pageCount <= 0) {
    throw new Error("PDF must contain at least one valid page")
  }
  if (range && (
    !Number.isInteger(range.start) ||
    !Number.isInteger(range.end) ||
    range.start < 1 ||
    range.end > pageCount ||
    range.start > range.end
  )) {
    throw new Error(`Page range must contain integers satisfying 1 <= start <= end <= ${pageCount}`)
  }

  let firstPage = pageCount >= 7 ? 2 : 1
  let lastPage = pageCount >= 7 ? pageCount - 1 : pageCount
  if (range) {
    firstPage = Math.max(firstPage, range.start)
    lastPage = Math.min(lastPage, range.end)
    if (firstPage > lastPage) {
      firstPage = range.start
      lastPage = range.end
    }
  }

  const candidates: Array<readonly [number, number?]> = []
  for (let page = firstPage; page <= lastPage; page += 2) {
    candidates.push(page + 1 <= lastPage ? [page, page + 1] : [page])
  }
  if (candidates.length <= MAX_REPRESENTATIVE_PAGE_PAIRS) {
    return candidates
  }
  return [
    candidates[0]!,
    candidates[Math.round((candidates.length - 1) / 2)]!,
    candidates[candidates.length - 1]!,
  ]
}

export function normalizeSampledPageWhitespace(text: string): string {
  return text.replace(/\s+/g, " ").trim()
}

export function truncateSampledPageText(text: string): string {
  if (text.length <= MAX_EXTRACTED_CHARS_PER_PAGE) {
    return text
  }

  const candidate = text.slice(0, MAX_EXTRACTED_CHARS_PER_PAGE)
  const lastWhitespace = candidate.lastIndexOf(" ")
  const reasonableBoundary = Math.floor(MAX_EXTRACTED_CHARS_PER_PAGE * 0.8)
  return candidate
    .slice(0, lastWhitespace >= reasonableBoundary ? lastWhitespace : undefined)
    .trimEnd()
}
