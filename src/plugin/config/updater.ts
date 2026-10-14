/**
 * OpenCode configuration file updater.
 *
 * Updates ~/.config/opencode/opencode.json(c) with plugin models.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { OPENCODE_MODEL_DEFINITIONS, toV2ModelDefinitions } from "./models";

// =============================================================================
// Types
// =============================================================================

export interface UpdateConfigResult {
  success: boolean;
  configPath: string;
  error?: string;
}

export interface OpencodeConfig {
  $schema?: string;
  plugin?: string[];
  plugins?: string[];
  provider?: {
    google?: {
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  providers?: {
    google?: {
      package?: string;
      models?: Record<string, unknown>;
      [key: string]: unknown;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UpdateConfigOptions {
  /** Override the config file path (for testing) */
  configPath?: string;
}

// =============================================================================
// Constants
// =============================================================================

const PLUGIN_NAME = "opencode-antigravity-auth@latest";
const SCHEMA_URL = "https://opencode.ai/config.json";
const OPENCODE_JSON_FILENAME = "opencode.json";
const OPENCODE_JSONC_FILENAME = "opencode.jsonc";

function stripJsonCommentsAndTrailingCommas(json: string): string {
  return json
    .replace(
      /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g,
      (match: string, group: string | undefined) => (group ? "" : match)
    )
    .replace(/,(\s*[}\]])/g, "$1");
}

/**
 * Get the opencode config directory path.
 */
export function getOpencodeConfigDir(): string {
  const xdgConfig = process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(xdgConfig, "opencode");
}

/**
 * Get the opencode config file path.
 *
 * Prefers opencode.jsonc when present so we update the active config file
 * instead of creating a new opencode.json.
 */
export function getOpencodeConfigPath(configDir = getOpencodeConfigDir()): string {
  const jsoncPath = join(configDir, OPENCODE_JSONC_FILENAME);
  const jsonPath = join(configDir, OPENCODE_JSON_FILENAME);

  if (existsSync(jsoncPath)) {
    return jsoncPath;
  }
  if (existsSync(jsonPath)) {
    return jsonPath;
  }

  return jsonPath;
}

// =============================================================================
// Main Function
// =============================================================================

/**
 * Updates the opencode configuration file with plugin models.
 *
 * This function:
 * 1. Reads existing opencode.json/opencode.jsonc (or creates default structure)
 * 2. Replaces `provider.google.models` with plugin models
 * 3. Writes back to disk with proper formatting
 *
 * Preserves:
 * - $schema and other top-level config keys
 * - Non-google provider sections
 * - Other settings within google provider (except models)
 *
 * @param options - Optional configuration (e.g., custom configPath for testing)
 * @returns UpdateConfigResult with success status and path
 */
export async function updateOpencodeConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath();

  try {
    let config: OpencodeConfig;

    // Read existing config or create default
    if (existsSync(configPath)) {
      const content = readFileSync(configPath, "utf-8");
      config = JSON.parse(stripJsonCommentsAndTrailingCommas(content)) as OpencodeConfig;
    } else {
      // Create default config structure
      config = {
        $schema: SCHEMA_URL,
        plugin: [],
        provider: {},
      };
    }

    // Ensure $schema is set
    if (!config.$schema) {
      config.$schema = SCHEMA_URL;
    }

    // Ensure plugin array exists and contains our plugin
    if (!Array.isArray(config.plugin)) {
      config.plugin = [];
    }

    // Check if plugin is already in the list (any version)
    const hasPlugin = config.plugin.some((p) =>
      p.includes("opencode-antigravity-auth")
    );
    if (!hasPlugin) {
      config.plugin.push(PLUGIN_NAME);
    }

    // Replace google models with plugin models, respecting both providers (v2) and provider (v1)
    const hasProviders = config.providers && typeof config.providers === "object";
    const hasProvider = config.provider && typeof config.provider === "object";

    if (hasProviders) {
      config.providers!.google ??= {};
      config.providers!.google.models = toV2ModelDefinitions(OPENCODE_MODEL_DEFINITIONS);
    }
    if (hasProvider) {
      config.provider!.google ??= {};
      config.provider!.google.models = { ...OPENCODE_MODEL_DEFINITIONS };
    }
    if (!hasProviders && !hasProvider) {
      config.provider = {
        google: {
          models: { ...OPENCODE_MODEL_DEFINITIONS },
        },
      };
    }

    // Ensure config directory exists
    const configDir = dirname(configPath);
    if (!existsSync(configDir)) {
      mkdirSync(configDir, { recursive: true });
    }

    // Write config with proper formatting (2-space indent)
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");

    return {
      success: true,
      configPath,
    };
  } catch (error) {
    return {
      success: false,
      configPath,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** V2 registers plugin models at runtime. This optional static export changes only models,
 * never inserts a V1 `plugin` entry or rewrites the V2 `plugins` selection. */
export async function updateV2ModelsConfig(
  options: UpdateConfigOptions = {}
): Promise<UpdateConfigResult> {
  const configPath = options.configPath ?? getOpencodeConfigPath(process.env.OPENCODE_CONFIG_DIR || getOpencodeConfigDir());
  try {
    const config: OpencodeConfig = existsSync(configPath)
      ? JSON.parse(stripJsonCommentsAndTrailingCommas(readFileSync(configPath, "utf-8"))) as OpencodeConfig
      : { $schema: SCHEMA_URL };

    const v2Definitions = toV2ModelDefinitions(OPENCODE_MODEL_DEFINITIONS);

    // Support both `providers` (OpenCode v2 native plural) and `provider` (legacy/v1 format supported by v2)
    const hasProviders = config.providers && typeof config.providers === "object";
    const hasProvider = config.provider && typeof config.provider === "object";

    if (hasProviders) {
      config.providers!.google ??= {};
      config.providers!.google.models = v2Definitions;
    }
    if (hasProvider) {
      config.provider!.google ??= {};
      config.provider!.google.models = v2Definitions;
    }
    if (!hasProviders && !hasProvider) {
      if (Array.isArray(config.plugins)) {
        config.providers = {
          google: {
            package: "aisdk:@ai-sdk/google",
            models: v2Definitions,
          },
        };
      } else {
        config.provider = {
          google: {
            models: v2Definitions,
          },
        };
      }
    }

    mkdirSync(dirname(configPath), { recursive: true });
    writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    return { success: true, configPath };
  } catch (error) {
    return { success: false, configPath, error: error instanceof Error ? error.message : String(error) };
  }
}
