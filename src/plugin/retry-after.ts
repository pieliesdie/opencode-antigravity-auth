/** Distinguish an explicit zero from "the server gave no retry time". */
export function retryAfterMs(headers: Headers, now = Date.now()): number | undefined {
  for (const [name, unit] of [["retry-after-ms", 1], ["retry-after", 1000]] as const) {
    const value = headers.get(name)?.trim()
    if (!value) continue
    if (/^\d+$/.test(value)) {
      const delay = Number(value) * unit
      if (Number.isSafeInteger(delay)) return delay
    } else if (name === "retry-after" && /GMT$/i.test(value)) {
      const deadline = Date.parse(value)
      if (Number.isFinite(deadline)) return Math.max(0, deadline - now)
    }
  }
  return undefined
}
