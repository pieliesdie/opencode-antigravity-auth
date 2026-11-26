import { exec } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"
import { authorizeAntigravity, cancelAuthorization, exchangeAntigravity } from "./antigravity/oauth.ts"
import { openAccountMenuWithUI, parseCallbackInput } from "./account-menu.ts"
import type { AccountMenuBackend, AccountMenuUI } from "./account-menu.ts"
import { createAccountAdmin } from "./plugin/account-admin.ts"
import type { AccountAdmin, RefreshAccount } from "./plugin/account-admin.ts"
import { parseRefreshParts } from "./plugin/auth.ts"
import { startOAuthListener } from "./plugin/server.ts"
import type { PluginClient } from "./plugin/types.ts"

type Dialog = Plugin.Context["ui"]["dialog"]
type OAuthMode = "auto" | "manual" | "back"

export type OAuthFlowRunner = (
  ui: Pick<Plugin.Context["ui"], "dialog" | "toast">,
  title: string,
) => Promise<RefreshAccount | undefined>

function openSystemBrowser(url: string): boolean {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`)
      return true
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`)
      return true
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false
    }
    exec(`xdg-open "${url}"`)
    return true
  } catch {
    return false
  }
}

async function runInteractiveOAuth(
  ui: Pick<Plugin.Context["ui"], "dialog" | "toast">,
  title: string,
): Promise<RefreshAccount | undefined> {
  const { dialog, toast } = ui
  const mode = await dialog.select<OAuthMode>({
    title,
    placeholder: "Choose sign-in method",
    options: [
      {
        title: "Sign in with browser (automatic)",
        value: "auto",
        description: "Opens Google sign-in and captures localhost redirect automatically",
        category: "Google OAuth",
      },
      {
        title: "Manual sign-in (paste redirect URL or code)",
        value: "manual",
        description: "Show OAuth URL to open in any browser/profile and paste the callback",
        category: "Google OAuth",
      },
      { title: "Back", value: "back", category: "Navigation" },
    ],
  })
  if (!mode || mode === "back") return undefined

  const authorization = await authorizeAntigravity()
  const expectedState = new URL(authorization.url).searchParams.get("state") ?? ""
  if (!expectedState) throw new Error("Failed to initialize OAuth state.")

  let listener: Awaited<ReturnType<typeof startOAuthListener>> | undefined
  try {
    let code = ""
    let state = ""

    if (mode === "auto") {
      try {
        listener = await startOAuthListener({ timeoutMs: 2 * 60 * 1000 })
      } catch {
        listener = undefined
      }
      const opened = openSystemBrowser(authorization.url)
      if (opened) {
        toast.show({
          title,
          message: "Opened Google sign-in in your browser…",
          variant: "info",
        })
      }

      if (listener) {
        type RaceOutcome =
          | { source: "callback"; url: URL }
          | { source: "prompt"; value: string | undefined }
          | { source: "callback-error" }

        const callbackRace: Promise<RaceOutcome> = listener
          .waitForCallback()
          .then((url): RaceOutcome => ({ source: "callback", url }))
          .catch((): RaceOutcome => ({ source: "callback-error" }))

        const promptPromise = dialog.prompt({
          title,
          description: `${opened ? "Complete sign-in in your browser — this dialog closes automatically." : "Open the URL below in your browser."} You can also paste the redirect URL here (Esc to cancel):\n\n${authorization.url}`,
          placeholder: "Waiting for browser callback (or paste redirect URL)…",
        })
        dialog.set?.({ centered: true, size: "large" })

        const promptRace: Promise<RaceOutcome> = promptPromise.then(
          (value): RaceOutcome => ({ source: "prompt", value }),
        )

        const winner = await Promise.race([callbackRace, promptRace])
        if (winner.source === "callback") {
          dialog.clear?.()
          code = winner.url.searchParams.get("code") ?? ""
          state = winner.url.searchParams.get("state") ?? ""
        } else if (winner.source === "prompt") {
          if (winner.value === undefined) return undefined
          const parsed = parseCallbackInput(winner.value, expectedState)
          if (!parsed) throw new Error("Invalid OAuth redirect URL or code.")
          code = parsed.code
          state = parsed.state
        } else {
          const manualValue = await promptRace
          if (manualValue.source !== "prompt" || manualValue.value === undefined) return undefined
          const parsed = parseCallbackInput(manualValue.value, expectedState)
          if (!parsed) throw new Error("Invalid OAuth redirect URL or code.")
          code = parsed.code
          state = parsed.state
        }
      } else {
        const manualValue = await dialog.prompt({
          title,
          description: `Open this URL in your browser, complete sign-in, and paste the redirect URL (or code) below:\n\n${authorization.url}`,
          placeholder: "http://localhost:51121/oauth-callback?code=…",
        })
        if (manualValue === undefined) return undefined
        const parsed = parseCallbackInput(manualValue, expectedState)
        if (!parsed) throw new Error("Invalid OAuth redirect URL or code.")
        code = parsed.code
        state = parsed.state
      }
    } else {
      const promptPromise = dialog.prompt({
        title,
        description: `Open this URL in your browser (or Incognito profile), complete Google sign-in, and paste the redirect URL or code below:\n\n${authorization.url}`,
        placeholder: "http://localhost:51121/oauth-callback?code=…",
      })
      dialog.set?.({ centered: true, size: "large" })
      const manualValue = await promptPromise
      if (manualValue === undefined) return undefined
      const parsed = parseCallbackInput(manualValue, expectedState)
      if (!parsed) throw new Error("Invalid OAuth redirect URL or code.")
      code = parsed.code
      state = parsed.state
    }

    if (!code || state !== expectedState) {
      throw new Error("Invalid OAuth callback or state mismatch.")
    }

    toast.show({ title, message: "Completing Google sign-in…", variant: "info" })
    const exchanged = await exchangeAntigravity(code, state, expectedState)
    if (exchanged.type !== "success") {
      throw new Error(exchanged.error || "Google OAuth exchange failed.")
    }
    const parts = parseRefreshParts(exchanged.refresh)
    if (!parts.refreshToken) {
      throw new Error("Google OAuth did not return a refresh token.")
    }
    return {
      refreshToken: parts.refreshToken,
      email: exchanged.email,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    }
  } finally {
    await listener?.close().catch(() => undefined)
    cancelAuthorization(expectedState)
  }
}

