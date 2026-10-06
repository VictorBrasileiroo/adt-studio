import { describe, expect, it } from "vitest"
import {
  aggregateBookProfile,
  detectActivitySignals,
  detectLikelyMultiColumn,
  HIGH_TEXT_CHAR_THRESHOLD,
  LEFT_COLUMN_BOUNDARY,
  LOW_TEXT_CHAR_THRESHOLD,
  median,
  MIN_CHARS_FOR_COLUMN_ANALYSIS,
  MIN_COLUMN_ITEM_RATIO,
  MIN_TEXT_ITEMS_FOR_COLUMN_ANALYSIS,
  RIGHT_COLUMN_BOUNDARY,
  type PageObservation,
  type PositionedTextItem,
} from "./profile.js"

function positionedItems(xs: readonly number[]): PositionedTextItem[] {
  return xs.map((x) => ({ text: "text", x }))
}

function observation(patch: Partial<PageObservation> = {}): PageObservation {
  return {
    pageNumber: 1, width: 600, height: 800, charCount: 0, textItemCount: 0,
    imageOperationCount: 0, isLandscape: false, isLikelyMultiColumn: false,
    hasActivitySignals: false, ...patch,
  }
}

describe("median", () => {
  it.each([
    { values: [], expected: 0 },
    { values: [9, 1, 4], expected: 4 },
    { values: [30, 2, 10, 4], expected: 7 },
    { values: [8], expected: 8 },
  ])("returns $expected for $values without mutating input", ({ values, expected }) => {
    expect(median(Object.freeze(values))).toBe(expected)
  })
})

describe("poc-v1 thresholds", () => {
  it("preserves every heuristic constant", () => {
    expect(LOW_TEXT_CHAR_THRESHOLD).toBe(250)
    expect(HIGH_TEXT_CHAR_THRESHOLD).toBe(1200)
    expect(MIN_CHARS_FOR_COLUMN_ANALYSIS).toBe(400)
    expect(MIN_TEXT_ITEMS_FOR_COLUMN_ANALYSIS).toBe(8)
    expect(LEFT_COLUMN_BOUNDARY).toBe(0.45)
    expect(RIGHT_COLUMN_BOUNDARY).toBe(0.55)
    expect(MIN_COLUMN_ITEM_RATIO).toBe(0.25)
  })
})

describe("detectLikelyMultiColumn", () => {
  const balanced = positionedItems([10, 20, 50, 50, 50, 50, 80, 90])

  it("allows exactly 400 characters, eight items and 25% on each side", () => {
    expect(detectLikelyMultiColumn(balanced, 400, 100)).toBe(true)
  })

  it("rejects fewer than 400 characters", () => {
    expect(detectLikelyMultiColumn(balanced, 399, 100)).toBe(false)
  })

  it("rejects fewer than eight items even when both sides have enough items", () => {
    expect(detectLikelyMultiColumn(positionedItems([10, 20, 50, 50, 50, 80, 90]), 400, 100)).toBe(false)
  })

  it.each([0, -100])("rejects page width %s", (width) => {
    expect(detectLikelyMultiColumn(balanced, 400, width)).toBe(false)
  })

  it("does not count items at exactly 45% as left", () => {
    expect(detectLikelyMultiColumn(positionedItems([10, 45, 50, 50, 50, 50, 80, 90]), 400, 100)).toBe(false)
  })

  it("does not count items at exactly 55% as right", () => {
    expect(detectLikelyMultiColumn(positionedItems([10, 20, 50, 50, 50, 50, 55, 90]), 400, 100)).toBe(false)
  })

  it.each([
    { side: "left", xs: [10, 50, 50, 50, 50, 50, 80, 90] },
    { side: "right", xs: [10, 20, 50, 50, 50, 50, 50, 90] },
  ])("rejects less than 25% on the $side", ({ xs }) => {
    expect(detectLikelyMultiColumn(positionedItems(xs), 400, 100)).toBe(false)
  })
})

