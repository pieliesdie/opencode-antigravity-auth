/**
 * Per-account model availability, normalization, and manual routing rules.
 *
 * Determines whether a given account can serve a requested model using:
 * 1. Config-level model->accounts and account->allow/deny rules (`antigravity.json`)
 * 2. Account-level manual allow/deny rules (`antigravity-accounts.json`)
 * 3. Runtime-learned temporary unavailability (403/404 entitlement failures)
 * 4. Auto-discovered catalog availability (`fetchAvailableModels` cache)
 */

import type { AntigravityAvailableModel, AntigravityAvailableModels } from "./config/models.ts"
import { antigravityModelIdFromEntry } from "./config/models.ts"
import type { ModelAccountRoutingConfig } from "./config/schema.ts"
import { gemini4Model } from "./gemini4.ts"
import {
  MODEL_ALIASES,
  isClaude55Model,
  isGemini3OrLaterModel,
} from "./transform/model-resolver.ts"

export type ModelIneligibilityReason =
  | "config-model-rule"
  | "config-account-deny"
  | "config-account-allow"
  | "account-disabled-model"
  | "account-allowed-models"
  | "runtime-unavailable"
  | "not-in-catalog"

export type ModelEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: ModelIneligibilityReason; detail?: string }

export interface AccountModelAvailabilitySubject {
  index: number
  email?: string
  allowedModels?: readonly string[]
  disabledModels?: readonly string[]
  cachedAvailableModels?: readonly string[]
  cachedAvailableModelsUpdatedAt?: number
  unavailableModels?: Readonly<Record<string, number>>
}

const INTERNAL_ANTIGRAVITY_MODEL_REGEX = /(?:^|-)(?:tiered|worker)(?:-|$)/i
const THINKING_TIER_SUFFIX_REGEX = /-(?:minimal|low|medium|high|xhigh)$/i

const PLACEHOLDER_ENUM_TO_MODEL: Readonly<Record<string, string>> = {
  MODEL_PLACEHOLDER_M400: "claude-opus-5-5",
  MODEL_PLACEHOLDER_M401: "claude-opus-5-5",
  MODEL_PLACEHOLDER_M402: "claude-opus-5-5",
  MODEL_PLACEHOLDER_M403: "claude-sonnet-5-5",
  MODEL_PLACEHOLDER_M404: "claude-sonnet-5-5",
  MODEL_PLACEHOLDER_M405: "claude-sonnet-5-5",
  MODEL_PLACEHOLDER_M417: "gemini-4-argon",
  MODEL_PLACEHOLDER_M418: "gemini-4-argon",
  MODEL_PLACEHOLDER_M419: "gemini-4-argon",
  MODEL_PLACEHOLDER_M525: "gemini-4-hydrogen",
  MODEL_PLACEHOLDER_M526: "gemini-4-hydrogen",
  MODEL_PLACEHOLDER_M527: "gemini-4-hydrogen",
  MODEL_PLACEHOLDER_M528: "gemini-4-hydrogen",
  MODEL_PLACEHOLDER_M532: "gemini-4-neon",
  MODEL_PLACEHOLDER_M533: "gemini-4-neon",
  MODEL_PLACEHOLDER_M534: "gemini-4-neon",
  MODEL_PLACEHOLDER_M535: "gemini-4-neon",
}

/**
 * Normalizes a requested or registry model identifier into a canonical lowercase
 * key used for per-model sticky tracking, caching, and rule matching.
 */
