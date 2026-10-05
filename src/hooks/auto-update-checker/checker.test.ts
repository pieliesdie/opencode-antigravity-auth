import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const { fsMock } = vi.hoisted(() => ({
  fsMock: {
    existsSync: vi.fn(),
    readFileSync: vi.fn(),
    writeFileSync: vi.fn(),
    statSync: vi.fn(),
  },
}));

vi.mock("node:fs", () => fsMock);

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("isLocalDevMode / getLocalDevPath", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsMock.existsSync.mockReturnValue(false);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns false when no config files exist", async () => {
    const { isLocalDevMode } = await import("./checker");
    expect(isLocalDevMode("/some/project")).toBe(false);
  });

  it("returns null from getLocalDevPath when no config exists", async () => {
    const { getLocalDevPath } = await import("./checker");
    expect(getLocalDevPath("/some/project")).toBeNull();
  });

  it("returns null when config has no matching file:// plugin entry", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.json"),
    );
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["some-other-plugin@1.0.0"] }),
    );
    expect(getLocalDevPath("/project")).toBeNull();
  });

  it("returns path when config contains a file:// entry for the package", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.json"),
    );
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({
        plugin: ["file:///home/user/opencode-antigravity-auth/dist/plugin.js"],
      }),
    );
    const result = getLocalDevPath("/project");
    expect(result).toContain("opencode-antigravity-auth");
  });

  it("returns an absolute V2 local dist path for the package", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugins: ["/workspace/opencode-antigravity-auth/dist"] }),
    );
    expect(getLocalDevPath("/project")).toBe("/workspace/opencode-antigravity-auth/dist");
  });

  it("handles JSONC config with comments and trailing commas", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) =>
      p.endsWith("opencode.jsonc"),
    );
    fsMock.readFileSync.mockReturnValue(
      `{
        // dev plugin
        "plugin": [
          "file:///home/user/opencode-antigravity-auth/dist/plugin.js",
        ]
      }`,
    );
    const result = getLocalDevPath("/project");
    expect(result).toContain("opencode-antigravity-auth");
  });

  it("returns null and does not throw when config file is malformed JSON", async () => {
    const { getLocalDevPath } = await import("./checker");
    fsMock.existsSync.mockReturnValue(true);
    fsMock.readFileSync.mockReturnValue("{ not valid json !!!}");
    expect(() => getLocalDevPath("/project")).not.toThrow();
    expect(getLocalDevPath("/project")).toBeNull();
  });
});

describe("findPluginEntry", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    fsMock.existsSync.mockReturnValue(false);
  });

  it("returns null when no config files exist", async () => {
    const { findPluginEntry } = await import("./checker");
    expect(findPluginEntry("/project")).toBeNull();
  });

  it("returns entry with isPinned=false for bare package name", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["opencode-antigravity-auth"] }),
    );
    const result = findPluginEntry("/project");
    expect(result).not.toBeNull();
    expect(result!.isPinned).toBe(false);
    expect(result!.pinnedVersion).toBeNull();
  });

  it("returns entry with isPinned=true for versioned package", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["opencode-antigravity-auth@1.5.0"] }),
    );
    const result = findPluginEntry("/project");
    expect(result).not.toBeNull();
    expect(result!.isPinned).toBe(true);
    expect(result!.pinnedVersion).toBe("1.5.0");
  });

  it("returns isPinned=false for @latest entry", async () => {
    const { findPluginEntry } = await import("./checker");
    fsMock.existsSync.mockImplementation((p: string) => p.endsWith("opencode.json"));
    fsMock.readFileSync.mockReturnValue(
      JSON.stringify({ plugin: ["opencode-antigravity-auth@latest"] }),
    );
    const result = findPluginEntry("/project");
    expect(result!.isPinned).toBe(false);
    expect(result!.pinnedVersion).toBeNull();
  });
});

