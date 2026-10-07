# Setup recommendation — integration notes

The "Let AI set it up" path of **Add Book** (`/books/new`) asks a recommender for the book's settings.
The default `apiSetupClient` implements `SetupClient` through
`POST /api/setup/recommendation`. The placeholder remains available for fixtures and isolated development.

## Contract

```ts
// recommendation/client.ts
interface SetupClient {
  recommend(request: SetupRequest, signal: AbortSignal): Promise<SetupResult>
}
```

- **Request** (`SetupRequest` in `contract.ts`)
  - `file` — the PDF.
  - `userLanguage` — the UI locale (e.g. `pt-BR`); the recommender writes `reason` and
    `ambiguityReason` in it (`--user-language` in adt-poc-llm).
  - `pages` — `{ start, end }` when the user chose some pages on upload, otherwise absent. The
    recommender samples inside it while keeping physical PDF page numbers.
- **Response** — `setupResultSchema` from `@adt/types`, re-exported by `contract.ts`, mirrors adt-poc-llm `poc-v1` (V2 output):
  six decisions (`preset`, `renderStrategy`, `pageGrouping`, `sectioningMode`,
  `activitiesGenerator`, `figureExtraction`), each `{ choice, confidence, reason, alternative,
  ambiguityReason, evidencePages }`, plus `provider`, `model`, `promptVersion`, `userLanguage`,
  `usage` and optional `timing`.
  Extra fields (e.g. `bookProfile`) pass through. The shared protocol lives in `@adt/types`;
  the browser `SetupRequest` and presentation helper `ambiguousDecisions` remain in `contract.ts`.
- **Abort** — Cancel / Start over abort the `signal`; pass it to `fetch`.

`SetupClientContext.tsx` defaults to `apiSetupClient`. The call goes through
`apps/studio/src/api/client.ts`, with credentials in headers built from provider manifests.
V1 requires OpenAI API with structured text and image input; server-side credentials also qualify.
Recommendation is transient before Create, with no book/cache/evidence persistence.

## Errors

Throw whatever fails; `classifySetupError` (in `client.ts`) sorts it for the loader:

| Kind | When | Screen |
|---|---|---|
| `auth` | HTTP 401/403, or a message about the API key | "Your AI provider needs attention" → Open AI providers |
| `quota` | HTTP 429, quota / rate limit | "Your AI provider is busy" → Try again |
| `offline` | network failure (`fetch failed`, `ENOTFOUND`, …) or the browser is offline | "You're offline", retries when back online |
| `unknown` | anything else (invalid structured output, unreadable PDF, …) | "We couldn't read this book" → Try again |

Every error offers "Set it up myself" (the step-by-step wizard, PDF kept) and shows the raw message
under "Show details". The shared `request()` helper throws `ApiRequestError` with the HTTP status.
The route preserves upstream 401/403/429 using safe messages and leaves `AiProviderError` to the
global handler. Other failures return a generic 500. In particular, the current core throws
untyped errors for ranges beyond the PDF page count, so they cannot yet be mapped safely to 400.

## What the screens do with the answer

- `renderStrategy.alternative !== null` → **Decide**: the choice and the alternative are the two
  picks, and the chat explains the doubt with `ambiguityReason`.
- Any other decision with an alternative → **Review** marks it "Not sure", with a one-click switch.
- `reason`, `evidencePages` and `confidence` show in Review's "How I set it up" list (pages and
  confidence on hover).
- `confidence` alone never routes anything (the recommender reports it uncalibrated).
- A `renderStrategy` the chosen preset doesn't offer is fitted (`fitStrategy` in `review/setup.tsx`:
  the alternative if allowed, else the preset default) and Review says so. A compatibility check in
  the recommender would make this unnecessary.
- A slow answer shows a calm note after `SLOW_AFTER_MS` (`useSetupRun.ts`, 5 s); tune it to the
  recommender's real latency.

## Testing

Wrap the flow in `<SetupClientProvider value={fakeClient}>` to drive any outcome. Unit tests:
`recommendation.test.ts` (contract, page sampling, error sorting, preset fitting) and
`useSetupRun.test.tsx` (answer, failure, slow, abort, retry).
