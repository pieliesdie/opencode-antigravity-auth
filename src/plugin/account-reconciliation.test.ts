import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { AccountManager } from "./accounts.ts"
import { loadAccounts, removeAccountFromStorage, saveAccounts, updateAccountInStorage } from "./storage.ts"

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "antigravity-v2-control-"))
  dirs.push(dir)
  vi.stubEnv("OPENCODE_CONFIG_DIR", dir)
  await saveAccounts({ version: 4, activeIndex: 0, accounts: [
    { refreshToken: "first", email: "a@example.com", addedAt: 1, lastUsed: 0 },
    { refreshToken: "second", email: "b@example.com", addedAt: 1, lastUsed: 0 },
  ] })
  // Already-running server holds its own snapshot; external TUI writes only to disk.
  return AccountManager.loadFromDisk()
}

describe("V2 account eligibility across isolated server and TUI state", () => {
  it("excludes externally disabled, removed, and verification-blocked accounts at the next selection", async () => {
    const server = await setup()
    await updateAccountInStorage("first", (account) => { account.enabled = false })
    server.reconcileEligibility(await loadAccounts())
    expect(server.getCurrentOrNextForFamily("claude")?.parts.refreshToken).toBe("second")
    await server.saveToDisk()
    expect((await loadAccounts())?.accounts[0]?.enabled).toBe(false)

    await updateAccountInStorage("first", (account) => { account.enabled = true })
    await updateAccountInStorage("second", (account) => {
      account.verificationRequired = true
      account.enabled = false
    })
    server.reconcileEligibility(await loadAccounts())
    expect(server.getCurrentOrNextForFamily("claude")?.parts.refreshToken).toBe("first")

    await removeAccountFromStorage("first")
    server.reconcileEligibility(await loadAccounts())
    expect(server.getAccountCount()).toBe(0)
    expect(server.getCurrentOrNextForFamily("claude")).toBeNull()
    await server.saveToDisk()
    expect((await loadAccounts())?.accounts.map((account) => account.refreshToken)).toEqual(["second"])
  })

  it("does not undo a newer in-memory verification block before its save reaches disk", async () => {
    const server = await setup()
    server.markAccountVerificationRequired(0, "blocked")
    server.reconcileEligibility(await loadAccounts())
    expect(server.getAccounts()[0]?.enabled).toBe(false)
    await server.flushSaveToDisk()
    expect((await loadAccounts())?.accounts[0]?.verificationRequired).toBe(true)
  })

  it("fails closed if storage cannot be loaded and restores selection on external re-enable", async () => {
    const server = await setup()
    server.reconcileEligibility(null)
    expect(server.getAccountCount()).toBe(0)
    expect(server.getCurrentAccountForFamily("claude")).toBeNull()
    expect(server.getNextForFamily("claude")).toBeNull()
    expect(server.getCurrentOrNextForFamily("claude")).toBeNull()
    expect(server.getCurrentOrNextForFamily("claude", undefined, "round-robin")).toBeNull()
    expect(server.getCurrentOrNextForFamily("claude", undefined, "hybrid")).toBeNull()
    expect(server.setPreferredAccount("first")).toBe(false)
    server.reconcileEligibility(await loadAccounts())
    expect(server.getAccountCount()).toBe(2)
  })

  it("preserves pending verification and unversioned controls through a failed read, save, and reload", async () => {
    const server = await setup()
    // The second account still has no control revision in the legacy storage format.
    expect((await loadAccounts())?.accounts[1]?.controlUpdatedAt).toBeUndefined()
    server.markAccountVerificationRequired(0, "verify", "https://example.com/verify")
    server.reconcileEligibility(null)
    expect(server.getAccounts()[0]).toMatchObject({
      enabled: false,
      verificationRequired: true,
      verificationRequiredReason: "verify",
    })
    expect(server.getCurrentOrNextForFamily("claude")).toBeNull()
    await server.flushSaveToDisk()
    const persisted = await loadAccounts()
    expect(persisted?.accounts[0]).toMatchObject({
      enabled: false,
      verificationRequired: true,
      verificationRequiredReason: "verify",
      verificationUrl: "https://example.com/verify",
    })
    expect(persisted?.accounts[1]).toMatchObject({ enabled: true })
    expect(persisted?.accounts[1]?.controlUpdatedAt).toBeUndefined()
    server.reconcileEligibility(persisted)
    expect(server.getCurrentOrNextForFamily("claude")?.parts.refreshToken).toBe("second")
    expect(server.getAccounts()[0]?.verificationRequired).toBe(true)
  })
})