function createTuiMenuUI(ui: Pick<Plugin.Context["ui"], "dialog" | "toast">): AccountMenuUI {
  const { dialog, toast } = ui
  return {
    async select(options) {
      let settled = false
      const pending = dialog.select({
        title: options.title,
        placeholder: options.placeholder,
        options: options.options.map((option) => ({ ...option })),
      }).finally(() => { settled = true })
      if (options.large) {
        dialog.set?.({ centered: true, size: "large" })
        queueMicrotask(() => {
          if (!settled) dialog.set?.({ centered: true, size: "large" })
        })
      }
      return pending
    },
    async confirm(options) {
      return Boolean(await dialog.confirm({
        title: options.title,
        message: options.message,
        label: { confirm: options.confirm, cancel: options.cancel },
      }))
    },
    async alert(options) {
      let settled = false
      const pending = dialog.alert({ title: options.title, message: options.message }).finally(() => { settled = true })
      dialog.set?.({ centered: true })
      queueMicrotask(() => {
        if (!settled) dialog.set?.({ centered: true })
      })
      await pending
    },
    toast(message) {
      toast.show({ title: "Antigravity accounts", message, variant: "info" })
    },
  }
}

function createTuiBackend(
  admin: AccountAdmin,
  ui: Pick<Plugin.Context["ui"], "dialog" | "toast">,
  runOAuth: OAuthFlowRunner,
): AccountMenuBackend {
  return {
    accounts: admin.accounts,
    list: () => admin.list(),
    quotas: (ids) => (ids !== undefined ? admin.quotas(ids) : admin.quotas()),
    models: (ids, options) => (
      options !== undefined ? admin.models(ids, options) : ids !== undefined ? admin.models(ids) : admin.models()
    ),
    setModelRules: (ids, rules) => admin.setModelRules(ids, rules),
    verify: (ids) => (ids !== undefined ? admin.verify(ids) : admin.verify()),
    setEnabled: (ids, enabled) => admin.setEnabled(ids, enabled),
    remove: (ids, confirm) => admin.remove(ids, confirm),
    removeAll: (confirm) => admin.removeAll(confirm),
    configureModels: () => admin.configureModels(),
    async addAccountWithOAuth() {
      const account = await runOAuth(ui, "Add a Google account")
      if (!account) return undefined
      return admin.saveNewAccount(account)
    },
    async refreshAccountWithOAuth(account) {
      const replacement = await runOAuth(ui, `Refresh sign-in · ${account.label}`)
      if (!replacement) return undefined
      await admin.completeRefresh(account.id, replacement)
      return `Re-authenticated ${replacement.email ?? account.label}.`
    },
  }
}

/** Native dialogs only; account IDs remain opaque and are never displayed. */
export async function openAccountMenu(
  ui: Pick<Plugin.Context["ui"], "dialog" | "toast">,
  createAdmin: () => Promise<AccountAdmin>,
  runOAuth: OAuthFlowRunner = runInteractiveOAuth,
): Promise<void> {
  await openAccountMenuWithUI(
    createTuiMenuUI(ui),
    async () => createTuiBackend(await createAdmin(), ui, runOAuth),
  )
}

function legacyClient(): PluginClient {
  // AccountAdmin's quota/verification paths do not call legacy client methods.
  // Fail closed if future backend changes attempt V1 auth or session operations.
  const unsupported = async (): Promise<never> => { throw new Error("Legacy server operation is unavailable in the V2 account menu.") }
  return {
    app: { log: unsupported },
    tui: { showToast: unsupported },
    auth: { set: unsupported },
    session: { prompt: unsupported, abort: unsupported, messages: unsupported },
  }
}

export default Plugin.define({
  id: "antigravity.accounts.tui",
  setup(context) {
    let active = false
    context.keymap.layer(() => ({
      mode: "global",
      commands: [{
        id: "antigravity.accounts",
        title: "Manage Antigravity accounts",
        description: "Quotas, verification, rotation and Google sign-in help",
        group: "Antigravity",
        palette: true,
        slash: { name: "antigravity-accounts" },
        async run() {
          if (active) return
          active = true
          try {
            await openAccountMenu(context.ui, () => createAccountAdmin(legacyClient()))
          } finally {
            active = false
          }
        },
      }],
    }))
  },
})
