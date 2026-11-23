import { AsyncLocalStorage } from "node:async_hooks"
import { createHash } from "node:crypto"
import type { LanguageModelV3CallOptions } from "@ai-sdk/provider"

type ToolKey = "functionCall" | "functionResponse"
interface Identity { key: ToolKey; name: string; id: string }
// The driver and the server interceptor are separate entrypoints in dist.
// Share the context carrier, never the identities between concurrent calls.
const storageKey = Symbol.for("@pieliesdie/antigravity-auth/google-tool-ids/v1")
const shared = globalThis as typeof globalThis & { [storageKey]?: AsyncLocalStorage<Identity[]> }
const identityContext = shared[storageKey] ??= new AsyncLocalStorage<Identity[]>()

/** @ai-sdk/google 3.0.24 omits toolCallId when serializing both halves. Keep
 * only the ordered identities, scoped to this driver invocation (never a header). */
export function withGoogleToolIds<T>(options: LanguageModelV3CallOptions, run: () => T): T {
  const ids: Identity[] = []
  for (const message of options.prompt) {
    if (message.role !== "assistant" && message.role !== "tool") continue
    for (const part of message.content) {
      if (part.type === "tool-call") ids.push({ key: "functionCall", name: part.toolName, id: part.toolCallId })
      if (part.type !== "tool-result") continue
      const count = part.output.type === "content" ? part.output.value.filter((item) => item.type === "text").length : 1
      for (let i = 0; i < count; i++) ids.push({ key: "functionResponse", name: part.toolName, id: part.toolCallId })
    }
  }
  return identityContext.run(ids, run)
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value)
}

function wireId(id: string): string {
  if (/^[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}$/i.test(id)) return id
  const hash = createHash("sha256").update(id).digest("hex")
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-8${hash.slice(13, 16)}-${((parseInt(hash[16]!, 16) & 3) | 8).toString(16)}${hash.slice(17, 20)}-${hash.slice(20, 32)}`
}

export function normalizeGeminiTools(contents: unknown): void {
  if (!Array.isArray(contents)) return
  const fields: Array<{ key: ToolKey; field: Record<string, unknown> }> = []
  for (const turn of contents) {
    if (!record(turn) || !Array.isArray(turn.parts)) continue
    const results: Array<{ field: Record<string, unknown>; content: unknown }> = []
    for (const part of turn.parts) {
      if (!record(part)) continue
      for (const key of ["functionCall", "functionResponse"] as const) {
        const field = part[key]
        if (!record(field)) continue
        fields.push({ key, field })
        if (key === "functionCall" && typeof part.thought_signature === "string") {
          part.thoughtSignature ??= part.thought_signature
          delete part.thought_signature
        }
        if (key !== "functionResponse" || !record(field.response)) continue
        const response = field.response
        if ("content" in response && Object.keys(response).every((k) => k === "name" || k === "content")) {
          results.push({ field, content: response.content })
        }
      }
    }
    if (turn.role === "user" && results.length && results.length === turn.parts.length) {
      turn.role = "model"
      for (const { field, content } of results) field.response = { output: typeof content === "string" ? content : JSON.stringify(content) }
    }
  }
  const source = identityContext.getStore()
  const matches = source?.length === fields.length && fields.every(({ key, field }, i) =>
    source[i]?.key === key && source[i]?.name === field.name)
  for (const [i, { field }] of fields.entries()) {
    const id = field.id ?? (matches ? source?.[i]?.id : undefined)
    if (typeof id === "string" && id) field.id = wireId(id)
  }
}
