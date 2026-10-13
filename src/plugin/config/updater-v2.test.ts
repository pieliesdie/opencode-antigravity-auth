import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { updateV2ModelsConfig } from "./updater.ts"

const dirs: string[] = []
afterEach(async () => {
  vi.unstubAllEnvs()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true })
})

describe("V2 model configuration", () => {
  it("replaces Google models without adding a legacy plugin or changing the selected V2 package", async () => {
    const dir = await mkdtemp(join(tmpdir(), "antigravity-v2-config-"))
    dirs.push(dir)
    const configPath = join(dir, "opencode.jsonc")
    await writeFile(configPath, `{
      // Keep this local package selection
      "plugins": ["/custom/path/opencode-antigravity-auth"],
      "provider": { "google": { "models": { "old": {} }, "other": true }, "other": { "keep": true } },
      "theme": "custom",
    }`)
    expect((await updateV2ModelsConfig({ configPath })).success).toBe(true)
    const result = JSON.parse(await readFile(configPath, "utf8"))
    expect(result.plugins).toEqual(["/custom/path/opencode-antigravity-auth"])
    expect(result.plugin).toBeUndefined()
    expect(result.provider.google.models.old).toBeUndefined()
    expect(Object.keys(result.provider.google.models).length).toBeGreaterThan(0)
    expect(result.provider.google.other).toBe(true)
    expect(result.provider.other).toEqual({ keep: true })
    expect(result.theme).toBe("custom")
  })

  it("never invents a plugin entry when creating a new V2 model config", async () => {
    const dir = await mkdtemp(join(tmpdir(), "antigravity-v2-config-"))
    dirs.push(dir)
    const configPath = join(dir, "opencode.json")
    expect((await updateV2ModelsConfig({ configPath })).success).toBe(true)
    const result = JSON.parse(await readFile(configPath, "utf8"))
    expect(result.plugin).toBeUndefined()
    expect(result.plugins).toBeUndefined()
    expect(Object.keys(result.provider.google.models).length).toBeGreaterThan(0)
  })

  it("configures models in OPENCODE_CONFIG_DIR without an explicit configPath", async () => {
    const dir = await mkdtemp(join(tmpdir(), "antigravity-v2-config-"))
    dirs.push(dir)
    vi.stubEnv("OPENCODE_CONFIG_DIR", dir)
    const configPath = join(dir, "opencode.jsonc")
    await writeFile(configPath, JSON.stringify({ plugins: ["local-v2-plugin"], provider: { google: { models: { old: {} } } } }))

    const result = await updateV2ModelsConfig()
    expect(result).toMatchObject({ success: true, configPath })
    const config = JSON.parse(await readFile(configPath, "utf8"))
    expect(config.plugins).toEqual(["local-v2-plugin"])
    expect(config.plugin).toBeUndefined()
    expect(config.provider.google.models.old).toBeUndefined()
    expect(Object.keys(config.provider.google.models).length).toBeGreaterThan(0)
  })
})
