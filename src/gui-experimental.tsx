import { createMemo, createSignal, For, onCleanup, Show } from "solid-js"
import { Command, Plugin } from "@opencode/plugin/gui"
import type { Context, DialogHandle } from "@opencode/plugin/gui"
import { AntigravityAccountsRpc } from "./antigravity-rpc.ts"
import { openAccountMenuWithUI } from "./account-menu.ts"
import type { AccountMenuBackend, AccountMenuUI } from "./account-menu.ts"

type OAuthMode = "auto" | "manual" | "back"

function openTextAlert(
  ctx: Pick<Context, "dialogs" | "ui">,
  title: string,
  message: string,
): Promise<void> {
  const ui = ctx.ui
  return new Promise<void>((resolve) => {
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      resolve()
    }
    ctx.dialogs.open((dialog) => {
      onCleanup(finish)
      return (
        <ui.Dialog
          title={title}
          size={message.length > 260 ? "large" : "fit"}
          footer={(
            <ui.Button variant="contrast" autofocus onClick={() => dialog.close()}>
              OK
            </ui.Button>
          )}
        >
          <div style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere", "font-size": "13px", "line-height": "1.5" }}>
            {message}
          </div>
        </ui.Dialog>
      )
    })
  })
}

function openTextConfirm(
  ctx: Pick<Context, "dialogs" | "ui">,
  options: {
    readonly title: string
    readonly message: string
    readonly confirm: string
    readonly cancel: string
    readonly danger?: boolean
  },
): Promise<boolean> {
  if (!options.message.includes("\n")) {
    return ctx.dialogs.confirm({
      title: options.title,
      description: options.message,
      confirm: options.confirm,
      cancel: options.cancel,
      danger: options.danger,
    })
  }
  const ui = ctx.ui
  return new Promise<boolean>((resolve) => {
    let settled = false
    const finish = (confirmed: boolean) => {
      if (settled) return
      settled = true
      resolve(confirmed)
    }
    ctx.dialogs.open((dialog) => {
      onCleanup(() => finish(false))
      return (
        <ui.Dialog
          title={options.title}
          size={options.message.length > 260 ? "large" : "fit"}
          footer={(
            <>
              <ui.Button variant="neutral" autofocus={options.danger} onClick={() => { finish(false); dialog.close() }}>
                {options.cancel}
              </ui.Button>
              <ui.Button
                variant={options.danger ? "danger" : "contrast"}
                autofocus={!options.danger}
                onClick={() => { finish(true); dialog.close() }}
              >
                {options.confirm}
              </ui.Button>
            </>
          )}
        >
          <div style={{ "white-space": "pre-wrap", "overflow-wrap": "anywhere", "font-size": "13px", "line-height": "1.5" }}>
            {options.message}
          </div>
        </ui.Dialog>
      )
    })
  })
}

function openMultiSelect(
  ctx: Pick<Context, "dialogs" | "ui">,
  options: {
    readonly title: string
    readonly description?: string
    readonly placeholder?: string
    readonly items: readonly { readonly id: string; readonly selected: boolean }[]
    readonly confirmLabel?: string
  },
): Promise<readonly string[] | undefined> {
  const ui = ctx.ui
  return new Promise<readonly string[] | undefined>((resolve) => {
    let settled = false
    const finish = (value?: readonly string[]) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    const [filter, setFilter] = createSignal("")
    const [selected, setSelected] = createSignal<ReadonlySet<string>>(
      new Set(options.items.filter((item) => item.selected).map((item) => item.id)),
    )
    const filtered = createMemo(() => {
      const query = filter().trim().toLowerCase()
      return query ? options.items.filter((item) => item.id.toLowerCase().includes(query)) : options.items
    })
    const toggle = (id: string, checked?: boolean) => {
      setSelected((prev) => {
        const next = new Set(prev)
        const enable = checked ?? !next.has(id)
        if (enable) next.add(id)
        else next.delete(id)
        return next
      })
    }

    ctx.dialogs.open((dialog) => {
      onCleanup(() => finish(undefined))
      return (
        <ui.Dialog
          title={options.title}
          description={options.description}
          size="large"
          footer={(
            <>
              <span style={{ "margin-right": "auto", "font-size": "12px", opacity: "0.7" }}>
                {selected().size} selected
              </span>
              <ui.Button variant="neutral" onClick={() => { finish(undefined); dialog.close() }}>
                Cancel
              </ui.Button>
              <ui.Button variant="contrast" onClick={() => { finish([...selected()].sort()); dialog.close() }}>
                {options.confirmLabel ?? "Save"}
              </ui.Button>
            </>
          )}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "10px" }}>
            <ui.TextInput
              label="Filter models"
              placeholder={options.placeholder ?? "Filter…"}
              value={filter()}
              onInput={setFilter}
              autofocus
            />
            <div style={{ display: "flex", "flex-direction": "column", gap: "4px" }}>
              <For each={filtered()}>
                {(item) => (
                  <div
                    style={{
                      display: "flex",
                      "align-items": "center",
                      "justify-content": "space-between",
                      gap: "12px",
                      padding: "6px 8px",
                      "border-radius": "6px",
                      cursor: "pointer",
                    }}
                    onClick={() => toggle(item.id)}
                  >
                    <span style={{ "font-size": "13px", "overflow-wrap": "anywhere" }}>{item.id}</span>
                    <div onClick={(event) => event.stopPropagation()}>
                      <ui.Switch
                        label={item.id}
                        hideLabel
                        checked={selected().has(item.id)}
                        onChange={(checked) => toggle(item.id, checked)}
                      />
                    </div>
                  </div>
                )}
              </For>
            </div>
          </div>
        </ui.Dialog>
      )
    })
  })
}