describe("detectActivitySignals", () => {
  it.each([
    { cue: "two question marks", text: "Why? How?" },
    { cue: "two lettered alternatives", text: "A) First B. Second" },
    { cue: "lowercase alternatives separated by newlines", text: "a. First\nb) Second" },
    { cue: "three numbered lines", text: "1. One\n 2) Two\n\t3. Three" },
    { cue: "a question and two numbered lines", text: "Which?\n1) One\n2. Two" },
  ])("detects $cue", ({ text }) => {
    expect(detectActivitySignals(text)).toBe(true)
  })

  it.each([
    { cue: "empty text", text: "" },
    { cue: "plain prose", text: "A paragraph without exercise cues." },
    { cue: "one question", text: "Why?" },
    { cue: "one alternative", text: "A) One" },
    { cue: "two numbered lines without a question", text: "1. One\n2) Two" },
    { cue: "a question and one numbered line", text: "Why?\n1. One" },
    { cue: "a question and one alternative", text: "Why? A) One" },
    { cue: "alternatives without preceding whitespace", text: "wordA) One wordB) Two" },
    { cue: "alternatives without following whitespace", text: "A)one B.two" },
    { cue: "non-ASCII alternatives", text: "Á) One É) Two" },
    { cue: "inline enumerations", text: "Items: 1. One 2. Two 3. Three" },
    { cue: "numbered lines without following whitespace", text: "1.One\n2)Two\n3.Three" },
  ])("does not detect $cue", ({ text }) => {
    expect(detectActivitySignals(text)).toBe(false)
  })
})

describe("aggregateBookProfile", () => {
  it("aggregates every numeric field from synthetic observations with physical page numbers", () => {
    const observations = [
      observation({ pageNumber: 20, charCount: 250, imageOperationCount: 0, isLandscape: true }),
      observation({ pageNumber: 21, charCount: 251, imageOperationCount: 1, isLikelyMultiColumn: true }),
      observation({ pageNumber: 22, charCount: 1199, imageOperationCount: 3, hasActivitySignals: true }),
      observation({ pageNumber: 23, charCount: 1200, imageOperationCount: 0, isLandscape: true, hasActivitySignals: true }),
    ].map((page) => Object.freeze(page))
    expect(aggregateBookProfile(Object.freeze(observations))).toEqual({
      pageCount: 4,
      text: { totalChars: 2900, avgCharsPerPage: 725, medianCharsPerPage: 725, lowTextPageRatio: 0.25, highTextPageRatio: 0.25 },
      images: { totalImageOperations: 4, pagesWithImagesRatio: 0.5, avgImagesPerPage: 1 },
      layout: { landscapePageRatio: 0.5, multiColumnPageRatio: 0.25 },
      activities: { activitySignalPageRatio: 0.5 },
    })
  })

  it.each([
    { charCount: 250, low: 1, high: 0 },
    { charCount: 251, low: 0, high: 0 },
    { charCount: 1199, low: 0, high: 0 },
    { charCount: 1200, low: 0, high: 1 },
  ])("uses inclusive text thresholds for $charCount characters", ({ charCount, low, high }) => {
    const profile = aggregateBookProfile([observation({ charCount })])
    expect(profile.text.lowTextPageRatio).toBe(low)
    expect(profile.text.highTextPageRatio).toBe(high)
  })

  it("returns zero averages, median and ratios for no observations", () => {
    expect(aggregateBookProfile([])).toEqual({
      pageCount: 0,
      text: { totalChars: 0, avgCharsPerPage: 0, medianCharsPerPage: 0, lowTextPageRatio: 0, highTextPageRatio: 0 },
      images: { totalImageOperations: 0, pagesWithImagesRatio: 0, avgImagesPerPage: 0 },
      layout: { landscapePageRatio: 0, multiColumnPageRatio: 0 },
      activities: { activitySignalPageRatio: 0 },
    })
  })

  it("bounds ratios at one when all observations carry the same signal", () => {
    const profile = aggregateBookProfile([
      observation({ charCount: 1200, imageOperationCount: 8, isLandscape: true, isLikelyMultiColumn: true, hasActivitySignals: true }),
      observation({ charCount: 1300, imageOperationCount: 4, isLandscape: true, isLikelyMultiColumn: true, hasActivitySignals: true }),
    ])
    expect(profile.text.highTextPageRatio).toBe(1)
    expect(profile.text.lowTextPageRatio).toBe(0)
    expect(profile.images.pagesWithImagesRatio).toBe(1)
    expect(profile.layout.landscapePageRatio).toBe(1)
    expect(profile.layout.multiColumnPageRatio).toBe(1)
    expect(profile.activities.activitySignalPageRatio).toBe(1)
    expect(profile.images.avgImagesPerPage).toBe(6)
  })
})
