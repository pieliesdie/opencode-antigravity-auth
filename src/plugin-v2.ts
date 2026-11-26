import { randomUUID } from "node:crypto"
import { Integration, Model, Plugin, Provider } from "@opencode/plugin"
import type { Credential } from "@opencode/plugin"
import type { IntegrationOAuthAuthorization } from "@opencode/plugin/promise/integration"
import type { SessionContext } from "@opencode/plugin/promise/session"
import { z } from "zod"
import { createGoogleGenerativeAI } from "./google-provider.ts"
import { ANTIGRAVITY_PROVIDER_ID } from "./constants.ts"
import { authorizeAntigravity, cancelAuthorization, exchangeAntigravity } from "./antigravity/oauth.ts"
import { parseCallbackInput } from "./account-menu.ts"
import { AntigravityAccountsRpc } from "./antigravity-rpc.ts"
import { createAntigravityPlugin } from "./plugin.ts"
import { createAccountAdmin } from "./plugin/account-admin.ts"
import type { AccountAdmin } from "./plugin/account-admin.ts"
import { loadConfig } from "./plugin/config/index.ts"
import { parseRefreshParts } from "./plugin/auth.ts"
import { gemini4Model, missingGemini4Credential } from "./plugin/gemini4.ts"
import { extractRequestedGeminiModel } from "./plugin/api-key.ts"
import { createLogger } from "./plugin/logger.ts"
import { writeConsoleLog } from "./plugin/logging-utils.ts"
import { startOAuthListener } from "./plugin/server.ts"
import type { OAuthListener } from "./plugin/server.ts"
import type { OpencodeModelDefinition } from "./plugin/config/models.ts"
import type { AuthDetails, LoaderResult, PluginClient, ProviderModel } from "./plugin/types.ts"

const PROVIDER_ID = ANTIGRAVITY_PROVIDER_ID
const METHOD_ID = "antigravity"
const GOOGLE_PACKAGE = `aisdk:${new URL("./google-provider.js", import.meta.url).href}`
const log = createLogger("opencode-v2")

function isLoader(value: LoaderResult | Record<string, unknown>): value is LoaderResult {
  return typeof value.fetch === "function"
}

function toModel(id: string, definition: ProviderModel): Model.Info {
  const model = definition as Partial<OpencodeModelDefinition>
  return {
    ...Model.Info.default(Provider.ID.make(PROVIDER_ID), Model.ID.make(id)),
    name: model.name ?? id,
    package: GOOGLE_PACKAGE,
    limit: model.limit ?? { context: 200_000, output: 32_000 },
    capabilities: {
      tools: true,
      input: model.modalities?.input ?? ["text", "image", "pdf"],
      output: model.modalities?.output ?? ["text"],
    },
    variants: Object.entries(model.variants ?? {}).map(([name, settings]) => ({
      id: Model.VariantID.make(name),
      settings: {
        thinkingConfig: {
          ...settings.thinkingConfig,
          ...(settings.thinkingLevel ? { thinkingLevel: settings.thinkingLevel } : {}),
        },
      },
    })),
  }
}

// V2 repairs the request context rather than editing V1's JSON session files.
function recoverContext(event: SessionContext): void {
  const results = new Set(event.messages.flatMap((message) => message.content
    .filter((part) => part.type === "tool-result")
    .map((part) => part.id)))
  event.messages = event.messages.flatMap((message) => {
    const missing = message.content.filter((part) => part.type === "tool-call")
      .filter((part) => !part.providerExecuted && !results.has(part.id))
    if (missing.length === 0) return [message]
    return [message, {
      role: "tool" as const,
      content: missing.map((part) => ({
        type: "tool-result" as const,
        id: part.id,
        name: part.name,
        result: { type: "error" as const, value: "Operation cancelled before a tool result was recorded" },
      })),
    }]
  })
}

