export interface NpmDistTags {
  latest: string;
  [key: string]: string;
}

export interface OpencodeConfig {
  plugin?: PluginConfigEntry[];
  plugins?: PluginConfigEntry[];
  [key: string]: unknown;
}

export interface PluginObjectEntry {
  package: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

// OpenCode V1 accepts tuple entries while V2 accepts package objects.
export type PluginConfigEntry = string | [string, Record<string, unknown>] | PluginObjectEntry;

export interface PackageJson {
  version: string;
  name?: string;
  [key: string]: unknown;
}

export interface UpdateCheckResult {
  needsUpdate: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  isLocalDev: boolean;
  isPinned: boolean;
}

export interface AutoUpdateCheckerOptions {
  showStartupToast?: boolean;
  autoUpdate?: boolean;
}
