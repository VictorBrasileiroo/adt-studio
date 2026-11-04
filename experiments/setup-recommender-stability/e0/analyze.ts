import { readFile, readdir } from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { DECISION_IDS, validateSetupRecommendationOutput } from "../../../packages/types/src/setup-recommendation.js"
import { canonical } from "./prepare.js"
import { recordSchema } from "./schema.js"
import type { runRepetitions } from "./run.js"

type Recorded = Awaited<ReturnType<typeof runRepetitions>>[number]
const pairs = (n: number) => n * (n - 1) / 2
const agreement = (values: string[]) => {
  const frequencies: Record<string, number> = {}
  for (const value of values) frequencies[value] = (frequencies[value] ?? 0) + 1
  const denominator = pairs(values.length)
  const numerator = Object.values(frequencies).reduce((sum, count) => sum + pairs(count), 0)
  return { numerator, denominator, proportion: denominator ? numerator / denominator : null, frequencies }
}
const totals = (values: Array<number | undefined>) => {
  const reported = values.filter((v): v is number => v !== undefined)
  const total = reported.reduce((sum, value) => sum + value, 0)
  return { reported: reported.length, total, mean: reported.length ? total / reported.length : null }
}

export function analyze(input: Recorded[]) {
  const records = input.map(record => recordSchema.parse(record))
  const groups = new Map<string, Recorded[]>()
  const seen = new Set<string>()
  for (const record of records) {
    const identity = `${record.runId}/${record.caseId}/${record.repetition}`
    if (seen.has(identity)) throw new Error("Duplicate repetition")
    seen.add(identity)
    // Never pool different requests, PDFs, commits or languages under one case ID.
    const key = canonical({ caseId: record.caseId, hashes: record.hashes, commit: record.commit })
    groups.set(key, [...(groups.get(key) ?? []), record])
  }
  const cases = [...groups.values()].map(group => {
    let invalid = 0
    let errors = 0
    const valid: Record<string, string>[] = []
    for (const record of group) {
      if (record.status === "error") { errors++; continue }
      try {
        if (record.status !== "success") throw new Error("Invalid response")
        const parsed = validateSetupRecommendationOutput(record.response, new Set(record.sampledPages))
        const vector = Object.fromEntries(DECISION_IDS.map(id => [id, parsed.recommendation[id].choice]))
        if (canonical(vector) !== canonical(record.choices)) throw new Error("Choice/response mismatch")
        valid.push(vector)
      } catch { invalid++ }
    }
    const fullVector = agreement(valid.map(canonical))
    return { caseId: group[0]!.caseId, hashes: group[0]!.hashes, commit: group[0]!.commit,
      total: group.length, valid: valid.length, invalid, errors, fullVector,
      distinctVectors: Object.keys(fullVector.frequencies).length,
      dimensions: Object.fromEntries(DECISION_IDS.map(id => [id, agreement(valid.map(vector => vector[id]!))])),
      inputTokens: totals(group.map(record => record.usage?.inputTokens)),
      outputTokens: totals(group.map(record => record.usage?.outputTokens)),
      latencyMs: totals(group.map(record => record.latencyMs)) }
  })
  const numerator = cases.reduce((sum, c) => sum + c.fullVector.numerator, 0)
  const denominator = cases.reduce((sum, c) => sum + c.fullVector.denominator, 0)
  return { cases, overall: { total: records.length,
    valid: cases.reduce((sum, c) => sum + c.valid, 0), invalid: cases.reduce((sum, c) => sum + c.invalid, 0),
    errors: cases.reduce((sum, c) => sum + c.errors, 0),
    fullVector: { numerator, denominator, proportion: denominator ? numerator / denominator : null },
    dimensions: Object.fromEntries(DECISION_IDS.map(id => {
      const numerator = cases.reduce((sum, c) => sum + c.dimensions[id]!.numerator, 0)
      const denominator = cases.reduce((sum, c) => sum + c.dimensions[id]!.denominator, 0)
      const frequencies: Record<string, number> = {}
      for (const c of cases) for (const [choice, count] of Object.entries(c.dimensions[id]!.frequencies)) {
        frequencies[choice] = (frequencies[choice] ?? 0) + count
      }
      return [id, { numerator, denominator, proportion: denominator ? numerator / denominator : null, frequencies }]
    })),
    inputTokens: totals(records.map(r => r.usage?.inputTokens)), outputTokens: totals(records.map(r => r.usage?.outputTokens)),
    latencyMs: totals(records.map(r => r.latencyMs)),
    aggregation: "micro: only pairs within the same PDF/request/commit; no cross-PDF pairs" } }
}

export async function analyzeDirectory(directory: string) {
  const records: Recorded[] = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const caseDir = path.join(directory, entry.name)
    for (const name of (await readdir(caseDir)).filter(name => /^repetition-\d+\.json$/.test(name)).sort()) {
      records.push(JSON.parse(await readFile(path.join(caseDir, name), "utf8")))
    }
  }
  return analyze(records)
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const directory = process.argv[2]
  if (!directory || process.argv.length !== 3) throw new Error("Usage: analyze.ts RUN_DIRECTORY")
  console.log(JSON.stringify(await analyzeDirectory(path.resolve(directory)), null, 2))
}
