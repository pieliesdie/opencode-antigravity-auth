import { randomUUID } from "node:crypto"
import { ANTIGRAVITY_PROVIDER_ID } from "../constants.ts"
import { verifyAccountAccess } from "../plugin.ts"
import { checkAccountsQuota, formatQuotaGroupEntries } from "./quota.ts"
import { updateV2ModelsConfig } from "./config/updater.ts"
import { sanitizeModelPatterns, sanitizeUnavailableModels } from "./model-availability.ts"
import { loadAccounts, removeAccountFromStorage, replaceAccountInStorage, saveAccounts, updateAccountInStorage } from "./storage.ts"
import type { AccountMetadataV3 } from "./storage.ts"
import type { PluginClient } from "./types.ts"

/** Opaque IDs are valid only for this backend instance; never pass refresh tokens to UI. */
export interface AccountView {
  readonly id: string
  readonly label: string
  readonly enabled: boolean
  readonly verificationRequired: boolean
  readonly allowedModels?: readonly string[]
  readonly disabledModels?: readonly string[]
  readonly cachedAvailableModels?: readonly string[]
}

export type RefreshAccount = Pick<AccountMetadataV3, "refreshToken" | "email" | "projectId" | "managedProjectId">

export interface AccountModelRulesUpdate {
  readonly allow?: readonly string[]
  readonly deny?: readonly string[]
  readonly clear?: boolean
}

