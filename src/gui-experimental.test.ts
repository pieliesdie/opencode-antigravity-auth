import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { AntigravityAccountsRpc } from "./antigravity-rpc.ts"
import type { AccountView } from "./plugin/account-admin.ts"

const mocks = vi.hoisted(() => ({
  cleanupCallbacks: [] as Array<() => void>,
  forComponent: <T,>(props: { each: readonly T[]; children: unknown }) => {
    const render = Array.isArray(props.children) ? props.children[0] : props.children
    return typeof render === "function" ? props.each.map((item) => render(item)) : []
  },
}))

vi.mock("@opencode/plugin/gui", () => ({
  Command: Symbol("Command"),
  Plugin: { define: (definition: unknown) => definition },
}))

vi.mock("solid-js", () => ({
  createSignal<T>(initial: T): [() => T, (next: T | ((prev: T) => T)) => T] {
    let value = initial
    const get = () => value
    const set = (next: T | ((prev: T) => T)) => {
      value = typeof next === "function" ? (next as (prev: T) => T)(value) : next
      return value
    }
    return [get, set]
  },
  createMemo<T>(fn: () => T) {
    return fn
  },
  For: mocks.forComponent,
  onCleanup(fn: () => void) {
    mocks.cleanupCallbacks.push(fn)
  },
  Show: (props: Record<string, unknown>) => props,
}))

const { openGuiAccountMenu, runGuiOAuth, default: guiPlugin } = await import("./gui-experimental.tsx")

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

interface RenderedNode {
  type: unknown
  props: Record<string, unknown>
  children: unknown[]
}

function findNodes(root: unknown, predicate: (node: RenderedNode) => boolean): RenderedNode[] {
  const matches: RenderedNode[] = []
  const visit = (value: unknown) => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) {
      for (const item of value) visit(item)
      return
    }
    const candidate = value as Partial<RenderedNode>
    if ("type" in candidate && "props" in candidate && candidate.props && typeof candidate.props === "object") {
      const node = candidate as RenderedNode
      if (predicate(node)) matches.push(node)
      visit(node.props.footer)
      visit(node.props.children)
      visit(node.children)
    }
  }
  visit(root)
  return matches
}

