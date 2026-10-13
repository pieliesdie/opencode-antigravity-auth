import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({
  load: vi.fn(), remove: vi.fn(), replace: vi.fn(), update: vi.fn(), quota: vi.fn(), verify: vi.fn(), configure: vi.fn(),
}))
vi.mock("./storage.ts", () => ({
  loadAccounts: mocks.load, removeAccountFromStorage: mocks.remove,
  replaceAccountInStorage: mocks.replace, updateAccountInStorage: mocks.update,
}))
vi.mock("./quota.ts", () => ({ checkAccountsQuota: mocks.quota }))
vi.mock("../plugin.ts", () => ({ verifyAccountAccess: mocks.verify }))
vi.mock("./config/updater.ts", () => ({ updateV2ModelsConfig: mocks.configure }))

const { createAccountAdmin } = await import("./account-admin.ts")
const client = { app: {} } as never
const account = (refreshToken: string, email: string) => ({ refreshToken, email, addedAt: 1, lastUsed: 1 })
const pool = () => ({ version: 4 as const, accounts: [account("secret-a", "a@example.com"), account("secret-b", "b@example.com")], activeIndex: 0 })

beforeEach(() => {
  vi.clearAllMocks()
  mocks.load.mockResolvedValue(pool())
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
})
