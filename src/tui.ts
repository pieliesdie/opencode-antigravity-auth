import { Plugin } from "@opencode/plugin/tui"
import { createAccountAdmin } from "./plugin/account-admin.ts"
import type { AccountAdmin, AccountView } from "./plugin/account-admin.ts"
import type { PluginClient } from "./plugin/types.ts"

type Dialog = Plugin.Context["ui"]["dialog"]
type Action = "list" | "quotas" | "verify" | "enable" | "disable" | "remove" | "remove-all" | "models" | "add" | "refresh" | "close"
type Selection = { kind: "account"; id: string } | { kind: "all" } | { kind: "back" }

const OAUTH_GUIDE = "In a terminal, run opencode auth login → Google → OAuth with Google (Antigravity). Complete the browser sign-in, then reopen /antigravity-accounts. This menu does not start OAuth."

function accountStatus(account: AccountView): string {
  return `${account.enabled ? "Enabled" : "Disabled"}${account.verificationRequired ? " · Google verification required" : ""}`
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
  await dialog.alert({ title, message: result })
}

function formatQuotas(result: string): string {
  // Keep each account together in one dialog, with its label above every detail.
  return result.split("\n").filter(Boolean).map((line) => {
    const separator = line.indexOf(": ")
    if (separator === -1) return line
    const heading = line.slice(0, separator + 1)
    const details = line.slice(separator + 2).split(/; |, (?=[^,;\n]+: )/g)
    return `${heading}\n${details.map((detail) => `  ${detail}`).join("\n")}`
  }).join("\n\n")
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
          { title: "Add a Google account", value: "add", description: "How to sign in with real Google OAuth", category: "Setup" },
          { title: "Refresh account sign-in", value: "refresh", description: "How to re-authenticate a saved account", disabled: empty, category: "Setup" },
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
        await showResult(dialog, "Live quotas · All accounts", formatQuotas(await admin.quotas()))
        continue
      }
      if (action === "verify") {
        toast.show({ title: "Antigravity accounts", message: "Checking Google verification…", variant: "info" })
        await showResult(dialog, "Google verification · All accounts", formatVerification(await admin.verify()))
        continue
      }
      if (action === "add") {
        await showResult(dialog, "Add a Google account", `${admin.addAccount()}\n\n${OAUTH_GUIDE}`)
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
        await showResult(dialog, "Refresh Google sign-in", `${account?.label ?? "Selected account"}\n\n${admin.refreshAccount(ids[0]!)}\n\n${OAUTH_GUIDE}\n\nSigning in again adds or reconnects an account; it does not promise to replace this saved entry. Use the standalone refresh command above for explicit replacement.`)
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
