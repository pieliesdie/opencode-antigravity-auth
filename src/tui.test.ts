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
    verify: vi.fn().mockResolvedValue("a@example.com: ok — ready"),
    setEnabled: vi.fn().mockResolvedValue("Account updated."),
    remove: vi.fn().mockResolvedValue("Account removed."),
    removeAll: vi.fn().mockResolvedValue("Removed 2 account(s)."),
    configureModels: vi.fn().mockResolvedValue("Models configured."),
    addAccount: vi.fn().mockReturnValue("Run `opencode auth login`."),
    refreshAccount: vi.fn().mockReturnValue("Run `antigravity-accounts refresh <account number>`."),
  }
  const select = vi.fn()
  const confirm = vi.fn().mockResolvedValue(true)
  const alert = vi.fn().mockResolvedValue(undefined)
  const toast = vi.fn()
  const ui = { dialog: { select, confirm, alert }, toast: { show: toast } }
  return { admin, select, confirm, alert, toast, ui }
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

  it("lists accounts and shows every live quota in one readable dialog without selecting accounts", async () => {
    const state = fixture()
    state.admin.quotas.mockResolvedValueOnce("a@example.com: claude: 25%, gemini: 75%; gemini-cli: 80%\nb@example.com: quota unavailable")
    state.select.mockResolvedValueOnce("list").mockResolvedValueOnce("quotas")
      .mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.list).toHaveBeenCalledOnce()
    expect(state.admin.quotas).toHaveBeenCalledOnce()
    expect(state.admin.quotas).toHaveBeenCalledWith()
    expect(state.select).toHaveBeenCalledTimes(3)
    expect(state.confirm).not.toHaveBeenCalled()
    const quotaDialogs = state.alert.mock.calls.map(([value]) => value).filter((value) => value.title.startsWith("Live quotas"))
    expect(quotaDialogs).toHaveLength(1)
    expect(quotaDialogs[0]!.message).toBe("a@example.com:\n  claude: 25%\n  gemini: 75%\n  gemini-cli: 80%\n\nb@example.com:\n  quota unavailable")
    expect(JSON.stringify(state.select.mock.calls)).not.toContain("secret-token")
  })

  it("gives every quota and status its own equally indented line without paging accounts", async () => {
    const state = fixture()
    state.admin.quotas.mockResolvedValueOnce("a@example.com: gemini-flash: 90%, gemini-pro: 75%, claude: 40%; No Gemini CLI quota available\nb@example.com: models/gemini-2.5_flash: 60%, claude: 30%; quota check failed: try again")
    state.select.mockResolvedValueOnce("quotas").mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.quotas).toHaveBeenCalledOnce()
    expect(state.alert).toHaveBeenCalledOnce()
    expect(state.alert.mock.calls[0]![0]).toEqual({
      title: "Live quotas · All accounts",
      message: "a@example.com:\n  gemini-flash: 90%\n  gemini-pro: 75%\n  claude: 40%\n  No Gemini CLI quota available\n\nb@example.com:\n  models/gemini-2.5_flash: 60%\n  claude: 30%\n  quota check failed: try again",
    })
    expect(state.confirm).not.toHaveBeenCalled()
    expect(state.select).toHaveBeenCalledTimes(2)
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

  it("shows real OAuth guidance for add/refresh without starting a login", async () => {
    const state = fixture()
    state.select.mockResolvedValueOnce("add").mockResolvedValueOnce("refresh")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" }).mockResolvedValueOnce("close")
    await openAccountMenu(state.ui as never, async () => state.admin as unknown as AccountAdmin)
    expect(state.admin.addAccount).toHaveBeenCalledOnce()
    expect(state.admin.refreshAccount).toHaveBeenCalledWith("opaque-a")
    expect(state.alert.mock.calls.map(([value]) => value.message).join(" ")).toContain("opencode auth login")
    expect(state.alert.mock.calls.map(([value]) => value.message).join(" ")).toContain("antigravity-accounts refresh")
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
})
