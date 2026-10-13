#!/usr/bin/env node
/** Standalone account manager. Quit OpenCode before modifying accounts externally. */
import { createInterface } from "node:readline/promises"
import { stdin, stdout } from "node:process"
import { pathToFileURL } from "node:url"
import { authorizeAntigravity, exchangeAntigravity } from "./antigravity/oauth.ts"
import { startOAuthListener } from "./plugin/server.ts"
import { loadAccounts, saveAccounts } from "./plugin/storage.ts"
import { parseRefreshParts } from "./plugin/auth.ts"
import { createAccountAdmin } from "./plugin/account-admin.ts"
import type { PluginClient } from "./plugin/types.ts"

const HELP = `Usage: antigravity-accounts <list|add|enable|disable|remove|quota|verify|refresh|configure-models> [account numbers|--all]
Examples: antigravity-accounts remove 2 ; antigravity-accounts remove --all ; antigravity-accounts quota --all`
const client = { app: { log: async () => undefined } } as unknown as PluginClient

async function login(manual: boolean): Promise<{ refresh: string; email?: string; projectId?: string; managedProjectId?: string }> {
  const listener = manual ? undefined : await startOAuthListener()
  try {
    const authorization = await authorizeAntigravity()
    stdout.write(`Open this URL to sign in:\n${authorization.url}\n`)
    let code: string
    let state: string
    if (listener) {
      const callback = await listener.waitForCallback()
      code = callback.searchParams.get("code") ?? ""
      state = callback.searchParams.get("state") ?? ""
    } else {
      if (!stdin.isTTY) throw new Error("Manual login requires a terminal")
      const rl = createInterface({ input: stdin, output: stdout })
      try {
        const value = await rl.question("Paste the full redirect URL (or code): ")
        const callback = value.startsWith("http") ? new URL(value) : undefined
        code = callback?.searchParams.get("code") ?? value.trim()
        state = callback?.searchParams.get("state") ?? new URL(authorization.url).searchParams.get("state") ?? ""
      } finally { rl.close() }
    }
    if (!code || state !== new URL(authorization.url).searchParams.get("state")) throw new Error("Invalid OAuth redirect or state")
    const result = await exchangeAntigravity(code, state)
    if (result.type !== "success") throw new Error(result.error)
    const parts = parseRefreshParts(result.refresh)
    return { refresh: parts.refreshToken, email: result.email, projectId: parts.projectId, managedProjectId: parts.managedProjectId }
  } finally { await listener?.close() }
}

export async function runAccountsCLI(args: string[], out: (text: string) => void = console.log): Promise<void> {
  const [command = "list", ...selectors] = args
  if (command === "help" || command === "--help") { out(HELP); return }
  if (!["list", "add", "enable", "disable", "remove", "quota", "verify", "refresh", "configure-models"].includes(command)) throw new Error(HELP)
  const mutates = ["add", "enable", "disable", "remove", "verify", "refresh", "configure-models"].includes(command)
  if (mutates) out("Warning: close OpenCode before changing accounts externally; a running process may retain its own account state.")
  const admin = await createAccountAdmin(client)
  const ids = admin.accounts.map((account) => account.id)
  const all = selectors.includes("--all")
  if (all && selectors.length !== 1) throw new Error("Use --all alone")
  const selected = all ? ids : selectors.filter((value) => value !== "--no-browser").map((value) => {
    const index = Number(value)
    if (!Number.isSafeInteger(index) || index < 1 || index > ids.length) throw new Error(`Invalid account number: ${value}`)
    return ids[index - 1]!
  })
  if (["enable", "disable", "remove", "refresh"].includes(command) && !selected.length) throw new Error("Select an account number or --all")
  if (command === "add" || command === "refresh") {
    if (command === "refresh" && selected.length !== 1) throw new Error("Refresh requires exactly one account")
    const account = await login(selectors.includes("--no-browser"))
    if (command === "refresh") {
      await admin.completeRefresh(selected[0]!, { refreshToken: account.refresh, email: account.email,
        projectId: account.projectId, managedProjectId: account.managedProjectId })
      out(`Re-authenticated ${account.email ?? "Google account"}.`)
      return
    }
    const existing = await loadAccounts()
    await saveAccounts({ version: 4, accounts: [{ refreshToken: account.refresh, email: account.email, projectId: account.projectId, addedAt: Date.now(), lastUsed: 0 }], activeIndex: existing?.activeIndex ?? 0 })
    out(`Added ${account.email ?? "Google account"}.`)
    return
  }
  const text = command === "list" ? await admin.list()
    : command === "quota" ? await admin.quotas(selected.length ? selected : undefined)
    : command === "verify" ? await admin.verify(selected.length ? selected : undefined)
    : command === "enable" ? await admin.setEnabled(selected, true)
    : command === "disable" ? await admin.setEnabled(selected, false)
    : command === "remove" ? all ? await admin.removeAll(true) : await admin.remove(selected, true)
    : await admin.configureModels()
  out(text ?? "")
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runAccountsCLI(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
}
