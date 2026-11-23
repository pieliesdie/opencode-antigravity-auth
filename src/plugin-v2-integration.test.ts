import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createServer } from "node:http"
import { once } from "node:events"
import { createGoogleGenerativeAI } from "./google-provider.ts"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

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

import { createAntigravityPlugin } from "./plugin.ts"
import { AccountManager } from "./plugin/accounts.ts"
import { resetModelCatalogsForTests } from "./plugin/model-catalog.ts"
import { resetAgySdkCredentialStateForTests } from "./plugin/api-key.ts"
import type { LoaderResult, PluginClient, PluginContext } from "./plugin/types.ts"

const testDirectories: string[] = []
const plugins: Array<{ dispose?: () => void }> = []
const accountManagers: AccountManager[] = []
let priorConfigDirectory: string | undefined

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "antigravity-v2-driver-"))
  testDirectories.push(directory)
  if (priorConfigDirectory === undefined) priorConfigDirectory = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = directory
  mkdirSync(join(directory, ".opencode"))
  writeFileSync(join(directory, ".opencode", "antigravity.json"), JSON.stringify({
    auto_update: false,
    proactive_token_refresh: false,
  }))
  return directory
}

function trackPlugin<T extends { dispose?: () => void }>(plugin: T): T {
  plugins.push(plugin)
  return plugin
}

function createClient(): PluginClient {
  return {
    app: { log: async () => undefined },
    tui: { showToast: async () => undefined },
    auth: { set: async () => undefined },
    session: {
      prompt: async () => undefined,
      abort: async () => undefined,
      messages: async () => ({ data: [] }),
    },
  } as unknown as PluginClient
}

function isLoader(value: LoaderResult | Record<string, unknown>): value is LoaderResult {
  return "fetch" in value && typeof value.fetch === "function"
}

function driverFetch(loader: LoaderResult): typeof globalThis.fetch {
  return async (input, init) => {
    if (input instanceof URL) return loader.fetch(input.toString(), init)
    return loader.fetch(input, init)
  }
}

function generateOptions(thinkingLevel: "low" | "medium" | "high" | "xhigh"): LanguageModelV3CallOptions {
  return {
    prompt: [{
      role: "user",
      content: [{ type: "text", text: "Describe the transport route." }],
    }],
    providerOptions: {
      google: { thinkingConfig: { thinkingLevel, includeThoughts: true } },
    },
  }
}

function googleResponse(): Response {
  return new Response(JSON.stringify({
    candidates: [{
      content: { role: "model", parts: [{ text: "transport response" }] },
      finishReason: "STOP",
    }],
    usageMetadata: { promptTokenCount: 3, candidatesTokenCount: 2, totalTokenCount: 5 },
  }), { headers: { "content-type": "application/json" } })
}

async function oauthLoader(tokens: string[] = ["first", "second"]): Promise<LoaderResult> {
  const directory = createDirectory()
  writeFileSync(join(directory, "antigravity-accounts.json"), JSON.stringify({
    version: 4, activeIndex: 0, activeIndexByFamily: { gemini: 0, claude: 0 },
    accounts: tokens.map(refreshToken => ({ refreshToken, projectId: "proj", managedProjectId: "managed", addedAt: 1, lastUsed: 0 })),
  }))
  const plugin = trackPlugin(await createAntigravityPlugin("google")({ client: createClient(), directory, runtime: "v2" }))
  const loader = await plugin.auth.loader(async () => ({
    type: "oauth", access: "access", refresh: "first|proj|managed", expires: Date.now() + 3_600_000,
  }), { id: "google" })
  if (!isLoader(loader)) throw new Error("Missing OAuth loader")
  return loader
}
const modelUrl = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-3.8-flash:generateContent"
const init = { method: "POST", body: JSON.stringify({ contents: [{ role: "user", parts: [{ text: "hi" }] }] }) }

function requestUrl(input: RequestInfo | URL): string {
  return input instanceof Request ? input.url : String(input)
}

