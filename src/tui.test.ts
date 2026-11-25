import { beforeEach, describe, expect, it, vi } from "vitest"
import type { AccountAdmin } from "./plugin/account-admin.ts"

const mocks = vi.hoisted(() => ({ createAdmin: vi.fn() }))
vi.mock("@opencode/plugin/tui", () => ({ Plugin: { define: (definition: unknown) => definition } }))
vi.mock("./plugin/account-admin.ts", () => ({ createAccountAdmin: mocks.createAdmin }))

const { openAccountMenu, default: plugin } = await import("./tui.ts")

function fixture() {
  const accounts = [
    { id: "opaque-a", label: "a@example.com", enabled: true, verificationRequired: false },
    { id: "opaque-b", label: "b@example.com", enabled: false, verificationRequired: true },
  ]
  const admin = {
    accounts,
    list: vi.fn().mockResolvedValue("1. a@example.com — enabled\n2. b@example.com — disabled"),
    quotas: vi.fn().mockResolvedValue("a@example.com: claude: 25%\nb@example.com: claude: 50%"),
    models: vi.fn().mockResolvedValue("a@example.com: available (2): gemini-3-flash, gemini-4-argon; rules: default"),
    setModelRules: vi.fn().mockResolvedValue("a@example.com model rules updated (deny=gemini-4-argon)."),
    verify: vi.fn().mockResolvedValue("a@example.com: ok — ready"),
    setEnabled: vi.fn().mockResolvedValue("Account updated."),
    remove: vi.fn().mockResolvedValue("Account removed."),
    removeAll: vi.fn().mockResolvedValue("Removed 2 account(s)."),
    configureModels: vi.fn().mockResolvedValue("Models configured."),
    addAccount: vi.fn().mockReturnValue("Run `opencode auth login`."),
    refreshAccount: vi.fn().mockReturnValue("Run `antigravity-accounts refresh <account number>`."),
    saveNewAccount: vi.fn().mockResolvedValue("Added c@example.com (3 account(s) total)."),
    completeRefresh: vi.fn().mockResolvedValue(undefined),
  }
  const select = vi.fn()
  const confirm = vi.fn().mockResolvedValue(true)
  const alert = vi.fn().mockResolvedValue(undefined)
  const prompt = vi.fn().mockResolvedValue(undefined)
  const set = vi.fn()
  const clear = vi.fn()
  const toast = vi.fn()
  const ui = { dialog: { select, confirm, alert, prompt, set, clear }, toast: { show: toast } }
  return { admin, select, confirm, alert, prompt, set, clear, toast, ui }
}

beforeEach(() => vi.clearAllMocks())