function createGuiMenuUI(ctx: Pick<Context, "dialogs" | "toast" | "ui">): AccountMenuUI {
  return {
    select(options) {
      return ctx.dialogs.select({
        title: options.title,
        placeholder: options.placeholder,
        options: options.options
          .filter((option) => !option.disabled)
          .map((option) => ({
            title: option.title,
            value: option.value,
            description: option.description,
            group: option.category,
          })),
      })
    },
    selectMultiple(options) {
      return openMultiSelect(ctx, options)
    },
    confirm(options) {
      return openTextConfirm(ctx, options)
    },
    alert(options) {
      return openTextAlert(ctx, options.title, options.message)
    },
    toast(message) {
      ctx.toast.show({
        title: "Antigravity accounts",
        description: message,
        variant: "default",
      })
    },
  }
}

export async function runGuiOAuth(
  ctx: Pick<Context, "client" | "dialogs" | "toast" | "system" | "ui">,
  snapshotId: string,
  title: string,
  accountId?: string,
): Promise<string | undefined> {
  const mode = await ctx.dialogs.select<OAuthMode>({
    title,
    placeholder: "Choose sign-in method",
    options: [
      {
        title: "Sign in with browser (automatic)",
        value: "auto",
        description: "Opens Google sign-in and captures localhost redirect automatically",
        group: "Google OAuth",
      },
      {
        title: "Manual sign-in (paste redirect URL or code)",
        value: "manual",
        description: "Show OAuth URL to open in any browser/profile and paste the callback",
        group: "Google OAuth",
      },
      { title: "Back", value: "back", group: "Navigation" },
    ],
  })
  if (!mode || mode === "back") return undefined

  const rpc = () => ctx.client.rpc(AntigravityAccountsRpc)
  const started = await rpc().oauthStart({
    snapshotId,
    mode,
    ...(accountId ? { accountId } : {}),
  })

  if (mode === "auto") {
    ctx.system.openExternal(started.url)
    ctx.toast.show({
      title,
      description: "Opened Google sign-in in your browser…",
      variant: "default",
    })
  }

  if (mode === "manual" || !started.listening) {
    try {
      const rawCallback = await ctx.dialogs.prompt({
        title,
        description: `Open this URL in your browser, complete Google sign-in, and paste the redirect URL (or code) below:\n\n${started.url}`,
        placeholder: "http://localhost:51121/oauth-callback?code=…",
        submit: "Complete sign-in",
      })
      if (rawCallback === undefined) {
        await rpc().oauthCancel({ attemptId: started.attemptId }).catch(() => undefined)
        return undefined
      }
      const completed = await rpc().oauthComplete({ attemptId: started.attemptId, rawCallback })
      return completed.message
    } catch (error: unknown) {
      await rpc().oauthCancel({ attemptId: started.attemptId }).catch(() => undefined)
      throw error
    }
  }

  const ui = ctx.ui
  return new Promise<string | undefined>((resolve, reject) => {
    let settled = false
    let dialogHandle: DialogHandle | undefined
    const waitController = new AbortController()

    const finish = (value?: string) => {
      if (settled) return
      settled = true
      dialogHandle?.close()
      resolve(value)
    }
    const fail = (error: unknown) => {
      if (settled) return
      settled = true
      dialogHandle?.close()
      reject(error)
    }

    const [callbackInput, setCallbackInput] = createSignal("")
    const [submitting, setSubmitting] = createSignal(false)
    const [copied, setCopied] = createSignal(false)
    const [statusText, setStatusText] = createSignal(
      "Complete sign-in in your browser — this dialog closes automatically. You can also paste the redirect URL below:",
    )
    const [errorText, setErrorText] = createSignal<string | undefined>(undefined)

    const submitManual = async () => {
      const value = callbackInput().trim()
      if (!value || submitting()) return
      setSubmitting(true)
      setErrorText(undefined)
      try {
        const result = await rpc().oauthComplete({ attemptId: started.attemptId, rawCallback: value })
        finish(result.message)
      } catch {
        setSubmitting(false)
        setErrorText("Invalid OAuth redirect URL or code. Check the URL and try again.")
      }
    }

    dialogHandle = ctx.dialogs.open((dialog) => {
      dialogHandle = dialog
      onCleanup(() => {
        if (settled) return
        waitController.abort()
        void rpc().oauthCancel({ attemptId: started.attemptId }).catch(() => undefined)
        finish(undefined)
      })

      return (
        <ui.Dialog
          title={title}
          description={statusText()}
          size="large"
          footer={(
            <>
              <ui.Button variant="neutral" onClick={() => dialog.close()}>
                Cancel
              </ui.Button>
              <ui.Button
                variant="contrast"
                busy={submitting()}
                disabled={!callbackInput().trim() || submitting()}
                onClick={() => void submitManual()}
              >
                Complete sign-in
              </ui.Button>
            </>
          )}
        >
          <div style={{ display: "flex", "flex-direction": "column", gap: "12px" }}>
            <div style={{ display: "flex", "align-items": "center", gap: "8px" }}>
              <ui.Button
                variant="ghost"
                size="small"
                icon="copy"
                onClick={() => {
                  void ctx.system.copy(started.url).then(() => setCopied(true)).catch(() => undefined)
                }}
              >
                {copied() ? "Copied sign-in URL" : "Copy sign-in URL"}
              </ui.Button>
              <ui.Button
                variant="ghost"
                size="small"
                onClick={() => ctx.system.openExternal(started.url)}
              >
                Open browser again
              </ui.Button>
            </div>
            <ui.TextInput
              label="Redirect URL or code"
              placeholder="Waiting for browser callback (or paste redirect URL)…"
              value={callbackInput()}
              onInput={(value) => {
                setCallbackInput(value)
                if (errorText()) setErrorText(undefined)
              }}
              onSubmit={() => void submitManual()}
              disabled={submitting()}
              invalid={Boolean(errorText())}
              autofocus
            />
            <Show when={errorText()}>
              {(message) => <div style={{ color: "var(--text-critical-base, #ef4444)", "font-size": "12px" }}>{message()}</div>}
            </Show>
          </div>
        </ui.Dialog>
      )
    })

    void rpc().oauthWait({ attemptId: started.attemptId }, { signal: waitController.signal })
      .then((result) => {
        if (settled) return
        if (result.status === "completed") {
          finish(result.message)
          return
        }
        if (result.status === "cancelled") {
          finish(undefined)
          return
        }
        setStatusText("Local callback timed out or was unavailable. Open the URL and paste the redirect URL below:")
      })
      .catch((error: unknown) => {
        if (settled || waitController.signal.aborted) return
        fail(error)
      })
  })
}