describe("OpenCode V2 plugins JSONC", () => {
  let directory: string;
  let configPath: string;

  beforeEach(async () => {
    vi.doUnmock("node:fs");
    vi.resetModules();
    directory = await mkdtemp(join(tmpdir(), "antigravity-v2-config-"));
    const configDirectory = join(directory, ".opencode");
    await mkdir(configDirectory);
    configPath = join(configDirectory, "opencode.jsonc");
  });

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it("finds and updates a pinned V2 object entry while preserving its options and unrelated strings", async () => {
    await writeFile(configPath, `{
  // V2 package object
  "plugins": [
    {
      "package": "opencode-antigravity-auth@1.5.0",
      "options": {
        "enabled": true,
        "pinnedReference": "opencode-antigravity-auth@1.5.0"
      }
    },
  ],
  "note": "opencode-antigravity-auth@1.5.0"
}
`);
    const { findPluginEntry, updatePinnedVersion } = await import("./checker");

    expect(findPluginEntry(directory)).toMatchObject({
      entry: "opencode-antigravity-auth@1.5.0",
      isPinned: true,
      pinnedVersion: "1.5.0",
      configPath,
    });
    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);

    const updated = await readFile(configPath, "utf-8");
    expect(updated).toContain('"package": "opencode-antigravity-auth@2.0.0"');
    expect(updated).toContain('"enabled": true');
    expect(updated).toContain('"pinnedReference": "opencode-antigravity-auth@1.5.0"');
    expect(updated).toContain('"note": "opencode-antigravity-auth@1.5.0"');
  });

  it("updates pinned V2 string entries", async () => {
    await writeFile(configPath, `{
  "plugins": [
    "other-plugin@1.0.0",
    "opencode-antigravity-auth@1.5.0",
  ],
}
`);
    const { findPluginEntry, updatePinnedVersion } = await import("./checker");

    expect(findPluginEntry(directory)?.pinnedVersion).toBe("1.5.0");
    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);
    expect(await readFile(configPath, "utf-8")).toContain('"opencode-antigravity-auth@2.0.0"');
  });

  it("retains V1 tuple entries when locating and updating a pinned package", async () => {
    await writeFile(configPath, `{
  "plugin": [
    ["opencode-antigravity-auth@1.5.0", { "enabled": true }],
  ],
}
`);
    const { findPluginEntry, updatePinnedVersion } = await import("./checker");

    expect(findPluginEntry(directory)?.pinnedVersion).toBe("1.5.0");
    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);
    const updated = await readFile(configPath, "utf-8");
    expect(updated).toContain('["opencode-antigravity-auth@2.0.0", { "enabled": true }]');
  });

  it("does not update matching strings outside a plugin array", async () => {
    const content = `{
  "plugins": ["other-plugin@1.0.0"],
  "note": "opencode-antigravity-auth@1.5.0",
  "metadata": { "package": "opencode-antigravity-auth@1.5.0" }
}
`;
    await writeFile(configPath, content);
    const { updatePinnedVersion } = await import("./checker");

    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(false);
    await expect(readFile(configPath, "utf-8")).resolves.toBe(content);
  });

  it("ignores commented and nested plugins arrays before the top-level V2 array", async () => {
    await writeFile(configPath, `{
  // "plugins": ["opencode-antigravity-auth@0.1.0"],
  "options": {
    "plugins": ["opencode-antigravity-auth@0.2.0"]
  },
  "plugins": ["opencode-antigravity-auth@1.5.0"]
}
`);
    const { findPluginEntry, updatePinnedVersion } = await import("./checker");

    expect(findPluginEntry(directory)?.pinnedVersion).toBe("1.5.0");
    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);
    const updated = await readFile(configPath, "utf-8");
    expect(updated).toContain('// "plugins": ["opencode-antigravity-auth@0.1.0"],');
    expect(updated).toContain('"plugins": ["opencode-antigravity-auth@0.2.0"]');
    expect(updated).toContain('"plugins": ["opencode-antigravity-auth@2.0.0"]');
  });

  it("skips a commented matching string before a V2 plugin entry", async () => {
    await writeFile(configPath, `{
  "plugins": [
    // "opencode-antigravity-auth@1.5.0",
    "opencode-antigravity-auth@1.5.0"
  ]
}
`);
    const { updatePinnedVersion } = await import("./checker");

    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);
    const updated = await readFile(configPath, "utf-8");
    expect(updated).toContain('// "opencode-antigravity-auth@1.5.0",');
    expect(updated).toContain('"opencode-antigravity-auth@2.0.0"');
  });

  it("skips a commented matching string before a V1 tuple package", async () => {
    await writeFile(configPath, `{
  "plugin": [
    [
      // "opencode-antigravity-auth@1.5.0",
      "opencode-antigravity-auth@1.5.0",
      { "enabled": true }
    ]
  ]
}
`);
    const { updatePinnedVersion } = await import("./checker");

    expect(updatePinnedVersion(configPath, "opencode-antigravity-auth@1.5.0", "2.0.0")).toBe(true);
    const updated = await readFile(configPath, "utf-8");
    expect(updated).toContain('// "opencode-antigravity-auth@1.5.0",');
    expect(updated).toContain('"opencode-antigravity-auth@2.0.0",');
  });
});
