import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import type { NpmDistTags, OpencodeConfig, PackageJson, PluginConfigEntry, UpdateCheckResult } from "./types";
import {
  PACKAGE_NAME,
  NPM_REGISTRY_URL,
  NPM_FETCH_TIMEOUT,
  INSTALLED_PACKAGE_JSON,
  USER_OPENCODE_CONFIG,
  USER_OPENCODE_CONFIG_JSONC,
} from "./constants";
import { logAutoUpdate } from "./logging";

export function isLocalDevMode(directory: string): boolean {
  return getLocalDevPath(directory) !== null;
}

function stripJsonComments(json: string): string {
  return json
    .replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m: string, g: string | undefined) => (g ? "" : m))
    .replace(/,(\s*[}\]])/g, "$1");
}

function getConfigPaths(directory: string): string[] {
  return [
    path.join(directory, ".opencode", "opencode.json"),
    path.join(directory, ".opencode", "opencode.jsonc"),
    path.join(directory, ".opencode.json"),
    USER_OPENCODE_CONFIG,
    USER_OPENCODE_CONFIG_JSONC,
  ];
}

function pluginPackage(entry: unknown): string | null {
  if (typeof entry === "string") return entry;
  if (Array.isArray(entry) && typeof entry[0] === "string") return entry[0];
  if (entry && typeof entry === "object" && "package" in entry && typeof entry.package === "string") {
    return entry.package;
  }
  return null;
}

function configuredPlugins(config: OpencodeConfig): PluginConfigEntry[] {
  const v2Plugins = Array.isArray(config.plugins) ? config.plugins : [];
  const v1Plugins = Array.isArray(config.plugin) ? config.plugin : [];
  return [...v2Plugins, ...v1Plugins];
}

function isPackageEntry(entry: string): boolean {
  return entry === PACKAGE_NAME
    || entry.startsWith(`${PACKAGE_NAME}@`)
    || (entry.startsWith("file://") && entry.includes(PACKAGE_NAME));
}

function skipString(content: string, start: number): number {
  const quote = content[start];
  let index = start + 1;
  while (index < content.length) {
    if (content[index] === "\\") {
      index += 2;
      continue;
    }
    if (content[index] === quote) return index + 1;
    index++;
  }
  return content.length;
}

function skipTrivia(content: string, start: number): number {
  let index = start;
  while (index < content.length) {
    if (/\s/.test(content[index] ?? "")) {
      index++;
      continue;
    }
    if (content.startsWith("//", index)) {
      const lineEnd = content.indexOf("\n", index + 2);
      index = lineEnd === -1 ? content.length : lineEnd + 1;
      continue;
    }
    if (content.startsWith("/*", index)) {
      const commentEnd = content.indexOf("*/", index + 2);
      index = commentEnd === -1 ? content.length : commentEnd + 2;
      continue;
    }
    break;
  }
  return index;
}

interface TextRange {
  start: number;
  end: number;
}

function findPluginArray(content: string, key: "plugin" | "plugins"): TextRange | null {
  let depth = 0;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === "\"" || character === "'") {
      const propertyStart = index;
      const propertyEnd = skipString(content, index);
      if (depth !== 1 || character !== "\"") {
        index = propertyEnd - 1;
        continue;
      }
      let cursor = skipTrivia(content, propertyEnd);
      if (content[cursor] !== ":") {
        index = propertyEnd - 1;
        continue;
      }
      try {
        if (JSON.parse(content.slice(propertyStart, propertyEnd)) !== key) {
          index = propertyEnd - 1;
          continue;
        }
      } catch {
        index = propertyEnd - 1;
        continue;
      }
      cursor = skipTrivia(content, cursor + 1);
      if (content[cursor] !== "[") {
        index = propertyEnd - 1;
        continue;
      }
      const start = cursor + 1;
      let arrayDepth = 1;
      for (let arrayIndex = start; arrayIndex < content.length; arrayIndex++) {
        const arrayCharacter = content[arrayIndex];
        if (arrayCharacter === "\"" || arrayCharacter === "'") {
          arrayIndex = skipString(content, arrayIndex) - 1;
          continue;
        }
        if (content.startsWith("//", arrayIndex) || content.startsWith("/*", arrayIndex)) {
          arrayIndex = skipTrivia(content, arrayIndex) - 1;
          continue;
        }
        if (arrayCharacter === "[") arrayDepth++;
        if (arrayCharacter === "]" && --arrayDepth === 0) return { start, end: arrayIndex };
      }
      return null;
    }
    if (content.startsWith("//", index) || content.startsWith("/*", index)) {
      index = skipTrivia(content, index) - 1;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") depth--;
  }
  return null;
}

