import { exec } from "node:child_process"
import { Plugin } from "@opencode/plugin/tui"
import { authorizeAntigravity, cancelAuthorization, exchangeAntigravity } from "./antigravity/oauth.ts"
import { createAccountAdmin } from "./plugin/account-admin.ts"
import type { AccountAdmin, AccountView, RefreshAccount } from "./plugin/account-admin.ts"
import { parseRefreshParts } from "./plugin/auth.ts"
import { OPENCODE_MODEL_DEFINITIONS } from "./plugin/config/models.ts"
import { normalizeModelKey } from "./plugin/model-availability.ts"
import { startOAuthListener } from "./plugin/server.ts"
import type { PluginClient } from "./plugin/types.ts"

type Dialog = Plugin.Context["ui"]["dialog"]
type Action = "list" | "quotas" | "model-access" | "verify" | "enable" | "disable" | "remove" | "remove-all" | "models" | "add" | "refresh" | "close"
type ModelAccessAction = "view" | "refresh" | "toggle-deny" | "toggle-allow" | "clear" | "back"
type OAuthMode = "auto" | "manual" | "back"
type Selection = { kind: "account"; id: string } | { kind: "all" } | { kind: "back" }

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

function parseCallbackInput(raw: string, expectedState: string): { code: string; state: string } | null {
  const trimmed = raw.trim()
  if (!trimmed) return null
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
    try {
      const parsed = new URL(trimmed)
      const code = parsed.searchParams.get("code") ?? ""
      const state = parsed.searchParams.get("state") ?? ""
      return code && state ? { code, state } : null
    } catch {
      return null
    }
  }
  return { code: trimmed, state: expectedState }
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
      throw new Error("Google did not return a refresh token.")
    }

    return {
      refreshToken: parts.refreshToken,
      email: exchanged.email,
      projectId: parts.projectId,
      managedProjectId: parts.managedProjectId,
    }
  } finally {
    cancelAuthorization(expectedState)
    await listener?.close().catch(() => undefined)
  }
}

function accountStatus(account: AccountView): string {
  const parts = [account.enabled ? "Enabled" : "Disabled"]
  if (account.verificationRequired) parts.push("Google verification required")
  if (account.allowedModels?.length) parts.push(`Allow: ${account.allowedModels.length}`)
  if (account.disabledModels?.length) parts.push(`Deny: ${account.disabledModels.length}`)
  return parts.join(" · ")
}

function knownModelsForAccount(account: AccountView): string[] {
  const set = new Set<string>()
  for (const id of Object.keys(OPENCODE_MODEL_DEFINITIONS)) {
    const normalized = normalizeModelKey(id)
    if (normalized) set.add(normalized)
  }
  for (const list of [account.cachedAvailableModels, account.allowedModels, account.disabledModels]) {
    for (const id of list ?? []) {
      if (id) set.add(id)
    }
  }
  return [...set].sort()
}

async function chooseAccounts(dialog: Dialog, admin: AccountAdmin, title: string, single = false): Promise<readonly string[] | undefined> {
  const selection = await dialog.select<Selection>({
    title,
    placeholder: "Search accounts",
    options: [
      ...(!single && admin.accounts.length > 1 ? [{ title: `All ${admin.accounts.length} accounts`, value: { kind: "all" } as const, category: "Selection" }] : []),
      ...admin.accounts.map((account) => ({
        title: account.label,
        value: { kind: "account", id: account.id } as const,
        description: accountStatus(account),
        category: "Google accounts",
      })),
      { title: "Back", value: { kind: "back" }, category: "Navigation" },
    ],
  })
  if (!selection || selection.kind === "back") return undefined
  return selection.kind === "all" ? admin.accounts.map((account) => account.id) : [selection.id]
}

async function showResult(dialog: Dialog, title: string, result: string): Promise<void> {
  let settled = false
  const pending = dialog.alert({ title, message: result }).finally(() => { settled = true })
  dialog.set?.({ centered: true })
  queueMicrotask(() => {
    if (!settled) dialog.set?.({ centered: true })
  })
  await pending
}

