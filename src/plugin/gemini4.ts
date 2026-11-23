import type { AntigravityAvailableModels } from "./config/models.ts"

export const GEMINI4_MODELS = [
  "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon", "gemini-4-hydrogen-sonar",
] as const
type ModelId = typeof GEMINI4_MODELS[number]
type Level = "low" | "medium" | "high" | "xhigh"

export function gemini4Model(id: string | undefined | null) {
  const bare = id?.replace(/^models\//, "").replace(/^antigravity-/, "")
  if (!bare) return undefined
  const suffix = /-(low|medium|high|xhigh|minimal)$/.exec(bare)
  const idWithoutLevel = suffix ? bare.slice(0, suffix.index) : bare
  const model = GEMINI4_MODELS.find(candidate => candidate === idWithoutLevel)
  if (model) return { model, level: suffix?.[1] === "minimal" ? "low" : suffix?.[1] }
  return undefined
}

export function gemini4Levels(model: ModelId): Level[] {
  return model === "gemini-4-neon" || model === "gemini-4-hydrogen"
    ? ["low", "medium", "high", "xhigh"] : ["low", "medium", "high"]
}

export interface Gemini4Route {
  backend: string
  level?: string
  supportsThinking?: boolean
  displayName?: string
  modelEnum?: string
}

// Antigravity CLI 1.5.9 used these labels and wire levels for Neon.
const NEON_TIERS = {
  low: { modelEnum: "MODEL_PLACEHOLDER_M534", thinkingLevel: "LOW" },
  medium: { modelEnum: "MODEL_PLACEHOLDER_M533", thinkingLevel: "MEDIUM" },
  high: { modelEnum: "MODEL_PLACEHOLDER_M532", thinkingLevel: "HIGH" },
  xhigh: { modelEnum: "MODEL_PLACEHOLDER_M535", thinkingLevel: 100 },
} as const

export function neonWireTier(requested = "high") {
  const normalized = requested.toLowerCase()
  const level = gemini4Levels("gemini-4-neon").find(tier => tier === (normalized === "minimal" ? "low" : normalized))
  if (!level) throw new Gemini4Unavailable(`Unsupported Neon thinking level: ${requested}`)
  return { level, backend: `gemini-4-neon-${level}`, ...NEON_TIERS[level] }
}

/** The registry key is the wire ID; modelName can identify the public family.
 * In particular a Sonar key remains Sonar even when labelled Hydrogen. */
export function gemini4Routes(registry: AntigravityAvailableModels) {
  const routes = new Map<ModelId, Gemini4Route[]>()
  const neonEntries: Array<Gemini4Route & { disabled?: boolean }> = []
  for (const [sourceId, entry] of Object.entries(registry)) {
    const backend = sourceId.replace(/^models\//, "")
    const id = gemini4Model(backend) ?? gemini4Model(entry.modelName)
    if (!id) continue
    const route = { backend, level: id.level, supportsThinking: entry.supportsThinking, displayName: entry.displayName }
    if (id.model === "gemini-4-neon") {
      neonEntries.push({ ...route, modelEnum: entry.model, disabled: entry.disabled })
      continue
    }
    if (entry.disabled) continue
    const group = routes.get(id.model) ?? []
    group.push(route)
    routes.set(id.model, group)
  }
  // Absent = unknown; present but empty = explicitly disabled. When a specific
  // tier is disabled, fall back to an enabled untiered alias if one is listed.
  if (neonEntries.length) {
    const enabled = gemini4Levels("gemini-4-neon").flatMap(level => {
      const exact = neonEntries.filter(route => route.level === level)
      const route = exact.find(route => !route.disabled)
        ?? neonEntries.find(route => !route.level && !route.disabled)
      return route ? [{ ...route, level }] : []
    })
    routes.set("gemini-4-neon", enabled)
  }
  return routes
}

export function selectGemini4Route(routes: Gemini4Route[], level: string | undefined) {
  return routes.find(route => route.level === level) ?? routes.find(route => !route.level)
}

export class Gemini4CatalogResponse extends Response {
  constructor(message: string) {
    super(JSON.stringify({ error: { code: 404, status: "NOT_FOUND", message } }), {
      status: 404, headers: { "content-type": "application/json" },
    })
  }
}

export class Gemini4Unavailable extends Error {
  response() {
    return new Gemini4CatalogResponse(this.message)
  }
}

export function missingGemini4Credential(model: string) {
  return Response.json({ error: { code: 401, status: "UNAUTHENTICATED",
    message: `Connect Antigravity OAuth or configure a Gemini API key to use ${model}.` } }, { status: 401 })
}
