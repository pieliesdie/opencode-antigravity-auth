import type { AntigravityAvailableModels } from "./config/models.ts"

export const GEMINI4_MODELS = [
  "gemini-4-argon", "gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon",
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
  return model === "gemini-4-argon"
    ? ["low", "medium", "high"]
    : ["low", "medium", "high", "xhigh"]
}

export interface Gemini4Route {
  backend: string
  level?: string
  supportsThinking?: boolean
  displayName?: string
  modelEnum?: string
}

// Antigravity CLI model_enum fallback values observed in daily fetchAvailableModels.
const GEMINI4_MODEL_ENUMS: Partial<Record<ModelId, Partial<Record<Level, string>>>> = {
  "gemini-4-argon": {
    low: "MODEL_PLACEHOLDER_M419",
    medium: "MODEL_PLACEHOLDER_M418",
    high: "MODEL_PLACEHOLDER_M417",
  },
  "gemini-4-hydrogen": {
    low: "MODEL_PLACEHOLDER_M527",
    medium: "MODEL_PLACEHOLDER_M526",
    high: "MODEL_PLACEHOLDER_M525",
    xhigh: "MODEL_PLACEHOLDER_M528",
  },
  "gemini-4-neon": {
    low: "MODEL_PLACEHOLDER_M534",
    medium: "MODEL_PLACEHOLDER_M533",
    high: "MODEL_PLACEHOLDER_M532",
    xhigh: "MODEL_PLACEHOLDER_M535",
  },
}

export function gemini4WireTier(model: ModelId, requested?: string) {
  const raw = (requested ?? "high").toLowerCase()
  const normalized = raw === "minimal" ? "low" : raw
  const level = gemini4Levels(model).find(tier => tier === normalized)
  if (!level) throw new Gemini4Unavailable(`Unsupported ${model} thinking level: ${requested}`)
  return { level, backend: `${model}-${level}`, thinkingLevel: level.toUpperCase(), modelEnum: GEMINI4_MODEL_ENUMS[model]?.[level] }
}

/** The registry key is the wire ID; modelName can identify the public family. */
export function gemini4Routes(registry: AntigravityAvailableModels) {
  const routes = new Map<ModelId, Gemini4Route[]>()
  for (const [sourceId, entry] of Object.entries(registry)) {
    if (entry.disabled) continue
    const backend = sourceId.replace(/^models\//, "")
    const id = gemini4Model(backend) ?? gemini4Model(entry.modelName)
    if (!id) continue
    const group = routes.get(id.model) ?? []
    group.push({
      backend,
      level: id.level,
      supportsThinking: entry.supportsThinking,
      displayName: entry.displayName,
      modelEnum: entry.model,
    })
    routes.set(id.model, group)
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