async function showScrollableDetails(
  dialog: Dialog,
  title: string,
  placeholder: string,
  options: readonly { title: string; description?: string; category?: string; value: string; disabled?: boolean }[],
): Promise<void> {
  let settled = false
  const pending = dialog.select<string>({
    title,
    placeholder,
    options: [
      ...options,
      { title: "Back", value: "__back__", category: "Navigation" },
    ],
  }).finally(() => { settled = true })
  dialog.set?.({ centered: true, size: "large" })
  queueMicrotask(() => {
    if (!settled) dialog.set?.({ centered: true, size: "large" })
  })
  await pending
}

const SUBGROUP_QUOTA_REGEX = /^([^(:;\n]+?)\s+\((5h|weekly)\):\s+(.+)$/

function parseQuotaOptions(result: string): Array<{ title: string; description?: string; category?: string; value: string; disabled?: boolean }> {
  const options: Array<{ title: string; description?: string; category?: string; value: string; disabled?: boolean }> = []
  let rowIndex = 0
  for (const line of result.split("\n").filter(Boolean)) {
    const separator = line.indexOf(": ")
    if (separator === -1) {
      options.push({ title: line, value: `row-${rowIndex++}` })
      continue
    }
    const accountLabel = line.slice(0, separator)
    const details = line.slice(separator + 2).split(/; |, (?=[^,;\n]+: )/g)

    // Group consecutive `(5h)` / `(weekly)` entries under their parent group (`gemini:` / `claude:`)
    // so each window renders indented with tree connectors.
    let i = 0
    while (i < details.length) {
      const detail = details[i]!
      const subgroup = SUBGROUP_QUOTA_REGEX.exec(detail)
      if (subgroup) {
        const groupName = subgroup[1]!
        const windows: Array<{ windowName: string; value: string }> = []
        while (i < details.length) {
          const next = SUBGROUP_QUOTA_REGEX.exec(details[i]!)
          if (!next || next[1] !== groupName) break
          windows.push({ windowName: next[2]!, value: next[3]! })
          i++
        }
        options.push({
          title: `${groupName}:`,
          category: accountLabel,
          value: `group-${rowIndex++}`,
        })
        windows.forEach((win, idx) => {
          const connector = idx === windows.length - 1 ? "└─" : "├─"
          options.push({
            title: `  ${connector} ${win.windowName}`,
            description: win.value,
            category: accountLabel,
            value: `row-${rowIndex++}`,
          })
        })
        continue
      }

      const colonIndex = detail.indexOf(": ")
      if (colonIndex !== -1) {
        options.push({
          title: detail.slice(0, colonIndex),
          description: detail.slice(colonIndex + 2),
          category: accountLabel,
          value: `row-${rowIndex++}`,
        })
      } else {
        options.push({
          title: detail,
          category: accountLabel,
          value: `row-${rowIndex++}`,
        })
      }
      i++
    }
  }
  return options
}

function parseModelsOptions(result: string): Array<{ title: string; description?: string; category?: string; value: string }> {
  const options: Array<{ title: string; description?: string; category?: string; value: string }> = []
  let rowIndex = 0
  for (const line of result.split("\n").filter(Boolean)) {
    const separator = line.indexOf(": ")
    if (separator === -1) {
      options.push({ title: line, value: `model-row-${rowIndex++}` })
      continue
    }
    const accountLabel = line.slice(0, separator)
    for (const detail of line.slice(separator + 2).split("; ")) {
      const colonIndex = detail.indexOf(": ")
      if (colonIndex !== -1) {
        options.push({
          title: detail.slice(0, colonIndex),
          description: detail.slice(colonIndex + 2),
          category: accountLabel,
          value: `model-row-${rowIndex++}`,
        })
      } else {
        options.push({
          title: detail,
          category: accountLabel,
          value: `model-row-${rowIndex++}`,
        })
      }
    }
  }
  return options
}

function formatVerification(result: string): string {
  return result.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(": ")
    if (separator === -1) return line
    return `${line.slice(0, separator + 1)}\n  ${line.slice(separator + 2)}`
  }).join("\n\n")
}