function arrayEntries(content: string, array: TextRange): TextRange[] {
  const entries: TextRange[] = [];
  let entryStart = array.start;
  let depth = 0;
  for (let index = array.start; index < array.end; index++) {
    const character = content[index];
    if (character === "\"" || character === "'") {
      index = skipString(content, index) - 1;
      continue;
    }
    if (content.startsWith("//", index) || content.startsWith("/*", index)) {
      index = skipTrivia(content, index) - 1;
      continue;
    }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") depth--;
    if (character === "," && depth === 0) {
      entries.push({ start: entryStart, end: index });
      entryStart = index + 1;
    }
  }
  if (entryStart < array.end) entries.push({ start: entryStart, end: array.end });
  return entries;
}

function stringValueRange(content: string, expected: string): TextRange | null {
  let depth = 0;
  const firstCharacter = skipTrivia(content, 0);
  const expectedDepth = content[firstCharacter] === "[" ? 1 : 0;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (content.startsWith("//", index) || content.startsWith("/*", index)) {
      index = skipTrivia(content, index) - 1;
      continue;
    }
    if (character === "[" || character === "{") depth++;
    if (character === "]" || character === "}") depth--;
    if (character !== "\"") continue;
    const end = skipString(content, index);
    if (depth === expectedDepth) {
      try {
        if (JSON.parse(content.slice(index, end)) === expected) return { start: index, end };
      } catch {
        // Continue scanning malformed JSONC fragments.
      }
    }
    index = end - 1;
  }
  return null;
}

function objectPackageValueRange(content: string): TextRange | null {
  let depth = 0;
  for (let index = 0; index < content.length; index++) {
    const character = content[index];
    if (character === "\"" || character === "'") {
      const keyStart = index;
      const keyEnd = skipString(content, index);
      if (depth !== 1 || character !== "\"") {
        index = keyEnd - 1;
        continue;
      }
      let cursor = skipTrivia(content, keyEnd);
      if (content[cursor] !== ":") {
        index = keyEnd - 1;
        continue;
      }
      try {
        if (JSON.parse(content.slice(keyStart, keyEnd)) !== "package") {
          index = keyEnd - 1;
          continue;
        }
      } catch {
        index = keyEnd - 1;
        continue;
      }
      cursor = skipTrivia(content, cursor + 1);
      if (content[cursor] !== "\"") return null;
      return { start: cursor, end: skipString(content, cursor) };
    }
    if (content.startsWith("//", index) || content.startsWith("/*", index)) {
      index = skipTrivia(content, index) - 1;
      continue;
    }
    if (character === "{" || character === "[") depth++;
    if (character === "}" || character === "]") depth--;
  }
  return null;
}