function createGuiFixture(accounts: AccountView[] = [
  { id: "opaque-a", label: "a@example.com", enabled: true, verificationRequired: false },
  { id: "opaque-b", label: "b@example.com", enabled: false, verificationRequired: true },
]) {
  const rpcHandlers = {
    snapshot: vi.fn().mockResolvedValue({ snapshotId: "snap-1", accounts }),
    releaseSnapshot: vi.fn().mockResolvedValue({ ok: true }),
    list: vi.fn().mockResolvedValue({ message: "1. a@example.com — enabled" }),
    quotas: vi.fn().mockResolvedValue({ message: "a@example.com: claude: 25%\nb@example.com: gemini: 80%" }),
    models: vi.fn().mockResolvedValue({ message: "a@example.com: available (1): gemini-4-hydrogen" }),
    setModelRules: vi.fn().mockResolvedValue({ message: "Model rules updated." }),
    verify: vi.fn().mockResolvedValue({ message: "a@example.com: ok — ready" }),
    setEnabled: vi.fn().mockResolvedValue({ message: "Account updated." }),
    remove: vi.fn().mockResolvedValue({ message: "Removed b@example.com." }),
    removeAll: vi.fn().mockResolvedValue({ message: "Removed all." }),
    configureModels: vi.fn().mockResolvedValue({ message: "Models configured." }),
    oauthStart: vi.fn().mockResolvedValue({
      attemptId: "attempt-1",
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=state-123",
      listening: true,
    }),
    oauthWait: vi.fn().mockResolvedValue({ status: "completed", message: "Added c@example.com (3 account(s) total)." }),
    oauthComplete: vi.fn().mockResolvedValue({ message: "Added c@example.com (3 account(s) total)." }),
    oauthCancel: vi.fn().mockResolvedValue({ ok: true }),
  }

  const select = vi.fn()
  const confirm = vi.fn().mockResolvedValue(true)
  const alert = vi.fn().mockResolvedValue(undefined)
  const prompt = vi.fn().mockResolvedValue(undefined)
  const renderedDialogs: unknown[] = []
  const openClose = vi.fn(() => {
    while (mocks.cleanupCallbacks.length) {
      mocks.cleanupCallbacks.pop()?.()
    }
  })
  const open = vi.fn((render: (dialog: { close: () => void }) => unknown) => {
    const handle = { close: openClose }
    renderedDialogs.push(render(handle))
    return handle
  })
  const toastShow = vi.fn(() => ({ dismiss: vi.fn() }))
  const openExternal = vi.fn()
  const copy = vi.fn().mockResolvedValue(undefined)
  const rpcFactory = vi.fn((definition: unknown) => {
    expect(definition).toBe(AntigravityAccountsRpc)
    return rpcHandlers
  })

  const uiDialog = (props: Record<string, unknown>) => ({ type: "Dialog", props, children: [] })
  const uiButton = (props: Record<string, unknown>) => ({ type: "Button", props, children: [] })
  const uiTextInput = (props: Record<string, unknown>) => ({ type: "TextInput", props, children: [] })
  const uiSwitch = (props: Record<string, unknown>) => ({ type: "Switch", props, children: [] })
  const ctx = {
    client: { rpc: rpcFactory },
    dialogs: { select, confirm, alert, prompt, open, active: () => false },
    toast: { show: toastShow },
    system: { openExternal, copy, save: vi.fn() },
    ui: { Dialog: uiDialog, Button: uiButton, TextInput: uiTextInput, Switch: uiSwitch },
  }
  return {
    ctx,
    rpcHandlers,
    rpcFactory,
    select,
    confirm,
    alert,
    prompt,
    open,
    openClose,
    renderedDialogs,
    toastShow,
    openExternal,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mocks.cleanupCallbacks.length = 0
  vi.stubGlobal("React", {
    Fragment: Symbol("Fragment"),
    createElement: (type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): RenderedNode | unknown => {
      const mergedProps = { ...(props ?? {}), ...(children.length ? { children } : {}) }
      if (type === mocks.forComponent) return mocks.forComponent(mergedProps as { each: readonly unknown[]; children: unknown })
      return { type, props: mergedProps, children }
    },
  })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("Desktop GUI Antigravity account command", () => {
  it("registers /antigravity-accounts slash command and prevents concurrent opens", async () => {
    const state = createGuiFixture()
    const menuGate = deferred<string | undefined>()
    state.select.mockReturnValueOnce(menuGate.promise)
    const add = vi.fn()
    const setup = (guiPlugin as unknown as { setup: (ctx: unknown) => void }).setup
    setup({ ...state.ctx, add })

    expect(add).toHaveBeenCalledOnce()
    const command = add.mock.calls[0]![1]() as {
      id: string
      slash: { name: string }
      run: () => Promise<void>
    }
    expect(command.id).toBe("accounts")
    expect(command.slash).toEqual({ name: "antigravity-accounts" })

    const first = command.run()
    const second = command.run()
    await vi.waitFor(() => expect(state.select).toHaveBeenCalledOnce())
    expect(state.rpcHandlers.snapshot).toHaveBeenCalledOnce()

    menuGate.resolve("close")
    await Promise.all([first, second])
    expect(state.rpcHandlers.releaseSnapshot).toHaveBeenCalledWith({ snapshotId: "snap-1" })
  })

  it("hides disabled options when no accounts exist and executes RPC actions cleanly", async () => {
    const emptyState = createGuiFixture([])
    emptyState.select.mockResolvedValueOnce("close")
    await openGuiAccountMenu(emptyState.ctx as never)
    const emptyOptions = emptyState.select.mock.calls[0]![0].options as Array<{ value: string; group?: string }>
    expect(emptyOptions.map((item) => item.value)).toEqual(["list", "add", "models", "close"])
    expect(emptyOptions[0]?.group).toBe("Accounts")

    const state = createGuiFixture()
    state.rpcHandlers.list.mockResolvedValueOnce({
      message: "1. a@example.com — enabled\n2. b@example.com — disabled",
    })
    state.select
      .mockResolvedValueOnce("list")
      .mockResolvedValueOnce("quotas")
      .mockResolvedValueOnce("__back__")
      .mockResolvedValueOnce("remove")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-b" })
      .mockResolvedValueOnce("models")
      .mockResolvedValueOnce("close")

    const originalOpen = state.open.getMockImplementation()!
    state.open.mockImplementation((render) => {
      const handle = originalOpen(render)
      const root = state.renderedDialogs.at(-1)
      const buttons = findNodes(root, (node) => node.type === state.ctx.ui.Button)
      const actionButton = buttons.find((node) =>
        node.props.variant === "danger" || (Array.isArray(node.children) && node.children.includes("OK")),
      )
      queueMicrotask(() => {
        (actionButton?.props.onClick as (() => void) | undefined)?.()
      })
      return handle
    })

    await openGuiAccountMenu(state.ctx as never)

    const [listDialog] = findNodes(state.renderedDialogs[0], (node) => node.type === state.ctx.ui.Dialog)
    expect(listDialog?.props.title).toBe("Saved Google accounts")
    const [preWrapContainer] = findNodes(state.renderedDialogs[0], (node) =>
      node.type === "div" && (node.props.style as Record<string, string> | undefined)?.["white-space"] === "pre-wrap",
    )
    expect(preWrapContainer?.children).toEqual(["1. a@example.com — enabled\n2. b@example.com — disabled"])

    expect(state.rpcHandlers.quotas).toHaveBeenCalledWith({ snapshotId: "snap-1" })
    const [removeDialog] = findNodes(state.renderedDialogs[1], (node) => node.type === state.ctx.ui.Dialog)
    expect(removeDialog?.props.title).toBe("Remove 1 Google account(s)?")
    expect(state.rpcHandlers.remove).toHaveBeenCalledWith({
      snapshotId: "snap-1",
      ids: ["opaque-b"],
      confirm: true,
    })
    expect(state.confirm).toHaveBeenCalledWith(expect.objectContaining({
      title: "Replace Google models?",
    }))
    expect(state.rpcHandlers.releaseSnapshot).toHaveBeenCalledWith({ snapshotId: "snap-1" })
  })

  it("opens external browser, shows auto-closing dialog during auto OAuth, and closes when callback completes", async () => {
    const state = createGuiFixture()
    const waitGate = deferred<{ status: "completed"; message: string }>()
    state.rpcHandlers.oauthWait.mockReturnValueOnce(waitGate.promise)
    state.select.mockResolvedValueOnce("auto")

    const flow = runGuiOAuth(state.ctx as never, "snap-1", "Add a Google account")
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce())

    expect(state.openExternal).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?state=state-123")
    expect(state.rpcHandlers.oauthStart).toHaveBeenCalledWith({ snapshotId: "snap-1", mode: "auto" })

    waitGate.resolve({ status: "completed", message: "Added c@example.com." })
    await expect(flow).resolves.toBe("Added c@example.com.")
    expect(state.openClose).toHaveBeenCalledOnce()
    expect(state.rpcHandlers.oauthCancel).not.toHaveBeenCalled()
  })

  it("allows pasting a callback URL inside the waiting dialog to complete auto OAuth early", async () => {
    const state = createGuiFixture()
    const waitGate = deferred<{ status: "cancelled" }>()
    state.rpcHandlers.oauthWait.mockReturnValueOnce(waitGate.promise)
    state.select.mockResolvedValueOnce("auto")

    const flow = runGuiOAuth(state.ctx as never, "snap-1", "Add a Google account")
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce())

    const [inputNode] = findNodes(state.renderedDialogs[0], (node) => node.type === state.ctx.ui.TextInput)
    expect(inputNode).toBeDefined()
    ;(inputNode!.props.onInput as (value: string) => void)("http://localhost:51121/oauth-callback?code=manual-1&state=state-123")
    await (inputNode!.props.onSubmit as () => void)()

    await expect(flow).resolves.toBe("Added c@example.com (3 account(s) total).")
    expect(state.rpcHandlers.oauthComplete).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      rawCallback: "http://localhost:51121/oauth-callback?code=manual-1&state=state-123",
    })
    expect(state.openClose).toHaveBeenCalledOnce()
    expect(state.rpcHandlers.oauthCancel).not.toHaveBeenCalled()
  })

  it("cancels server OAuth listener when user closes the waiting dialog", async () => {
    const state = createGuiFixture()
    const waitGate = deferred<{ status: "cancelled" }>()
    state.rpcHandlers.oauthWait.mockReturnValueOnce(waitGate.promise)
    state.select.mockResolvedValueOnce("auto")

    const flow = runGuiOAuth(state.ctx as never, "snap-1", "Add a Google account")
    await vi.waitFor(() => expect(state.open).toHaveBeenCalledOnce())

    state.openClose()
    await expect(flow).resolves.toBeUndefined()
    expect(state.rpcHandlers.oauthCancel).toHaveBeenCalledWith({ attemptId: "attempt-1" })
  })

  it("supports manual OAuth fallback and cancels cleanly if prompt is dismissed", async () => {
    const state = createGuiFixture()
    state.select.mockResolvedValueOnce("manual").mockResolvedValueOnce("manual")
    state.prompt
      .mockResolvedValueOnce("http://localhost:51121/oauth-callback?code=abc&state=state-123")
      .mockResolvedValueOnce(undefined)

    const completed = await runGuiOAuth(state.ctx as never, "snap-1", "Add a Google account")
    expect(completed).toBe("Added c@example.com (3 account(s) total).")
    expect(state.rpcHandlers.oauthComplete).toHaveBeenCalledWith({
      attemptId: "attempt-1",
      rawCallback: "http://localhost:51121/oauth-callback?code=abc&state=state-123",
    })

    const cancelled = await runGuiOAuth(state.ctx as never, "snap-1", "Add a Google account")
    expect(cancelled).toBeUndefined()
    expect(state.rpcHandlers.oauthCancel).toHaveBeenCalledWith({ attemptId: "attempt-1" })
  })

  it("toggles multiple models in one open dialog before saving or cancelling", async () => {
    const state = createGuiFixture([
      {
        id: "opaque-a",
        label: "a@example.com",
        enabled: true,
        verificationRequired: false,
        disabledModels: ["gemini-4-argon"],
        cachedAvailableModels: ["gemini-4-argon", "gemini-4-hydrogen", "claude-opus-4-6-thinking"],
      },
    ])
    state.select
      .mockResolvedValueOnce("model-access")
      .mockResolvedValueOnce("toggle-deny")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" })
      .mockResolvedValueOnce("model-access")
      .mockResolvedValueOnce("toggle-allow")
      .mockResolvedValueOnce({ kind: "account", id: "opaque-a" })
      .mockResolvedValueOnce("close")

    const originalOpen = state.open.getMockImplementation()!
    let dialogIndex = 0
    state.open.mockImplementation((render) => {
      const handle = originalOpen(render)
      const root = state.renderedDialogs.at(-1)
      const step = dialogIndex++
      queueMicrotask(() => {
        if (step === 0) {
          const switches = findNodes(root, (node) => node.type === state.ctx.ui.Switch)
          const argon = switches.find((node) => node.props.label === "gemini-4-argon")
          const hydrogen = switches.find((node) => node.props.label === "gemini-4-hydrogen")
          const claude = switches.find((node) => node.props.label === "claude-opus-4-6-thinking")
          ;(argon?.props.onChange as (checked: boolean) => void)(false)
          ;(hydrogen?.props.onChange as (checked: boolean) => void)(true)
          ;(claude?.props.onChange as (checked: boolean) => void)(true)
          const buttons = findNodes(root, (node) => node.type === state.ctx.ui.Button)
          const save = buttons.find((node) => Array.isArray(node.children) && node.children.includes("Save"))
          ;(save?.props.onClick as () => void)()
          return
        }
        if (step === 1) {
          const buttons = findNodes(root, (node) => node.type === state.ctx.ui.Button)
          const ok = buttons.find((node) => Array.isArray(node.children) && node.children.includes("OK"))
          ;(ok?.props.onClick as () => void)()
          return
        }
        const switches = findNodes(root, (node) => node.type === state.ctx.ui.Switch)
        const hydrogen = switches.find((node) => node.props.label === "gemini-4-hydrogen")
        ;(hydrogen?.props.onChange as (checked: boolean) => void)(true)
        const buttons = findNodes(root, (node) => node.type === state.ctx.ui.Button)
        const cancel = buttons.find((node) => Array.isArray(node.children) && node.children.includes("Cancel"))
        ;(cancel?.props.onClick as () => void)()
      })
      return handle
    })

    await openGuiAccountMenu(state.ctx as never)

    expect(state.rpcHandlers.setModelRules).toHaveBeenCalledTimes(1)
    expect(state.rpcHandlers.setModelRules).toHaveBeenCalledWith({
      snapshotId: "snap-1",
      ids: ["opaque-a"],
      deny: ["claude-opus-4-6-thinking", "gemini-4-hydrogen"],
    })
  })
})