describe("V2 Antigravity account command", () => {
  it("registers a global slash and palette command at setup, without a rendered slot", async () => {
    const state = fixture()
    mocks.createAdmin.mockResolvedValue(state.admin)
    state.select.mockResolvedValueOnce("close")
    const layer = vi.fn()
    plugin.setup({ ui: state.ui, keymap: { layer } } as never)
    expect(layer).toHaveBeenCalledOnce()
    const command = layer.mock.calls[0]![0]().commands[0]
    expect(command.slash).toEqual({ name: "antigravity-accounts" })
    expect(command.palette).toBe(true)
    await command.run()
    expect(mocks.createAdmin).toHaveBeenCalledOnce()
  })

  it("lists accounts and shows every live quota in a scrollable dialog grouped by account", async () => {
    const state = fixture()
    state.admin.quotas.mockResolvedValueOnce("a@example.com: claude: 25%, gemini: 75%; gemini-3.8-flash: 80%\nb@example.com: quota unavailable")
    state.select.mockResolvedValueOnce("list").mockResolvedValueOnce("quotas")
      .mockResolvedValueOnce("__back__")
      .mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.list).toHaveBeenCalledOnce()
    expect(state.admin.quotas).toHaveBeenCalledOnce()
    expect(state.admin.quotas).toHaveBeenCalledWith()
    expect(state.select).toHaveBeenCalledTimes(4)
    expect(state.confirm).not.toHaveBeenCalled()
    const quotaSelect = state.select.mock.calls.map(([value]) => value).find((value) => value.title === "Live quotas · All accounts")
    expect(quotaSelect?.options).toEqual([
      { title: "claude", description: "25%", category: "a@example.com", value: "row-0" },
      { title: "gemini", description: "75%", category: "a@example.com", value: "row-1" },
      { title: "gemini-3.8-flash", description: "80%", category: "a@example.com", value: "row-2" },
      { title: "quota unavailable", category: "b@example.com", value: "row-3" },
      { title: "Back", value: "__back__", category: "Navigation" },
    ])
    expect(JSON.stringify(state.select.mock.calls)).not.toContain("secret-token")
  })

  it("renders scrollable quota rows for multi-account output without paging accounts", async () => {
    const state = fixture()
    state.admin.quotas.mockResolvedValueOnce("a@example.com: gemini: 90%, claude: 40%\nb@example.com: models/gemini-2.5_flash: 60%, claude: 30%; quota check failed: try again")
    state.select.mockResolvedValueOnce("quotas").mockResolvedValueOnce("__back__").mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.quotas).toHaveBeenCalledOnce()
    expect(state.confirm).not.toHaveBeenCalled()
    expect(state.select).toHaveBeenCalledTimes(3)
    const quotaSelect = state.select.mock.calls[1]![0]
    expect(quotaSelect.title).toBe("Live quotas · All accounts")
    expect(quotaSelect.options.slice(0, 5)).toEqual([
      { title: "gemini", description: "90%", category: "a@example.com", value: "row-0" },
      { title: "claude", description: "40%", category: "a@example.com", value: "row-1" },
      { title: "models/gemini-2.5_flash", description: "60%", category: "b@example.com", value: "row-2" },
      { title: "claude", description: "30%", category: "b@example.com", value: "row-3" },
      { title: "quota check failed", description: "try again", category: "b@example.com", value: "row-4" },
    ])
    expect(state.set).toHaveBeenCalledWith({ centered: true, size: "large" })
  })

  it("checks verification for all accounts in one grouped dialog without selecting or paging", async () => {
    const state = fixture()
    const verificationUrl = "https://accounts.google.com/verify?continue=one,two;mode=check"
    state.admin.verify.mockResolvedValueOnce(`a@example.com: ok — ready, no action needed; access is available\nb@example.com: blocked — Complete verification at ${verificationUrl} (open the link, then try again)`)
    state.select.mockResolvedValueOnce("verify").mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.verify).toHaveBeenCalledOnce()
    expect(state.admin.verify).toHaveBeenCalledWith()
    expect(state.select).toHaveBeenCalledTimes(2)
    expect(state.confirm).not.toHaveBeenCalled()
    expect(state.alert).toHaveBeenCalledOnce()
    expect(state.alert.mock.calls[0]![0]).toEqual({
      title: "Google verification · All accounts",
      message: `a@example.com:\n  ok — ready, no action needed; access is available\n\nb@example.com:\n  blocked — Complete verification at ${verificationUrl} (open the link, then try again)`,
    })
    expect(JSON.stringify(state.alert.mock.calls)).not.toContain("opaque-")
  })

  it("enables or disables rotation with the selected IDs", async () => {
    const state = fixture()
    state.select.mockResolvedValueOnce("enable").mockResolvedValueOnce({ kind: "all" })
      .mockResolvedValueOnce("disable").mockResolvedValueOnce({ kind: "account", id: "opaque-a" })
      .mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.verify).not.toHaveBeenCalled()
    expect(state.admin.setEnabled).toHaveBeenNthCalledWith(1, ["opaque-a", "opaque-b"], true)
    expect(state.admin.setEnabled).toHaveBeenNthCalledWith(2, ["opaque-a"], false)
  })

  it("requires confirmation for selected removal, all removal and model configuration", async () => {
    const state = fixture()
    state.select.mockResolvedValueOnce("remove").mockResolvedValueOnce({ kind: "account", id: "opaque-a" })
      .mockResolvedValueOnce("remove-all").mockResolvedValueOnce("models").mockResolvedValueOnce("close")
    state.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true).mockResolvedValueOnce(false)
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.remove).not.toHaveBeenCalled()
    expect(state.admin.removeAll).toHaveBeenCalledWith(true)
    expect(state.admin.configureModels).not.toHaveBeenCalled()
    expect(state.confirm.mock.calls[0]![0].message).toContain("a@example.com")
    expect(state.confirm.mock.calls[1]![0].message).toContain("b@example.com")
  })

  it("applies confirmed single-account removal and model configuration", async () => {
    const state = fixture()
    state.select.mockResolvedValueOnce("remove").mockResolvedValueOnce({ kind: "account", id: "opaque-b" })
      .mockResolvedValueOnce("models").mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.remove).toHaveBeenCalledWith(["opaque-b"], true)
    expect(state.admin.configureModels).toHaveBeenCalledOnce()
  })

  it("runs interactive OAuth login for add and refresh and persists the resulting credentials", async () => {
    const state = fixture()
    const runOAuth = vi.fn()
      .mockResolvedValueOnce({ refreshToken: "tok-c", email: "c@example.com", projectId: "proj-c" })
      .mockResolvedValueOnce({ refreshToken: "tok-a-new", email: "a@example.com", projectId: "proj-a" })
    state.select.mockResolvedValueOnce("add").mockResolvedValueOnce("refresh")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" }).mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin, runOAuth)
    expect(runOAuth).toHaveBeenCalledTimes(2)
    expect(state.admin.saveNewAccount).toHaveBeenCalledWith({
      refreshToken: "tok-c",
      email: "c@example.com",
      projectId: "proj-c",
    })
    expect(state.admin.completeRefresh).toHaveBeenCalledWith("opaque-a", {
      refreshToken: "tok-a-new",
      email: "a@example.com",
      projectId: "proj-a",
    })
    expect(state.alert.mock.calls.map(([value]) => value.message).join("\n")).toContain("Added c@example.com")
    expect(state.alert.mock.calls.map(([value]) => value.message).join("\n")).toContain("Re-authenticated a@example.com")
  })

  it("handles back, cancellation, stale selections and errors without exposing exception payloads", async () => {
    const state = fixture()
    state.select.mockResolvedValueOnce("remove").mockResolvedValueOnce({ kind: "back" })
      .mockResolvedValueOnce("quotas").mockResolvedValueOnce("close")
    state.admin.quotas.mockRejectedValueOnce(new Error("secret-token"))
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.remove).not.toHaveBeenCalled()
    expect(state.admin.quotas).toHaveBeenCalledWith()
    expect(state.select).toHaveBeenCalledTimes(4)
    expect(state.alert.mock.calls.at(-1)![0].message).not.toContain("secret-token")
    const cancelled = fixture()
    cancelled.select.mockResolvedValueOnce(undefined)
    await openAccountMenu(cancelled.ui as never, async () => cancelled.admin as unknown as AccountAdmin)
    expect(cancelled.admin.removeAll).not.toHaveBeenCalled()
  })

  it("views, refreshes, and updates per-account model access rules from the model-access menu", async () => {
    const state = fixture()
    state.select
      .mockResolvedValueOnce("model-access").mockResolvedValueOnce("view").mockResolvedValueOnce("__back__")
      .mockResolvedValueOnce("model-access").mockResolvedValueOnce("refresh").mockResolvedValueOnce("__back__")
      .mockResolvedValueOnce("model-access").mockResolvedValueOnce("toggle-deny")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" }).mockResolvedValueOnce("gemini-4-argon")
      .mockResolvedValueOnce("model-access").mockResolvedValueOnce("clear")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" })
      .mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.models).toHaveBeenNthCalledWith(1)
    expect(state.admin.models).toHaveBeenNthCalledWith(2, undefined, { refresh: true })
    expect(state.admin.setModelRules).toHaveBeenNthCalledWith(1, ["opaque-a"], { deny: ["gemini-4-argon"] })
    expect(state.admin.setModelRules).toHaveBeenNthCalledWith(2, ["opaque-a"], { clear: true })
  })

  it("renders 5h and weekly quota windows as scrollable subgroup rows under each account", async () => {
    const state = fixture()
    state.admin.quotas.mockResolvedValueOnce(
      "a@example.com: claude (5h): 100% (resets in 4h), claude (weekly): 90% (resets in 5d), gemini (5h): 50% (resets in 3h), gemini (weekly): 96% (resets in 6d)",
    )
    state.select.mockResolvedValueOnce("quotas").mockResolvedValueOnce("__back__").mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    const quotaSelect = state.select.mock.calls[1]![0]
    expect(quotaSelect.title).toBe("Live quotas · All accounts")
    expect(quotaSelect.options).toEqual([
      { title: "claude:", category: "a@example.com", value: "group-0" },
      { title: "  ├─ 5h", description: "100% (resets in 4h)", category: "a@example.com", value: "row-1" },
      { title: "  └─ weekly", description: "90% (resets in 5d)", category: "a@example.com", value: "row-2" },
      { title: "gemini:", category: "a@example.com", value: "group-3" },
      { title: "  ├─ 5h", description: "50% (resets in 3h)", category: "a@example.com", value: "row-4" },
      { title: "  └─ weekly", description: "96% (resets in 6d)", category: "a@example.com", value: "row-5" },
      { title: "Back", value: "__back__", category: "Navigation" },
    ])
    expect(state.set).toHaveBeenCalledWith({ centered: true, size: "large" })
  })
})
