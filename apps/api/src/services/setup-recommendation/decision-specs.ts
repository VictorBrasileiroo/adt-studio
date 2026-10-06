import type { DecisionId, Recommendation } from "@adt/types"

export interface ChoiceDecisionSpec<K extends DecisionId> {
  readonly id: K
  readonly instructions: string
  readonly options: readonly {
    readonly id: Recommendation[K]["choice"]
    readonly description: string
  }[]
}

/** Keeps each decision ID associated with its own shared choice contract. */
export type DecisionSpec = {
  [K in DecisionId]: ChoiceDecisionSpec<K>
}[DecisionId]

export const PRESET_SPEC = {
  id: "preset",
  instructions: "Which ADT preset best matches this book?",
  options: [
    {
      id: "textbook",
      description:
        "Educational content with structured chapters, exercises, activities, or complex layouts.",
    },
    {
      id: "storybook",
      description:
        "Illustrated narrative content with large images, visual storytelling, and relatively little text.",
    },
    {
      id: "reference",
      description:
        "Dense informational or technical content such as documentation, manuals, handbooks, tables, or glossaries.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"preset">

export const POC_V1_RENDER_STRATEGY_SPEC = {
  id: "renderStrategy",
  instructions: "Which ADT rendering strategy best fits this book?",
  options: [
    {
      id: "llm",
      description:
        "AI-generated reflowable layout that uses the source page as a visual reference but may reorganize content for clear, responsive HTML. Prefer when semantic structure and adaptability matter more than preserving exact page geometry.",
    },
    {
      id: "llm-overlay",
      description:
        "AI-generated layout that visually reconstructs the source page by using the original page image as a background and inferring positions for accessible text overlays. Prefer when strong visual fidelity matters but responsive adaptation and AI-based reconstruction are still desired.",
    },
    {
      id: "single_column",
      description:
        "Deterministic reflowable single-column layout for predominantly linear content. Prefer when text can be read sequentially and meaning does not depend on page-specific spatial relationships; do not choose only because a book is text-heavy.",
    },
    {
      id: "two_column_story",
      description:
        "Deterministic responsive story template that reorganizes content into a prominent image area and a text area. Prefer when pages consistently fit an image-plus-text structure; avoid when meaning depends on arbitrary or complex original positioning.",
    },
    {
      id: "fixed_layout",
      description:
        "Preserves the source PDF page as a largely static, non-reflowable composition using its original page geometry and positioned text rather than asking AI to reconstruct the layout. Prefer when exact spatial placement is essential to meaning or experience; do not choose merely because pages are illustrated or visually complex.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"renderStrategy">

export const PAGE_GROUPING_SPEC = {
  id: "pageGrouping",
  instructions: "How should the pages of this book be grouped?",
  options: [
    {
      id: "single",
      description:
        "Treat each PDF page as an independent screen; also preferred when only a few exceptional spreads exist.",
    },
    {
      id: "spread",
      description:
        "Join facing pages into wide screens when compositions frequently span both pages or cross the gutter.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"pageGrouping">

export const SECTIONING_MODE_SPEC = {
  id: "sectioningMode",
  instructions: "How should content be divided into sections?",
  options: [
    {
      id: "page",
      description:
        "Keep each page as one section when its content works as a self-contained unit.",
    },
    {
      id: "dynamic",
      description:
        "Keep pages whole normally but split pages containing multiple distinct activity types.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"sectioningMode">

export const ACTIVITIES_SPEC = {
  id: "activitiesGenerator",
  instructions: "Should ADT activity conversion be enabled for this book?",
  options: [
    {
      id: "enabled",
      description:
        "Use when existing exercises or activities should be detected and converted into interactive HTML elements.",
    },
    {
      id: "disabled",
      description:
        "Use when the book mainly contains reading content without activities that need interactive conversion.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"activitiesGenerator">

export const FIGURE_EXTRACTION_SPEC = {
  id: "figureExtraction",
  instructions: "How should ADT handle composite figure extraction?",
  options: [
    {
      id: "off",
      description:
        "Keep raster and vector artwork separate from nearby selectable text instead of creating composite figure crops.",
    },
    {
      id: "auto",
      description:
        "Create composite candidates and retain those better represented visually than as semantic HTML.",
    },
    {
      id: "all",
      description:
        "Create every composite figure candidate and let the normal image filters decide what remains.",
    },
  ],
} as const satisfies ChoiceDecisionSpec<"figureExtraction">

export const POC_V1_DECISION_SPECS = [
  PRESET_SPEC,
  POC_V1_RENDER_STRATEGY_SPEC,
  PAGE_GROUPING_SPEC,
  SECTIONING_MODE_SPEC,
  ACTIVITIES_SPEC,
  FIGURE_EXTRACTION_SPEC,
] as const satisfies readonly DecisionSpec[]
