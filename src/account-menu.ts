import type { AccountModelRulesUpdate, AccountView } from "./plugin/account-admin.ts"
import { OPENCODE_MODEL_DEFINITIONS } from "./plugin/config/models.ts"
import { normalizeModelKey } from "./plugin/model-availability.ts"

export type AccountMenuAction =
  | "list"
  | "quotas"
  | "model-access"
  | "verify"
  | "enable"
  | "disable"
  | "remove"
  | "remove-all"
  | "models"
  | "add"
  | "refresh"
  | "close"

type ModelAccessAction = "view" | "refresh" | "toggle-deny" | "toggle-allow" | "clear" | "back"
type Selection = { kind: "account"; id: string } | { kind: "all" } | { kind: "back" }

export interface MenuSelectOption<T> {
  readonly title: string
  readonly value: T
  readonly description?: string
  readonly category?: string
  readonly disabled?: boolean
}

export interface AccountMenuUI {
  select<T>(options: {
    readonly title: string
    readonly placeholder?: string
    readonly options: readonly MenuSelectOption<T>[]
    readonly large?: boolean
  }): Promise<T | undefined>
  selectMultiple?(options: {
    readonly title: string
    readonly description?: string
    readonly placeholder?: string
    readonly items: readonly { readonly id: string; readonly selected: boolean }[]
    readonly confirmLabel?: string
  }): Promise<readonly string[] | undefined>
  confirm(options: {
    readonly title: string
    readonly message: string
    readonly confirm: string
    readonly cancel: string
    readonly danger?: boolean
  }): Promise<boolean>
  alert(options: {
    readonly title: string
    readonly message: string
  }): Promise<void>
  toast(message: string): void
}

export interface AccountMenuBackend {
  readonly accounts: readonly AccountView[]
  list(): Promise<string>
  quotas(ids?: readonly string[]): Promise<string>
  models(ids?: readonly string[], options?: { refresh?: boolean }): Promise<string>
  setModelRules(ids: readonly string[], rules: AccountModelRulesUpdate): Promise<string>
  verify(ids?: readonly string[]): Promise<string>
  setEnabled(ids: readonly string[], enabled: boolean): Promise<string>
  remove(ids: readonly string[], confirm: boolean): Promise<string>
  removeAll(confirm: boolean): Promise<string>
  configureModels(): Promise<string>
  addAccountWithOAuth(): Promise<string | undefined>
  refreshAccountWithOAuth(account: AccountView): Promise<string | undefined>
  dispose?(): Promise<void> | void
}

