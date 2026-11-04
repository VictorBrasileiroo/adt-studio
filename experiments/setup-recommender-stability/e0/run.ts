import { randomUUID } from "node:crypto"
import { execFileSync } from "node:child_process"
import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { performance } from "node:perf_hooks"
import { fileURLToPath } from "node:url"
import type { LLMModel, TokenUsage } from "../../../packages/llm/src/types.js"
import { DECISION_IDS, validateSetupRecommendationOutput } from "../../../packages/types/src/setup-recommendation.js"
import { createSetupRecommendationModel, SETUP_RECOMMENDATION_MODEL_ID, SETUP_RECOMMENDATION_PROVIDER } from "../../../apps/api/src/services/setup-recommendation/recommend.js"
import { POC_V1_PROMPT_VERSION } from "../../../apps/api/src/services/setup-recommendation/prompt.js"
import { hash, logicalRequest, verifyPreparation } from "./prepare.js"
import { analyzeDirectory } from "./analyze.js"
import { corpusSchema, recordSchema } from "./schema.js"

const base = "d0890d4bae919ffbcefa761bfbceca815a0421ec"
const directory = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(directory, "../../..")
const git = (...args: string[]) => execFileSync("git", ["-c", `safe.directory=${root.replaceAll("\\", "/")}`, ...args],
  { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
export const save = (filename: string, value: unknown) => writeFile(filename, JSON.stringify(value, null, 2) + "\n", { flag: "wx" })
class RunnerInputError extends Error {}

export function classifyError(error: unknown): string {
  if (typeof error !== "object" || error === null) return "provider-or-transport-or-structured-parse"
  const info = error as { statusCode?: unknown; status?: unknown; name?: unknown }
  const status = info.statusCode ?? info.status
  if (status === 401 || status === 403) return "authentication-or-permission"
  if (status === 429) return "rate-limit-or-quota"
  if (typeof status === "number" && status >= 500) return "upstream-server"
  if (info.name === "TimeoutError" || info.name === "AbortError") return "timeout-or-abort"
  if (info.name === "AI_NoObjectGeneratedError" || info.name === "ZodError") return "structured-output"
  return "provider-or-transport-or-structured-parse"
}

export async function runRepetitions(
  frozen: Awaited<ReturnType<typeof verifyPreparation>>["frozen"], model: LLMModel,
  metadata: { runId: string; caseId: string; commit: string; experiment?: "smoke"; provider?: string },
  persist: (record: typeof recordSchema._output) => Promise<unknown>,
  repetitions: 1 | 10 = 10,
) {
  if (repetitions !== 1 && repetitions !== 10) throw new RunnerInputError("Repetitions must be 1 or 10")
  const records: Parameters<typeof persist>[0][] = []
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    // Guard against mutation by the transport between repetitions.
    if (hash(logicalRequest(frozen.request)) !== frozen.hashes.request) throw new Error("Frozen request changed")
    const started = performance.now()
    let response: unknown
    let choices: Record<string, string> | undefined
    let usage: TokenUsage | undefined
    let status: "success" | "invalid" | "error" = "error"
    let errorCategory: string | undefined
    try {
      const generated = await model.generateObject<unknown>(frozen.request)
      if (generated.cached) throw new Error("Unexpected cached result")
      usage = generated.usage
      try {
        const parsed = validateSetupRecommendationOutput(generated.object, frozen.pages)
        response = parsed
        choices = Object.fromEntries(DECISION_IDS.map(id => [id, parsed.recommendation[id].choice]))
        status = "success"
      } catch { status = "invalid"; errorCategory = "output-validation" }
    } catch (error) { errorCategory = classifyError(error) }
    if (hash(logicalRequest(frozen.request)) !== frozen.hashes.request) throw new Error("Transport mutated frozen request")
    const record = recordSchema.parse({ ...metadata, repetition, hashes: frozen.hashes, modelId: SETUP_RECOMMENDATION_MODEL_ID,
      promptVersion: POC_V1_PROMPT_VERSION, sampledPages: [...frozen.pages], status,
      parameters: { maxRetries: 0, temperature: "omitted", maxTokens: "omitted", seed: "not exposed" },
      response, choices, errorCategory, usage, latencyMs: performance.now() - started })
    // No raw SDK errors: they can contain keys, request headers and provider bodies.
    await persist(record)
    records.push(record)
  }
  return records
}

export async function main(args: string[], resultsRoot = path.join(directory, "results")) {
  let paid = false
  let smoke = false
  let caseId: string | undefined
  let corpusPath = path.join(directory, "../corpus.json")
  let corpusSeen = false
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--allow-paid" && !paid) { paid = true; continue }
    if (args[i] === "--smoke" && !smoke) { smoke = true; continue }
    if (args[i] === "--case" && caseId === undefined && args[i + 1] && !args[i + 1]!.startsWith("--")) {
      caseId = args[++i]!; continue
    }
    if (args[i] === "--corpus" && !corpusSeen && args[i + 1] && !args[i + 1]!.startsWith("--")) {
      corpusPath = path.resolve(args[++i]!); corpusSeen = true; continue
    }
    throw new RunnerInputError("Usage: run.ts [--corpus MANIFEST] [--allow-paid] [--smoke --case CASE_ID] (each option at most once)")
  }
  if (smoke && !paid) throw new RunnerInputError("Smoke requires --allow-paid; no inference executed")
  if (smoke && !caseId) throw new RunnerInputError("Smoke requires --case CASE_ID")
  if (!smoke && caseId !== undefined) throw new RunnerInputError("--case requires --smoke")
  const corpus = corpusSchema.parse(JSON.parse(await readFile(corpusPath, "utf8")))
  const cases = smoke ? corpus.cases.filter(entry => entry.id === caseId) : corpus.cases
  if (!cases.length) throw new RunnerInputError("Unknown case; select an ID from the corpus")
  const commit = git("rev-parse", "HEAD")
  git("merge-base", "--is-ancestor", base, "HEAD")
  // Allow a future harness-only commit, but reject changed V1 code/dependencies.
  git("diff", "--exit-code", base, "--", "apps/api/src/services/setup-recommendation", "packages/llm", "packages/types", "packages/pdf", "pnpm-lock.yaml", "package.json")
  const runId = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID()}`
  const output = smoke ? path.join(resultsRoot, "smoke", runId) : path.join(resultsRoot, runId)
  await mkdir(output, { recursive: true })
  await save(path.join(output, "run.json"), { runId, base, commit, branch: git("branch", "--show-current"),
    mode: smoke ? "smoke" : paid ? "paid" : "prepare-only", ...(smoke ? { caseId } : {}), corpus, node: process.version, platform: process.platform,
    lockfileHash: hash(await readFile(path.join(root, "pnpm-lock.yaml"), "utf8")),
    sourceHashes: Object.fromEntries(await Promise.all(["recommend", "evidence", "profile", "sampling", "prompt", "decision-specs"].map(async name =>
      [name, hash(await readFile(path.join(root, `apps/api/src/services/setup-recommendation/${name}.ts`), "utf8"))]))),
    logicalDefaults: "See each case request.json; omitted generation options remain omitted" })
  console.log(`Run directory: ${output}; mode: ${smoke ? "SMOKE (1 attempt)" : paid ? "PAID" : "prepare-only (0 LLM calls)"}`)
  const prepared = []
  let blocked = false
  for (const entry of cases) {
    const caseDir = path.join(output, entry.id)
    await mkdir(caseDir)
    try {
      if (!entry.pdf) throw new Error("Missing PDF configuration")
      const pdfBuffer = await readFile(path.resolve(path.dirname(corpusPath), entry.pdf))
      const verification = await verifyPreparation({ pdfBuffer, userLanguage: entry.userLanguage, range: entry.range ?? undefined })
      await save(path.join(caseDir, "preparation.json"), { hashes: verification.hashes, deterministic: verification.deterministic })
      await save(path.join(caseDir, "evidence.json"), verification.frozen.evidence)
      await save(path.join(caseDir, "request.json"), verification.frozen.logical)
      if (!verification.deterministic) { blocked = true; console.log(`${entry.id}: divergent hashes; paid execution blocked`); continue }
      prepared.push({ entry, caseDir, frozen: verification.frozen })
      console.log(`${entry.id}: 3/3 equal preparation hashes; ${verification.frozen.hashes.request}`)
    } catch {
      blocked = true
      await save(path.join(caseDir, "blocked.json"), { reason: "Missing/unreadable PDF, invalid range, or preparation failure; inspect corpus locally" })
      console.log(`${entry.id}: preparation blocked; no inference`)
    }
  }
  if (blocked) throw new Error(`Corpus/preparation blocked; see ${output}`)
  if (!paid) return output
  if (!smoke && new Set(prepared.map(item => item.frozen.hashes.pdf)).size !== 3) throw new Error("Paid corpus requires three distinct PDFs")
  // No provider creation, credential resolution, or network access before this gate.
  if (!process.env.OPENAI_API_KEY?.trim()) throw new Error("OPENAI_API_KEY required; no inference executed")
  const model = createSetupRecommendationModel({ openai: { apiKey: process.env.OPENAI_API_KEY } })
  for (const { entry, caseDir, frozen } of prepared) {
    const records = await runRepetitions(frozen, model, { runId, caseId: entry.id, commit,
      ...(smoke ? { experiment: "smoke" as const, provider: SETUP_RECOMMENDATION_PROVIDER } : {}) }, record =>
      save(path.join(caseDir, `repetition-${String(record.repetition).padStart(2, "0")}.json`), record), smoke ? 1 : 10)
    if (smoke) {
      console.log(`Smoke status: ${records[0]!.status}; excluded from E0 baseline`)
      if (records[0]!.status !== "success") throw new RunnerInputError("Smoke failed; inspect the saved status/error category. No retry executed")
    }
  }
  if (!smoke) await save(path.join(output, "analysis.json"), await analyzeDirectory(output))
  return output
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await main(process.argv.slice(2)) }
  catch (error) {
    console.error(error instanceof RunnerInputError ? error.message : "E0 blocked/failed. Check corpus, preparation artifacts, HEAD and credentials locally. No raw SDK error logged.")
    process.exitCode = 1
  }
}
