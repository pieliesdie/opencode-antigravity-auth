import { expect, it } from "vitest"
import { prepareAntigravityRequest } from "./request.ts"
import { retryAfterMs } from "./retry-after.ts"

const url = "https://generativelanguage.googleapis.com/v1beta/models/antigravity-gemini-4-hydrogen:generateContent"
const intro = "## Code Mode tools (call only inside `execute`)\n- opencode (2 tools)\n"
const entry = "  - tools.opencode.session_move({\n  directory: string,\n}): Promise<{\n  directory: string,\n}> // Move a session to another directory, or omit sessionID to move the current session.\n"
const next = "  - tools.opencode.session_rename({ title: string }): Promise<void> // Rename."
const hint = "When you create a worktree outside the current working directory and intend to use it as your primary working directory, consider using `execute` to call `tools.opencode.session_move` and make the worktree the session's working directory."
const authored = "Document tools.opencode.session_move verbatim."

it.each([false, true])("preserves authored mentions and removes both stock constructs (wrapped=%s)", wrapped => {
  for (const structured of [false, true]) {
    const catalog = intro + entry + next
    const systemInstruction = structured ? { parts: [{ text: catalog }, { text: hint }, { text: authored }] } : [catalog, hint, authored].join("\n")
    const request = { systemInstruction, contents: [{ role: "user", parts: [{ text: authored }] }] }
    const prepared = prepareAntigravityRequest(url, { method: "POST", body: JSON.stringify(wrapped ? { project: "p", request } : request) }, "access", "p", undefined, "antigravity")
    const wire = JSON.parse(String(prepared.init.body)).request
    const text: string = typeof wire.systemInstruction === "string" ? wire.systemInstruction : wire.systemInstruction.parts.map((p: { text: string }) => p.text).join("\n")
    expect(text).toContain(intro + next)
    expect(text).not.toContain(hint)
    expect(text.match(/tools\.opencode\.session_move/g)).toHaveLength(1)
    expect(text).toContain(authored)
    expect(wire.contents).toEqual(request.contents)
  }
})

it("reads server retry times without treating a missing header as a deadline", () => {
  const now = Date.UTC(2026, 0, 1)
  expect(retryAfterMs(new Headers({ "retry-after": new Date(now + 13_000).toUTCString() }), now)).toBe(13_000)
  expect(retryAfterMs(new Headers({ "retry-after": "2" }))).toBe(2000)
  expect(retryAfterMs(new Headers({ "retry-after-ms": "125" }))).toBe(125)
  expect(retryAfterMs(new Headers({ "retry-after": "0" }))).toBe(0)
  expect(retryAfterMs(new Headers({ "retry-after": "2x" }))).toBeUndefined()
})
