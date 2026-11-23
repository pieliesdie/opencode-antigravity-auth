import type { ProviderModel } from "../types";
import { gemini4Model, gemini4Routes, gemini4Levels, selectGemini4Route } from "../gemini4.ts"

export type ModelThinkingLevel = "minimal" | "low" | "medium" | "high" | "xhigh";

export interface ModelThinkingConfig {
  thinkingBudget: number;
}

export interface ModelVariant {
  thinkingLevel?: ModelThinkingLevel;
  thinkingConfig?: ModelThinkingConfig;
}

export interface ModelLimit {
  context: number;
  output: number;
}

export type ModelModality = "text" | "image" | "pdf";

export interface ModelModalities {
  input: ModelModality[];
  output: ModelModality[];
}

export interface OpencodeModelDefinition extends ProviderModel {
  name: string;
  temperature?: boolean;
  limit: ModelLimit;
  modalities: ModelModalities;
  variants?: Record<string, ModelVariant>;
}

export type OpencodeModelDefinitions = Record<string, OpencodeModelDefinition>;

export interface GeminiApiModel {
  name?: string;
  baseModelId?: string;
  displayName?: string;
  inputTokenLimit?: number;
  outputTokenLimit?: number;
  supportedGenerationMethods?: string[];
}

export interface AntigravityAvailableModel {
  displayName?: string;
  modelName?: string;
  model?: string
  disabled?: boolean
  supportsThinking?: boolean
}

export type AntigravityAvailableModels = Record<string, AntigravityAvailableModel>;

const DEFAULT_MODALITIES: ModelModalities = {
  input: ["text", "image", "pdf"],
  output: ["text"],
};