beforeEach(() => {
  resetModelCatalogsForTests()
  resetAgySdkCredentialStateForTests()
  for (const name of ["GEMINI_API_KEY", "GOOGLE_API_KEY", "OPENCODE_ANTIGRAVITY_API_KEYS"]) {
    vi.stubEnv(name, "")
  }
  const loadFromDisk = AccountManager.loadFromDisk
  vi.spyOn(AccountManager, "loadFromDisk").mockImplementation(async (auth) => {
    const manager = await loadFromDisk(auth)
    accountManagers.push(manager)
    return manager
  })
})

afterEach(async () => {
  for (const plugin of plugins.splice(0)) plugin.dispose?.()
  for (const manager of accountManagers.splice(0)) await manager.flushSaveToDisk()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
  while (testDirectories.length > 0) {
    const directory = testDirectories.pop()
    if (directory) rmSync(directory, { recursive: true, force: true })
  }
  if (priorConfigDirectory === undefined) {
    delete process.env.OPENCODE_CONFIG_DIR
  } else {
    process.env.OPENCODE_CONFIG_DIR = priorConfigDirectory
  }
  priorConfigDirectory = undefined
})

describe("Antigravity transport through @ai-sdk/google", () => {
  it.each([
    ["argon", "medium", "gemini-4-argon-medium"],
    ["carbon", "xhigh", "carbon-backend-v2"],
    ["hydrogen", "xhigh", "hydrogen-backend-v2"],
    ["neon", "xhigh", "neon-backend-v2"],
    ["hydrogen-sonar", "low", "gemini-4-hydrogen-sonar"],
  ] as const)("sends %s to its discovered OAuth backend at %s", async (name, level, backend) => {
    const model = `gemini-4-${name}`
    const sent: Array<{ id: string; level: string; token: string | null }> = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: {
        [backend]: { modelName: name === "hydrogen-sonar" ? "gemini-4-hydrogen" : model },
      } })
      if (!url.includes(":generateContent")) return new Response("1.0.0")
      const body = JSON.parse(String(options?.body))
      sent.push({ id: body.model, level: body.request.generationConfig.thinkingConfig.thinkingLevel,
        token: new Headers(options?.headers).get("authorization") })
      return googleResponse()
    })
    const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader(["first"])) })
    await sdk(model).doGenerate(generateOptions(level))
    expect(sent).toEqual([{ id: backend, level: level.toUpperCase(), token: "Bearer access" }])
  })

  it.each([["argon", "high"], ["carbon", "xhigh"], ["hydrogen", "xhigh"], ["neon", "xhigh"]] as const)(
    "uses the public %s ID and configured key when OAuth does not list it", async (name, level) => {
      const model = `gemini-4-${name}`
      vi.stubEnv("GEMINI_API_KEY", "fixture-key")
      const sent: Array<{ url: string; key: string | null; level: string }> = []
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
        const url = requestUrl(input)
        if (url.includes("fetchAvailableModels")) return Response.json({ models: {} })
        if (url.includes("models?pageSize")) return Response.json({ models: [{ name: `models/${model}`, supportedGenerationMethods: ["generateContent"] }] })
        if (url.includes(":generateContent")) {
          sent.push({ url, key: new Headers(options?.headers).get("x-goog-api-key"),
            level: JSON.parse(String(options?.body)).generationConfig.thinkingConfig.thinkingLevel })
          return googleResponse()
        }
        return new Response("1.0.0")
      })
      const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader(["first"])) })
      await sdk(model).doGenerate(generateOptions(level))
      expect(sent).toEqual([{ url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, key: "fixture-key", level }])
    },
  )

  it("reports unavailable Neon before generation without substituting Hydrogen Sonar or Argon", async () => {
    const posts: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes(":generateContent")) posts.push(url)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: {
        "gemini-4-neon": { disabled: true }, "gemini-4-hydrogen-sonar": { modelName: "gemini-4-hydrogen" }, "gemini-4-argon": {},
      } })
      return new Response("1.0.0")
    })
    const loader = await oauthLoader(["first"])
    for (const name of ["neon", "hydrogen"]) {
      const result = await loader.fetch(modelUrl.replace("antigravity-gemini-3.8-flash", `gemini-4-${name}`), init)
      expect(result.status).toBe(404)
      expect((await result.json()).error.message).toContain(`gemini-4-${name} is not listed`)
    }
    expect(posts).toEqual([])
  })

  it("sends Gemini 4 models with CLI tier ids, model_enum labels and uppercase thinking levels", async () => {
    const sent: Array<{ id: string; labels: unknown; level: string }> = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: {
        "gemini-4-neon-low": { model: "MODEL_PLACEHOLDER_M534" },
        "gemini-4-neon-medium": { model: "MODEL_PLACEHOLDER_M533" },
        "gemini-4-neon-high": { model: "MODEL_PLACEHOLDER_M532" },
        "gemini-4-neon-xhigh": { model: "MODEL_PLACEHOLDER_M535" },
        "gemini-4-hydrogen-low": { model: "MODEL_PLACEHOLDER_M527" },
        "gemini-4-hydrogen-medium": { model: "MODEL_PLACEHOLDER_M526" },
        "gemini-4-hydrogen-high": { model: "MODEL_PLACEHOLDER_M525" },
        "gemini-4-hydrogen-xhigh": { model: "MODEL_PLACEHOLDER_M528" },
      } })
      if (!url.includes(":generateContent")) return new Response("1.0.0")
      const body = JSON.parse(String(options?.body))
      sent.push({ id: body.model, labels: body.request.labels, level: body.request.generationConfig.thinkingConfig.thinkingLevel })
      return googleResponse()
    })
    const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader(["first"])) })
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      await sdk("antigravity-gemini-4-neon").doGenerate(generateOptions(level))
    }
    for (const level of ["low", "medium", "high", "xhigh"] as const) {
      await sdk("antigravity-gemini-4-hydrogen").doGenerate(generateOptions(level))
    }
    expect(sent).toEqual([
      { id: "gemini-4-neon-low", labels: { model_enum: "MODEL_PLACEHOLDER_M534" }, level: "LOW" },
      { id: "gemini-4-neon-medium", labels: { model_enum: "MODEL_PLACEHOLDER_M533" }, level: "MEDIUM" },
      { id: "gemini-4-neon-high", labels: { model_enum: "MODEL_PLACEHOLDER_M532" }, level: "HIGH" },
      { id: "gemini-4-neon-xhigh", labels: { model_enum: "MODEL_PLACEHOLDER_M535" }, level: "XHIGH" },
      { id: "gemini-4-hydrogen-low", labels: { model_enum: "MODEL_PLACEHOLDER_M527" }, level: "LOW" },
      { id: "gemini-4-hydrogen-medium", labels: { model_enum: "MODEL_PLACEHOLDER_M526" }, level: "MEDIUM" },
      { id: "gemini-4-hydrogen-high", labels: { model_enum: "MODEL_PLACEHOLDER_M525" }, level: "HIGH" },
      { id: "gemini-4-hydrogen-xhigh", labels: { model_enum: "MODEL_PLACEHOLDER_M528" }, level: "XHIGH" },
    ])
  })

  it("rejects Neon before generation when a nonempty catalog omits it", async () => {
    const posts: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes(":generateContent")) posts.push(url)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: { "gemini-4-argon-high": {} } })
      return new Response("1.0.0")
    })
    const loader = await oauthLoader(["first"])
    const result = await loader.fetch(modelUrl.replace("antigravity-gemini-3.8-flash", "antigravity-gemini-4-neon"), init)
    expect(result.status).toBe(404)
    expect((await result.json()).error.message).toContain("gemini-4-neon is not listed")
    expect(posts).toEqual([])
  })

  it("defaults bare Neon picker id to the High tier when listed", async () => {
    const bodies: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: { "gemini-4-neon-high": { model: "MODEL_PLACEHOLDER_M532" } } })
      if (!url.includes(":generateContent")) return new Response("1.0.0")
      bodies.push(String(options?.body))
      return googleResponse()
    })
    const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader(["first"])) })
    await sdk("antigravity-gemini-4-neon").doGenerate({ prompt: generateOptions("high").prompt })
    expect(bodies).toHaveLength(1)
    const body = JSON.parse(bodies[0]!)
    expect(body.model).toBe("gemini-4-neon-high")
    expect(body.request.labels).toEqual({ model_enum: "MODEL_PLACEHOLDER_M532" })
    expect(body.request.generationConfig.thinkingConfig.thinkingLevel).toBe("HIGH")
  })

  it("rejects Neon before generation when every listed tier is disabled", async () => {
    const posts: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes(":generateContent")) posts.push(url)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: { "gemini-4-neon-xhigh": { disabled: true } } })
      return new Response("1.0.0")
    })
    const loader = await oauthLoader(["first"])
    const result = await loader.fetch(modelUrl.replace("antigravity-gemini-3.8-flash", "gemini-4-neon"), init)
    expect(result.status).toBe(404)
    expect((await result.json()).error.message).toContain("gemini-4-neon is not listed")
    expect(posts).toEqual([])
  })

  it("falls back to an enabled untiered Neon alias when only the exact tier is disabled", async () => {
    const sent: Array<{ id: string; level: string | number }> = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("fetchAvailableModels")) return Response.json({ models: {
        "gemini-4-neon-xhigh": { disabled: true }, "gemini-4-neon": {},
      } })
      if (!url.includes(":generateContent")) return new Response("1.0.0")
      const body = JSON.parse(String(options?.body))
      sent.push({ id: body.model, level: body.request.generationConfig.thinkingConfig.thinkingLevel })
      return googleResponse()
    })
    const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader(["first"])) })
    await sdk("antigravity-gemini-4-neon").doGenerate(generateOptions("xhigh"))
    expect(sent).toEqual([{ id: "gemini-4-neon", level: "XHIGH" }])
  })

  it("keeps the original Neon 429 when discovery fails", async () => {
    vi.stubEnv("GEMINI_API_KEY", "public-key")
    const refusal = JSON.stringify({ error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } })
    const posts: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("fetchAvailableModels")) return new Response("offline", { status: 503 })
      if (url.includes(":generateContent")) {
        posts.push(JSON.parse(String(options?.body)).model)
        return new Response(refusal, { status: 429 })
      }
      return new Response("1.0.0")
    })
    const loader = await oauthLoader(["first"])
    const result = await loader.fetch(modelUrl.replace("antigravity-gemini-3.8-flash", "gemini-4-neon"), init)
    expect(result.status).toBe(429)
    expect(await result.text()).toBe(refusal)
    expect(posts).toEqual(["gemini-4-neon-high"])
    expect(accountManagers[0]!.getAccountsSnapshot()[0]!.rateLimitResetTimes).toEqual({})
  })

  it("streams Neon xhigh only with a key whose catalog lists generation across A/B/A", async () => {
    const model = "gemini-4-neon"
    const sent: string[] = []
    const lists: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      const key = new Headers(options?.headers).get("x-goog-api-key") ?? ""
      if (url.includes("models?pageSize")) {
        lists.push(key)
        return Response.json({ models: [{ name: `models/${model}`, supportedGenerationMethods: key === "A" ? ["generateContent"] : ["countTokens"] }] })
      }
      if (url.includes(":streamGenerateContent")) {
        const body = JSON.parse(String(options?.body))
        sent.push(`${key}:${new URL(url).pathname}:${body.generationConfig.thinkingConfig.thinkingLevel}`)
        return new Response(`data: ${await googleResponse().text()}\n\n`, { headers: { "content-type": "text/event-stream" } })
      }
      return new Response("1.0.0")
    })
    let key = "A"
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client: createClient(), directory: createDirectory(), runtime: "v2" }))
    const loaded = await plugin.auth.loader(async () => ({ type: "api", key }), { id: "google" })
    if (!isLoader(loaded)) throw new Error("Missing API-key loader")
    const driver = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(loaded) })(model)
    const stream = async () => {
      const reader = (await driver.doStream(generateOptions("xhigh"))).stream.getReader()
      while (!(await reader.read()).done) { /* drain the SDK stream */ }
    }
    await stream()
    key = "B"
    await expect(stream()).rejects.toThrow(/not listed for generation/)
    key = "A"
    await stream()
    expect(sent).toEqual(Array(2).fill("A:/v1beta/models/gemini-4-neon:streamGenerateContent:xhigh"))
    expect(lists).toEqual(["A", "B"])
  })
  it("sends one POST when the server reads it and closes without a response", async () => {    let posts = 0
    const server = createServer((req) => {
      req.resume()
      req.on("end", () => { if (req.method === "POST") posts++; req.socket.destroy() })
    })
    server.listen(0, "127.0.0.1")
    await once(server, "listening")
    const address = server.address()
    if (!address || typeof address === "string") throw new Error("Missing test port")
    const network = globalThis.fetch
    try {
      vi.stubGlobal("fetch", (input: RequestInfo | URL, options?: RequestInit) => requestUrl(input).includes("v1internal:generateContent")
        ? network(`http://127.0.0.1:${address.port}`, options) : Promise.resolve(new Response("1.0.0")))
      const loader = await oauthLoader()
      await expect(loader.fetch(modelUrl, init)).rejects.toThrow()
      expect(posts).toBe(1)
    } finally { await new Promise<void>(resolve => server.close(() => resolve())) }
  })

  it("falls back to the next endpoint when a 200 response is empty, instead of failing the request", async () => {
    const posts: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      if (!url.includes("v1internal:generateContent")) return new Response("1.0.0")
      posts.push(url)
      // First endpoint answers 200 with an empty body; the second one works.
      return posts.length === 1 ? new Response("", { status: 200 }) : googleResponse()
    })
    const directory = createDirectory()
    writeFileSync(join(directory, "antigravity.json"), JSON.stringify({
      empty_response_max_attempts: 1,
      empty_response_retry_delay_ms: 500,
    }))
    writeFileSync(join(directory, "antigravity-accounts.json"), JSON.stringify({
      version: 4, activeIndex: 0, activeIndexByFamily: { gemini: 0, claude: 0 },
      accounts: [{ refreshToken: "first", projectId: "proj", managedProjectId: "managed", addedAt: 1, lastUsed: 0 }],
    }))
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client: createClient(), directory, runtime: "v2" }))
    const loader = await plugin.auth.loader(async () => ({
      type: "oauth", access: "access", refresh: "first|proj|managed", expires: Date.now() + 3_600_000,
    }), { id: "google" })
    if (!isLoader(loader)) throw new Error("Missing OAuth loader")
    const sdk = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(loader) })
    const result = await sdk("gemini-3-pro-preview").doGenerate(generateOptions("high"))
    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    expect(posts).toHaveLength(2)
  })

  it.each(["Resource has been exhausted", "Resource has been exhausted (e.g. check quota)."])("returns an unexplained 429 without account marks or API-key fallback: %s", async message => {
    vi.stubEnv("GEMINI_API_KEY", "public-key")
    const attempts: string[] = []
    const body = JSON.stringify({ error: { code: 429, message, status: "RESOURCE_EXHAUSTED" } })
    vi.stubGlobal("fetch", (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes("enerateContent")) {
        attempts.push(url)
        return Promise.resolve(new Response(body, { status: 429 }))
      }
      return Promise.resolve(new Response("1.0.0"))
    })
    const loader = await oauthLoader()
    const result = await loader.fetch(modelUrl, init)
    expect(result.status).toBe(429)
    expect(await result.text()).toBe(body)
    expect(attempts).toHaveLength(1)
    for (const account of accountManagers[0]!.getAccountsSnapshot()) expect(account.rateLimitResetTimes).toEqual({})
  })

  it("propagates Esc without retrying or penalizing accounts", async () => {
    const controller = new AbortController()
    const stop = new Error("Esc")
    let requests = 0
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      if (requestUrl(input).includes("v1internal:generateContent")) {
        requests++
        controller.abort(stop)
        throw stop
      }
      return new Response("1.0.0")
    })
    const loader = await oauthLoader()
    await expect(loader.fetch(modelUrl, { ...init, signal: controller.signal })).rejects.toBe(stop)
    expect(requests).toBe(1)
    for (const account of accountManagers[0]!.getAccountsSnapshot()) expect(account.rateLimitResetTimes).toEqual({})
  })

  it("respects a header-only 429 and records only the affected model", async () => {
    const retryDate = new Date(Date.now() + 600_000).toUTCString()
    const network = vi.fn(async (input: RequestInfo | URL) => requestUrl(input).includes("generateContent")
      ? new Response("busy", { status: 429, headers: { "retry-after": retryDate } })
      : new Response("1.0.0"))
    vi.stubGlobal("fetch", network)
    const loader = await oauthLoader(["first"])
    const response = await loader.fetch(modelUrl, init)
    expect(response.status).toBe(429)
    expect(response.headers.get("retry-after")).toBe(retryDate)
    const marks = accountManagers[0]!.getAccountsSnapshot()[0]!.rateLimitResetTimes
    const entries = Object.entries(marks)
    expect(entries).toHaveLength(1)
    expect(entries[0]![0]).toMatch(/^gemini-antigravity:.*gemini-3\.8-flash/)
    expect(entries[0]![1]).toBeGreaterThanOrEqual(Date.parse(retryDate))
    expect(network.mock.calls.filter(([input]) => requestUrl(input).includes("generateContent"))).toHaveLength(1)
  })

  it("does not retry a bare public API refusal on another key", async () => {
    vi.stubEnv("GEMINI_API_KEY", "fallback-key")
    const keys: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      if (requestUrl(input).includes("generateContent")) {
        keys.push(new Headers(options?.headers).get("x-goog-api-key") ?? "")
        return new Response("Resource has been exhausted", { status: 429 })
      }
      return new Response("1.0.0")
    })
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client: createClient(), directory: createDirectory(), runtime: "v2" }))
    const loader = await plugin.auth.loader(async () => ({ type: "api", key: "primary-key" }), { id: "google" })
    if (!isLoader(loader)) throw new Error("Missing API-key loader")
    const result = await loader.fetch(modelUrl.replace("antigravity-gemini-3.8-flash", "gemini-2.5-flash"), init)
    expect(result.status).toBe(429)
    expect(await result.text()).toBe("Resource has been exhausted")
    expect(keys).toHaveLength(1)
  })

  it("falls through to OAuth when preferred Gemini API keys are already in rate-limit cooldown", async () => {
    vi.stubEnv("GEMINI_API_KEY", "cooldown-key")
    const directory = createDirectory()
    writeFileSync(join(directory, ".opencode", "antigravity.json"), JSON.stringify({
      auto_update: false,
      proactive_token_refresh: false,
      agy_sdk: { enabled: true, prefer_for_gemini: true, api_key_fallback: true, cloud_projects: [] },
    }))
    writeFileSync(join(directory, "antigravity-accounts.json"), JSON.stringify({
      version: 4, activeIndex: 0, activeIndexByFamily: { gemini: 0, claude: 0 },
      accounts: [{ refreshToken: "first", projectId: "proj", managedProjectId: "managed", addedAt: 1, lastUsed: 0 }],
    }))
    let apiCalls = 0
    let oauthCalls = 0
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("generativelanguage.googleapis.com") && url.includes(":generateContent")) {
        apiCalls++
        return new Response("busy", { status: 429, headers: { "retry-after": "60" } })
      }
      if (url.includes("v1internal:generateContent")) {
        oauthCalls++
        return googleResponse()
      }
      return new Response("1.0.0")
    })
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client: createClient(), directory, runtime: "v2" }))
    const loader = await plugin.auth.loader(async () => ({
      type: "oauth", access: "access", refresh: "first|proj|managed", expires: Date.now() + 3_600_000,
    }), { id: "google" })
    if (!isLoader(loader)) throw new Error("Missing OAuth loader")
    const url = modelUrl.replace("antigravity-gemini-3.8-flash", "gemini-2.5-flash")
    expect((await loader.fetch(url, init)).status).toBe(200)
    expect((await loader.fetch(url, init)).status).toBe(200)
    expect(apiCalls).toBe(1)
    expect(oauthCalls).toBe(2)
  })

  it("falls back to a configured Gemini API key when a single OAuth account gets a 429 exceeding max_rate_limit_wait_seconds", async () => {
    vi.stubEnv("GEMINI_API_KEY", "fallback-key")
    const apiKeys: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("v1internal:generateContent")) {
        return new Response("busy", { status: 429, headers: { "retry-after": "600" } })
      }
      if (url.includes("generativelanguage.googleapis.com") && url.includes(":generateContent")) {
        apiKeys.push(new Headers(options?.headers).get("x-goog-api-key") ?? "")
        return googleResponse()
      }
      return new Response("1.0.0")
    })
    const loader = await oauthLoader(["first"])
    const response = await loader.fetch(modelUrl, init)
    expect(response.status).toBe(200)
    expect(apiKeys).toEqual(["fallback-key"])
    expect(Object.keys(accountManagers[0]!.getAccountsSnapshot()[0]!.rateLimitResetTimes)).toHaveLength(1)
  })

  it("preserves reversed parallel tool results and mixed media through the real SDK", async () => {
    const bodies: string[] = []
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, options?: RequestInit) => {
      if (requestUrl(input).includes("oauth2.googleapis.com/token")) return Response.json({ access_token: "second-access", expires_in: 3600 })
      if (!requestUrl(input).includes("v1internal:generateContent")) return new Response("1.0.0")
      bodies.push(String(options?.body))
      return googleResponse()
    })
    const model = createGoogleGenerativeAI({ apiKey: "placeholder", fetch: driverFetch(await oauthLoader()) }).languageModel("antigravity-gemini-3.8-flash")
    const options: LanguageModelV3CallOptions = { prompt: [
      { role: "user", content: [{ type: "text", text: "read twice" }] },
      { role: "assistant", content: ["a", "b"].map(toolCallId => ({ type: "tool-call", toolName: "read", toolCallId, input: { file: toolCallId } })) },
      { role: "tool", content: [
        { type: "tool-result", toolName: "read", toolCallId: "b", output: { type: "error-json", value: { error: "missing" } } },
        { type: "tool-result", toolName: "read", toolCallId: "a", output: { type: "text", value: "first file" } },
      ] },
    ] }
    await model.doGenerate(options)
    await model.doGenerate(options)
    const [calls, results] = JSON.parse(bodies[0]!).request.contents.slice(-2)
    const [a, b] = calls.parts.map((part: { functionCall: { id: string } }) => part.functionCall.id)
    expect(a).toMatch(/^[0-9a-f-]{36}$/)
    expect(b).not.toBe(a)
    expect(results.role).toBe("model")
    expect(results.parts.map((p: { functionResponse: unknown }) => p.functionResponse)).toEqual([
      { id: b, name: "read", response: { output: '{"error":"missing"}' } },
      { id: a, name: "read", response: { output: "first file" } },
    ])
    expect(JSON.parse(bodies[1]!).request.contents).toEqual(JSON.parse(bodies[0]!).request.contents)
    await model.doGenerate({ prompt: [...options.prompt.slice(0, 2), {
      role: "tool", content: [{ type: "tool-result", toolName: "read", toolCallId: "a", output: { type: "content", value: [
        { type: "text", text: "caption" }, { type: "image-data", mediaType: "image/png", data: "AQID" },
      ] } }],
    }] })
    const mixed = JSON.parse(bodies[2]!).request.contents.at(-1)
    expect(mixed.role).toBe("user")
    expect(mixed.parts).toContainEqual({ inlineData: { mimeType: "image/png", data: "AQID" } })
    expect(mixed.parts[0].functionResponse.response).toEqual({ name: "read", content: "caption" })
  })
  it("reports the failed refresh token to V2 instead of clearing the current host credential", async () => {
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      }
      throw new Error(`Unexpected request: ${url}`)
    }))
    const directory = createDirectory()
    const client = createClient()
    client.auth.revoke = vi.fn(async () => undefined)
    const set = vi.spyOn(client.auth, "set")
    const plugin = trackPlugin(await createAntigravityPlugin("google")({ client, directory, runtime: "v2" }))
    const loaded = await plugin.auth.loader(async () => ({
      type: "oauth",
      refresh: "revoked-token|test-project|managed-project",
      access: "expired-access",
      expires: 1,
    }), { id: "google" })
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    await expect(model.doGenerate(generateOptions("high"))).rejects.toThrow()
    expect(client.auth.revoke).toHaveBeenCalledWith("revoked-token")
    expect(set).not.toHaveBeenCalled()
  })

  it("rewrites an OAuth Gemini request, retains the variant thinking level, and parses the Google driver response", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      return googleResponse()
    }))
    const directory = createDirectory()
    const context: PluginContext = {
      client: createClient(),
      directory,
      runtime: "v2",
    }
    const plugin = trackPlugin(await createAntigravityPlugin("google")(context))
    const loaded = await plugin.auth.loader(
      async () => ({
        type: "oauth",
        refresh: "refresh-token|test-project|managed-project",
        access: "oauth-access",
        expires: Date.now() + 3_600_000,
      }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    const result = await model.doGenerate(generateOptions("high"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    const transport = requests.find((request) => request.url.includes("v1internal:generateContent"))
    expect(transport?.url).toContain("cloudcode-pa")
    const body = JSON.parse(String(transport?.init?.body)) as {
      request?: {
        generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } }
      }
    }
    expect(body.request?.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "high", includeThoughts: true })
  })

  it("routes API-key credentials through the real driver while replacing its placeholder key", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      return googleResponse()
    }))
    const directory = createDirectory()
    const plugin = trackPlugin(await createAntigravityPlugin("google")({
      client: createClient(),
      directory,
      runtime: "v2",
    }))
    const loaded = await plugin.auth.loader(
      async () => ({ type: "api", key: "plugin-api-key" }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("API-key auth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-2.5-flash")

    const result = await model.doGenerate(generateOptions("medium"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    expect(requests).toHaveLength(1)
    expect(requests[0]?.url).toContain("generativelanguage.googleapis.com")
    const headers = new Headers(requests[0]?.init?.headers)
    expect(headers.get("x-goog-api-key")).toBe("plugin-api-key")
    const body = JSON.parse(String(requests[0]?.init?.body)) as {
      generationConfig?: { thinkingConfig?: { thinkingLevel?: string; includeThoughts?: boolean } }
    }
    expect(body.generationConfig?.thinkingConfig).toEqual({ thinkingLevel: "medium", includeThoughts: true })
  })

  it("prefers an active V2 OAuth credential over the stored active account", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = []
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = requestUrl(input)
      if (url.includes("antigravity-auto-updater")) return new Response("1.18.3")
      requests.push({ url, init })
      if (url.includes("oauth2.googleapis.com/token")) {
        return new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })
      }
      return googleResponse()
    }))
    const directory = createDirectory()
    writeFileSync(join(directory, "antigravity-accounts.json"), JSON.stringify({
      version: 4,
      activeIndex: 0,
      activeIndexByFamily: { claude: 0, gemini: 0 },
      accounts: [
        {
          email: "stored-a@example.test",
          refreshToken: "stored-refresh-a",
          projectId: "stored-project-a",
          managedProjectId: "stored-managed-a",
          addedAt: 1,
          lastUsed: 0,
        },
        {
          email: "oauth-b@example.test",
          refreshToken: "oauth-refresh-b",
          projectId: "oauth-project-b",
          managedProjectId: "oauth-managed-b",
          addedAt: 2,
          lastUsed: 0,
        },
      ],
    }, null, 2))
    const plugin = trackPlugin(await createAntigravityPlugin("google")({
      client: createClient(),
      directory,
      runtime: "v2",
    }))
    const loaded = await plugin.auth.loader(
      async () => ({
        type: "oauth",
        refresh: "oauth-refresh-b|oauth-project-b|oauth-managed-b",
        access: "oauth-access-b",
        expires: Date.now() + 3_600_000,
      }),
      { id: "google" },
    )
    if (!isLoader(loaded)) throw new Error("OAuth did not produce a fetch loader")
    const model = createGoogleGenerativeAI({ apiKey: "driver-placeholder", fetch: driverFetch(loaded) })("gemini-3-pro-preview")

    const result = await model.doGenerate(generateOptions("high"))

    expect(result.content).toContainEqual(expect.objectContaining({ type: "text", text: "transport response" }))
    const transport = requests.find((request) => request.url.includes("v1internal:generateContent"))
    expect(new Headers(transport?.init?.headers).get("authorization")).toBe("Bearer oauth-access-b")
    expect(requests.some((request) => String(request.init?.body).includes("stored-refresh-a"))).toBe(false)
  })
})
