import { afterEach, expect, it, vi } from "vitest"
import { authorizeAntigravity, cancelAuthorization, exchangeAntigravity } from "./oauth.ts"

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

it("binds concurrent callbacks to their own one-time PKCE verifier", async () => {
  const [a, b] = await Promise.all([authorizeAntigravity("a"), authorizeAntigravity("b")])
  const state = (url: string) => new URL(url).searchParams.get("state")!
  const [first, second] = [state(a.url), state(b.url)]
  expect(first).not.toBe(second)
  expect(Buffer.from(first, "base64url").toString()).not.toContain(a.verifier)
  const exchange = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === "POST") return Response.json({ access_token: "access", expires_in: 3600, refresh_token: "refresh" })
    return Response.json({})
  })
  vi.stubGlobal("fetch", exchange)
  expect((await exchangeAntigravity("code", second, first)).type).toBe("failed")
  expect(exchange).not.toHaveBeenCalled()
  expect(await exchangeAntigravity("code", second, second)).toMatchObject({ type: "success", projectId: "b" })
  expect((exchange.mock.calls[0]?.[1].body as URLSearchParams).get("code_verifier")).toBe(b.verifier)
  expect((await exchangeAntigravity("code", second, second)).type).toBe("failed")
  cancelAuthorization(first)
  expect((await exchangeAntigravity("code", first, first)).type).toBe("failed")
  expect(exchange).toHaveBeenCalledTimes(2)
})

it("expires an abandoned login without opening another one", async () => {
  vi.useFakeTimers()
  const { url } = await authorizeAntigravity()
  const state = new URL(url).searchParams.get("state")!
  vi.advanceTimersByTime(30 * 60_000)
  const network = vi.fn()
  vi.stubGlobal("fetch", network)
  expect((await exchangeAntigravity("code", state, state)).type).toBe("failed")
  expect(network).not.toHaveBeenCalled()
})

it("invalidates a manual login when its runtime is disposed", async () => {
  const lifetime = new AbortController()
  const { url } = await authorizeAntigravity("project", lifetime.signal)
  const state = new URL(url).searchParams.get("state")!
  const network = vi.fn()
  vi.stubGlobal("fetch", network)
  lifetime.abort()
  expect((await exchangeAntigravity("code", state, state)).type).toBe("failed")
  expect(network).not.toHaveBeenCalled()
})
