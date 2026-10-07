import { Hono } from "hono"
import { HTTPException } from "hono/http-exception"
import { z } from "zod"
import { AiProviderError } from "@adt/llm"
import { setupResultSchema } from "@adt/types"
import { readProviderCredentials } from "../middleware/provider-credentials.js"
import { createSetupRecommendationModel, recommendSetup } from "../services/setup-recommendation/recommend.js"

const Pages = z.object({ start: z.number().int().positive(), end: z.number().int().positive() })
  .strict().refine(({ start, end }) => start <= end)
const UserLanguage = z.string().trim().min(1)
const PROVIDER_ERRORS = {
  401: "OpenAI authentication failed",
  403: "OpenAI request forbidden",
  429: "OpenAI rate limit or quota exceeded",
} as const

export function createSetupRecommendationRoutes(deps: {
  recommendSetup?: typeof recommendSetup
  createSetupRecommendationModel?: typeof createSetupRecommendationModel
} = {}): Hono {
  const app = new Hono()
  const recommend = deps.recommendSetup ?? recommendSetup
  const createModel = deps.createSetupRecommendationModel ?? createSetupRecommendationModel

  app.post("/setup/recommendation", async (c) => {
    if (!c.req.header("Content-Type")?.toLowerCase().startsWith("multipart/form-data")) {
      throw new HTTPException(400, { message: "multipart/form-data is required" })
    }
    const form = await c.req.formData().catch(() => {
      throw new HTTPException(400, { message: "Invalid multipart form" })
    })
    const pdf = form.get("pdf")
    // Same PDF identification as the Studio upload boundary; MuPDF reads the bytes.
    if (!(pdf instanceof File) || !(pdf.type === "application/pdf" || pdf.name.toLowerCase().endsWith(".pdf"))) {
      throw new HTTPException(400, { message: "pdf file is required" })
    }
    const language = UserLanguage.safeParse(form.get("userLanguage"))
    if (!language.success) throw new HTTPException(400, { message: "userLanguage is required" })
    let range: z.infer<typeof Pages> | undefined
    const pages = form.get("pages")
    if (pages !== null) {
      try {
        range = Pages.parse(typeof pages === "string" ? JSON.parse(pages) : null)
      } catch {
        throw new HTTPException(400, { message: "pages must be a strict object with positive integer start <= end" })
      }
    }

    try {
      const credentials = readProviderCredentials(c)
      const llmModel = createModel(credentials)
      const result = await recommend({
        pdfBuffer: Buffer.from(await pdf.arrayBuffer()),
        userLanguage: language.data,
        range,
        signal: c.req.raw.signal,
      }, { llmModel })
      return c.json(setupResultSchema.parse(result))
    } catch (error) {
      if (AiProviderError.is(error)) throw error
      const status = typeof error === "object" && error !== null
        ? ("statusCode" in error ? error.statusCode : "status" in error ? error.status : undefined)
        : undefined
      if (status === 401 || status === 403 || status === 429) {
        // SDK messages can echo credentials; never serialize/log the upstream object.
        return c.json({ error: PROVIDER_ERRORS[status] }, status)
      }
      // PDF/range/schema errors currently have no distinguishable request-error type.
      throw new HTTPException(500, { message: "Setup recommendation failed" })
    }
  })
  return app
}