export const OPENCODE_MODEL_DEFINITIONS: OpencodeModelDefinitions = {
  "antigravity-gemini-3.8-flash": {
    name: "Gemini 3.8 Flash (Antigravity)",
    temperature: false,
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  // Antigravity serves Argon as gemini-4-argon-{low,medium,high}
  // (see resolveAntigravityGemini4ArgonBackendModel). Antigravity's default
  // context window for it is 256K tokens, smaller than the API's 1M.
  "antigravity-gemini-4-argon": {
    name: "Gemini 4 Argon (Antigravity)",
    temperature: false,
    limit: { context: 262144, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  ...Object.fromEntries(
    ["gemini-4-carbon", "gemini-4-hydrogen", "gemini-4-neon"].map(id => [`antigravity-${id}`, {
      name: `${titleFromModelId(id)} (Antigravity)`,
      limit: defaultLimitForModel(id),
      modalities: DEFAULT_MODALITIES,
      variants: defaultVariantsForModel(id),
    }]),
  ),
  "antigravity-gemini-3-flash": {
    name: "Gemini 3 Flash (Antigravity)",
    limit: { context: 1048576, output: 65536 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-gemini-3.1-flash-lite": {
    name: "Gemini 3.1 Flash Lite (Antigravity)",
    temperature: false,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-gemini-3.5-flash-lite": {
    name: "Gemini 3.5 Flash Lite (Antigravity)",
    temperature: false,
    limit: { context: 1048576, output: 65535 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      minimal: { thinkingLevel: "minimal" },
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-claude-opus-5-5": {
    name: "Claude Opus 5.5 (Antigravity)",
    limit: { context: 1000000, output: 128000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-claude-sonnet-5-5": {
    name: "Claude Sonnet 5.5 (Antigravity)",
    limit: { context: 1000000, output: 128000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    },
  },
  "antigravity-claude-sonnet-4-6": {
    name: "Claude Sonnet 4.6 (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
  },
  "antigravity-claude-opus-4-6-thinking": {
    name: "Claude Opus 4.6 Thinking (Antigravity)",
    limit: { context: 200000, output: 64000 },
    modalities: DEFAULT_MODALITIES,
    variants: {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    },
  },
};

/**
 * Converts OpencodeModelDefinitions to native OpenCode V2 model configuration format.
 * V2 uses `capabilities` and array-based `variants: [{ id, settings }]`.
 */
export function toV2ModelDefinitions(
  definitions: OpencodeModelDefinitions = OPENCODE_MODEL_DEFINITIONS,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [id, model] of Object.entries(definitions)) {
    const entry: Record<string, unknown> = {
      name: model.name,
      limit: model.limit,
    };
    if (model.temperature !== undefined) {
      entry.temperature = model.temperature;
    }
    entry.capabilities = {
      input: model.modalities?.input ?? ["text", "image", "pdf"],
      output: model.modalities?.output ?? ["text"],
    };
    if (model.variants && typeof model.variants === "object") {
      if (Array.isArray(model.variants)) {
        entry.variants = model.variants;
      } else {
        entry.variants = Object.entries(model.variants).map(([variantId, settings]) => ({
          id: variantId,
          settings,
        }));
      }
    }
    result[id] = entry;
  }

  return result;
}

function modelIdFromGeminiName(name: string | undefined): string | null {
  if (!name) return null;
  const id = name.replace(/^models\//, "").trim();
  return id || null;
}

export function supportsGeminiGeneration(model: GeminiApiModel): boolean {
  const methods = model.supportedGenerationMethods ?? [];
  return methods.includes("generateContent") || methods.includes("streamGenerateContent");
}

function titleFromModelId(modelId: string): string {
  return modelId
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function defaultLimitForModel(modelId: string): ModelLimit {
  if (/claude-(?:opus|sonnet)-5-5/i.test(modelId)) {
    return { context: 1000000, output: 128000 };
  }
  if (modelId.includes("claude")) {
    return { context: 200000, output: 64000 };
  }
  return { context: 1048576, output: 65536 };
}

function defaultVariantsForModel(modelId: string): Record<string, ModelVariant> | undefined {
  const normalized = modelId.toLowerCase().replace(/^antigravity-/, "");
  const family = gemini4Model(normalized)
  if (family) return Object.fromEntries(gemini4Levels(family.model).map(thinkingLevel => [thinkingLevel, { thinkingLevel }]))
  if (/^claude-(?:opus|sonnet)-5-5(?:-|$)/.test(normalized)) {
    return {
      low: { thinkingLevel: "low" },
      medium: { thinkingLevel: "medium" },
      high: { thinkingLevel: "high" },
    };
  }
  if (normalized.includes("claude") && normalized.includes("thinking")) {
    return {
      low: { thinkingConfig: { thinkingBudget: 8192 } },
      max: { thinkingConfig: { thinkingBudget: 32768 } },
    };
  }
  if (normalized.startsWith("gemini-3") || normalized.startsWith("gemini-2.5")) {
    if (normalized.includes("pro")) {
      return {
        low: { thinkingLevel: "low" },
        high: { thinkingLevel: "high" },
      };
    }
    if (normalized.includes("flash")) {
      return {
        minimal: { thinkingLevel: "minimal" },
        low: { thinkingLevel: "low" },
        medium: { thinkingLevel: "medium" },
        high: { thinkingLevel: "high" },
      };
    }
  }
  return undefined;
}

function mergeWithStaticDefinition(
  modelId: string,
  discovered: OpencodeModelDefinition,
): OpencodeModelDefinition {
  const existing = OPENCODE_MODEL_DEFINITIONS[modelId];
  if (!existing) return discovered;

  return {
    ...existing,
    ...discovered,
    limit: discovered.limit ?? existing.limit,
    modalities: discovered.modalities ?? existing.modalities,
    variants: existing.variants ?? discovered.variants,
  };
}

const GROUPED_TIERED_MODEL_REGEX = /^(gemini-3\.8-flash|claude-(?:opus|sonnet)-5-5)(?:-(low|medium|high))?$/i;
const TIERED_LEVELS = ["low", "medium", "high"] as const;

function groupedTieredModel(id: string | undefined | null) {
  const bare = id?.replace(/^models\//, "").replace(/^antigravity-/, "")
  if (!bare) return undefined
  const match = GROUPED_TIERED_MODEL_REGEX.exec(bare)
  if (!match) return undefined
  return { model: match[1]!.toLowerCase(), level: match[2]?.toLowerCase() }
}

export function antigravityModelIdFromEntry(sourceId: string, entry: AntigravityAvailableModel): string | null {
  const family = gemini4Model(sourceId) ?? gemini4Model(entry.modelName)
  if (family) return `antigravity-${family.model}`
  const grouped = groupedTieredModel(sourceId) ?? groupedTieredModel(entry.modelName)
  if (grouped) return `antigravity-${grouped.model}`
  const rawId = (entry.modelName || sourceId).trim();
  if (!rawId) return null;
  const modelId = rawId.replace(/^models\//, "");
  return modelId.startsWith("antigravity-") ? modelId : `antigravity-${modelId}`;
}

export function modelsFromGeminiApi(models: GeminiApiModel[]): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {};

  for (const model of models) {
    if (!supportsGeminiGeneration(model)) continue;
    const modelId = modelIdFromGeminiName(model.name) || model.baseModelId;
    if (!modelId) continue;
    if (gemini4Model(modelId)?.model === "gemini-4-hydrogen-sonar") continue

    const variants = defaultVariantsForModel(modelId);
    const discovered: OpencodeModelDefinition = {
      name: model.displayName ? `${model.displayName} (Gemini API)` : `${titleFromModelId(modelId)} (Gemini API)`,
      limit: {
        context: model.inputTokenLimit ?? defaultLimitForModel(modelId).context,
        output: model.outputTokenLimit ?? defaultLimitForModel(modelId).output,
      },
      modalities: DEFAULT_MODALITIES,
      ...(variants ? { variants } : {}),
    };
    definitions[modelId] = mergeWithStaticDefinition(modelId, discovered);
  }

  return definitions;
}

const INTERNAL_ANTIGRAVITY_MODEL_REGEX = /(?:^|-)(?:tiered|worker)(?:-|$)/i;

export function modelsFromAntigravityAvailableModels(
  models: AntigravityAvailableModels,
): OpencodeModelDefinitions {
  const definitions: OpencodeModelDefinitions = {};
  const tieredGroups = new Map<string, Array<{ level?: string; supportsThinking?: boolean; displayName?: string }>>()

  for (const [sourceId, entry] of Object.entries(models)) {
    if (entry.disabled) continue
    const modelId = antigravityModelIdFromEntry(sourceId, entry);
    if (!modelId) continue;

    if (INTERNAL_ANTIGRAVITY_MODEL_REGEX.test(sourceId) || INTERNAL_ANTIGRAVITY_MODEL_REGEX.test(modelId)) continue
    if (gemini4Model(modelId)) continue // Group tiered registry entries below.
    const grouped = groupedTieredModel(sourceId) ?? groupedTieredModel(entry.modelName)
    if (grouped) {
      const group = tieredGroups.get(grouped.model) ?? []
      group.push({ level: grouped.level, supportsThinking: entry.supportsThinking, displayName: entry.displayName })
      tieredGroups.set(grouped.model, group)
      continue
    }
    if (!entry.displayName && !OPENCODE_MODEL_DEFINITIONS[modelId]) continue
    const variants = defaultVariantsForModel(modelId)
    const discovered: OpencodeModelDefinition = {
      name: `${entry.displayName ?? titleFromModelId(modelId.replace(/^antigravity-/, ""))} (Antigravity)`,
      limit: defaultLimitForModel(modelId),
      modalities: DEFAULT_MODALITIES,
      ...(variants ? { variants } : {}),
    };
    definitions[modelId] = mergeWithStaticDefinition(modelId, discovered);
    if (entry.supportsThinking === false) {
      definitions[modelId].variants = undefined
      definitions[modelId].supportsThinking = false
    }
  }

  for (const [model, routes] of tieredGroups) {
    if (!routes.length) continue
    const id = `antigravity-${model}`
    const levels = TIERED_LEVELS.filter(level => {
      const route = routes.find(r => r.level === level) ?? routes.find(r => !r.level)
      return route && route.supportsThinking !== false
    })
    const displayName = routes
      .find(route => route.displayName)
      ?.displayName?.replace(/\s*\((?:low|medium|high|xhigh|minimal)\)\s*$/i, "")
      .trim()
    const base = OPENCODE_MODEL_DEFINITIONS[id]
    definitions[id] = {
      ...(base ?? {}),
      name: `${displayName || titleFromModelId(model)} (Antigravity)`,
      limit: base?.limit ?? defaultLimitForModel(model),
      modalities: base?.modalities ?? DEFAULT_MODALITIES,
      ...(levels.length
        ? { variants: Object.fromEntries(levels.map(thinkingLevel => [thinkingLevel, { thinkingLevel }])) }
        : { variants: undefined, supportsThinking: false }),
    }
  }

  for (const [model, routes] of gemini4Routes(models)) {
    if (!routes.length) continue
    const id = `antigravity-${model}`
    const levels = gemini4Levels(model).filter(level => {
      const route = selectGemini4Route(routes, level)
      return route && route.supportsThinking !== false
    })
    const displayName = routes
      .find(route => route.displayName)
      ?.displayName?.replace(/\s*\((?:low|medium|high|xhigh|minimal)\)\s*$/i, "")
      .trim()
    definitions[id] = {
      name: `${displayName || titleFromModelId(model)} (Antigravity)`,
      limit: OPENCODE_MODEL_DEFINITIONS[id]?.limit ?? defaultLimitForModel(model),
      modalities: DEFAULT_MODALITIES,
      ...(model === "gemini-4-hydrogen-sonar" || model === "gemini-4-argon" ? { temperature: false } : {}),
      ...(levels.length
        ? { variants: Object.fromEntries(levels.map(thinkingLevel => [thinkingLevel, { thinkingLevel }])) }
        : { variants: undefined, supportsThinking: false }),
    }
  }
  return definitions;
}

export function mergeModelDefinitions(...definitions: Record<string, ProviderModel>[]): Record<string, ProviderModel> {
  return Object.assign({}, ...definitions);
}