export function parseCallbackInput(raw: string, expectedState: string): { code: string; state: string } | null {
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

function accountStatus(account: AccountView): string {
  const parts: string[] = [account.enabled ? "enabled" : "disabled"]
  if (account.verificationRequired) parts.push("verification required")
  if (account.allowedModels?.length) parts.push(`allow: ${account.allowedModels.length}`)
  if (account.disabledModels?.length) parts.push(`deny: ${account.disabledModels.length}`)
  return parts.join(", ")
}

export function knownModelsForAccount(account: AccountView): string[] {
  const seen = new Set<string>()
  const add = (id: string) => {
    const normalized = normalizeModelKey(id)
    if (normalized) seen.add(normalized)
  }
  for (const id of account.cachedAvailableModels ?? []) add(id)
  for (const id of Object.keys(OPENCODE_MODEL_DEFINITIONS)) add(id)
  for (const id of account.allowedModels ?? []) add(id)
  for (const id of account.disabledModels ?? []) add(id)
  return [...seen].sort()
}

async function chooseAccounts(
  ui: AccountMenuUI,
  accounts: readonly AccountView[],
  title: string,
  single = false,
): Promise<readonly string[] | undefined> {
  const selection = await ui.select<Selection>({
    title,
    placeholder: single ? "Choose an account" : "Choose one account or all accounts",
    options: [
      ...(single
        ? []
        : [{
            title: "All accounts",
            description: `${accounts.length} saved account(s)`,
            value: { kind: "all" as const },
            category: "Batch",
          }]),
      ...accounts.map((account) => ({
        title: account.label,
        description: accountStatus(account),
        value: { kind: "account" as const, id: account.id },
        category: "Accounts",
      })),
      { title: "Back", value: { kind: "back" as const }, category: "Navigation" },
    ],
  })
  if (!selection || selection.kind === "back") return undefined
  return selection.kind === "all" ? accounts.map((account) => account.id) : [selection.id]
}

async function showScrollableDetails(
  ui: AccountMenuUI,
  title: string,
  placeholder: string,
  options: readonly MenuSelectOption<string>[],
): Promise<void> {
  await ui.select<string>({
    title,
    placeholder,
    large: true,
    options: [
      ...options,
      { title: "Back", value: "__back__", category: "Navigation" },
    ],
  })
}

const SUBGROUP_QUOTA_REGEX = /^([^(:;\n]+?)\s+\((5h|weekly)\):\s+(.+)$/

export function parseQuotaOptions(result: string): Array<MenuSelectOption<string>> {
  const options: Array<MenuSelectOption<string>> = []
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

export function parseModelsOptions(result: string): Array<MenuSelectOption<string>> {
  const options: Array<MenuSelectOption<string>> = []
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

export function formatVerification(result: string): string {
  return result.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(": ")
    if (separator === -1) return line
    return `${line.slice(0, separator + 1)}\n  ${line.slice(separator + 2)}`
  }).join("\n\n")
}

/** Shared interactive menu flow; account IDs remain opaque and are never displayed. */
export async function openAccountMenuWithUI(
  ui: AccountMenuUI,
  createBackend: () => Promise<AccountMenuBackend>,
): Promise<void> {
  while (true) {
    let action: AccountMenuAction | undefined
    let backend: AccountMenuBackend | undefined
    try {
      // Reload before every menu: all mutations (including verification) can change IDs/state.
      backend = await createBackend()
      const empty = backend.accounts.length === 0
      action = await ui.select<AccountMenuAction>({
        title: `Antigravity accounts · ${backend.accounts.length} saved`,
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
        await ui.alert({ title: "Saved Google accounts", message: await backend.list() })
        continue
      }
      if (action === "quotas") {
        ui.toast("Fetching live quotas…")
        await showScrollableDetails(
          ui,
          "Live quotas · All accounts",
          "Scroll or filter by account, group, or window (Esc to go back)",
          parseQuotaOptions(await backend.quotas()),
        )
        continue
      }
      if (action === "model-access") {
        const subAction = await ui.select<ModelAccessAction>({
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
            ui,
            "Model access · All accounts",
            "Scroll or filter by account or model (Esc to go back)",
            parseModelsOptions(await backend.models()),
          )
          continue
        }
        if (subAction === "refresh") {
          ui.toast("Refreshing available models…")
          await showScrollableDetails(
            ui,
            "Live models · All accounts",
            "Scroll or filter by account or model (Esc to go back)",
            parseModelsOptions(await backend.models(undefined, { refresh: true })),
          )
          continue
        }
        if (subAction === "clear") {
          const targetIds = await chooseAccounts(ui, backend.accounts, "Clear model rules for", false)
          if (!targetIds?.length) continue
          await ui.alert({ title: "Model rules updated", message: await backend.setModelRules(targetIds, { clear: true }) })
          continue
        }
        const singleIds = await chooseAccounts(ui, backend.accounts, subAction === "toggle-deny" ? "Choose account (deny list)" : "Choose account (allow list)", true)
        if (!singleIds?.length) continue
        const selectedAccount = backend.accounts.find((candidate) => candidate.id === singleIds[0])
        if (!selectedAccount) continue
        const currentList = subAction === "toggle-deny"
          ? [...(selectedAccount.disabledModels ?? [])]
          : [...(selectedAccount.allowedModels ?? [])]
        const currentSet = new Set(currentList)
        const knownModels = knownModelsForAccount(selectedAccount)
        const listTitle = `${selectedAccount.label} · ${subAction === "toggle-deny" ? "Deny list" : "Allow list"}`
        let nextList: string[]
        if (ui.selectMultiple) {
          const chosen = await ui.selectMultiple({
            title: listTitle,
            description: subAction === "toggle-deny"
              ? "Toggle models to exclude from this account, then click Save."
              : "Toggle models allowed on this account, then click Save.",
            placeholder: "Filter models…",
            items: knownModels.map((modelId) => ({
              id: modelId,
              selected: currentSet.has(modelId),
            })),
            confirmLabel: "Save",
          })
          if (!chosen) continue
          nextList = [...new Set(chosen)].sort()
        } else {
          const modelChoice = await ui.select<string>({
            title: listTitle,
            placeholder: "Select a model to toggle",
            options: [
              ...knownModels.map((modelId) => ({
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
          nextList = [...currentSet].sort()
        }
        await ui.alert({
          title: "Model rules updated",
          message: await backend.setModelRules(
            [selectedAccount.id],
            subAction === "toggle-deny" ? { deny: nextList } : { allow: nextList },
          ),
        })
        continue
      }
      if (action === "verify") {
        ui.toast("Checking Google verification…")
        await ui.alert({ title: "Google verification · All accounts", message: formatVerification(await backend.verify()) })
        continue
      }
      if (action === "add") {
        const message = await backend.addAccountWithOAuth()
        if (!message) continue
        await ui.alert({ title: "Account added", message })
        continue
      }
      if (action === "models") {
        if (await ui.confirm({
          title: "Replace Google models?",
          message: "Replace provider.google.models in the local OpenCode configuration with Antigravity models? Existing plugins and other settings will be preserved. V2 normally registers models automatically.",
          confirm: "Replace models",
          cancel: "Back",
        })) {
          await ui.alert({ title: "Model configuration", message: await backend.configureModels() })
        }
        continue
      }
      if (action === "remove-all") {
        if (await ui.confirm({
          title: "Remove all Google accounts?",
          message: `Remove all ${backend.accounts.length} saved account(s):\n${backend.accounts.map((account) => account.label).join("\n")}\n\nThis cannot be undone. You will need to sign in again.`,
          confirm: "Remove all",
          cancel: "Keep accounts",
          danger: true,
        })) {
          await ui.alert({ title: "Accounts removed", message: await backend.removeAll(true) })
        }
        continue
      }
      const titles = { enable: "Enable accounts", disable: "Disable accounts", remove: "Remove accounts", refresh: "Refresh sign-in for" }
      const ids = await chooseAccounts(ui, backend.accounts, titles[action], action === "refresh")
      if (!ids?.length) continue
      if (action === "refresh") {
        const account = backend.accounts.find((candidate) => candidate.id === ids[0])
        if (!account) continue
        const message = await backend.refreshAccountWithOAuth(account)
        if (!message) continue
        await ui.alert({ title: "Sign-in refreshed", message })
        continue
      }
      if (action === "remove") {
        const labels = backend.accounts.filter((account) => ids.includes(account.id)).map((account) => account.label)
        if (await ui.confirm({
          title: `Remove ${ids.length} Google account(s)?`,
          message: `${labels.join("\n")}\n\nThis cannot be undone. Removed accounts will no longer be used for rotation.`,
          confirm: "Remove",
          cancel: "Keep accounts",
          danger: true,
        })) {
          await ui.alert({ title: "Accounts removed", message: await backend.remove(ids, true) })
        }
        continue
      }
      ui.toast("Updating rotation…")
      await ui.alert({ title: "Account rotation", message: await backend.setEnabled(ids, action === "enable") })
    } catch {
      // Never expose exception payloads: network errors can contain credentials.
      await ui.alert({
        title: "Account action failed",
        message: "Could not complete the account action. Account selection may have changed, or Google may be unavailable. Reopen the menu and try again. No credentials are shown here.",
      })
      if (!action) return
    } finally {
      await backend?.dispose?.()
    }
  }
}
