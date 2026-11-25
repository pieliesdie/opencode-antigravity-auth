import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

vi.mock("@opencode-ai/plugin", () => ({
  tool: Object.assign(
    (definition: unknown) => definition,
    {
      schema: {
        string: () => ({ describe: () => ({}) }),
        boolean: () => ({ optional: () => ({ default: () => ({ describe: () => ({}) }) }) }),
        array: () => ({ optional: () => ({ describe: () => ({}) }) }),
      },
    },
  ),
}))

import { AccountManager } from "./accounts.ts"
import { DEFAULT_CONFIG } from "./config/schema.ts"
import { resetModelCatalogsForTests } from "./model-catalog.ts"
import {
  loadAccounts,
  removeAccountFromStorage,
  saveAccounts,
  type AccountStorageV4,
} from "./storage.ts"
import type { PluginClient } from "./types.ts"

describe("Model-aware AccountManager rotation", () => {
  beforeEach(() => {
    vi.useRealTimers()
    vi.stubGlobal("process", { ...process, pid: 0 })
  })

  it("maintains independent sticky active accounts per model without clobbering sibling models", () => {
    const now = Date.now()
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: "free@example.com",
          refreshToken: "r-free",
          addedAt: 1,
          lastUsed: 0,
          cachedAvailableModels: ["gemini-3-flash", "claude-sonnet-4-6"],
          cachedAvailableModelsUpdatedAt: now,
        },
        {
          email: "ultra@example.com",
          refreshToken: "r-ultra",
          addedAt: 1,
          lastUsed: 0,
          cachedAvailableModels: ["gemini-3-flash", "gemini-4-argon", "claude-opus-5-5"],
          cachedAvailableModelsUpdatedAt: now,
        },
      ],
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
    }

    const manager = new AccountManager(undefined, stored)

    // First request on gemini-3-flash sticks to account 0 (free)
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-3-flash", "sticky")?.index).toBe(0)
    // Switching to gemini-4-argon automatically routes to account 1 (ultra)
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-4-argon", "sticky")?.index).toBe(1)
    // Returning to gemini-3-flash keeps account 0 sticky!
    expect(manager.getCurrentOrNextForFamily("gemini", "antigravity-gemini-3-flash", "sticky")?.index).toBe(0)
    // Returning to gemini-4-argon keeps account 1 sticky!
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-4-argon-high", "sticky")?.index).toBe(1)
  })

  it("rotates round-robin independently per model over eligible accounts only", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 0, disabledModels: ["gemini-4-*"] },
        { email: "b@example.com", refreshToken: "r2", addedAt: 1, lastUsed: 0 },
        { email: "c@example.com", refreshToken: "r3", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }

    const manager = new AccountManager(undefined, stored)

    // gemini-4-argon only rotates between accounts 1 and 2 (skipping 0)
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-4-argon", "round-robin")?.index).toBe(1)
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-4-argon", "round-robin")?.index).toBe(2)
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-4-argon", "round-robin")?.index).toBe(1)

    // gemini-3-flash has its own round-robin cursor across 0, 1, 2
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3-flash", "round-robin")?.index).toBe(0)
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3-flash", "round-robin")?.index).toBe(1)
    expect(manager.getCurrentOrNextForFamily("gemini", "gemini-3-flash", "round-robin")?.index).toBe(2)
  })

  it("filters hybrid strategy candidates by model availability and config rules", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        { email: "free@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 0 },
        { email: "pro@example.com", refreshToken: "r2", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    }

    const manager = new AccountManager(undefined, stored, {
      ...DEFAULT_CONFIG.model_routing,
      model_accounts: {
        "claude-opus-5-5": ["pro@example.com"],
      },
    })

    expect(manager.getCurrentOrNextForFamily("claude", "antigravity-claude-opus-5-5", "hybrid")?.email).toBe(
      "pro@example.com",
    )
    // Returns null when the only eligible account is excluded
    expect(
      manager.getCurrentOrNextForFamily(
        "claude",
        "antigravity-claude-opus-5-5",
        "hybrid",
        "antigravity",
        false,
        100,
        600_000,
        new Set([1]),
      ),
    ).toBeNull()
  })

  it("scopes soft-quota, rate-limit wait times, and other-account checks to model-eligible accounts", () => {
    const now = Date.now()
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [
        {
          email: "free@example.com",
          refreshToken: "r1",
          addedAt: 1,
          lastUsed: 0,
          disabledModels: ["gemini-4-argon"],
          cachedQuota: { gemini: { remainingFraction: 1, modelCount: 1 } },
          cachedQuotaUpdatedAt: now,
        },
        {
          email: "ultra@example.com",
          refreshToken: "r2",
          addedAt: 1,
          lastUsed: 0,
          cachedQuota: {
            gemini: {
              remainingFraction: 0.05,
              resetTime: new Date(now + 120_000).toISOString(),
              modelCount: 1,
            },
          },
          cachedQuotaUpdatedAt: now,
        },
      ],
      activeIndex: 0,
    }

    const manager = new AccountManager(undefined, stored)

    // For gemini-4-argon, only account 1 is eligible and it is over 90% threshold
    expect(manager.areAllAccountsOverSoftQuota("gemini", 90, 600_000, "gemini-4-argon")).toBe(true)
    expect(manager.hasOtherAccountWithAntigravityAvailable(1, "gemini", "gemini-4-argon")).toBe(false)

    // For gemini-3-pro, account 0 is eligible and has 100% remaining
    expect(manager.areAllAccountsOverSoftQuota("gemini", 90, 600_000, "gemini-3-pro")).toBe(false)
    expect(manager.hasOtherAccountWithAntigravityAvailable(1, "gemini", "gemini-3-pro")).toBe(true)
  })

  it("clears runtime unavailability when fresh catalog reports the model available", () => {
    const stored: AccountStorageV4 = {
      version: 4,
      accounts: [{ email: "a@example.com", refreshToken: "r1", addedAt: 1, lastUsed: 0 }],
      activeIndex: 0,
    }
    const manager = new AccountManager(undefined, stored)
    const acc = manager.getAccounts()[0]!

    manager.markModelUnavailable(acc, "gemini-4-argon", 60_000)
    expect(manager.isAccountEligibleForModel(acc, "gemini-4-argon")).toBe(false)

    manager.updateAvailableModelsCache(0, { "gemini-4-argon-high": { displayName: "Argon" } })
    expect(manager.isAccountEligibleForModel(acc, "gemini-4-argon")).toBe(true)
  })
})

