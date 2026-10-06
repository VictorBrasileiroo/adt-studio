import { DECISION_IDS, type DecisionId, type Recommendation } from "@adt/types"

/** Keep existing Studio consumers connected to the shared setup protocol. */
export {
  CONFIDENCE,
  PRESET_IDS,
  RENDER_STRATEGY_IDS,
  PAGE_GROUPING_IDS,
  SECTIONING_MODE_IDS,
  ACTIVITIES_IDS,
  FIGURE_EXTRACTION_IDS,
  DECISION_IDS,
  recommendationSchema,
  setupResultSchema,
  type Confidence,
  type Recommendation,
  type DecisionId,
  type Decision,
  type SetupResult,
} from "@adt/types"

/** Browser request wrapper; the HTTP adapter maps the File to an upload. */
export type SetupRequest = { file: File; userLanguage: string; pages?: { start: number; end: number } }

/** Decisions the AI couldn't settle between two specific options. */
export function ambiguousDecisions(rec: Recommendation): DecisionId[] {
  return DECISION_IDS.filter((id) => rec[id].alternative !== null)
}
