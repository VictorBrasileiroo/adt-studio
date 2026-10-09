# AI Setup Recommender V1

Implementation snapshot reviewed on 2026-10-09 at `114c2c764`, branch
`feat/333-setup-recommender-integration` (issue #333). This records existing
behavior, not spec approval or release acceptance.

## Scope

The Add Book AI path now uses a real API recommender instead of the placeholder.
It suggests six settings from the uploaded PDF and optional physical page range;
the user reviews and may override them before Create. V1 fixes the provider/model
to `openai:gpt-5.4-mini`, using the frozen PoC `poc-v1` decision knowledge and
`adt-config-recommender-poc-v1` prompt. “V2 output” in the inherited prompt names
the PoC's ambiguity-aware schema revision, not a second ADT integration version.

## Implemented flow

1. [LoaderScreen](../apps/studio/src/components/wizard/auto/loader/LoaderScreen.tsx)
   sends the PDF, UI locale and range through `apiSetupClient` and the shared
   [API client](../apps/studio/src/api/client.ts).
   [ChooseScreen](../apps/studio/src/components/wizard/start/choose/ChooseScreen.tsx)
   enables AI setup only for available OpenAI structured text with image input;
   a local key or server credentials qualify. This is not a live model-access probe.
2. [POST /api/setup/recommendation](../apps/api/src/routes/setup-recommendation.ts)
   validates multipart input and passes header credentials into the existing LLM
   credential resolver (including server `OPENAI_API_KEY`).
3. [Evidence preparation](../apps/api/src/services/setup-recommendation/evidence.ts)
   uses [@adt/pdf / MuPDF](../packages/pdf/src/setup-recommendation-evidence.ts)
   to inspect every page in scope, without running normal pipeline extraction.
   The API owns the PoC heuristics, profile aggregation and sampling policy.
4. [Sampling](../apps/api/src/services/setup-recommendation/sampling.ts) selects at
   most three consecutive pairs (six pages), retaining at most 300 normalized
   characters per page. For PDFs with at least seven pages, normal eligibility
   excludes physical pages 1 and N. A range intersects that eligibility; an empty
   intersection falls back to the requested range. Citations retain physical IDs.
   `BookProfile.pageCount` counts pages in scope, while the evidence's `pageCount`
   counts the original PDF. Only sampled pages are rasterized: longest side 1100 px,
   top-aligned PNG contact sheets with a 12 px gray gap.
5. [recommendSetup](../apps/api/src/services/setup-recommendation/recommend.ts)
   builds the inline [prompt](../apps/api/src/services/setup-recommendation/prompt.ts):
   system Decision Knowledge and UI language, then profile, alternating pair text
   and image parts, and the final six-decision task. `@adt/llm` performs one native
   structured generation with `maxRetries: 0`; the AI SDK backend also disables
   retries. There is no parse repair or provider/model fallback.
6. A request-specific model schema limits citations to sampled pages; independent
   post-parse validation checks semantic relationships. The API returns metadata,
   the validated recommendation, token usage and preparation/inference/total timings.
7. [AddBookFlow](../apps/studio/src/components/wizard/AddBookFlow.tsx) holds the raw
   result in memory. A render alternative routes to Decide; otherwise it applies
   picks and opens Review. Create uses the existing book creation mutation to save
   the PDF and final config, then optionally start extraction. Recommendation
   provenance is not included in that creation payload.

## Contracts and applied settings

Input: multipart `pdf`, nonblank `userLanguage`, optional JSON `pages` with strict
positive integer `start <= end`. PDF page-count bounds are checked during evidence
preparation. Provider/model form fields cannot change the fixed V1 model.

The [shared Zod contract](../packages/types/src/setup-recommendation.ts) requires
exactly these decisions:

| Decision | Valid IDs | Final wizard/config mapping |
|---|---|---|
| `preset` | `textbook`, `storybook`, `reference` | Preset defaults and `layout_type` |
| `renderStrategy` | `llm`, `llm-overlay`, `single_column`, `two_column_story`, `fixed_layout` | `default_render_strategy` |
| `pageGrouping` | `single`, `spread` | `spread_mode` |
| `sectioningMode` | `page`, `dynamic` | `page_sectioning.mode` |
| `activitiesGenerator` | `enabled`, `disabled` | Boolean form field; disabled or fixed layout writes `generate_activities: false` |
| `figureExtraction` | `off`, `auto`, `all` | `figure_extraction_mode` and synchronized legacy `vector_text_grouping` |

Each decision requires `choice`, categorical `confidence`, `reason` (1–500 chars),
nullable `alternative` and `ambiguityReason`, and sorted unique `evidencePages`.
An alternative must differ from the choice, have an ambiguity reason and cannot
accompany high confidence. Low/medium confidence need not have an alternative.
Empty citations are allowed for global evidence. Confidence is not calibrated;
validation does not establish factual support, explanation language or joint
configuration compatibility. The result envelope is extensible, but the current
service does not return `bookProfile`, sampled evidence or the full prompt.

[fitStrategy](../apps/studio/src/components/wizard/auto/review/setup.tsx) uses the
allowed choice, then an allowed alternative, then the preset default, preserving
the raw recommendation and tracking the adjustment. Decide also filters its options
by preset; displayed candidates can differ from the raw pair. Review explains the
four layout decisions. Activities and Figure Extraction remain editable in All
settings, without equivalent reason/confidence/alternative presentation. Final
serialization follows [bookCreationConfig](../apps/studio/src/components/wizard/core/bookCreationConfig.ts),
including fixed-layout activity and image-filter overrides.

## Validation evidence and boundaries

Test sources were inspected; **no tests, builds or live calls were run for this
documentation audit**. Existing coverage is not a claim of a passing current run:

| Evidence | Coverage inspected |
|---|---|
| [Shared schema tests](../packages/types/src/__tests__/setup-recommendation.test.ts) | Six IDs, strictness, ambiguity and sampled-citation rejection |
| [API core tests](../apps/api/src/services/setup-recommendation/) | Heuristic thresholds, range/sampling bounds, frozen prompt hashes, one-call behavior, semantic rejection and signals |
| [PDF tests](../packages/pdf/src/__tests__/setup-recommendation-evidence.test.ts) | Synthetic PDF facts, masks, sampled rasterization, contact-sheet geometry and resource cleanup |
| [Route tests](../apps/api/src/routes/setup-recommendation.test.ts) | Multipart, safe 401/403/429, server/header credentials, synthetic cancellation and absence of pre-Create writes with a fake LLM |
| [Studio tests](../apps/studio/src/components/wizard/auto/recommendation/) and [availability tests](../apps/studio/src/components/wizard/start/choose/ChooseScreen.test.tsx) | HTTP adapter, errors, abort/retry, routing predicates and fitting without raw-result mutation |

[Offline parity](../apps/api/src/services/setup-recommendation/parity.test.ts) uses
one real Raven PDF and an independent frozen-PoC
[baseline](../apps/api/src/services/setup-recommendation/__fixtures__/poc-v1/raven.json).
It checks input SHA-256, observations/profile, sampled text hashes, sheet dimensions,
prompt/Decision Knowledge hashes, part ordering and logical schema. Its LLM is
synthetic and network calls are forbidden. Enumerated PDF.js→MuPDF deltas include
page 12 characters/items (403/36 → 398/31) and total characters (1330 → 1325).
Pixels, PNG bytes, provider transport, live output and timing are excluded.

The frozen PoC documents historical **15/18 in-sample agreement** over four books,
not accuracy or integrated-ADT validation. Local PoC `output/*.poc-v1.json` files
dated 2026-10-02 record successful model runs; local
`output/final-poc-v1-smoke.log` records `Connection error`. These unversioned,
overwritable artifacts are historical observations, not commit-pinned ADT evidence.
No integrated live comparison record was found in the inspected branch, SPEC PR
or issue discussion. AC-13's live portion, stochastic repeatability, real HTTP
disconnect propagation, end-to-end Create/conversion and release verification
remain unvalidated in this audit.

## Known limits and pending decisions

- **Cache/audit divergence:** model creation supplies no `cacheDir`/`onLog`, and
  generation supplies no log metadata. No prompt, response, evidence or cache is
  persisted before Create or transferred into the book afterward. Review's brief
  explanations and console summaries do not meet AGENTS.md's full inspectability
  and LLM-cache principles. This remains explicit debt, not an approved exemption.
  No temporary book/session store or entity-versioning path was introduced.
- **Failures:** HTTP input-shape errors return 400; known upstream auth/quota status
  codes receive safe messages. Unreadable PDFs, out-of-document ranges, schema
  failures, timeouts and untyped backend connectivity errors collapse to generic
  500. Browser fetch failure can be classified offline; backend connectivity can
  appear unknown. Try again/online recovery starts a fresh uncached call; manual
  setup keeps the PDF. A 5 s slow notice is not a timeout (the shared backend defaults
  to 90 s for inference). Failure frequency/root cause has not been established.
- **Inherited evidence limits:** no OCR or extraction-quality diagnostics; image
  paints, columns and activity cues are proxies; sparse samples and short excerpts
  can miss decisive content. Artificial page pairs can bias spread interpretation.
- **Decision limits:** one shared call couples six choices; confidence is uncalibrated
  and no backend compatibility resolver exists. Frontend fitting and Create's
  overrides are partial safeguards, not proof of a valid or successful conversion.
- **Parity/performance limits:** PoC uses PDF.js/native canvas and OpenAI Responses
  with `store: false` and image `detail: high`; ADT uses MuPDF/WASM, existing PNG
  tooling and the existing AI SDK transport, without an image-detail port. Their
  behavioral equivalence is not proven. PDF preparation is synchronous and inspects
  all pages in scope; cancellation is checked around it, not within its page loop.
  Large-document latency/memory and broader PDF-engine differences need evidence.

## References

- [SPEC-0016 proposal / PR #932](https://github.com/unicef/adt-studio/pull/932),
  `spec/333-ai-setup-recommender`, snapshot `79bd3bbb2`: `in-review`, no approvers
  in front matter, absent from this integration branch. Its criteria are proposed,
  not approved or all satisfied; cache/audit deferral does not resolve the principles.
- [Add Book parent PR #930](https://github.com/unicef/adt-studio/pull/930) and
  [existing frontend integration notes](../apps/studio/src/components/wizard/auto/recommendation/README.md).
- Frozen PoC `fd367428b5ca9bf1c2d7df1d980fe02788c02d17`:
  [V1](https://github.com/VictorBrasileiroo/adt-poc-llm/blob/fd367428b5ca9bf1c2d7df1d980fe02788c02d17/docs/POC_V1.md),
  [limitations](https://github.com/VictorBrasileiroo/adt-poc-llm/blob/fd367428b5ca9bf1c2d7df1d980fe02788c02d17/docs/LIMITATIONS.md),
  [evaluation](https://github.com/VictorBrasileiroo/adt-poc-llm/blob/fd367428b5ca9bf1c2d7df1d980fe02788c02d17/evaluation/README.md).