describe("Model availability storage persistence & merge", () => {
  let tempDir: string
  let priorConfigDir: string | undefined

  beforeEach(() => {
    priorConfigDir = process.env.OPENCODE_CONFIG_DIR
    tempDir = mkdtempSync(join(tmpdir(), "agy-model-storage-"))
    process.env.OPENCODE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("persists allowedModels, disabledModels, cachedAvailableModels, unavailableModels, and remaps activeIndexByModel on removal", async () => {
    const now = Date.now()
    await saveAccounts({
      version: 4,
      accounts: [
        {
          email: "a@example.com",
          refreshToken: "tok-a",
          addedAt: 1,
          lastUsed: 10,
          disabledModels: ["gemini-4-*"],
          cachedAvailableModels: ["gemini-3-flash"],
          cachedAvailableModelsUpdatedAt: now,
          unavailableModels: { "gemini-4-argon": now + 60_000 },
          controlUpdatedAt: 100,
        },
        {
          email: "b@example.com",
          refreshToken: "tok-b",
          addedAt: 1,
          lastUsed: 20,
          allowedModels: ["gemini-4-*", "claude-*"],
          cachedAvailableModels: ["gemini-4-argon", "claude-opus-5-5"],
          cachedAvailableModelsUpdatedAt: now,
          controlUpdatedAt: 100,
        },
      ],
      activeIndex: 0,
      activeIndexByModel: {
        "gemini-3-flash": 0,
        "gemini-4-argon": 1,
      },
    })

    const loaded = await loadAccounts()
    expect(loaded?.accounts[0]?.disabledModels).toEqual(["gemini-4-*"])
    expect(loaded?.accounts[0]?.cachedAvailableModels).toEqual(["gemini-3-flash"])
    expect(loaded?.accounts[1]?.allowedModels).toEqual(["gemini-4-*", "claude-*"])
    expect(loaded?.activeIndexByModel).toEqual({
      "gemini-3-flash": 0,
      "gemini-4-argon": 1,
    })

    // Removing account 0 remaps activeIndexByModel["gemini-4-argon"] from 1 -> 0
    await removeAccountFromStorage("tok-a")
    const afterRemove = await loadAccounts()
    expect(afterRemove?.accounts).toHaveLength(1)
    expect(afterRemove?.accounts[0]?.email).toBe("b@example.com")
    expect(afterRemove?.activeIndexByModel?.["gemini-4-argon"]).toBe(0)
  })
})

describe("Plugin model-aware failover and multi-account discovery", () => {
  let tempDir: string
  let priorConfigDir: string | undefined

  const client = {
    tui: { showToast: vi.fn(async () => undefined) },
    app: { log: vi.fn(async () => undefined) },
    auth: { set: vi.fn(async () => undefined) },
  } as unknown as PluginClient

  beforeEach(() => {
    resetModelCatalogsForTests()
    priorConfigDir = process.env.OPENCODE_CONFIG_DIR
    tempDir = mkdtempSync(join(tmpdir(), "agy-model-plugin-"))
    process.env.OPENCODE_CONFIG_DIR = tempDir
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    resetModelCatalogsForTests()
    if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
    rmSync(tempDir, { recursive: true, force: true })
  })

  it("aggregates available models across all enabled accounts during provider.models() discovery", async () => {
    await saveAccounts({
      version: 4,
      accounts: [
        { email: "free@example.com", refreshToken: "tok-free", projectId: "proj-free", addedAt: 1, lastUsed: 0 },
        { email: "ultra@example.com", refreshToken: "tok-ultra", projectId: "proj-ultra", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    })

    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "")
        const token = body.includes("tok-ultra") ? "access-ultra" : "access-free"
        return Response.json({ access_token: token, expires_in: 3600 })
      }
      if (url.includes("fetchAvailableModels")) {
        const auth = new Headers(init?.headers).get("authorization")
        if (auth === "Bearer access-ultra") {
          return Response.json({
            models: {
              "gemini-3-flash": { displayName: "Gemini 3 Flash" },
              "gemini-4-argon-high": { displayName: "Gemini 4 Argon" },
            },
          })
        }
        return Response.json({
          models: {
            "gemini-3-flash": { displayName: "Gemini 3 Flash" },
            "gemini-4-argon-high": { displayName: "Gemini 4 Argon", disabled: true },
          },
        })
      }
      return new Response("1.0.0")
    }))

    const { createAntigravityPlugin } = await import("../plugin.ts")
    const plugin = await createAntigravityPlugin("google")({ client, directory: tempDir })
    try {
      const models = await plugin.provider!.models!({ id: "google" }, {})
      expect(models["antigravity-gemini-3-flash"]).toBeDefined()
      expect(models["antigravity-gemini-4-argon"]).toBeDefined()
    } finally {
      plugin.dispose?.()
    }
  })

  it("rotates to another account when a Gemini 4 model is not listed on the first account", async () => {
    await saveAccounts({
      version: 4,
      accounts: [
        { email: "free@example.com", refreshToken: "tok-free", projectId: "proj-free", addedAt: 1, lastUsed: 0 },
        { email: "ultra@example.com", refreshToken: "tok-ultra", projectId: "proj-ultra", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    })

    const generationTokens: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "")
        const token = body.includes("tok-ultra") ? "access-ultra" : "access-free"
        return Response.json({ access_token: token, expires_in: 3600 })
      }
      if (url.includes("fetchAvailableModels")) {
        const auth = new Headers(init?.headers).get("authorization")
        if (auth === "Bearer access-ultra") {
          return Response.json({
            models: {
              "gemini-4-neon-high": { model: "MODEL_PLACEHOLDER_M532" },
            },
          })
        }
        return Response.json({
          models: {
            "gemini-3-flash": {},
          },
        })
      }
      if (url.includes(":generateContent")) {
        const auth = new Headers(init?.headers).get("authorization") ?? ""
        generationTokens.push(auth)
        return Response.json({
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: "ok" }] }, finishReason: "STOP" }],
          },
        })
      }
      return new Response("1.0.0")
    }))

    const { createAntigravityPlugin } = await import("../plugin.ts")
    const plugin = await createAntigravityPlugin("google")({ client, directory: tempDir })
    try {
      const loader = await plugin.auth.loader(
        async () => ({ type: "oauth", refresh: "tok-free|proj-free", access: "access-free", expires: Date.now() + 3_600_000 }),
        { id: "google" },
      )
      const fetchFn = (loader as { fetch: typeof fetch }).fetch
      const reqUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-4-neon:generateContent"
      const reqInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }

      const res1 = await fetchFn(reqUrl, reqInit)
      expect(res1.status).toBe(200)
      expect(generationTokens).toEqual(["Bearer access-ultra"])

      // Second request goes straight to ultra without touching free again
      const res2 = await fetchFn(reqUrl, reqInit)
      expect(res2.status).toBe(200)
      expect(generationTokens).toEqual(["Bearer access-ultra", "Bearer access-ultra"])
    } finally {
      plugin.dispose?.()
    }
  })

  it("rotates to another account on 403 permission denied on resource project and caches unavailability", async () => {
    await saveAccounts({
      version: 4,
      accounts: [
        { email: "free@example.com", refreshToken: "tok-free", projectId: "proj-free", addedAt: 1, lastUsed: 0 },
        { email: "pro@example.com", refreshToken: "tok-pro", projectId: "proj-pro", addedAt: 1, lastUsed: 0 },
      ],
      activeIndex: 0,
    })

    const calls: string[] = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url.includes("oauth2.googleapis.com/token")) {
        const body = String(init?.body ?? "")
        const token = body.includes("tok-pro") ? "access-pro" : "access-free"
        return Response.json({ access_token: token, expires_in: 3600 })
      }
      if (url.includes(":generateContent")) {
        const auth = new Headers(init?.headers).get("authorization") ?? ""
        calls.push(auth)
        if (auth === "Bearer access-free") {
          return Response.json(
            { error: { code: 403, status: "PERMISSION_DENIED", message: "Permission denied on resource project proj-free" } },
            { status: 403 },
          )
        }
        return Response.json({
          response: {
            candidates: [{ content: { role: "model", parts: [{ text: "ok from pro" }] }, finishReason: "STOP" }],
          },
        })
      }
      return new Response("1.0.0")
    }))

    const { createAntigravityPlugin } = await import("../plugin.ts")
    const plugin = await createAntigravityPlugin("google")({ client, directory: tempDir })
    try {
      const loader = await plugin.auth.loader(
        async () => ({ type: "oauth", refresh: "tok-free|proj-free", access: "access-free", expires: Date.now() + 3_600_000 }),
        { id: "google" },
      )
      const fetchFn = (loader as { fetch: typeof fetch }).fetch
      const reqUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-opus-5-5:generateContent"
      const reqInit = {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
      }

      const res1 = await fetchFn(reqUrl, reqInit)
      expect(res1.status).toBe(200)
      expect(calls).toEqual(["Bearer access-free", "Bearer access-pro"])

      // Subsequent request skips free directly and hits pro
      const res2 = await fetchFn(reqUrl, reqInit)
      expect(res2.status).toBe(200)
      expect(calls).toEqual(["Bearer access-free", "Bearer access-pro", "Bearer access-pro"])
    } finally {
      plugin.dispose?.()
    }
  })

  it("returns 404 immediately without sleeping when no enabled account is eligible for the requested model", async () => {
    await saveAccounts({
      version: 4,
      accounts: [
        {
          email: "free@example.com",
          refreshToken: "tok-free",
          projectId: "proj-free",
          addedAt: 1,
          lastUsed: 0,
          disabledModels: ["claude-opus-5-5"],
        },
      ],
      activeIndex: 0,
    })

    vi.stubGlobal("fetch", vi.fn(async () => new Response("1.0.0")))

    const { createAntigravityPlugin } = await import("../plugin.ts")
    const plugin = await createAntigravityPlugin("google")({ client, directory: tempDir })
    try {
      const loader = await plugin.auth.loader(
        async () => ({ type: "oauth", refresh: "tok-free|proj-free", access: "access-free", expires: Date.now() + 3_600_000 }),
        { id: "google" },
      )
      const fetchFn = (loader as { fetch: typeof fetch }).fetch
      const res = await fetchFn(
        "https://generativelanguage.googleapis.com/v1beta/models/antigravity-claude-opus-5-5:generateContent",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }),
        },
      )
      expect(res.status).toBe(404)
      expect((await res.json()).error.message).toContain("No enabled Antigravity account is eligible")
    } finally {
      plugin.dispose?.()
    }
  })
})