export function getLocalDevPath(directory: string): string | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = configuredPlugins(config);

      for (const entry of plugins) {
        const packageEntry = pluginPackage(entry);
        if (packageEntry?.startsWith("file://") && packageEntry.includes(PACKAGE_NAME)) {
          try {
            return fileURLToPath(packageEntry);
          } catch {
            return packageEntry.replace("file://", "");
          }
        }
        // OpenCode V2 also accepts an absolute local dist directory in `plugins`.
        if (packageEntry && path.isAbsolute(packageEntry) && packageEntry.includes(PACKAGE_NAME)) {
          return packageEntry;
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

function findPackageJsonUp(startPath: string): string | null {
  try {
    const stat = fs.statSync(startPath);
    let dir = stat.isDirectory() ? startPath : path.dirname(startPath);

    for (let i = 0; i < 10; i++) {
      const pkgPath = path.join(dir, "package.json");
      if (fs.existsSync(pkgPath)) {
        try {
          const content = fs.readFileSync(pkgPath, "utf-8");
          const pkg = JSON.parse(content) as PackageJson;
          if (pkg.name === PACKAGE_NAME) return pkgPath;
        } catch {
          continue;
        }
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}

export function getLocalDevVersion(directory: string): string | null {
  const localPath = getLocalDevPath(directory);
  if (!localPath) return null;

  try {
    const pkgPath = findPackageJsonUp(localPath);
    if (!pkgPath) return null;
    const content = fs.readFileSync(pkgPath, "utf-8");
    const pkg = JSON.parse(content) as PackageJson;
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

export interface PluginEntryInfo {
  entry: string;
  isPinned: boolean;
  pinnedVersion: string | null;
  configPath: string;
}

export function findPluginEntry(directory: string): PluginEntryInfo | null {
  for (const configPath of getConfigPaths(directory)) {
    try {
      if (!fs.existsSync(configPath)) continue;
      const content = fs.readFileSync(configPath, "utf-8");
      const config = JSON.parse(stripJsonComments(content)) as OpencodeConfig;
      const plugins = configuredPlugins(config);

      for (const entry of plugins) {
        const packageEntry = pluginPackage(entry);
        if (!packageEntry || !isPackageEntry(packageEntry)) continue;
        if (packageEntry === PACKAGE_NAME) {
          return { entry: packageEntry, isPinned: false, pinnedVersion: null, configPath };
        }
        if (packageEntry.startsWith(`${PACKAGE_NAME}@`)) {
          const pinnedVersion = packageEntry.slice(PACKAGE_NAME.length + 1);
          const isPinned = pinnedVersion !== "latest";
          return { entry: packageEntry, isPinned, pinnedVersion: isPinned ? pinnedVersion : null, configPath };
        }
        if (packageEntry.startsWith("file://")) {
          return { entry: packageEntry, isPinned: false, pinnedVersion: null, configPath };
        }
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function getCachedVersion(): string | null {
  try {
    if (fs.existsSync(INSTALLED_PACKAGE_JSON)) {
      const content = fs.readFileSync(INSTALLED_PACKAGE_JSON, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch {
    return null;
  }

  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const pkgPath = findPackageJsonUp(currentDir);
    if (pkgPath) {
      const content = fs.readFileSync(pkgPath, "utf-8");
      const pkg = JSON.parse(content) as PackageJson;
      if (pkg.version) return pkg.version;
    }
  } catch (err) {
    logAutoUpdate(`Failed to resolve version from current directory: ${err}`);
  }

  return null;
}

export function updatePinnedVersion(configPath: string, oldEntry: string, newVersion: string): boolean {
  try {
    const content = fs.readFileSync(configPath, "utf-8");
    const newEntry = `${PACKAGE_NAME}@${newVersion}`;
    for (const key of ["plugins", "plugin"] as const) {
      const pluginArray = findPluginArray(content, key);
      if (!pluginArray) continue;
      for (const entryRange of arrayEntries(content, pluginArray)) {
        const entryText = content.slice(entryRange.start, entryRange.end);
        let parsedEntry: unknown;
        try {
          parsedEntry = JSON.parse(stripJsonComments(entryText));
        } catch {
          continue;
        }
        if (pluginPackage(parsedEntry) !== oldEntry) continue;

        const valueRange = typeof parsedEntry === "object" && parsedEntry !== null && !Array.isArray(parsedEntry)
          ? objectPackageValueRange(entryText)
          : stringValueRange(entryText, oldEntry);
        if (!valueRange) continue;
        const start = entryRange.start + valueRange.start;
        const end = entryRange.start + valueRange.end;
        const updatedContent = content.slice(0, start) + JSON.stringify(newEntry) + content.slice(end);
        fs.writeFileSync(configPath, updatedContent, "utf-8");
        logAutoUpdate(`Updated ${configPath}: ${oldEntry} → ${newEntry}`);
        return true;
      }
    }

    logAutoUpdate(`Entry "${oldEntry}" not found in plugin arrays of ${configPath}`);
    return false;
  } catch (err) {
    console.error(`[auto-update-checker] Failed to update config file ${configPath}:`, err);
    return false;
  }
}

export async function getLatestVersion(): Promise<string | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), NPM_FETCH_TIMEOUT);

  try {
    const response = await fetch(NPM_REGISTRY_URL, {
      signal: controller.signal,
      headers: { Accept: "application/json" },
    });

    if (!response.ok) return null;

    const data = (await response.json()) as NpmDistTags;
    return data.latest ?? null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function checkForUpdate(directory: string): Promise<UpdateCheckResult> {
  if (isLocalDevMode(directory)) {
    logAutoUpdate("Local dev mode detected, skipping update check");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: true, isPinned: false };
  }

  const pluginInfo = findPluginEntry(directory);
  if (!pluginInfo) {
    logAutoUpdate("Plugin not found in config");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: false };
  }

  const currentVersion = getCachedVersion() ?? pluginInfo.pinnedVersion;
  if (!currentVersion) {
    logAutoUpdate("No version found (cached or pinned)");
    return { needsUpdate: false, currentVersion: null, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
  }

  const latestVersion = await getLatestVersion();
  if (!latestVersion) {
    logAutoUpdate("Failed to fetch latest version");
    return { needsUpdate: false, currentVersion, latestVersion: null, isLocalDev: false, isPinned: pluginInfo.isPinned };
  }

  const needsUpdate = currentVersion !== latestVersion;
  logAutoUpdate(`Current: ${currentVersion}, Latest: ${latestVersion}, NeedsUpdate: ${needsUpdate}`);
  return { needsUpdate, currentVersion, latestVersion, isLocalDev: false, isPinned: pluginInfo.isPinned };
}