export const AntigravityV2Plugin = Plugin.define({
  id: "opencode-antigravity-auth",
  async setup(ctx) {
    const controller = new AbortController()
    const config = loadConfig(ctx.location.directory)
    let invalidConnection: { key: string | undefined; refresh: string } | undefined
    const connectionKey = (connection: Awaited<ReturnType<typeof ctx.integration.connection.active>>) =>
      connection?.type === "credential" ? connection.id : connection?.type === "env" ? connection.name : undefined

    const getAuth = async (): Promise<AuthDetails> => {
      const connection = await ctx.integration.connection.active(PROVIDER_ID)
      if (!connection) return { type: "none" }
      const credential = await ctx.integration.connection.resolve(connection)
      if (credential?.type === "oauth") {
        if (connectionKey(connection) === invalidConnection?.key && credential.refresh === invalidConnection?.refresh) {
          return { type: "none" }
        }
        return credential
      }
      if (credential?.type === "key") return { type: "api", key: credential.key }
      return { type: "none" }
    }

    // The shared transport only needs notifications and revocation reporting in
    // V2. Session recovery below uses the V2 context, never the V1 storage APIs.
    const client = {
      app: { log: async ({ body }: { body: { level: "debug" | "info" | "warn" | "error"; message: string } }) => {
        writeConsoleLog(body.level, body.message)
      } },
      tui: { showToast: async ({ body }: { body: { title?: string; message: string } }) => {
        writeConsoleLog("info", body.title ? `${body.title}: ${body.message}` : body.message)
      } },
      auth: { revoke: async (refreshToken: string) => {
        const connection = await ctx.integration.connection.active(PROVIDER_ID)
        if (!connection) return
        const credential = await ctx.integration.connection.resolve(connection)
        if (credential?.type !== "oauth" || parseRefreshParts(credential.refresh).refreshToken !== refreshToken) return
        // Quarantine the revoked token, not its reusable connection ID. A host
        // credential update can replace the token without creating a new ID.
        invalidConnection = { key: connectionKey(connection), refresh: credential.refresh }
        await ctx.integration.connection.status({
          integrationID: PROVIDER_ID,
          connection,
          status: { status: "needs_auth", message: "Google revoked the refresh token. Reconnect Antigravity." },
        })
      } },
    } as unknown as PluginClient

    const legacy = await createAntigravityPlugin(PROVIDER_ID)({
      client,
      directory: ctx.location.directory,
      runtime: "v2",
    })
    let loaderKey: string | undefined
    let loaderPromise: Promise<LoaderResult | Record<string, unknown>> | undefined
    const getLoader = async () => {
      const auth = await getAuth()
      const key = JSON.stringify([auth.type, "refresh" in auth ? auth.refresh : "key" in auth ? auth.key : undefined])
      if (!loaderPromise || key !== loaderKey) {
        loaderKey = key
        const pending = legacy.auth.loader(getAuth, { id: PROVIDER_ID })
        loaderPromise = pending
        // Clear failures so a transient connection error can be retried.
        void pending.catch(() => {
          if (loaderPromise === pending) loaderPromise = undefined
        })
      }
      return loaderPromise
    }

    await ctx.integration.transform((editor) => {
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: {
          id: METHOD_ID,
          type: "oauth",
          label: "OAuth with Google (Antigravity)",
          form: [{ key: "noBrowser", type: "boolean", title: "Paste the redirect URL manually", default: false }],
        },
        async authorize(answer): Promise<IntegrationOAuthAuthorization> {
          const method = legacy.auth.methods.find((method) => method.type === "oauth")
          if (!method?.authorize) throw new Error("Antigravity OAuth is unavailable")
          const authorization = await method.authorize({ noBrowser: String(answer.noBrowser ?? false) })
          const complete = async (code?: string): Promise<Credential.OAuth> => {
            const result = authorization.method === "auto"
              ? await authorization.callback()
              : await authorization.callback(code ?? "")
            if (result.type !== "success") throw new Error(result.error ?? "Antigravity authentication failed")
            invalidConnection = undefined
            loaderPromise = undefined
            return { type: "oauth", methodID: Integration.MethodID.make(METHOD_ID), refresh: result.refresh, access: result.access, expires: result.expires }
          }
          if (authorization.method === "code") {
            return { url: authorization.url, instructions: authorization.instructions, mode: "code", callback: complete }
          }
          const callback = complete()
          void callback.catch((error: unknown) => log.warn("OAuth callback failed", { error: String(error) }))
          return { url: authorization.url, instructions: authorization.instructions, mode: "auto", callback }
        },
        // Refresh belongs to the shared account pool. A host refresh would
        // abort model resolution on invalid_grant before rotation can run.
      })
      editor.method.update({
        integrationID: PROVIDER_ID,
        method: { type: "key", label: "Gemini API key (Antigravity SDK / Google AI)" },
      })
    })

    let sourceModels: Model.Info[] = []
    let unavailable: ReadonlySet<string> = new Set()
    const published = new Set<string>()
    const discoverModels = async () => {
      let excluded: ReadonlySet<string> = new Set()
      const definitions = await legacy.provider?.models?.({ id: PROVIDER_ID }, {
        auth: await getAuth(), onUnavailable: (ids) => { excluded = ids },
      }) ?? {}
      sourceModels = Object.entries(definitions).map(([id, definition]) => toModel(id, definition))
      unavailable = excluded
    }
    await discoverModels()
    await ctx.provider.transform((editor) => {
      const existing = editor.get(PROVIDER_ID)
      if (!existing) {
        for (const model of sourceModels) if (model.id.startsWith("antigravity-") || gemini4Model(model.id)) published.add(model.id)
        editor.add({
          info: {
            ...Provider.Info.empty(Provider.ID.make(PROVIDER_ID)),
            name: "Google (Antigravity)",
            integrationID: Integration.ID.make(PROVIDER_ID),
            package: GOOGLE_PACKAGE,
            activation: "enabled",
          },
          models: sourceModels,
        })
        return
      }
      editor.update(PROVIDER_ID, (provider) => {
        provider.package = GOOGLE_PACKAGE
        // The transport can also use accounts on disk or configured API keys.
        provider.activation = "enabled"
      })
      const models = new Map(existing.models)
      const current = new Set(sourceModels.map((model) => String(model.id)))
      for (const id of [...published, ...unavailable]) {
        if (!current.has(id)) models.delete(Model.ID.make(id))
      }
      for (const id of published) if (!current.has(id)) published.delete(id)
      for (const model of sourceModels) {
        if (model.id.startsWith("antigravity-")) {
          published.add(model.id)
          const old = models.get(model.id)
          models.set(model.id, old ? { ...old, variants: model.variants } : model)
        } else if (!models.has(model.id) || published.has(model.id)) {
          if (gemini4Model(model.id)) published.add(model.id)
          models.set(model.id, model)
        }
      }
      editor.models.set(PROVIDER_ID, [...models.values()])
    })
    await ctx.model.transform((editor) => {
      for (const model of editor.list(PROVIDER_ID)) {
        editor.update(PROVIDER_ID, String(model.id), (model) => { model.package = GOOGLE_PACKAGE })
      }
    })
    await ctx.aisdk.hook("sdk", async (event) => {
      const loader = await getLoader()
      event.options.apiKey = (isLoader(loader) ? loader.apiKey : event.options.apiKey) || "antigravity-oauth"
      event.options.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
        // V2 may retain this SDK across credential switches. Resolve the loader
        // for each request so its account pool follows the active connection.
        const currentLoader = await getLoader()
        // The shared interceptor reads init.body. Normalize one-shot Request
        // inputs from the SDK without consuming the caller's original body.
        const request = new Request(input, init)
        if (!isLoader(currentLoader)) {
          const auth = await getAuth()
          const requested = gemini4Model(extractRequestedGeminiModel(request.url))
          if (requested && auth.type !== "api" && event.options.apiKey === "antigravity-oauth") {
            return missingGemini4Credential(requested.model)
          }
          if (auth.type === "api" && typeof auth.key === "string") request.headers.set("x-goog-api-key", auth.key)
        }
        const fetchRequest = isLoader(currentLoader) ? currentLoader.fetch : globalThis.fetch
        return fetchRequest(request.url, {
          method: request.method,
          headers: request.headers,
          body: request.body ? await request.text() : undefined,
          signal: request.signal,
        })
      }
      // Built-in SDK initialization runs before external hooks. Recreate the
      // driver with the intercepted fetch, rather than mutating unused options.
      event.sdk = createGoogleGenerativeAI(event.options)
    }, { providerID: PROVIDER_ID })

    if (config.session_recovery) {
      await ctx.session.hook("context", recoverContext, { providerID: PROVIDER_ID })
    }
    await ctx.tool.transform((editor) => {
      for (const [name, definition] of Object.entries(legacy.tool ?? {})) {
        const schema = z.object(definition.args)
        editor.add({
          name,
          description: definition.description,
          input: z.toJSONSchema(schema),
          async execute(input, context) {
            await getLoader()
            return { content: await definition.execute(schema.parse(input), {
              sessionID: context.sessionID,
              messageID: context.messageID,
              agent: context.agent,
              abort: context.signal,
            }) }
          },
        })
      }
    })

    const refreshPool = async () => {
      loaderPromise = undefined
      await discoverModels()
      await ctx.provider.reload()
    }

    interface PendingOAuthAttempt {
      snapshotId: string
      accountId?: string
      expectedState: string
      listener?: OAuthListener
      cancelled: boolean
      inFlight?: Promise<string>
    }

    const snapshots = new Map<string, AccountAdmin>()
    const oauthAttempts = new Map<string, PendingOAuthAttempt>()
    const MAX_SNAPSHOTS = 8
    const MAX_OAUTH_ATTEMPTS = 8

    const requireSnapshot = (snapshotId: string): AccountAdmin => {
      const admin = snapshots.get(snapshotId)
      if (!admin) throw new Error("Account selection is stale; reopen account management.")
      return admin
    }

    const closeOAuthAttempt = async (attemptId: string, cancel = false) => {
      const attempt = oauthAttempts.get(attemptId)
      if (!attempt) return
      if (cancel) attempt.cancelled = true
      oauthAttempts.delete(attemptId)
      await attempt.listener?.close().catch(() => undefined)
      cancelAuthorization(attempt.expectedState)
    }

    const completeOAuthAttempt = async (attemptId: string, code: string, state: string): Promise<string> => {
      const attempt = oauthAttempts.get(attemptId)
      if (!attempt) throw new Error("OAuth sign-in session expired; try again.")
      if (attempt.cancelled) throw new Error("OAuth sign-in was cancelled.")
      if (attempt.inFlight) return attempt.inFlight
      const run = (async () => {
        if (!code || state !== attempt.expectedState) {
          throw new Error("Invalid OAuth callback or state mismatch.")
        }
        const exchanged = await exchangeAntigravity(code, state, attempt.expectedState)
        if (exchanged.type !== "success") {
          throw new Error(exchanged.error || "Google OAuth exchange failed.")
        }
        const parts = parseRefreshParts(exchanged.refresh)
        if (!parts.refreshToken) {
          throw new Error("Google OAuth did not return a refresh token.")
        }
        const payload = {
          refreshToken: parts.refreshToken,
          email: exchanged.email,
          projectId: parts.projectId,
          managedProjectId: parts.managedProjectId,
        }
        const admin = requireSnapshot(attempt.snapshotId)
        let message: string
        if (attempt.accountId) {
          const account = admin.accounts.find((candidate) => candidate.id === attempt.accountId)
          await admin.completeRefresh(attempt.accountId, payload)
          message = `Re-authenticated ${payload.email ?? account?.label ?? "Google account"}.`
        } else {
          message = await admin.saveNewAccount(payload)
        }
        await refreshPool()
        return message
      })()
      attempt.inFlight = run
      try {
        return await run
      } finally {
        await closeOAuthAttempt(attemptId)
      }
    }

    const waitWithSignal = <T>(promise: Promise<T>, signal: AbortSignal): Promise<T | "aborted"> => {
      if (signal.aborted) return Promise.resolve("aborted")
      return new Promise<T | "aborted">((resolve, reject) => {
        const onAbort = () => resolve("aborted")
        signal.addEventListener("abort", onAbort, { once: true })
        promise.then(
          (value) => {
            signal.removeEventListener("abort", onAbort)
            resolve(value)
          },
          (error) => {
            signal.removeEventListener("abort", onAbort)
            reject(error)
          },
        )
      })
    }

    const rpcRegistration = await ctx.rpc?.register(AntigravityAccountsRpc, {
      async snapshot() {
        const admin = await createAccountAdmin(client, PROVIDER_ID)
        const snapshotId = randomUUID()
        if (snapshots.size >= MAX_SNAPSHOTS) {
          const oldest = snapshots.keys().next().value
          if (oldest) snapshots.delete(oldest)
        }
        snapshots.set(snapshotId, admin)
        return {
          snapshotId,
          accounts: admin.accounts.map((account) => ({
            id: account.id,
            label: account.label,
            enabled: account.enabled,
            verificationRequired: account.verificationRequired,
            ...(account.allowedModels ? { allowedModels: [...account.allowedModels] } : {}),
            ...(account.disabledModels ? { disabledModels: [...account.disabledModels] } : {}),
            ...(account.cachedAvailableModels ? { cachedAvailableModels: [...account.cachedAvailableModels] } : {}),
          })),
        }
      },
      async releaseSnapshot({ snapshotId }) {
        return { ok: snapshots.delete(snapshotId) }
      },
      async list({ snapshotId }) {
        return { message: await requireSnapshot(snapshotId).list() }
      },
      async quotas({ snapshotId, ids }) {
        const admin = requireSnapshot(snapshotId)
        return { message: await (ids !== undefined ? admin.quotas(ids) : admin.quotas()) }
      },
      async models({ snapshotId, ids, refresh }) {
        const admin = requireSnapshot(snapshotId)
        return {
          message: await (refresh !== undefined
            ? admin.models(ids, { refresh })
            : ids !== undefined
              ? admin.models(ids)
              : admin.models()),
        }
      },
      async setModelRules({ snapshotId, ids, allow, deny, clear }) {
        const message = await requireSnapshot(snapshotId).setModelRules(ids, { allow, deny, clear })
        await refreshPool()
        return { message }
      },
      async verify({ snapshotId, ids }) {
        const admin = requireSnapshot(snapshotId)
        const message = await (ids !== undefined ? admin.verify(ids) : admin.verify())
        await refreshPool()
        return { message }
      },
      async setEnabled({ snapshotId, ids, enabled }) {
        const message = await requireSnapshot(snapshotId).setEnabled(ids, enabled)
        await refreshPool()
        return { message }
      },
      async remove({ snapshotId, ids, confirm }) {
        const message = await requireSnapshot(snapshotId).remove(ids, confirm)
        await refreshPool()
        return { message }
      },
      async removeAll({ snapshotId, confirm }) {
        const message = await requireSnapshot(snapshotId).removeAll(confirm)
        await refreshPool()
        return { message }
      },
      async configureModels({ snapshotId }) {
        return { message: await requireSnapshot(snapshotId).configureModels() }
      },
      async oauthStart({ snapshotId, mode, accountId }) {
        const admin = requireSnapshot(snapshotId)
        if (accountId && !admin.accounts.some((account) => account.id === accountId)) {
          throw new Error("Account selection is stale; reopen account management.")
        }
        const authorization = await authorizeAntigravity()
        const expectedState = new URL(authorization.url).searchParams.get("state") ?? ""
        if (!expectedState) throw new Error("Failed to initialize OAuth state.")
        let listener: OAuthListener | undefined
        if (mode === "auto") {
          try {
            listener = await startOAuthListener({ timeoutMs: 2 * 60 * 1000 })
          } catch {
            listener = undefined
          }
        }
        if (oauthAttempts.size >= MAX_OAUTH_ATTEMPTS) {
          const oldest = oauthAttempts.keys().next().value
          if (oldest) await closeOAuthAttempt(oldest, true)
        }
        const attemptId = randomUUID()
        oauthAttempts.set(attemptId, {
          snapshotId,
          accountId,
          expectedState,
          listener,
          cancelled: false,
        })
        return {
          attemptId,
          url: authorization.url,
          listening: Boolean(listener),
        }
      },
      async oauthWait({ attemptId }, context) {
        const attempt = oauthAttempts.get(attemptId)
        if (!attempt || attempt.cancelled) return { status: "cancelled" as const }
        if (attempt.inFlight) return { status: "completed" as const, message: await attempt.inFlight }
        if (!attempt.listener) return { status: "listener-failed" as const }
        try {
          const callbackUrl = await waitWithSignal(attempt.listener.waitForCallback(), context.signal)
          if (callbackUrl === "aborted") return { status: "cancelled" as const }
          if (attempt.cancelled) return { status: "cancelled" as const }
          if (attempt.inFlight) return { status: "completed" as const, message: await attempt.inFlight }
          const code = callbackUrl.searchParams.get("code") ?? ""
          const state = callbackUrl.searchParams.get("state") ?? ""
          const message = await completeOAuthAttempt(attemptId, code, state)
          return { status: "completed" as const, message }
        } catch {
          if (attempt.cancelled) return { status: "cancelled" as const }
          if (attempt.inFlight) return { status: "completed" as const, message: await attempt.inFlight }
          return { status: "listener-failed" as const }
        }
      },
      async oauthComplete({ attemptId, rawCallback }) {
        const attempt = oauthAttempts.get(attemptId)
        if (!attempt) throw new Error("OAuth sign-in session expired; try again.")
        if (attempt.inFlight) return { message: await attempt.inFlight }
        const parsed = parseCallbackInput(rawCallback, attempt.expectedState)
        if (!parsed) throw new Error("Invalid OAuth redirect URL or code.")
        const message = await completeOAuthAttempt(attemptId, parsed.code, parsed.state)
        return { message }
      },
      async oauthCancel({ attemptId }) {
        const existed = oauthAttempts.has(attemptId)
        await closeOAuthAttempt(attemptId, true)
        return { ok: existed }
      },
    })

    const events = (async () => {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        try {
          if (event.type === "session.created") {
            await legacy.event?.({ event: { type: event.type, properties: { info: {
              id: event.data.sessionID,
              parentID: event.data.parentID,
            } } } })
          } else if (event.type === "credential.updated" || event.type === "credential.switched") {
            await refreshPool()
          }
        } catch (error: unknown) {
          if (!controller.signal.aborted) log.warn("Event handling failed", { type: event.type, error: String(error) })
        }
      }
    })().catch((error: unknown) => {
      if (!controller.signal.aborted) log.warn("Event subscription failed", { error: String(error) })
    })
    return async () => {
      controller.abort()
      await rpcRegistration?.dispose()
      await Promise.all([...oauthAttempts.keys()].map((attemptId) => closeOAuthAttempt(attemptId, true)))
      snapshots.clear()
      legacy.dispose?.()
      await events
    }
  },
})
