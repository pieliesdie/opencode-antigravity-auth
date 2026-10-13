import { beforeEach, describe, expect, it, vi } from "vitest"

const mocks = vi.hoisted(() => ({ load: vi.fn(), remove: vi.fn(), replace: vi.fn(), update: vi.fn(), quota: vi.fn(), verify: vi.fn(), sync: vi.fn(), config: vi.fn(), save: vi.fn(), exchange: vi.fn(), callback: vi.fn() }))
vi.mock("./plugin/storage.ts", () => ({ loadAccounts: mocks.load, removeAccountFromStorage: mocks.remove, replaceAccountInStorage: mocks.replace, updateAccountInStorage: mocks.update, saveAccounts: mocks.save }))
vi.mock("./antigravity/oauth.ts", () => ({ authorizeAntigravity: async () => ({ url: "https://accounts.example.test/?state=state" }), exchangeAntigravity: mocks.exchange }))
vi.mock("./plugin/server.ts", () => ({ startOAuthListener: async () => ({ waitForCallback: mocks.callback, close: async () => undefined }) }))
vi.mock("./plugin.ts", () => ({ verifyAccountAccess: mocks.verify, syncV2AccountChange: mocks.sync }))
vi.mock("./plugin/quota.ts", () => ({ checkAccountsQuota: mocks.quota }))
vi.mock("./plugin/config/updater.ts", () => ({ updateV2ModelsConfig: mocks.config }))
const { runAccountsCLI } = await import("./accounts-cli.ts")
const account = (refreshToken: string) => ({ refreshToken, email: `${refreshToken}@example.com`, addedAt: 1, lastUsed: 0 })

describe("antigravity-accounts CLI", () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.load.mockResolvedValue({ version: 4, accounts: [account("first"), account("second")], activeIndex: 0 })
    mocks.remove.mockResolvedValue(true)
    mocks.replace.mockResolvedValue(undefined)
    mocks.exchange.mockResolvedValue({ type: "success", refresh: "new|project", email: "first@example.com", access: "", expires: 1 })
    mocks.callback.mockResolvedValue(new URL("http://localhost/?code=code&state=state"))
    mocks.update.mockResolvedValue(true)
    mocks.quota.mockResolvedValue([{ status: "ok", quota: { groups: { claude: { remainingFraction: 0.25 } } } }])
    mocks.verify.mockResolvedValue({ status: "ok", message: "ready" })
    mocks.config.mockResolvedValue({ success: true, configPath: "opencode.json" })
  })

  it("lists accounts without a warning or mutation", async () => {
    const lines: string[] = []
    await runAccountsCLI(["list"], (line) => lines.push(line))
    expect(lines.join("\n")).toContain("first@example.com")
    expect(lines.join("\n")).not.toContain("Warning")
  })

  it("deletes --all with locked tombstones and warns to close OpenCode", async () => {
    const lines: string[] = []
    await runAccountsCLI(["remove", "--all"], (line) => lines.push(line))
    expect(lines[0]).toContain("close OpenCode")
    expect(mocks.remove.mock.calls.map(([token]) => token)).toEqual(["first", "second"])
    expect(lines.at(-1)).toContain("Removed 2")
  })

  it("rejects invalid account number before changing storage", async () => {
    await expect(runAccountsCLI(["disable", "3"])).rejects.toThrow("Invalid account number")
    expect(mocks.update).not.toHaveBeenCalled()
  })

  it("checks quota and verification via live APIs and configures models", async () => {
    const lines: string[] = []
    await runAccountsCLI(["quota", "1"], (line) => lines.push(line))
    expect(lines.at(-1)).toContain("claude: 25%")
    expect(mocks.quota).toHaveBeenCalledOnce()
    await runAccountsCLI(["verify", "1"], (line) => lines.push(line))
    expect(mocks.verify).toHaveBeenCalledOnce()
    await runAccountsCLI(["configure-models"], (line) => lines.push(line))
    expect(lines.at(-1)).toContain("Google models replaced")
  })

  it("refreshes the selected identity using one atomic replacement, never add then delete", async () => {
    const output: string[] = []
    await runAccountsCLI(["refresh", "1"], (line) => output.push(line))
    expect(mocks.replace).toHaveBeenCalledWith("first", { refreshToken: "new", email: "first@example.com", projectId: "project", managedProjectId: undefined })
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(output.at(-1)).toContain("Re-authenticated")
  })

  it("does not persist or remove anything when a different identity signs in for refresh", async () => {
    mocks.exchange.mockResolvedValueOnce({ type: "success", refresh: "wrong|project", email: "other@example.com", access: "", expires: 1 })
    mocks.replace.mockRejectedValueOnce(new Error("Signed-in identity does not match the selected account; nothing was changed."))
    await expect(runAccountsCLI(["refresh", "1"], () => undefined)).rejects.toThrow("identity does not match")
    expect(mocks.save).not.toHaveBeenCalled()
    expect(mocks.remove).not.toHaveBeenCalled()
  })

  it("rejects a mismatched OAuth callback state before token exchange or persistence", async () => {
    mocks.callback.mockResolvedValueOnce(new URL("http://localhost/?code=code&state=wrong"))
    await expect(runAccountsCLI(["refresh", "1"], () => undefined)).rejects.toThrow("Invalid OAuth redirect or state")
    expect(mocks.exchange).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
    expect(mocks.save).not.toHaveBeenCalled()
  })
})
