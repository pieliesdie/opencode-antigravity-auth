import { randomUUID } from "node:crypto"
import { ANTIGRAVITY_PROVIDER_ID } from "../constants.ts"
import { verifyAccountAccess } from "../plugin.ts"
import { checkAccountsQuota } from "./quota.ts"
import { updateV2ModelsConfig } from "./config/updater.ts"
import { loadAccounts, removeAccountFromStorage, replaceAccountInStorage, updateAccountInStorage } from "./storage.ts"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

/** Opaque IDs are valid only for this backend instance; never pass refresh tokens to UI. */
export interface AccountView {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly verificationRequired: boolean
}

export type RefreshAccount = Pick<AccountMetadataV3, "refreshToken" | "email" | "projectId" | "managedProjectId">

export interface AccountAdmin {
  readonly accounts: readonly AccountView[]
  list(): Promise<string>
  quotas(ids?: readonly string[]): Promise<string>
  verify(ids?: readonly string[]): Promise<string>
  setEnabled(ids: readonly string[], enabled: boolean): Promise<string>
  remove(ids: readonly string[], confirm: boolean): Promise<string>
  removeAll(confirm: boolean): Promise<string>
  configureModels(): Promise<string>
  /** No OAuth is started by account administration. */
  addAccount(): string
  refreshAccount(id: string): string
  /** Only call after a genuine OAuth exchange; validates identity and retires the old token atomically. */
  completeRefresh(id: string, replacement: RefreshAccount): Promise<void>
}

function label(account: AccountMetadataV3, index: number): string {
  return account.email ?? `Google account ${index + 1}`
}

function redactTokens(message: string, accounts: readonly AccountMetadataV3[]): string {
  return accounts.reduce((safe, account) => safe.replaceAll(account.refreshToken, "[redacted]"), message)
}

export async function createAccountAdmin(
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountAdmin> {
  const initial = await loadAccounts()
  const selectedTokens = new Map<string, string>()
  const accounts: AccountView[] = (initial?.accounts ?? []).map((account, index) => {
    const id = randomUUID()
    selectedTokens.set(id, account.refreshToken)
    return { id, label: label(account, index), enabled: account.enabled !== false, verificationRequired: account.verificationRequired === true }
  })

  async function select(ids?: readonly string[]): Promise<AccountMetadataV3[]> {
    const current = (await loadAccounts())?.accounts ?? []
    const requested = ids ?? [...selectedTokens.keys()]
    const tokens = requested.map((id) => selectedTokens.get(id))
    if (tokens.some((token) => !token)) throw new Error("Account selection is stale; reopen account management.")
    const unique = [...new Set(tokens as string[])]
    const found = unique.map((token) => current.find((account) => account.refreshToken === token))
    if (found.some((account) => !account)) throw new Error("Account selection changed; reopen account management.")
    return found as AccountMetadataV3[]
  }

  async function removeSelected(ids: readonly string[]): Promise<string> {
    if (!ids.length) throw new Error("Select an account.")
    const targets = await select(ids)
    const lines: string[] = []
    for (const account of targets) {
      if (!await removeAccountFromStorage(account.refreshToken)) throw new Error("Account selection changed; reopen account management.")
      lines.push(`Removed ${label(account, 0)}.`)
    }
    return lines.join("\n")
  }

  return {
    accounts,
    async list() {
      const current = await loadAccounts()
      if (!current?.accounts.length) return "No Google accounts remain. Run `opencode auth login` to sign in."
      return current.accounts.map((account, index) => `${index + 1}. ${label(account, index)} — ${account.enabled === false ? "disabled" : "enabled"}`).join("\n")
    },
    async quotas(ids) {
      const targets = await select(ids)
      if (!targets.length) return "No Google accounts remain."
      const results = await checkAccountsQuota(targets, client, providerId)
      return results.map((result, index) => {
        const groups = result.quota?.groups
          ? Object.entries(result.quota.groups).map(([name, quota]) => `${name}: ${Math.round((quota.remainingFraction ?? 0) * 100)}%`).join(", ") : ""
        const cli = result.geminiCliQuota?.models.map((model) => `${model.modelId}: ${Math.round(model.remainingFraction * 100)}%`).join(", ")
        return redactTokens(`${label(targets[index]!, index)}: ${result.error ?? ([groups || result.quota?.error, cli || result.geminiCliQuota?.error].filter(Boolean).join("; ") || "No quota available")}`, targets)
      }).join("\n")
    },
    async verify(ids) {
      const targets = await select(ids)
      if (!targets.length) return "No Google accounts remain."
      const lines: string[] = []
      for (const account of targets) {
        const result = await verifyAccountAccess(account, client, providerId)
        if (result.status !== "error") {
          let wasVerificationRequired = false
          const saved = await updateAccountInStorage(account.refreshToken, (latest) => {
            wasVerificationRequired = latest.verificationRequired === true
            latest.verificationRequired = result.status === "blocked"
            latest.verificationRequiredAt = result.status === "blocked" ? (latest.verificationRequiredAt ?? Date.now()) : undefined
            latest.verificationRequiredReason = result.status === "blocked" ? result.message : undefined
            latest.verificationUrl = result.status === "blocked" ? result.verifyUrl : undefined
            if (result.status === "blocked") latest.enabled = false
            if (result.status === "ok" && wasVerificationRequired) latest.enabled = true
          })
          if (!saved) throw new Error("Account selection changed during verification; reopen account management.")
        }
        lines.push(redactTokens(`${label(account, 0)}: ${result.status} — ${result.message}${result.verifyUrl ? ` (${result.verifyUrl})` : ""}`, targets))
      }
      return lines.join("\n")
    },
    async setEnabled(ids, enabled) {
      if (!ids.length) throw new Error("Select an account.")
      const targets = await select(ids)
      const lines: string[] = []
      for (const account of targets) {
        if (!await updateAccountInStorage(account.refreshToken, (latest) => { latest.enabled = enabled })) {
          throw new Error("Account selection changed; reopen account management.")
        }
        lines.push(`${label(account, 0)} ${enabled ? "enabled" : "disabled"}.`)
      }
      return lines.join("\n")
    },
    async remove(ids, confirm) {
      if (!confirm) throw new Error("Confirm account removal before deleting.")
      return removeSelected(ids)
    },
    async removeAll(confirm) {
      if (!confirm) throw new Error("Confirm removal of all accounts before deleting.")
      const current = (await loadAccounts())?.accounts ?? []
      if (current.length !== selectedTokens.size || current.some((account) => ![...selectedTokens.values()].includes(account.refreshToken))) {
        throw new Error("Account pool changed; reopen account management before deleting all.")
      }
      if (!current.length) return "No Google accounts remain."
      await removeSelected(accounts.map((account) => account.id))
      return `Removed ${current.length} account(s).`
    },
    async configureModels() {
      const result = await updateV2ModelsConfig()
      return result.success ? `Google models replaced in ${result.configPath}. Existing V2 plugins were preserved.` : `Could not configure models: ${result.error}`
    },
    addAccount() { return "Run `opencode auth login` to add a Google account, or `antigravity-accounts add` after closing OpenCode." },
    refreshAccount(id) {
      if (!selectedTokens.has(id)) throw new Error("Account selection is stale; reopen account management.")
      return "Run `antigravity-accounts refresh <account number>` after closing OpenCode to re-authenticate this account."
    },
    async completeRefresh(id, replacement) {
      const [account] = await select([id])
      if (!account) throw new Error("Account selection changed; reopen account management.")
      await replaceAccountInStorage(account.refreshToken, replacement)
    },
  }
}
