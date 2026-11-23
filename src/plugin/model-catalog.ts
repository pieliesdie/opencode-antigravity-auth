/**
 * Live cache of the public Gemini API model catalog (`GET
 * generativelanguage.googleapis.com/v1beta/models`) and the Antigravity model
 * registry (`POST v1internal:fetchAvailableModels`), sourced from model discovery
 * and quota fetches.
 *
 * Routing decisions and dynamic model resolution use this live data to discover
 * new and updated models directly from Google's registries without requiring manual
 * plugin updates.
 */
import { createHash } from "node:crypto"
import type { AntigravityAvailableModels, GeminiApiModel } from "./config/models";
import { supportsGeminiGeneration } from "./config/models.ts"

const CATALOG_TTL_MS = 60 * 60 * 1000;

interface PublicModelCatalog {
  ids: ReadonlySet<string>;
  fetchedAt: number;
}

interface AntigravityModelCatalog {
  models: AntigravityAvailableModels;
  fetchedAt: number;
}

let catalog: PublicModelCatalog | undefined;
const publicCatalogsByKey = new Map<string, PublicModelCatalog>()
const antigravityCatalog = new Map<string, AntigravityModelCatalog>()
function catalogKey(token: string, project: string): string {
  return `${createHash("sha256").update(token).digest("hex")}:${project}`
}

function modelIdFromName(model: GeminiApiModel): string | null {
  const raw = (model.name ? model.name.replace(/^models\//, "") : model.baseModelId)?.trim();
  return raw || null;
}

/**
 * Records a freshly-fetched public Gemini API model list. Called as a side
 * effect of the existing model-discovery fetch — no extra network round trip.
 */
export function recordPublicGeminiApiModels(models: GeminiApiModel[], apiKey?: string): void {
  if (apiKey) {
    for (const [key, entry] of publicCatalogsByKey) {
      if (Date.now() - entry.fetchedAt > CATALOG_TTL_MS) publicCatalogsByKey.delete(key)
    }
    const ids = new Set(models.filter(supportsGeminiGeneration).flatMap(model => modelIdFromName(model) ?? []))
    publicCatalogsByKey.set(catalogKey(apiKey, ""), { ids, fetchedAt: Date.now() })
  }
  const ids = new Set<string>();
  for (const model of models) {
    const id = modelIdFromName(model);
    if (id) ids.add(id.toLowerCase());
  }
  if (ids.size === 0) return;
  catalog = { ids, fetchedAt: Date.now() };
}

/**
 * Returns the live set of public Gemini API model ids, or `undefined` when no
 * catalog has been fetched yet (cold start) or the cached one is stale.
 * Callers should fall back to static heuristics in the `undefined` case.
 */
export function getPublicGeminiApiModelIds(): ReadonlySet<string> | undefined {
  if (!catalog) return undefined;
  if (Date.now() - catalog.fetchedAt > CATALOG_TTL_MS) return undefined;
  return catalog.ids;
}

export function getPublicGenerationModelIds(apiKey: string): ReadonlySet<string> | undefined {
  const entry = publicCatalogsByKey.get(catalogKey(apiKey, ""))
  return entry && Date.now() - entry.fetchedAt <= CATALOG_TTL_MS ? entry.ids : undefined
}

/**
 * Records available models from the Antigravity model registry (`fetchAvailableModels`).
 * Called as a side effect of quota checks and model discovery.
 */
export function recordAntigravityAvailableModels(token: string, project: string, models: AntigravityAvailableModels): void {
  for (const [key, entry] of antigravityCatalog) {
    if (Date.now() - entry.fetchedAt > CATALOG_TTL_MS) antigravityCatalog.delete(key)
  }
  antigravityCatalog.set(catalogKey(token, project), {
    models: { ...models },
    fetchedAt: Date.now(),
  })
}

/**
 * Returns the cached Antigravity available models, or `undefined` when no catalog
 * has been fetched yet or the cached one is stale.
 */
export function getCachedAntigravityAvailableModels(token: string, project: string): AntigravityAvailableModels | undefined {
  const entry = antigravityCatalog.get(catalogKey(token, project))
  return entry && Date.now() - entry.fetchedAt <= CATALOG_TTL_MS ? entry.models : undefined
}

export function resetPublicGeminiApiModelCatalogForTests(): void {
  publicCatalogsByKey.clear()
  catalog = undefined;
}

export function resetAntigravityModelCatalogForTests(): void {
  antigravityCatalog.clear()
}

export function resetModelCatalogsForTests(): void {
  resetPublicGeminiApiModelCatalogForTests()
  antigravityCatalog.clear()
}
