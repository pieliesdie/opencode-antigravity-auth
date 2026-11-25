import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  load: vi.fn(), save: vi.fn(), remove: vi.fn(), replace: vi.fn(), update: vi.fn(), quota: vi.fn(), verify: vi.fn(), configure: vi.fn(),
}))
vi.mock("./storage.ts", () => ({
  loadAccounts: mocks.load, saveAccounts: mocks.save, removeAccountFromStorage: mocks.remove,
  replaceAccountInStorage: mocks.replace, updateAccountInStorage: mocks.update,
}))
vi.mock("./quota.ts", async (importOriginal) => {
  const original = await importOriginal<typeof import("./quota.ts")>()
  return { ...original, checkAccountsQuota: mocks.quota }
})
vi.mock("../plugin.ts", () => ({ verifyAccountAccess: mocks.verify }))
vi.mock("./config/updater.ts", () => ({ updateV2ModelsConfig: mocks.configure }))

const { createAccountAdmin } = await import("./account-admin.ts")
const client = { app: {} } as never
const account = (refreshToken: string, email: string) => ({ refreshToken, email, addedAt: 1, lastUsed: 1 })
const pool = () => ({ version: 4 as const, accounts: [account("secret-a", "a@example.com"), account("secret-b", "b@example.com")], activeIndex: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(pool())
  mocks.save.mockResolvedValue(undefined)
  mocks.remove.mockResolvedValue(true)
  mocks.replace.mockResolvedValue(undefined)
  mocks.update.mockResolvedValue(true)
  mocks.quota.mockResolvedValue([{ quota: { groups: { claude: { remainingFraction: 0.5 } } } }])
  mocks.verify.mockResolvedValue({ status: "ok", message: "ready" })
  mocks.configure.mockResolvedValue({ success: true, configPath: "opencode.json" })
})