export interface AccountAdmin {
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
  /** Guidance fallback for external OAuth sign-in. */
  addAccount(): string
  refreshAccount(id: string): string
  /** Persist a newly authenticated Google OAuth account into the pool. */
  saveNewAccount(account: RefreshAccount): Promise<string>
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
    return {
      id,
      label: label(account, index),
      enabled: account.enabled !== false,
      verificationRequired: account.verificationRequired === true,
      ...(account.allowedModels?.length ? { allowedModels: [...account.allowedModels] } : {}),
      ...(account.disabledModels?.length ? { disabledModels: [...account.disabledModels] } : {}),
      ...(account.cachedAvailableModels !== undefined ? { cachedAvailableModels: [...account.cachedAvailableModels] } : {}),
    }
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
      return current.accounts.map((account, index) => {
        const ruleParts: string[] = []
        if (account.allowedModels?.length) ruleParts.push(`allow: ${account.allowedModels.join(", ")}`)
        if (account.disabledModels?.length) ruleParts.push(`deny: ${account.disabledModels.join(", ")}`)
        const suffix = ruleParts.length ? ` (${ruleParts.join("; ")})` : ""
        return `${index + 1}. ${label(account, index)} — ${account.enabled === false ? "disabled" : "enabled"}${suffix}`
      }).join("\n")
    },
    async quotas(ids) {
      const targets = await select(ids)
      if (!targets.length) return "No Google accounts remain."
      const results = await checkAccountsQuota(targets, client, providerId)
      return results.map((result, index) => {
        const groups = result.quota?.groups
          ? Object.entries(result.quota.groups)
              .flatMap(([name, quota]) => formatQuotaGroupEntries(name, quota))
              .join(", ")
          : ""
        return redactTokens(`${label(targets[index]!, index)}: ${result.error ?? ([groups || result.quota?.error].filter(Boolean).join("; ") || "No quota available")}`, targets)
      }).join("\n")
    },
    async models(ids, options) {
      const targets = await select(ids)
      if (!targets.length) return "No Google accounts remain."
      const refreshedByToken = new Map<string, { models?: string[]; error?: string }>()
      if (options?.refresh) {
        const results = await checkAccountsQuota(targets, client, providerId)
        for (let i = 0; i < targets.length; i++) {
          const target = targets[i]!
          const res = results[i]
          if (res?.status === "ok" && res.availableModels !== undefined) {
            refreshedByToken.set(target.refreshToken, { models: res.availableModels })
            const saved = await updateAccountInStorage(target.refreshToken, (latest) => {
              latest.cachedAvailableModels = res.availableModels
              latest.cachedAvailableModelsUpdatedAt = Date.now()
            })
            if (saved) {
              target.cachedAvailableModels = res.availableModels
              target.cachedAvailableModelsUpdatedAt = Date.now()
            }
          } else {
            refreshedByToken.set(target.refreshToken, { error: res?.error ?? res?.quota?.error ?? "failed to refresh models" })
          }
        }
      }
      const now = Date.now()
      return targets.map((account, index) => {
        const refreshed = refreshedByToken.get(account.refreshToken)
        const parts: string[] = []
        if (refreshed?.error) {
          parts.push(`refresh error: ${refreshed.error}`)
        }
        const available = refreshed?.models ?? account.cachedAvailableModels
        if (available !== undefined) {
          parts.push(`available (${available.length}): ${available.length ? available.join(", ") : "none"}`)
        } else {
          parts.push("available: not cached yet")
        }
        const activeUnavailable = Object.keys(sanitizeUnavailableModels(account.unavailableModels, now))
        if (activeUnavailable.length) {
          parts.push(`temporarily unavailable: ${activeUnavailable.join(", ")}`)
        }
        if (account.allowedModels?.length) {
          parts.push(`allow: ${account.allowedModels.join(", ")}`)
        }
        if (account.disabledModels?.length) {
          parts.push(`deny: ${account.disabledModels.join(", ")}`)
        }
        if (!account.allowedModels?.length && !account.disabledModels?.length) {
          parts.push("rules: default")
        }
        return redactTokens(`${label(account, index)}: ${parts.join("; ")}`, targets)
      }).join("\n")
    },
    async setModelRules(ids, rules) {
      if (!ids.length) throw new Error("Select an account.")
      const targets = await select(ids)
      const lines: string[] = []
      const normalizedAllow = rules.allow !== undefined ? sanitizeModelPatterns(rules.allow) : undefined
      const normalizedDeny = rules.deny !== undefined ? sanitizeModelPatterns(rules.deny) : undefined
      for (const account of targets) {
        if (!await updateAccountInStorage(account.refreshToken, (latest) => {
          if (rules.clear) {
            latest.allowedModels = undefined
            latest.disabledModels = undefined
            return
          }
          if (rules.allow !== undefined) latest.allowedModels = normalizedAllow
          if (rules.deny !== undefined) latest.disabledModels = normalizedDeny
        })) {
          throw new Error("Account selection changed; reopen account management.")
        }
        if (rules.clear) {
          lines.push(`${label(account, 0)} model rules cleared.`)
        } else {
          const summary: string[] = []
          if (rules.allow !== undefined) summary.push(`allow=${normalizedAllow?.join(", ") || "none"}`)
          if (rules.deny !== undefined) summary.push(`deny=${normalizedDeny?.join(", ") || "none"}`)
          lines.push(`${label(account, 0)} model rules updated (${summary.join("; ") || "unchanged"}).`)
        }
      }
      return lines.join("\n")
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
    async saveNewAccount(account) {
      if (!account.refreshToken) throw new Error("Missing refresh token from Google sign-in.")
      const existing = await loadAccounts()
      const accounts = [...(existing?.accounts ?? [])]
      const now = Date.now()
      const existingIdx = accounts.findIndex((candidate) =>
        (account.email && candidate.email?.toLowerCase() === account.email.toLowerCase()) ||
        candidate.refreshToken === account.refreshToken,
      )
      if (existingIdx >= 0) {
        const previous = accounts[existingIdx]!
        if (previous.refreshToken !== account.refreshToken) {
          await replaceAccountInStorage(previous.refreshToken, account)
        } else {
          await updateAccountInStorage(previous.refreshToken, (latest) => {
            latest.email = account.email ?? latest.email
            latest.projectId = account.projectId ?? latest.projectId
            latest.managedProjectId = account.managedProjectId ?? latest.managedProjectId
            latest.enabled = true
            latest.verificationRequired = false
            latest.lastUsed = now
          })
        }
        return `Updated ${account.email ?? "Google account"} in account pool.`
      }
      accounts.push({
        email: account.email,
        refreshToken: account.refreshToken,
        projectId: account.projectId,
        managedProjectId: account.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      })
      await saveAccounts({
        version: 4,
        accounts,
        activeIndex: existing?.activeIndex ?? 0,
        activeIndexByFamily: existing?.activeIndexByFamily,
        activeIndexByModel: existing?.activeIndexByModel,
      })
      return `Added ${account.email ?? "Google account"} (${accounts.length} account(s) total).`
    },
    async completeRefresh(id, replacement) {
      const [account] = await select([id])
      if (!account) throw new Error("Account selection changed; reopen account management.")
      await replaceAccountInStorage(account.refreshToken, replacement)
    },
  }
}