/** Native dialogs only; account IDs remain opaque and are never displayed. */
export async function openAccountMenu(
  ui: Pick<Plugin.Context["ui"], "dialog" | "toast">,
  createAdmin: () => Promise<AccountAdmin>,
  runOAuth: OAuthFlowRunner = runInteractiveOAuth,
): Promise<void> {
  const { dialog, toast } = ui
  while (true) {
    let action: Action | undefined
    try {
      // Reload before every menu: all mutations (including verification) can change IDs/state.
      const admin = await createAdmin()
      const empty = admin.accounts.length === 0
      action = await dialog.select<Action>({
        title: `Antigravity accounts · ${admin.accounts.length} saved`,
        placeholder: "Choose an action",
        options: [
          { title: "List accounts", value: "list", description: "Saved accounts and rotation status", category: "Accounts" },
          { title: "Check live quotas", value: "quotas", description: "View quotas for all saved accounts", disabled: empty, category: "Accounts" },
          { title: "Check Google verification", value: "verify", description: "Send a small test request; update verification status", disabled: empty, category: "Accounts" },
          { title: "Enable accounts", value: "enable", description: "Include in automatic rotation", disabled: empty, category: "Rotation" },
          { title: "Disable accounts", value: "disable", description: "Keep saved, exclude from rotation", disabled: empty, category: "Rotation" },
          { title: "Model access & rules", value: "model-access", description: "View per-account available models and allow/deny rules", disabled: empty, category: "Rotation" },
          { title: "Add a Google account", value: "add", description: "Sign in with Google OAuth and add to pool", category: "Setup" },
          { title: "Refresh account sign-in", value: "refresh", description: "Re-authenticate a saved account with Google OAuth", disabled: empty, category: "Setup" },
          { title: "Configure models", value: "models", description: "Update the local OpenCode model configuration", category: "Setup" },
          { title: "Remove accounts…", value: "remove", description: "Choose one or all; confirmation required", disabled: empty, category: "Removal" },
          { title: "Remove all accounts…", value: "remove-all", description: "Forget every saved Google account", disabled: empty, category: "Removal" },
          { title: "Close", value: "close", category: "Navigation" },
        ],
      })
      if (!action || action === "close") return
      if (action === "list") {
        await showResult(dialog, "Saved Google accounts", await admin.list())
        continue
      }
      if (action === "quotas") {
        toast.show({ title: "Antigravity accounts", message: "Fetching live quotas…", variant: "info" })
        await showScrollableDetails(
          dialog,
          "Live quotas · All accounts",
          "Scroll or filter by account, group, or window (Esc to go back)",
          parseQuotaOptions(await admin.quotas()),
        )
        continue
      }
      if (action === "model-access") {
        const subAction = await dialog.select<ModelAccessAction>({
          title: "Model access & rotation rules",
          placeholder: "Choose an action",
          options: [
            { title: "View per-account models", value: "view", description: "Show cached available models and allow/deny rules", category: "Inspect" },
            { title: "Refresh live available models", value: "refresh", description: "Fetch available models for all accounts and update cache", category: "Inspect" },
            { title: "Toggle denied model on account", value: "toggle-deny", description: "Exclude or re-include a specific model on one account", category: "Rules" },
            { title: "Toggle allowed model on account", value: "toggle-allow", description: "Restrict an account to specific allowed models", category: "Rules" },
            { title: "Clear manual model rules", value: "clear", description: "Reset allow/deny rules to automatic detection", category: "Rules" },
            { title: "Back", value: "back", category: "Navigation" },
          ],
        })
        if (!subAction || subAction === "back") continue
        if (subAction === "view") {
          await showScrollableDetails(
            dialog,
            "Model access · All accounts",
            "Scroll or filter by account or model (Esc to go back)",
            parseModelsOptions(await admin.models()),
          )
          continue
        }
        if (subAction === "refresh") {
          toast.show({ title: "Antigravity accounts", message: "Refreshing available models…", variant: "info" })
          await showScrollableDetails(
            dialog,
            "Live models · All accounts",
            "Scroll or filter by account or model (Esc to go back)",
            parseModelsOptions(await admin.models(undefined, { refresh: true })),
          )
          continue
        }
        if (subAction === "clear") {
          const targetIds = await chooseAccounts(dialog, admin, "Clear model rules for", false)
          if (!targetIds?.length) continue
          await showResult(dialog, "Model rules updated", await admin.setModelRules(targetIds, { clear: true }))
          continue
        }
        const singleIds = await chooseAccounts(dialog, admin, subAction === "toggle-deny" ? "Choose account (deny list)" : "Choose account (allow list)", true)
        if (!singleIds?.length) continue
        const selectedAccount = admin.accounts.find((candidate) => candidate.id === singleIds[0])
        if (!selectedAccount) continue
        const currentList = subAction === "toggle-deny"
          ? [...(selectedAccount.disabledModels ?? [])]
          : [...(selectedAccount.allowedModels ?? [])]
        const currentSet = new Set(currentList)
        const modelChoice = await dialog.select<string>({
          title: `${selectedAccount.label} · ${subAction === "toggle-deny" ? "Deny list" : "Allow list"}`,
          placeholder: "Select a model to toggle",
          options: [
            ...knownModelsForAccount(selectedAccount).map((modelId) => ({
              title: `${currentSet.has(modelId) ? "[x]" : "[ ]"} ${modelId}`,
              value: modelId,
              description: currentSet.has(modelId)
                ? (subAction === "toggle-deny" ? "Currently denied (select to remove)" : "Currently allowed (select to remove)")
                : (subAction === "toggle-deny" ? "Select to deny on this account" : "Select to allow on this account"),
              category: "Models",
            })),
            { title: "Back", value: "__back__", category: "Navigation" },
          ],
        })
        if (!modelChoice || modelChoice === "__back__") continue
        if (currentSet.has(modelChoice)) currentSet.delete(modelChoice)
        else currentSet.add(modelChoice)
        const nextList = [...currentSet].sort()
        await showResult(
          dialog,
          "Model rules updated",
          await admin.setModelRules(
            [selectedAccount.id],
            subAction === "toggle-deny" ? { deny: nextList } : { allow: nextList },
          ),
        )
        continue
      }
      if (action === "verify") {
        toast.show({ title: "Antigravity accounts", message: "Checking Google verification…", variant: "info" })
        await showResult(dialog, "Google verification · All accounts", formatVerification(await admin.verify()))
        continue
      }
      if (action === "add") {
        const account = await runOAuth(ui, "Add a Google account")
        if (!account) continue
        await showResult(dialog, "Account added", await admin.saveNewAccount(account))
        continue
      }
      if (action === "models") {
        if (await dialog.confirm({ title: "Replace Google models?", message: "Replace provider.google.models in the local OpenCode configuration with Antigravity models? Existing plugins and other settings will be preserved. V2 normally registers models automatically.", label: { confirm: "Replace models", cancel: "Back" } })) {
          await showResult(dialog, "Model configuration", await admin.configureModels())
        }
        continue
      }
      if (action === "remove-all") {
        if (await dialog.confirm({
          title: "Remove all Google accounts?",
          message: `Remove all ${admin.accounts.length} saved account(s):\n${admin.accounts.map((account) => account.label).join("\n")}\n\nThis cannot be undone. You will need to sign in again.`,
          label: { confirm: "Remove all", cancel: "Keep accounts" },
        })) await showResult(dialog, "Accounts removed", await admin.removeAll(true))
        continue
      }
      const titles = { enable: "Enable accounts", disable: "Disable accounts", remove: "Remove accounts", refresh: "Refresh sign-in for" }
      const ids = await chooseAccounts(dialog, admin, titles[action], action === "refresh")
      if (!ids?.length) continue
      if (action === "refresh") {
        const account = admin.accounts.find((candidate) => candidate.id === ids[0])
        const replacement = await runOAuth(ui, `Refresh sign-in · ${account?.label ?? "Google account"}`)
        if (!replacement) continue
        await admin.completeRefresh(ids[0]!, replacement)
        await showResult(dialog, "Sign-in refreshed", `Re-authenticated ${replacement.email ?? account?.label ?? "Google account"}.`)
        continue
      }
      if (action === "remove") {
        const labels = admin.accounts.filter((account) => ids.includes(account.id)).map((account) => account.label)
        if (await dialog.confirm({
          title: `Remove ${ids.length} Google account(s)?`,
          message: `${labels.join("\n")}\n\nThis cannot be undone. Removed accounts will no longer be used for rotation.`,
          label: { confirm: "Remove", cancel: "Keep accounts" },
        })) await showResult(dialog, "Accounts removed", await admin.remove(ids, true))
        continue
      }
      toast.show({ title: "Antigravity accounts", message: "Updating rotation…", variant: "info" })
      await showResult(dialog, "Account rotation", await admin.setEnabled(ids, action === "enable"))
    } catch {
      // Never expose exception payloads: network errors can contain credentials.
      await dialog.alert({ title: "Account action failed", message: "Could not complete the account action. Account selection may have changed, or Google may be unavailable. Reopen the menu and try again. No credentials are shown here." })
      if (!action) return
    }
  }
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
