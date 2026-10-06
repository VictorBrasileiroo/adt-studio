import { createHash } from "node:crypto"
import { describe, expect, expectTypeOf, it } from "vitest"
import {
  ACTIVITIES_IDS, DECISION_IDS, FIGURE_EXTRACTION_IDS, PAGE_GROUPING_IDS,
  PRESET_IDS, RENDER_STRATEGY_IDS, SECTIONING_MODE_IDS,
  type DecisionId, type Recommendation,
} from "@adt/types"
import * as specs from "./decision-specs.js"
import type { ChoiceDecisionSpec, DecisionSpec } from "./decision-specs.js"
import { buildDecisionContext } from "./prompt.js"

describe("poc-v1 Decision Specs", () => {
  it("AC-8: contains exactly the six stable specs in frozen order", () => {
    expect(specs.POC_V1_DECISION_SPECS).toEqual([
      specs.PRESET_SPEC,
      specs.POC_V1_RENDER_STRATEGY_SPEC,
      specs.PAGE_GROUPING_SPEC,
      specs.SECTIONING_MODE_SPEC,
      specs.ACTIVITIES_SPEC,
      specs.FIGURE_EXTRACTION_SPEC,
    ])
    const ids = specs.POC_V1_DECISION_SPECS.map(({ id }) => id)
    expect(ids).toEqual([
      "preset", "renderStrategy", "pageGrouping", "sectioningMode",
      "activitiesGenerator", "figureExtraction",
    ])
    expect(ids).toEqual(DECISION_IDS)
  })

  it("AC-8: matches every shared contract option ID and order, excluding two_column", () => {
    const choices = {
      preset: PRESET_IDS,
      renderStrategy: RENDER_STRATEGY_IDS,
      pageGrouping: PAGE_GROUPING_IDS,
      sectioningMode: SECTIONING_MODE_IDS,
      activitiesGenerator: ACTIVITIES_IDS,
      figureExtraction: FIGURE_EXTRACTION_IDS,
    } satisfies { [K in DecisionId]: readonly Recommendation[K]["choice"][] }
    for (const spec of specs.POC_V1_DECISION_SPECS) {
      const optionIds = spec.options.map(({ id }) => id)
      expect(optionIds).toEqual(choices[spec.id])
      expect(optionIds).not.toContain("two_column")
    }
  })

  it("AC-8: derives choices from the decision-specific shared type", () => {
    expectTypeOf<ChoiceDecisionSpec<"preset">["options"][number]["id"]>()
      .toEqualTypeOf<Recommendation["preset"]["choice"]>()
    expectTypeOf<ChoiceDecisionSpec<"renderStrategy">["options"][number]["id"]>()
      .toEqualTypeOf<Recommendation["renderStrategy"]["choice"]>()
    expectTypeOf<DecisionSpec>().extract<{ id: "preset" }>()
      .toEqualTypeOf<ChoiceDecisionSpec<"preset">>()
  })

  it("AC-8: retains baseline Preset and frozen poc-v1 Render wording", () => {
    expect(specs.PRESET_SPEC.instructions).toBe("Which ADT preset best matches this book?")
    expect(specs.PRESET_SPEC.options[0].description).toBe(
      "Educational content with structured chapters, exercises, activities, or complex layouts.",
    )
    expect(specs.POC_V1_RENDER_STRATEGY_SPEC.options[0].description)
      .toContain("AI-generated reflowable layout")
    expect(specs.POC_V1_RENDER_STRATEGY_SPEC.options[2].description)
      .toContain("do not choose only because a book is text-heavy")
    expect(specs.POC_V1_RENDER_STRATEGY_SPEC.options[4].description)
      .toContain("do not choose merely because pages are illustrated or visually complex")
  })

  it("AC-8: exports only the selected stable configuration without experimental specs", () => {
    expect(Object.keys(specs).sort()).toEqual([
      "ACTIVITIES_SPEC", "FIGURE_EXTRACTION_SPEC", "PAGE_GROUPING_SPEC",
      "POC_V1_DECISION_SPECS", "POC_V1_RENDER_STRATEGY_SPEC", "PRESET_SPEC",
      "SECTIONING_MODE_SPEC",
    ].sort())
  })
})

describe("Decision Knowledge", () => {
  it("AC-8: includes each frozen instruction and description with the PoC separators", () => {
    const context = buildDecisionContext()
    expect(context.startsWith("ADT DECISION KNOWLEDGE\n\n")).toBe(true)
    for (const spec of specs.POC_V1_DECISION_SPECS) {
      expect(context).toContain(`${spec.id}\nGoal: ${spec.instructions}\nOptions:\n`)
      for (const option of spec.options) {
        expect(context).toContain(`- ${option.id}: ${option.description}`)
      }
    }
    expect(context).toContain("\n\nrenderStrategy\nGoal:")
    expect(context).toBe(buildDecisionContext(specs.POC_V1_DECISION_SPECS))
  })

  it("AC-8: preserves the frozen poc-v1 Decision Knowledge SHA-256", () => {
    expect(createHash("sha256").update(buildDecisionContext()).digest("hex"))
      .toBe("e79bafab8955d959a1d9b8bc180e0d815e7960886f6c2a459a199ce2cef6ea8e")
  })

  it("formats supplied specs without mutation", () => {
    const custom = Object.freeze([{
      id: "preset",
      instructions: "Fixture goal",
      options: Object.freeze([{ id: "textbook", description: "Fixture description" }] as const),
    }] as const satisfies readonly DecisionSpec[])
    expect(buildDecisionContext(custom)).toBe(
      "ADT DECISION KNOWLEDGE\n\npreset\nGoal: Fixture goal\nOptions:\n- textbook: Fixture description",
    )
    expect(buildDecisionContext(custom)).toBe(buildDecisionContext(custom))
  })
})
