import { defineConfig } from "vitest/config"
export default defineConfig({ test: { include: ["experiments/setup-recommender-stability/e0/*.test.ts"], testTimeout: 60000 } })