describe("account administration backend", () => {
  it("exposes opaque, per-instance IDs with safe labels and no credentials", async () => {
    const first = await createAccountAdmin(client)
    const second = await createAccountAdmin(client)
    expect(first.accounts.map(({ label }) => label)).toEqual(["a@example.com", "b@example.com"])
    expect(first.accounts[0]?.id).not.toBe(second.accounts[0]?.id)
    expect(JSON.stringify(first.accounts)).not.toContain("secret-a")
    expect(await first.list()).toContain("b@example.com")
  })

  it("rejects missing and stale targets before mutation, without falling back to other accounts", async () => {
    const admin = await createAccountAdmin(client)
    await expect(admin.setEnabled(["secret-a"], false)).rejects.toThrow("stale")
    mocks.load.mockResolvedValueOnce({ ...pool(), accounts: [account("secret-b", "b@example.com")] })
    await expect(admin.remove([admin.accounts[0]!.id], true)).rejects.toThrow("changed")
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("handles multiple selections, confirmation, and deletion", async () => {
    const admin = await createAccountAdmin(client)
    const ids = admin.accounts.map(({ id }) => id)
    await expect(admin.remove(ids, false)).rejects.toThrow("Confirm")
    await admin.setEnabled(ids, false)
    expect(mocks.update.mock.calls.map(([token]) => token)).toEqual(["secret-a", "secret-b"])
    await admin.remove(ids, true)
    expect(mocks.remove.mock.calls.map(([token]) => token)).toEqual(["secret-a", "secret-b"])
  })

  it("refuses remove-all if the account pool changed, and requires confirmation", async () => {
    const admin = await createAccountAdmin(client)
    await expect(admin.removeAll(false)).rejects.toThrow("Confirm")
    mocks.load.mockResolvedValueOnce({ ...pool(), accounts: [account("secret-c", "c@example.com"), ...pool().accounts] })
    await expect(admin.removeAll(true)).rejects.toThrow("pool changed")
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(await admin.removeAll(true)).toBe("Removed 2 account(s).")
  })

  it("checks live quotas without a storage write, verifies selected accounts, and configures models", async () => {
    const admin = await createAccountAdmin(client)
    const id = admin.accounts[0]!.id
    expect(await admin.quotas([id])).toContain("claude: 50%")
    expect(mocks.quota.mock.calls[0]?.[0]).toEqual([pool().accounts[0]])
    expect(await admin.verify([id])).toContain("ready")
    expect(mocks.update).toHaveBeenCalledWith("secret-a", expect.any(Function))
    expect(await admin.configureModels()).toContain("opencode.json")
  })

  it("redacts refresh tokens embedded in remote quota and verification messages", async () => {
    const admin = await createAccountAdmin(client)
    const id = admin.accounts[0]!.id
    mocks.quota.mockResolvedValueOnce([{ error: "quota failed for secret-a" }])
    const quota = await admin.quotas([id])
    expect(quota).toContain("[redacted]")
    expect(quota).not.toContain("secret-a")
    mocks.verify.mockResolvedValueOnce({ status: "error", message: "verification failed for secret-a" })
    const message = await admin.verify([id])
    expect(message).toContain("[redacted]")
    expect(message).not.toContain("secret-a")
  })

  it("offers OAuth guidance rather than simulating a TUI login; completion delegates to atomic identity-safe replacement", async () => {
    const admin = await createAccountAdmin(client)
    expect(admin.addAccount()).toContain("opencode auth login")
    expect(admin.refreshAccount(admin.accounts[0]!.id)).toContain("antigravity-accounts refresh")
    expect(mocks.replace).not.toHaveBeenCalled()
    await admin.completeRefresh(admin.accounts[0]!.id, { refreshToken: "new", email: "a@example.com" })
    expect(mocks.replace).toHaveBeenCalledWith("secret-a", { refreshToken: "new", email: "a@example.com" })
  })

  it("displays, refreshes, and updates per-account model availability and manual allow/deny rules", async () => {
    mocks.quota.mockResolvedValueOnce([
      { status: "ok", availableModels: ["gemini-3-flash", "gemini-4-argon"], quota: { groups: {} } },
    ])
    const admin = await createAccountAdmin(client)
    const id = admin.accounts[0]!.id

    const refreshed = await admin.models([id], { refresh: true })
    expect(refreshed).toContain("gemini-4-argon")
    expect(mocks.update).toHaveBeenCalledWith("secret-a", expect.any(Function))

    const updated = await admin.setModelRules([id], { deny: ["gemini-4-*"] })
    expect(updated).toContain("deny=gemini-4-*")

    const cleared = await admin.setModelRules([id], { clear: true })
    expect(cleared).toContain("model rules cleared")
  })

  it("includes reset time and window hint in live quota output when resetTime is provided", async () => {
    const now = Date.now()
    mocks.quota.mockResolvedValueOnce([{
      quota: {
        groups: {
          claude: { remainingFraction: 0.4, resetTime: new Date(now + 4 * 60 * 60 * 1000).toISOString(), modelCount: 1 },
          gemini: { remainingFraction: 0.8, resetTime: new Date(now + 5 * 24 * 60 * 60 * 1000 + 60_000).toISOString(), modelCount: 1 },
        },
      },
    }])
    const admin = await createAccountAdmin(client)
    const output = await admin.quotas([admin.accounts[0]!.id])
    expect(output).toMatch(/claude: 40% \(resets in [^·]+\)/)
    expect(output).toMatch(/gemini: 80% \(resets in 5d · weekly\)/)
  })

  it("renders separate 5h and weekly quota windows when retrieveUserQuotaSummary data is present", async () => {
    const now = Date.now()
    mocks.quota.mockResolvedValueOnce([{
      quota: {
        groups: {
          claude: {
            remainingFraction: 0.9,
            modelCount: 2,
            fiveHour: { remainingFraction: 1, resetTime: new Date(now + 4 * 60 * 60 * 1000 + 60_000).toISOString() },
            weekly: { remainingFraction: 0.9, resetTime: new Date(now + 5 * 24 * 60 * 60 * 1000 + 60_000).toISOString() },
          },
          gemini: {
            remainingFraction: 0.5,
            modelCount: 3,
            fiveHour: { remainingFraction: 0.5, resetTime: new Date(now + 3 * 60 * 60 * 1000 + 60_000).toISOString() },
            weekly: { remainingFraction: 0.96, resetTime: new Date(now + 6 * 24 * 60 * 60 * 1000 + 60_000).toISOString() },
          },
        },
      },
    }])
    const admin = await createAccountAdmin(client)
    const output = await admin.quotas([admin.accounts[0]!.id])
    expect(output).toContain("claude (5h): 100% (resets in 4h")
    expect(output).toContain("claude (weekly): 90% (resets in 5d)")
    expect(output).toContain("gemini (5h): 50% (resets in 3h")
    expect(output).toContain("gemini (weekly): 96% (resets in 6d)")
  })

  it("persists a newly authenticated account via saveNewAccount without wiping existing accounts", async () => {
    const admin = await createAccountAdmin(client)
    const msg = await admin.saveNewAccount({
      refreshToken: "secret-c",
      email: "c@example.com",
      projectId: "proj-c",
    })
    expect(msg).toContain("Added c@example.com")
    expect(mocks.save).toHaveBeenCalledOnce()
    const saved = mocks.save.mock.calls[0]![0]
    expect(saved.accounts).toHaveLength(3)
    expect(saved.accounts[2]).toMatchObject({ refreshToken: "secret-c", email: "c@example.com", projectId: "proj-c" })
  })
})