async function createGuiBackend(
  ctx: Pick<Context, "client" | "dialogs" | "toast" | "system" | "ui">,
): Promise<AccountMenuBackend> {
  const rpc = () => ctx.client.rpc(AntigravityAccountsRpc)
  const { snapshotId, accounts } = await rpc().snapshot({})
  return {
    accounts,
    async list() {
      return (await rpc().list({ snapshotId })).message
    },
    async quotas(ids) {
      return (await rpc().quotas({ snapshotId, ...(ids !== undefined ? { ids: [...ids] } : {}) })).message
    },
    async models(ids, options) {
      return (await rpc().models({
        snapshotId,
        ...(ids !== undefined ? { ids: [...ids] } : {}),
        ...(options?.refresh !== undefined ? { refresh: options.refresh } : {}),
      })).message
    },
    async setModelRules(ids, rules) {
      return (await rpc().setModelRules({
        snapshotId,
        ids: [...ids],
        ...(rules.allow !== undefined ? { allow: [...rules.allow] } : {}),
        ...(rules.deny !== undefined ? { deny: [...rules.deny] } : {}),
        ...(rules.clear !== undefined ? { clear: rules.clear } : {}),
      })).message
    },
    async verify(ids) {
      return (await rpc().verify({ snapshotId, ...(ids !== undefined ? { ids: [...ids] } : {}) })).message
    },
    async setEnabled(ids, enabled) {
      return (await rpc().setEnabled({ snapshotId, ids: [...ids], enabled })).message
    },
    async remove(ids, confirm) {
      return (await rpc().remove({ snapshotId, ids: [...ids], confirm })).message
    },
    async removeAll(confirm) {
      return (await rpc().removeAll({ snapshotId, confirm })).message
    },
    async configureModels() {
      return (await rpc().configureModels({ snapshotId })).message
    },
    addAccountWithOAuth() {
      return runGuiOAuth(ctx, snapshotId, "Add a Google account")
    },
    refreshAccountWithOAuth(account) {
      return runGuiOAuth(ctx, snapshotId, `Refresh sign-in · ${account.label}`, account.id)
    },
    async dispose() {
      await rpc().releaseSnapshot({ snapshotId }).catch(() => undefined)
    },
  }
}

export async function openGuiAccountMenu(
  ctx: Pick<Context, "client" | "dialogs" | "toast" | "system" | "ui">,
): Promise<void> {
  await openAccountMenuWithUI(createGuiMenuUI(ctx), () => createGuiBackend(ctx))
}

export default Plugin.define({
  setup(ctx) {
    let active = false
    ctx.add(Command, () => ({
      id: "accounts",
      title: "Manage Antigravity accounts",
      description: "Quotas, verification, rotation and Google sign-in help",
      group: "Antigravity",
      slash: { name: "antigravity-accounts" },
      async run() {
        if (active) return
        active = true
        try {
          await openGuiAccountMenu(ctx)
        } finally {
          active = false
        }
      },
    }))
  },
})
