import { describe, expect, it } from "vitest"
import {
  evaluateAccountModelEligibility,
  extractAvailableModelsFromRegistry,
  matchesModelPattern,
  mergeAntigravityRegistries,
  normalizeModelKey,
  sanitizeModelPatterns,
  sanitizeUnavailableModels,
} from "./model-availability.ts"
import { DEFAULT_CONFIG } from "./config/schema.ts"

describe("model-availability", () => {
  describe("normalizeModelKey", () => {
    it("normalizes antigravity prefixes, models/ prefixes, tiers, preview suffixes, and aliases", () => {
      expect(normalizeModelKey("antigravity-gemini-4-argon")).toBe("gemini-4-argon")
      expect(normalizeModelKey("gemini-4-argon-high")).toBe("gemini-4-argon")
      expect(normalizeModelKey("antigravity-gemini-4-neon-xhigh")).toBe("gemini-4-neon")
      expect(normalizeModelKey("models/antigravity-gemini-3.8-flash-medium")).toBe("gemini-3.8-flash")
      expect(normalizeModelKey("gemini-3-flash-preview")).toBe("gemini-3-flash")
      expect(normalizeModelKey("antigravity-claude-opus-5-5-high")).toBe("claude-opus-5-5")
      expect(normalizeModelKey("gemini-claude-opus-4-6-thinking-low")).toBe("claude-opus-4-6-thinking")
      expect(normalizeModelKey("gemini-claude-sonnet-4-6")).toBe("claude-sonnet-4-6")
      expect(normalizeModelKey("gemini-flash-latest")).toBe("gemini-3.8-flash")
      expect(normalizeModelKey("MODEL_PLACEHOLDER_M417")).toBe("gemini-4-argon")
      expect(normalizeModelKey("MODEL_PLACEHOLDER_M402")).toBe("claude-opus-5-5")
    })

    it("preserves non-tier suffixes on models that do not use thinking tiers", () => {
      expect(normalizeModelKey("gpt-oss-120b-medium")).toBe("gpt-oss-120b-medium")
    })
  })

  describe("matchesModelPattern", () => {
    it("matches exact normalized models and glob wildcards", () => {
      expect(matchesModelPattern("antigravity-gemini-4-argon-high", "gemini-4-argon")).toBe(true)
      expect(matchesModelPattern("gemini-4-neon", "gemini-4-*")).toBe(true)
      expect(matchesModelPattern("antigravity-claude-opus-5-5", "claude-*")).toBe(true)
      expect(matchesModelPattern("gemini-3-flash", "claude-*")).toBe(false)
      expect(matchesModelPattern("anything", "*")).toBe(true)
    })
  })

  describe("extractAvailableModelsFromRegistry & mergeAntigravityRegistries", () => {
    it("extracts available and disabled models while keeping models with any enabled tier available", () => {
      const extracted = extractAvailableModelsFromRegistry({
        "gemini-4-neon-xhigh": { disabled: true },
        "gemini-4-neon-high": { displayName: "Gemini 4 Neon" },
        "gemini-4-argon-high": { disabled: true },
        "claude-opus-5-5-high": { displayName: "Claude Opus 5.5" },
        "internal-worker-model": { displayName: "Internal" },
      })
      expect(extracted.available).toEqual(["claude-opus-5-5", "gemini-4-neon"])
      expect(extracted.disabled).toEqual(["gemini-4-argon"])
    })

    it("merges registries across multiple accounts so enabled entries win over disabled ones", () => {
      const merged = mergeAntigravityRegistries([
        {
          "gemini-3-flash": { displayName: "Gemini 3 Flash", supportsThinking: false },
          "gemini-4-argon-high": { displayName: "Gemini 4 Argon", disabled: true },
        },
        {
          "gemini-3-flash": { displayName: "Gemini 3 Flash", supportsThinking: true },
          "gemini-4-argon-high": { displayName: "Gemini 4 Argon" },
          "claude-opus-5-5-high": { displayName: "Claude Opus 5.5" },
        },
      ])
      expect(merged["gemini-4-argon-high"]?.disabled).toBeUndefined()
      expect(merged["gemini-3-flash"]?.supportsThinking).toBe(true)
      expect(merged["claude-opus-5-5-high"]).toBeDefined()
    })
  })

  describe("evaluateAccountModelEligibility", () => {
    const baseAccount = { index: 0, email: "free@example.com" }

    it("enforces config model_accounts and account_rules", () => {
      const config = {
        ...DEFAULT_CONFIG.model_routing,
        model_accounts: {
          "gemini-4-*": ["ultra@example.com"],
        },
        account_rules: {
          "free@example.com": { deny: ["claude-opus-*"] },
          "2": { allow: ["claude-*"] },
        },
      }
      expect(evaluateAccountModelEligibility(baseAccount, "gemini-4-argon", config)).toEqual({
        eligible: false,
        reason: "config-model-rule",
        detail: expect.any(String),
      })
      expect(
        evaluateAccountModelEligibility({ index: 1, email: "ultra@example.com" }, "gemini-4-argon", config),
      ).toEqual({
        eligible: false,
        reason: "config-account-allow",
        detail: expect.any(String),
      })
      expect(
        evaluateAccountModelEligibility(baseAccount, "claude-opus-5-5", config),
      ).toEqual({
        eligible: false,
        reason: "config-account-deny",
        detail: expect.any(String),
      })
      expect(
        evaluateAccountModelEligibility(baseAccount, "gemini-3-flash", config),
      ).toEqual({ eligible: true })
    })

    it("enforces stored allow/deny rules, runtime cooldown, and cached catalog TTL", () => {
      const now = 1_000_000
      expect(
        evaluateAccountModelEligibility(
          { ...baseAccount, disabledModels: ["gemini-4-*"] },
          "antigravity-gemini-4-neon",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toMatchObject({ eligible: false, reason: "account-disabled-model" })

      expect(
        evaluateAccountModelEligibility(
          { ...baseAccount, allowedModels: ["gemini-3-*"] },
          "claude-sonnet-4-6",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toMatchObject({ eligible: false, reason: "account-allowed-models" })

      expect(
        evaluateAccountModelEligibility(
          { ...baseAccount, unavailableModels: { "gemini-4-argon": now + 60_000 } },
          "gemini-4-argon-high",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toMatchObject({ eligible: false, reason: "runtime-unavailable" })

      // Expired runtime unavailability becomes eligible again
      expect(
        evaluateAccountModelEligibility(
          { ...baseAccount, unavailableModels: { "gemini-4-argon": now - 1 } },
          "gemini-4-argon-high",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toEqual({ eligible: true })

      // Fresh catalog omits gemini-4-argon -> ineligible
      expect(
        evaluateAccountModelEligibility(
          {
            ...baseAccount,
            cachedAvailableModels: ["gemini-3-flash"],
            cachedAvailableModelsUpdatedAt: now - 10_000,
          },
          "gemini-4-argon",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toMatchObject({ eligible: false, reason: "not-in-catalog" })

      // Stale catalog fails open
      expect(
        evaluateAccountModelEligibility(
          {
            ...baseAccount,
            cachedAvailableModels: ["gemini-3-flash"],
            cachedAvailableModelsUpdatedAt: now - 61 * 60 * 1000,
          },
          "gemini-4-argon",
          DEFAULT_CONFIG.model_routing,
          now,
        ),
      ).toEqual({ eligible: true })

      // TTL=0 disables catalog filtering
      expect(
        evaluateAccountModelEligibility(
          {
            ...baseAccount,
            cachedAvailableModels: ["gemini-3-flash"],
            cachedAvailableModelsUpdatedAt: now,
          },
          "gemini-4-argon",
          { ...DEFAULT_CONFIG.model_routing, availability_cache_ttl_minutes: 0 },
          now,
        ),
      ).toEqual({ eligible: true })
    })

    it("sanitizes model patterns and unavailable model maps", () => {
      expect(sanitizeModelPatterns([" antigravity-gemini-4-argon-high ", "gemini-4-argon", "claude-*", ""])).toEqual([
        "gemini-4-argon",
        "claude-*",
      ])
      expect(sanitizeUnavailableModels({ "antigravity-gemini-4-argon-high": 2000, "claude-opus-5-5": 500 }, 1000)).toEqual({
        "gemini-4-argon": 2000,
      })
    })
  })
})