export function normalizeModelKey(model: string): string {
  const trimmed = model.trim()
  if (!trimmed) return ""

  const upper = trimmed.toUpperCase()
  const placeholderMapped = PLACEHOLDER_ENUM_TO_MODEL[upper]
  if (placeholderMapped) {
    return placeholderMapped
  }

  let key = trimmed
    .toLowerCase()
    .replace(/^models\//, "")
    .replace(/^antigravity-/, "")

  const directAlias = MODEL_ALIASES[key]
  if (directAlias) {
    key = directAlias.toLowerCase()
  }

  if (key.startsWith("gemini-claude-")) {
    key = key.slice("gemini-".length)
  }

  const g4 = gemini4Model(key)
  if (g4) {
    return g4.model
  }

  if (isClaude55Model(key)) {
    return key.replace(THINKING_TIER_SUFFIX_REGEX, "")
  }

  const supportsTier =
    isGemini3OrLaterModel(key) ||
    key.includes("gemini-2.5") ||
    (key.includes("claude") && key.includes("thinking"))

  if (supportsTier) {
    key = key.replace(THINKING_TIER_SUFFIX_REGEX, "")
  }

  if (isGemini3OrLaterModel(key)) {
    key = key.replace(/-preview$/, "")
  }

  const postAlias = MODEL_ALIASES[key]
  if (postAlias) {
    key = postAlias.toLowerCase()
  }

  return key
}

/**
 * Normalizes a user-supplied model pattern (allowing `*` wildcards).
 */
export function normalizeModelPattern(pattern: string): string {
  const trimmed = pattern.trim()
  if (!trimmed) return ""
  if (trimmed === "*") return "*"
  if (trimmed.includes("*")) {
    return trimmed
      .toLowerCase()
      .replace(/^models\//, "")
      .replace(/^antigravity-/, "")
  }
  return normalizeModelKey(trimmed)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Matches a model identifier against a literal model ID or glob pattern (`*`).
 */
export function matchesModelPattern(model: string, pattern: string): boolean {
  const normalizedPattern = normalizeModelPattern(pattern)
  if (!normalizedPattern) return false
  if (normalizedPattern === "*") return true

  const normalizedModel = normalizeModelKey(model)
  if (!normalizedModel) return false

  if (!normalizedPattern.includes("*")) {
    return normalizedModel === normalizedPattern
  }

  const regexSource = `^${normalizedPattern.split("*").map(escapeRegExp).join(".*")}$`
  return new RegExp(regexSource, "i").test(normalizedModel)
}

export function matchesAnyModelPattern(
  model: string,
  patterns: readonly string[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return false
  return patterns.some((pattern) => matchesModelPattern(model, pattern))
}

/**
 * Extracts canonical available and explicitly disabled model IDs from an
 * Antigravity `fetchAvailableModels` registry payload.
 */
export function extractAvailableModelsFromRegistry(
  registry: AntigravityAvailableModels,
): { available: string[]; disabled: string[] } {
  const availableSet = new Set<string>()
  const disabledSet = new Set<string>()

  for (const [sourceId, entry] of Object.entries(registry)) {
    if (!entry) continue
    if (INTERNAL_ANTIGRAVITY_MODEL_REGEX.test(sourceId)) continue

    const mappedFromPlaceholder = PLACEHOLDER_ENUM_TO_MODEL[sourceId.toUpperCase()]
    const fromEntry = antigravityModelIdFromEntry(sourceId, entry)
    const rawId = mappedFromPlaceholder ?? fromEntry ?? entry.modelName ?? sourceId
    if (!rawId || INTERNAL_ANTIGRAVITY_MODEL_REGEX.test(rawId)) continue

    const canonical = normalizeModelKey(rawId)
    if (!canonical) continue

    if (entry.disabled === true) {
      disabledSet.add(canonical)
    } else {
      availableSet.add(canonical)
    }
  }

  for (const id of availableSet) {
    disabledSet.delete(id)
  }

  return {
    available: [...availableSet].sort(),
    disabled: [...disabledSet].sort(),
  }
}

/**
 * Merges `fetchAvailableModels` registries across multiple enabled accounts so
 * OpenCode model discovery surfaces every model available to at least one account.
 */
export function mergeAntigravityRegistries(
  registries: readonly AntigravityAvailableModels[],
): AntigravityAvailableModels {
  const merged: AntigravityAvailableModels = {}

  for (const registry of registries) {
    for (const [sourceId, entry] of Object.entries(registry)) {
      if (!entry) continue
      const existing = merged[sourceId]
      if (!existing) {
        merged[sourceId] = { ...entry }
        continue
      }

      const existingEnabled = existing.disabled !== true
      const incomingEnabled = entry.disabled !== true

      if (!existingEnabled && incomingEnabled) {
        merged[sourceId] = { ...existing, ...entry, disabled: entry.disabled }
        continue
      }

      if (existingEnabled && !incomingEnabled) {
        continue
      }

      const mergedEntry: AntigravityAvailableModel = {
        ...existing,
        ...entry,
        displayName: existing.displayName ?? entry.displayName,
        modelName: existing.modelName ?? entry.modelName,
        model: existing.model ?? entry.model,
        disabled: existing.disabled === true && entry.disabled === true ? true : undefined,
        supportsThinking:
          existing.supportsThinking === true || entry.supportsThinking === true
            ? true
            : existing.supportsThinking ?? entry.supportsThinking,
      }
      merged[sourceId] = mergedEntry
    }
  }

  return merged
}

function accountMatchesSelector(
  account: Pick<AccountModelAvailabilitySubject, "index" | "email">,
  selector: string,
): boolean {
  const trimmed = selector.trim()
  if (!trimmed) return false
  if (trimmed === "*") return true

  if (account.email && account.email.toLowerCase() === trimmed.toLowerCase()) {
    return true
  }

  // 1-based account index selector (matches CLI/UI numbering)
  if (/^\d+$/.test(trimmed)) {
    const oneBased = Number(trimmed)
    return oneBased === account.index + 1
  }

  return false
}

/**
 * Evaluates whether an account is eligible to serve a requested model.
 */
export function evaluateAccountModelEligibility(
  account: AccountModelAvailabilitySubject,
  model: string | null | undefined,
  routingConfig?: ModelAccountRoutingConfig,
  now: number = Date.now(),
): ModelEligibilityResult {
  if (!model) {
    return { eligible: true }
  }

  const modelKey = normalizeModelKey(model)
  if (!modelKey) {
    return { eligible: true }
  }

  // 1. Config-level per-model account allowlist (`model_routing.model_accounts`)
  if (routingConfig?.model_accounts) {
    const matchedSelectors: string[] = []
    for (const [pattern, selectors] of Object.entries(routingConfig.model_accounts)) {
      if (!selectors || selectors.length === 0) continue
      if (matchesModelPattern(modelKey, pattern)) {
        matchedSelectors.push(...selectors)
      }
    }
    if (matchedSelectors.length > 0) {
      const allowed = matchedSelectors.some((selector) =>
        accountMatchesSelector(account, selector),
      )
      if (!allowed) {
        return {
          eligible: false,
          reason: "config-model-rule",
          detail: `model_accounts restricts ${modelKey}`,
        }
      }
    }
  }

  // 2. Config-level per-account allow/deny rules (`model_routing.account_rules`)
  if (routingConfig?.account_rules) {
    const matchingRules = Object.entries(routingConfig.account_rules)
      .filter(([selector]) => accountMatchesSelector(account, selector))
      .map(([, rule]) => rule)

    for (const rule of matchingRules) {
      if (matchesAnyModelPattern(modelKey, rule.deny)) {
        return {
          eligible: false,
          reason: "config-account-deny",
          detail: `denied by config account_rules for ${modelKey}`,
        }
      }
    }

    const allowPatterns = matchingRules.flatMap((rule) => rule.allow ?? [])
    if (allowPatterns.length > 0 && !matchesAnyModelPattern(modelKey, allowPatterns)) {
      return {
        eligible: false,
        reason: "config-account-allow",
        detail: `not in config account_rules allowlist for ${modelKey}`,
      }
    }
  }

  // 3. Stored per-account manual allow/deny rules (`antigravity-accounts.json`)
  if (matchesAnyModelPattern(modelKey, account.disabledModels)) {
    return {
      eligible: false,
      reason: "account-disabled-model",
      detail: `disabled on account for ${modelKey}`,
    }
  }
  if (
    account.allowedModels &&
    account.allowedModels.length > 0 &&
    !matchesAnyModelPattern(modelKey, account.allowedModels)
  ) {
    return {
      eligible: false,
      reason: "account-allowed-models",
      detail: `not in account allowedModels for ${modelKey}`,
    }
  }

  // 4. Runtime-learned temporary unavailability (403/404 entitlement failure)
  const unavailableUntil = account.unavailableModels?.[modelKey]
  if (typeof unavailableUntil === "number" && Number.isFinite(unavailableUntil) && now < unavailableUntil) {
    return {
      eligible: false,
      reason: "runtime-unavailable",
      detail: `temporarily unavailable until ${new Date(unavailableUntil).toISOString()}`,
    }
  }

  // 5. Auto-discovered catalog availability (`cachedAvailableModels`)
  const cacheTtlMinutes = routingConfig?.availability_cache_ttl_minutes ?? 60
  if (
    cacheTtlMinutes > 0 &&
    Array.isArray(account.cachedAvailableModels) &&
    typeof account.cachedAvailableModelsUpdatedAt === "number" &&
    Number.isFinite(account.cachedAvailableModelsUpdatedAt) &&
    now - account.cachedAvailableModelsUpdatedAt <= cacheTtlMinutes * 60 * 1000
  ) {
    const listed = account.cachedAvailableModels.some(
      (entry) => normalizeModelKey(entry) === modelKey,
    )
    if (!listed) {
      return {
        eligible: false,
        reason: "not-in-catalog",
        detail: `${modelKey} is not in account's cached available models`,
      }
    }
  }

  return { eligible: true }
}

/**
 * Deduplicates and normalizes a list of manual model patterns.
 */
export function sanitizeModelPatterns(patterns: readonly string[] | undefined): string[] | undefined {
  if (!patterns) return undefined
  const seen = new Set<string>()
  const result: string[] = []
  for (const raw of patterns) {
    if (typeof raw !== "string") continue
    const normalized = normalizeModelPattern(raw)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result.length > 0 ? result : undefined
}

/**
 * Prunes expired or invalid entries from a `unavailableModels` map.
 */
export function sanitizeUnavailableModels(
  raw: Record<string, number> | undefined,
  now: number = Date.now(),
): Record<string, number> {
  const out: Record<string, number> = {}
  if (!raw) return out
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "number" || !Number.isFinite(value) || value <= now) {
      continue
    }
    const normalized = normalizeModelKey(key)
    if (!normalized) continue
    out[normalized] = Math.max(out[normalized] ?? 0, value)
  }
  return out
}
