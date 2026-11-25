import { exec } from "node:child_process";
import { tool } from "@opencode-ai/plugin";
import {
  ANTIGRAVITY_DEFAULT_PROJECT_ID,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_FALLBACKS,
  ANTIGRAVITY_PROVIDER_ID,
  getAntigravityHeaders,
  type HeaderStyle,
} from "./constants";
import { authorizeAntigravity, cancelAuthorization, exchangeAntigravity } from "./antigravity/oauth";
import type { AntigravityTokenExchangeResult } from "./antigravity/oauth";
import { accessTokenExpired, isOAuthAuth, parseRefreshParts, formatRefreshParts } from "./plugin/auth";
import { pressEnterToContinue, promptAddAnotherAccount, promptLoginMode, promptProjectId, type LoginMenuResult } from "./plugin/cli";
import { ensureProjectContext } from "./plugin/project";
import {
  startAntigravityDebugRequest, 
  logAntigravityDebugResponse,
  logAccountContext,
  logRateLimitEvent,
  logRateLimitSnapshot,
  logResponseBody,
  logModelFamily,
  isDebugEnabled,
  getLogFilePath,
  initializeDebug,
  sanitizeUrlForLog,
} from "./plugin/debug";
import {
  buildThinkingWarmupBody,
  isGenerativeLanguageRequest,
  prepareAntigravityRequest,
  transformAntigravityResponse,
} from "./plugin/request";
import {
  resolveModelWithTier,
} from "./plugin/transform/model-resolver";
import {
  isEmptyResponseBody,
  createSyntheticErrorResponse,
} from "./plugin/request-helpers";
import { EmptyResponseError } from "./plugin/errors";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./plugin/token";
import { startOAuthListener, type OAuthListener } from "./plugin/server";
import { clearAccounts, loadAccounts, removeAccountFromStorage, saveAccounts } from "./plugin/storage";
import { AccountManager, type ModelFamily, parseRateLimitReason, calculateBackoffMs, computeSoftQuotaCacheTtlMs } from "./plugin/accounts";
import { createAutoUpdateCheckerHook } from "./hooks/auto-update-checker";
import { loadConfig, initRuntimeConfig, type AntigravityConfig } from "./plugin/config";
import { createSessionRecoveryHook, getRecoverySuccessToast } from "./plugin/recovery";
import { checkAccountsQuota, fetchAvailableModels, formatQuotaResetSuffix } from "./plugin/quota";
import { initDiskSignatureCache } from "./plugin/cache";
import { createProactiveRefreshQueue, type ProactiveRefreshQueue } from "./plugin/refresh-queue";
import { initLogger, createLogger } from "./plugin/logger";
import { initHealthTracker, getHealthTracker, initTokenTracker, getTokenTracker } from "./plugin/rotation";
import { initAntigravityVersion } from "./plugin/version";
import { retryAfterMs } from "./plugin/retry-after.ts"
import { executeSearch } from "./plugin/search";
import {
  createAntigravityOnlyModelErrorResponse,
  extractRequestedGeminiModel,
  fetchWithAgySdkCredential,
  fetchGeminiApiModels,
  getAgySdkCredentials,
  isAgySdkSupportedRequest,
  isAntigravityOnlyGenerativeLanguageRequest,
  isApiKeyAuth,
  isRetryableAgySdkCredentialStatus,
  markAgySdkCredentialRateLimited,
  selectAgySdkCredential,
} from "./plugin/api-key";
import {
  OPENCODE_MODEL_DEFINITIONS,
  antigravityModelIdFromEntry,
  type AntigravityAvailableModels,
  mergeModelDefinitions,
  modelsFromAntigravityAvailableModels,
  modelsFromGeminiApi,
} from "./plugin/config/models";
import {
  getCachedAntigravityAvailableModels,
  recordAntigravityAvailableModels,
  recordPublicGeminiApiModels,
} from "./plugin/model-catalog";
import {
  mergeAntigravityRegistries,
  sanitizeModelPatterns,
} from "./plugin/model-availability.ts";
import type { AgySdkCredential } from "./plugin/api-key";
import { GEMINI4_MODELS, Gemini4CatalogResponse, Gemini4Unavailable, gemini4Model, gemini4Routes, missingGemini4Credential, type Gemini4Route } from "./plugin/gemini4.ts"
import { getPublicGenerationModelIds } from "./plugin/model-catalog.ts"
import type {
  AuthDetails,
  GetAuth,
  LoaderResult,
  OAuthAuthDetails,
  PluginClient,
  PluginContext,
  PluginResult,
  ProjectContextResult,
  Provider,
  ProviderModel,
} from "./plugin/types";

const MAX_OAUTH_ACCOUNTS = 10;
const MAX_WARMUP_SESSIONS = 1000;
const MAX_WARMUP_RETRIES = 2;
// Per-session warmup attempt counter. A plain Set can't enforce
// MAX_WARMUP_RETRIES (membership is only 0/1), so the retry cap was dead.
const warmupAttemptCounts = new Map<string, number>();
const warmupSucceededSessionIds = new Set<string>();

// Track if this plugin instance is running in a child session (subagent, background task).
// Used to filter toasts based on toast_scope config. These are a LAST-EVENT
// heuristic set by the most recent session.created event.
//
// KNOWN LIMITATION (do not re-attempt per-request correlation): a single plugin
// instance serves many concurrent sessions, so a subagent's session.created can
// flip these globals while a root session's request is still in flight, briefly
// mis-scoping a toast. This race cannot currently be closed from the fetch
// interceptor because it has no access to the request's OpenCode session id —
// the Gemini request payload/headers do not carry it, and `prepared.sessionId`
// is a signature *cache* key (`${PLUGIN_SESSION_ID}:model:project:conversation`
// from request.ts), NOT the `session.created` `info.id`. A prior attempt to key a
// per-session parent map by `prepared.sessionId` could never match and was
// removed as dead code. Closing the race requires a real correlation source
// (OpenCode exposing the session id to the provider fetch, or a plugin API for
// the active session).
let isChildSession = false;
let childSessionParentID: string | undefined = undefined;

const log = createLogger("plugin");

// Module-level toast debounce to persist across requests (fixes toast spam)
const rateLimitToastCooldowns = new Map<string, number>();
const RATE_LIMIT_TOAST_COOLDOWN_MS = 5000;
const MAX_TOAST_COOLDOWN_ENTRIES = 100;

// Track if "all accounts blocked" toasts were shown to prevent spam in while loop
let softQuotaToastShown = false;
let rateLimitToastShown = false;

// Module-level reference to AccountManager for access from auth.login
let activeAccountManager: import("./plugin/accounts").AccountManager | null = null;

function cleanupToastCooldowns(): void {
  if (rateLimitToastCooldowns.size > MAX_TOAST_COOLDOWN_ENTRIES) {
    const now = Date.now();
    for (const [key, time] of rateLimitToastCooldowns) {
      if (now - time > RATE_LIMIT_TOAST_COOLDOWN_MS * 2) {
        rateLimitToastCooldowns.delete(key);
      }
    }
  }
}

function shouldShowRateLimitToast(message: string): boolean {
  cleanupToastCooldowns();
  const toastKey = message.replace(/\d+/g, "X");
  const lastShown = rateLimitToastCooldowns.get(toastKey) ?? 0;
  const now = Date.now();
  if (now - lastShown < RATE_LIMIT_TOAST_COOLDOWN_MS) {
    return false;
  }
  rateLimitToastCooldowns.set(toastKey, now);
  return true;
}

function resetAllAccountsBlockedToasts(): void {
  softQuotaToastShown = false;
  rateLimitToastShown = false;
}

const quotaRefreshInProgressByEmail = new Set<string>();

function defaultRetryMsForConfig(config: AntigravityConfig): number {
  return (config.default_retry_after_seconds ?? 60) * 1000;
}

async function tryFetchWithAgySdkCredentials(
  input: RequestInfo,
  init: RequestInit | undefined,
  credentials: AgySdkCredential[],
  fallbackRetryAfterMs: number,
  discoverPublic = true,
): Promise<Response | null> {
  if (credentials.length === 0) return null;
  const attempted = new Set<string>();
  let lastResponse: Response | null = null;
  const family = gemini4Model(extractRequestedGeminiModel(toUrlString(input)))
  let omitted = 0

  while (attempted.size < credentials.length) {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
    signal?.throwIfAborted()
    const credential = selectAgySdkCredential(
      credentials.filter((candidate) => !attempted.has(candidate.apiKey)),
    );
    if (!credential) {
      break;
    }
    attempted.add(credential.apiKey);
    if (family && discoverPublic) {
      let ids = getPublicGenerationModelIds(credential.apiKey)
      if (!ids) {
        try {
          const list = await waitForShared(fetchGeminiApiModels(credential), signal)
          recordPublicGeminiApiModels(list, credential.apiKey)
          ids = getPublicGenerationModelIds(credential.apiKey)
        } catch (error) {
          signal?.throwIfAborted()
          log.debug("gemini4-public-discovery-failed", { error: String(error) })
        }
      }
      if (ids && !ids.has(family.model)) { omitted++; continue }
    }
    const response = await fetchWithAgySdkCredential(input, init, credential);
    signal?.throwIfAborted()
    if (!await shouldRetrySdkResponse(response)) {
      return response;
    }
    if ([429, 503, 529].includes(response.status)) {
      const { explicitDelay } = await getRetryEvidence(response)
      markAgySdkCredentialRateLimited(credential, explicitDelay ?? fallbackRetryAfterMs)
    }
    lastResponse = response;
  }

  if (!lastResponse && family && omitted === credentials.length) {
    return new Gemini4CatalogResponse(`${family.model} is not listed for generation by the configured Gemini API key(s).`)
  }
  return lastResponse ?? new Response(
    JSON.stringify({ error: { message: "All Gemini API keys are temporarily rate-limited" } }),
    {
      status: 429,
      headers: { "content-type": "application/json" },
    },
  );
}

async function modelsFromAgySdkCredentials(
  config: AntigravityConfig,
  auth: AuthDetails | undefined,
): Promise<Record<string, ProviderModel>> {
  if (!config.model_discovery.enabled || !config.model_discovery.gemini_api) return {};
  const credentials = getAgySdkCredentials(config, isApiKeyAuth(auth) ? auth : null);
  if (credentials.length === 0) return {};

  const errors: unknown[] = [];
  for (const credential of credentials) {
    try {
      const models = await fetchGeminiApiModels(credential);
      recordPublicGeminiApiModels(models, credential.apiKey);
      return modelsFromGeminiApi(models);
    } catch (error) {
      errors.push(error);
    }
  }

  if (errors.length > 0) {
    log.debug("gemini-model-discovery-failed", { errors: errors.map((error) => String(error)) });
  }
  return {};
}

interface OAuthDiscoveryTarget {
  auth: OAuthAuthDetails;
  accountIndex?: number;
}

async function fetchModelsForOAuthTarget(
  target: OAuthDiscoveryTarget,
  client: PluginClient,
  providerId: string,
  accountManager: AccountManager | null,
): Promise<AntigravityAvailableModels | undefined> {
  let effectiveAuth = target.auth;
  let parts = parseRefreshParts(effectiveAuth.refresh);
  const projectId = parts.managedProjectId || parts.projectId || ANTIGRAVITY_DEFAULT_PROJECT_ID;
  try {
    if (accessTokenExpired(effectiveAuth)) {
      const refreshed = await refreshAccessToken(effectiveAuth, client, providerId);
      if (refreshed) {
        effectiveAuth = refreshed;
        parts = parseRefreshParts(refreshed.refresh);
        if (target.accountIndex !== undefined && accountManager) {
          const acc = accountManager.getAccounts()[target.accountIndex];
          if (acc) accountManager.updateFromAuth(acc, refreshed);
        }
      }
    }
    const accessToken = effectiveAuth.access;
    if (!accessToken || accessTokenExpired(effectiveAuth)) {
      return getCachedAntigravityAvailableModels(parts.refreshToken, projectId);
    }
    const response = await fetchAvailableModels(accessToken, projectId);
    if (response.models) {
      recordAntigravityAvailableModels(parts.refreshToken, projectId, response.models);
      if (target.accountIndex !== undefined && accountManager) {
        accountManager.updateAvailableModelsCache(target.accountIndex, response.models);
      }
    }
    return response.models ?? getCachedAntigravityAvailableModels(parts.refreshToken, projectId);
  } catch (error) {
    log.debug("fetchAvailableModels-failed", { error: String(error) });
    if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") return undefined;
    return getCachedAntigravityAvailableModels(parts.refreshToken, projectId);
  }
}

async function modelsFromOAuthAuth(
  config: AntigravityConfig,
  auth: AuthDetails | undefined,
  client: PluginClient,
  providerId: string,
  accountManager: AccountManager | null,
): Promise<AntigravityAvailableModels | undefined> {
  if (!config.model_discovery.enabled || !config.model_discovery.antigravity) return undefined;

  const targets: OAuthDiscoveryTarget[] = [];
  const seenTokens = new Set<string>();

  if (accountManager) {
    for (const acc of accountManager.getAccounts()) {
      if (acc.enabled === false || !acc.parts?.refreshToken) continue;
      if (seenTokens.has(acc.parts.refreshToken)) continue;
      seenTokens.add(acc.parts.refreshToken);
      const matchesPassedAuth =
        auth && isOAuthAuth(auth) && parseRefreshParts(auth.refresh).refreshToken === acc.parts.refreshToken;
      targets.push({
        accountIndex: acc.index,
        auth: {
          type: "oauth",
          refresh: formatRefreshParts(acc.parts),
          access: acc.access ?? (matchesPassedAuth ? auth.access : undefined),
          expires: acc.expires ?? (matchesPassedAuth ? auth.expires : undefined),
        },
      });
    }
  } else {
    const stored = await loadAccounts().catch(() => null);
    if (stored && stored.accounts.length > 0) {
      for (const acc of stored.accounts) {
        if (acc.enabled === false || !acc.refreshToken) continue;
        if (seenTokens.has(acc.refreshToken)) continue;
        seenTokens.add(acc.refreshToken);
        const matchesPassedAuth =
          auth && isOAuthAuth(auth) && parseRefreshParts(auth.refresh).refreshToken === acc.refreshToken;
        targets.push({
          auth: {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: acc.refreshToken,
              projectId: acc.projectId,
              managedProjectId: acc.managedProjectId,
            }),
            access: matchesPassedAuth ? auth.access : undefined,
            expires: matchesPassedAuth ? auth.expires : undefined,
          },
        });
      }
    }
  }

  if (auth && isOAuthAuth(auth)) {
    const token = parseRefreshParts(auth.refresh).refreshToken;
    if (token && !seenTokens.has(token)) {
      seenTokens.add(token);
      targets.unshift({ auth });
    }
  }

  if (targets.length === 0) return undefined;

  if (targets.length === 1) {
    const result = await fetchModelsForOAuthTarget(targets[0]!, client, providerId, accountManager);
    if (result && accountManager) {
      accountManager.requestSaveToDisk();
    }
    return result;
  }

  // Query all enabled accounts with bounded concurrency so models available on
  // any account (e.g. Ultra/Pro tiers) appear in OpenCode's model picker.
  const DISCOVERY_CONCURRENCY = 3;
  const registries: AntigravityAvailableModels[] = [];
  let cursor = 0;
  const worker = async (): Promise<void> => {
    while (true) {
      const idx = cursor++;
      if (idx >= targets.length) break;
      const target = targets[idx];
      if (!target) continue;
      const result = await fetchModelsForOAuthTarget(target, client, providerId, accountManager);
      if (result) registries.push(result);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(DISCOVERY_CONCURRENCY, targets.length) }, () => worker()),
  );

  if (registries.length === 0) return undefined;
  if (accountManager) {
    accountManager.requestSaveToDisk();
  }
  return mergeAntigravityRegistries(registries);
}

function hasProviderModelRuntimeShape(model: ProviderModel | undefined): boolean {
  return !!model
    && typeof model.api === "object"
    && model.api !== null
    && typeof model.capabilities === "object"
    && model.capabilities !== null;
}

function modalitiesToCapabilities(model: ProviderModel, existing: ProviderModel | undefined): Record<string, unknown> {
  const modalities = model.modalities as { input?: string[]; output?: string[] } | undefined;
  const existingCapabilities = existing?.capabilities as Record<string, unknown> | undefined;
  const existingInput = existingCapabilities?.input as Record<string, unknown> | undefined;
  const existingOutput = existingCapabilities?.output as Record<string, unknown> | undefined;

  const input = modalities?.input ?? [];
  const output = modalities?.output ?? [];

  return {
    temperature: model.temperature ?? existingCapabilities?.temperature ?? true,
    reasoning: model.supportsThinking === false ? false : existingCapabilities?.reasoning ?? !!model.variants,
    attachment: existingCapabilities?.attachment ?? (input.includes("image") || input.includes("pdf")),
    toolcall: existingCapabilities?.toolcall ?? true,
    input: {
      text: existingInput?.text ?? input.includes("text"),
      audio: existingInput?.audio ?? input.includes("audio"),
      image: existingInput?.image ?? input.includes("image"),
      video: existingInput?.video ?? input.includes("video"),
      pdf: existingInput?.pdf ?? input.includes("pdf"),
    },
    output: {
      text: existingOutput?.text ?? output.includes("text"),
      audio: existingOutput?.audio ?? output.includes("audio"),
      image: existingOutput?.image ?? output.includes("image"),
      video: existingOutput?.video ?? output.includes("video"),
      pdf: existingOutput?.pdf ?? output.includes("pdf"),
    },
    interleaved: existingCapabilities?.interleaved ?? false,
  };
}

function costForProviderModel(model: ProviderModel, existing: ProviderModel | undefined): Record<string, unknown> {
  const existingCost = existing?.cost as Record<string, unknown> | undefined;
  const modelCost = model.cost;
  return {
    input: modelCost?.input ?? existingCost?.input ?? 0,
    output: modelCost?.output ?? existingCost?.output ?? 0,
    cache: existingCost?.cache ?? { read: 0, write: 0 },
  };
}

function normalizeProviderHookModels(
  providerId: string,
  provider: Provider,
  definitions: Record<string, ProviderModel>,
  existingModels: Record<string, ProviderModel> = provider.models ?? {},
): Record<string, ProviderModel> {
  const normalized: Record<string, ProviderModel> = {};
  const providerApi = typeof provider.api === "string" ? provider.api : "";
  const providerNpm = typeof provider.npm === "string" ? provider.npm : "@ai-sdk/google";

  for (const [id, model] of Object.entries(definitions)) {
    const existing = existingModels[id];
    if (hasProviderModelRuntimeShape(model)) {
      normalized[id] = model;
      continue;
    }

    const limit = model.limit as { context?: number; input?: number; output?: number } | undefined;
    const existingLimit = existing?.limit as { context?: number; input?: number; output?: number } | undefined;
    const existingApi = existing?.api as Record<string, unknown> | undefined;

    normalized[id] = {
      ...existing,
      ...model,
      id,
      providerID: existing?.providerID ?? provider.id ?? providerId,
      api: {
        id: existingApi?.id ?? id,
        url: existingApi?.url ?? providerApi,
        npm: existingApi?.npm ?? providerNpm,
      },
      status: existing?.status ?? model.status ?? "active",
      headers: existing?.headers ?? model.headers ?? {},
      options: existing?.options ?? model.options ?? {},
      cost: costForProviderModel(model, existing),
      limit: {
        context: limit?.context ?? existingLimit?.context ?? 0,
        input: limit?.input ?? existingLimit?.input,
        output: limit?.output ?? existingLimit?.output ?? 0,
      },
      capabilities: modalitiesToCapabilities(model, existing),
      release_date: existing?.release_date ?? model.release_date ?? "",
    };
  }

  return normalized;
}

async function tryAgySdkFallbackForRequest(
  input: RequestInfo,
  init: RequestInit | undefined,
  config: AntigravityConfig,
  credentials: AgySdkCredential[],
  urlString: string,
  includeCatalogMiss = false,
): Promise<Response | null> {
  if (!config.agy_sdk.api_key_fallback || credentials.length === 0 || !isAgySdkSupportedRequest(urlString)) {
    return null;
  }
  // Defensive: if the original request body was already consumed (e.g. `input` is a
  // Request whose stream was read upstream), re-sending it through the api-key path
  // would throw "body already used". Current callers pass a string body, so this is
  // latent — but bail gracefully (return null → caller surfaces its existing error
  // Response) rather than letting an unhandled TypeError crash the session.
  if (typeof input !== "string" && "bodyUsed" in input && (input as Request).bodyUsed) {
    log.warn("agy-sdk fallback skipped: original request body already consumed", {
      url: sanitizeUrlForLog(urlString),
    });
    return null;
  }
  const response = await tryFetchWithAgySdkCredentials(
    input,
    init,
    credentials,
    defaultRetryMsForConfig(config),
    config.model_discovery.enabled && config.model_discovery.gemini_api,
  )
  return !includeCatalogMiss && response instanceof Gemini4CatalogResponse ? null : response
}

async function triggerAsyncQuotaRefreshForAccount(
  accountManager: AccountManager,
  accountIndex: number,
  client: PluginClient,
  providerId: string,
  intervalMinutes: number,
): Promise<void> {
  if (intervalMinutes <= 0) return;
  
  const accounts = accountManager.getAccounts();
  const account = accounts[accountIndex];
  if (!account || account.enabled === false) return;
  
  const accountKey = account.email ?? `idx-${accountIndex}`;
  if (quotaRefreshInProgressByEmail.has(accountKey)) return;
  
  const intervalMs = intervalMinutes * 60 * 1000;
  const age = account.cachedQuotaUpdatedAt != null 
    ? Date.now() - account.cachedQuotaUpdatedAt 
    : Infinity;
  
  if (age < intervalMs) return;
  
  quotaRefreshInProgressByEmail.add(accountKey);
  
  try {
    const accountsForCheck = accountManager.getAccountsForQuotaCheck();
    const singleAccount = accountsForCheck[accountIndex];
    if (!singleAccount) {
      quotaRefreshInProgressByEmail.delete(accountKey);
      return;
    }
    
    const results = await checkAccountsQuota([singleAccount], client, providerId);
    
    if (results[0]?.status === "ok") {
      let updated = false;
      if (results[0].quota?.groups) {
        accountManager.updateQuotaCache(accountIndex, results[0].quota.groups);
        updated = true;
      }
      if (results[0].availableModels !== undefined) {
        accountManager.updateAvailableModelsCache(accountIndex, results[0].availableModels);
        updated = true;
      }
      if (updated) {
        accountManager.requestSaveToDisk();
      }
    }
  } catch (err) {
    log.debug(`quota-refresh-failed email=${accountKey}`, { error: String(err) });
  } finally {
    quotaRefreshInProgressByEmail.delete(accountKey);
  }
}

function trackWarmupAttempt(sessionId: string): boolean {
  if (warmupSucceededSessionIds.has(sessionId)) {
    return false;
  }
  const attempts = getWarmupAttemptCount(sessionId);
  if (attempts >= MAX_WARMUP_RETRIES) {
    return false;
  }
  // Evict the oldest entry ONLY when inserting a brand-new session. Evicting
  // before the has-check could delete the very session being retried (if it were
  // the oldest), resetting its count to 0 and defeating the cap.
  if (!warmupAttemptCounts.has(sessionId) && warmupAttemptCounts.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupAttemptCounts.keys().next().value;
    if (first !== undefined) {
      warmupAttemptCounts.delete(first);
      warmupSucceededSessionIds.delete(first);
    }
  }
  // Count this attempt up-front so failed attempts accrue toward the cap
  // (previously the failure path cleared the record, so the cap never engaged).
  warmupAttemptCounts.set(sessionId, attempts + 1);
  return true;
}

function getWarmupAttemptCount(sessionId: string): number {
  return warmupAttemptCounts.get(sessionId) ?? 0;
}

function markWarmupSuccess(sessionId: string): void {
  warmupSucceededSessionIds.add(sessionId);
  warmupAttemptCounts.delete(sessionId);
  if (warmupSucceededSessionIds.size >= MAX_WARMUP_SESSIONS) {
    const first = warmupSucceededSessionIds.values().next().value;
    if (first) warmupSucceededSessionIds.delete(first);
  }
}

function isWSL(): boolean {
  if (process.platform !== "linux") return false;
  try {
    const { readFileSync } = require("node:fs");
    const release = readFileSync("/proc/version", "utf8").toLowerCase();
    return release.includes("microsoft") || release.includes("wsl");
  } catch {
    return false;
  }
}

function isWSL2(): boolean {
  if (!isWSL()) return false;
  try {
    const { readFileSync } = require("node:fs");
    const version = readFileSync("/proc/version", "utf8").toLowerCase();
    return version.includes("wsl2") || version.includes("microsoft-standard");
  } catch {
    return false;
  }
}

function isRemoteEnvironment(): boolean {
  if (process.env.SSH_CLIENT || process.env.SSH_TTY || process.env.SSH_CONNECTION) {
    return true;
  }
  if (process.env.REMOTE_CONTAINERS || process.env.CODESPACES) {
    return true;
  }
  if (process.platform === "linux" && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY && !isWSL()) {
    return true;
  }
  return false;
}

function shouldSkipLocalServer(): boolean {
  return isWSL2() || isRemoteEnvironment();
}

async function openBrowser(url: string): Promise<boolean> {
  try {
    if (process.platform === "darwin") {
      exec(`open "${url}"`);
      return true;
    }
    if (process.platform === "win32") {
      exec(`start "" "${url}"`);
      return true;
    }
    if (isWSL()) {
      try {
        exec(`wslview "${url}"`);
        return true;
      } catch {}
    }
    if (!process.env.DISPLAY && !process.env.WAYLAND_DISPLAY) {
      return false;
    }
    exec(`xdg-open "${url}"`);
    return true;
  } catch {
    return false;
  }
}

type VerificationProbeResult = {
  status: "ok" | "blocked" | "error";
  message: string;
  verifyUrl?: string;
};

function decodeEscapedText(input: string): string {
  return input
    .replace(/&amp;/g, "&")
    .replace(/\\u([0-9a-fA-F]{4})/g, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

function normalizeGoogleVerificationUrl(rawUrl: string): string | undefined {
  const normalized = decodeEscapedText(rawUrl).trim();
  if (!normalized) {
    return undefined;
  }
  try {
    const parsed = new URL(normalized);
    if (parsed.hostname !== "accounts.google.com") {
      return undefined;
    }
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function selectBestVerificationUrl(urls: string[]): string | undefined {
  const unique = Array.from(new Set(urls.map((url) => normalizeGoogleVerificationUrl(url)).filter(Boolean) as string[]));
  if (unique.length === 0) {
    return undefined;
  }
  unique.sort((a, b) => {
    const score = (value: string): number => {
      let total = 0;
      if (value.includes("plt=")) total += 4;
      if (value.includes("/signin/continue")) total += 3;
      if (value.includes("continue=")) total += 2;
      if (value.includes("service=cloudcode")) total += 1;
      return total;
    };
    return score(b) - score(a);
  });
  return unique[0];
}

function extractVerificationErrorDetails(bodyText: string): {
  validationRequired: boolean;
  message?: string;
  verifyUrl?: string;
} {
  const decodedBody = decodeEscapedText(bodyText);
  const lowerBody = decodedBody.toLowerCase();
  let validationRequired = lowerBody.includes("validation_required");
  let message: string | undefined;
  const verificationUrls = new Set<string>();

  const collectUrlsFromText = (text: string): void => {
    for (const match of text.matchAll(/https:\/\/accounts\.google\.com\/[^\s"'<>]+/gi)) {
      if (match[0]) {
        verificationUrls.add(match[0]);
      }
    }
  };

  collectUrlsFromText(decodedBody);

  const payloads: unknown[] = [];
  const trimmed = decodedBody.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      payloads.push(JSON.parse(trimmed));
    } catch {
    }
  }

  for (const rawLine of decodedBody.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("data:")) {
      continue;
    }
    const payloadText = line.slice(5).trim();
    if (!payloadText || payloadText === "[DONE]") {
      continue;
    }
    try {
      payloads.push(JSON.parse(payloadText));
    } catch {
      collectUrlsFromText(payloadText);
    }
  }

  const visited = new Set<unknown>();
  const walk = (value: unknown, key?: string): void => {
    if (typeof value === "string") {
      const normalizedValue = decodeEscapedText(value);
      const lowerValue = normalizedValue.toLowerCase();
      const lowerKey = key?.toLowerCase() ?? "";

      if (lowerValue.includes("validation_required")) {
        validationRequired = true;
      }
      if (
        !message &&
        (lowerKey.includes("message") || lowerKey.includes("detail") || lowerKey.includes("description"))
      ) {
        message = normalizedValue;
      }
      if (
        lowerKey.includes("validation_url") ||
        lowerKey.includes("verify_url") ||
        lowerKey.includes("verification_url") ||
        lowerKey === "url"
      ) {
        verificationUrls.add(normalizedValue);
      }
      collectUrlsFromText(normalizedValue);
      return;
    }

    if (!value || typeof value !== "object" || visited.has(value)) {
      return;
    }

    visited.add(value);

    if (Array.isArray(value)) {
      for (const item of value) {
        walk(item);
      }
      return;
    }

    for (const [childKey, childValue] of Object.entries(value as Record<string, unknown>)) {
      walk(childValue, childKey);
    }
  };

  for (const payload of payloads) {
    walk(payload);
  }

  if (!validationRequired) {
    validationRequired =
      lowerBody.includes("verification required") ||
      lowerBody.includes("verify your account") ||
      lowerBody.includes("account verification");
  }

  if (!message) {
    const fallback = decodedBody
      .split("\n")
      .map((line) => line.trim())
      .find((line) => line && !line.startsWith("data:") && /(verify|validation|required)/i.test(line));
    if (fallback) {
      message = fallback;
    }
  }

  return {
    validationRequired,
    message,
    verifyUrl: selectBestVerificationUrl([...verificationUrls]),
  };
}

/**
 * Detects a project-scoped "Permission denied on resource project X" 403 from
 * the Antigravity Code Assist backend (status PERMISSION_DENIED). This is
 * distinct from `validation_required` (account needs re-verification): it
 * signals the resolved backend model id isn't entitled for this managed
 * project — e.g. a staged Google rollout gate on a newly-added backend
 * variant (such as the Gemini 3.5 Flash "agent"/high-tier id) — not a
 * credential problem.
 *
 * Retrying the other Antigravity endpoints can't help (the project
 * entitlement is identical across daily/autopush/prod), but the public
 * Gemini API (agy-sdk path) routes through a separate entitlement system and
 * can still serve the model.
 */
function isModelPermissionDeniedOnProjectError(bodyText: string): boolean {
  const decoded = decodeEscapedText(bodyText).toLowerCase();
  return decoded.includes("permission denied on resource project");
}

export async function verifyAccountAccess(
  account: {
    refreshToken: string;
    email?: string;
    projectId?: string;
    managedProjectId?: string;
  },
  client: PluginClient,
  providerId: string,
): Promise<VerificationProbeResult> {
  const parsed = parseRefreshParts(account.refreshToken);
  if (!parsed.refreshToken) {
    return { status: "error", message: "Missing refresh token for selected account." };
  }

  const auth = {
    type: "oauth" as const,
    refresh: formatRefreshParts({
      refreshToken: parsed.refreshToken,
      projectId: parsed.projectId ?? account.projectId,
      managedProjectId: parsed.managedProjectId ?? account.managedProjectId,
    }),
    access: "",
    expires: 0,
  };

  let refreshedAuth: Awaited<ReturnType<typeof refreshAccessToken>>;
  try {
    refreshedAuth = await refreshAccessToken(auth, client, providerId);
  } catch (error) {
    if (error instanceof AntigravityTokenRefreshError) {
      return { status: "error", message: error.message };
    }
    return { status: "error", message: `Token refresh failed: ${String(error)}` };
  }

  if (!refreshedAuth?.access) {
    return { status: "error", message: "Could not refresh access token for this account." };
  }

  const projectId =
    parsed.managedProjectId ??
    parsed.projectId ??
    account.managedProjectId ??
    account.projectId ??
    ANTIGRAVITY_DEFAULT_PROJECT_ID;

  const headers: Record<string, string> = {
    ...getAntigravityHeaders(),
    Authorization: `Bearer ${refreshedAuth.access}`,
    "Content-Type": "application/json",
  };

  const requestBody = {
    project: projectId,
    model: "gemini-3-flash",
    request: {
      model: "gemini-3-flash",
      contents: [{ role: "user", parts: [{ text: "ping" }] }],
      generationConfig: { maxOutputTokens: 1, temperature: 0 },
    },
  };

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 20000);

  let response: Response;
  try {
    response = await fetch(`${ANTIGRAVITY_ENDPOINT}/v1internal:streamGenerateContent?alt=sse`, {
      method: "POST",
      headers,
      body: JSON.stringify(requestBody),
      signal: controller.signal,
    });
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { status: "error", message: "Verification check timed out." };
    }
    return { status: "error", message: `Verification check failed: ${String(error)}` };
  } finally {
    clearTimeout(timeoutId);
  }

  let responseBody = "";
  try {
    responseBody = await response.text();
  } catch {
    responseBody = "";
  }

  if (response.ok) {
    return { status: "ok", message: "Account verification check passed." };
  }

  const extracted = extractVerificationErrorDetails(responseBody);
  if (response.status === 403 && extracted.validationRequired) {
    return {
      status: "blocked",
      message: extracted.message ?? "Google requires additional account verification.",
      verifyUrl: extracted.verifyUrl,
    };
  }

  const fallbackMessage = extracted.message ?? `Request failed (${response.status} ${response.statusText}).`;
  return {
    status: "error",
    message: fallbackMessage,
  };
}

async function promptAccountIndexForVerification(
  accounts: Array<{ email?: string; index: number }>,
): Promise<number | undefined> {
  if (!process.stdin.isTTY) {
    return accounts[0]?.index;
  }
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log("\nSelect an account to verify:");
    for (const account of accounts) {
      const label = account.email || `Account ${account.index + 1}`;
      console.log(`  ${account.index + 1}. ${label}`);
    }
    console.log("");

    while (true) {
      const answer = (await rl.question("Account number (leave blank to cancel): ")).trim();
      if (!answer) {
        return undefined;
      }
      const parsedIndex = Number(answer);
      if (!Number.isInteger(parsedIndex)) {
        console.log("Please enter a valid account number.");
        continue;
      }
      const normalizedIndex = parsedIndex - 1;
      const selected = accounts.find((account) => account.index === normalizedIndex);
      if (!selected) {
        console.log("Please enter a number from the list above.");
        continue;
      }
      return selected.index;
    }
  } finally {
    rl.close();
  }
}

async function promptOpenVerificationUrl(): Promise<boolean> {
  const answer = (await promptOAuthCallbackValue("Open verification URL in your browser now? [Y/n]: ")).trim().toLowerCase();
  return answer === "" || answer === "y" || answer === "yes";
}

type VerificationStoredAccount = {
  enabled?: boolean;
  verificationRequired?: boolean;
  verificationRequiredAt?: number;
  verificationRequiredReason?: string;
  verificationUrl?: string;
};

function markStoredAccountVerificationRequired(
  account: VerificationStoredAccount,
  reason: string,
  verifyUrl?: string,
): boolean {
  let changed = false;
  const wasVerificationRequired = account.verificationRequired === true;

  if (!wasVerificationRequired) {
    account.verificationRequired = true;
    changed = true;
  }

  if (!wasVerificationRequired || account.verificationRequiredAt === undefined) {
    account.verificationRequiredAt = Date.now();
    changed = true;
  }

  const normalizedReason = reason.trim();
  if (account.verificationRequiredReason !== normalizedReason) {
    account.verificationRequiredReason = normalizedReason;
    changed = true;
  }

  const normalizedUrl = verifyUrl?.trim();
  if (normalizedUrl && account.verificationUrl !== normalizedUrl) {
    account.verificationUrl = normalizedUrl;
    changed = true;
  }

  if (account.enabled !== false) {
    account.enabled = false;
    changed = true;
  }

  return changed;
}

function clearStoredAccountVerificationRequired(
  account: VerificationStoredAccount,
  enableIfRequired = false,
): { changed: boolean; wasVerificationRequired: boolean } {
  const wasVerificationRequired = account.verificationRequired === true;
  let changed = false;

  if (account.verificationRequired !== false) {
    account.verificationRequired = false;
    changed = true;
  }
  if (account.verificationRequiredAt !== undefined) {
    account.verificationRequiredAt = undefined;
    changed = true;
  }
  if (account.verificationRequiredReason !== undefined) {
    account.verificationRequiredReason = undefined;
    changed = true;
  }
  if (account.verificationUrl !== undefined) {
    account.verificationUrl = undefined;
    changed = true;
  }

  if (enableIfRequired && wasVerificationRequired && account.enabled === false) {
    account.enabled = true;
    changed = true;
  }

  return { changed, wasVerificationRequired };
}

async function promptOAuthCallbackValue(message: string): Promise<string> {
  if (!process.stdin.isTTY) {
    throw new Error("Interactive prompt not available in this environment. Please ensure the OAuth callback opens in the browser automatically.");
  }
  const { createInterface } = await import("node:readline/promises");
  const { stdin, stdout } = await import("node:process");
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question(message)).trim();
  } finally {
    rl.close();
  }
}

type OAuthCallbackParams = { code: string; state: string };

function getStateFromAuthorizationUrl(authorizationUrl: string): string {
  try {
    return new URL(authorizationUrl).searchParams.get("state") ?? "";
  } catch {
    return "";
  }
}

function extractOAuthCallbackParams(url: URL): OAuthCallbackParams | null {
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) {
    return null;
  }
  return { code, state };
}

function parseOAuthCallbackInput(
  value: string,
  fallbackState: string,
): OAuthCallbackParams | { error: string } {
  const trimmed = value.trim();
  if (!trimmed) {
    return { error: "Missing authorization code" };
  }

  try {
    const url = new URL(trimmed);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");

    if (!code) {
      return { error: "Missing code in callback URL" };
    }
    if (!state) {
      return { error: "Missing state in callback URL" };
    }

    return { code, state };
  } catch {
    if (!fallbackState) {
      return { error: "Missing state. Paste the full redirect URL instead of only the code." };
    }

    return { code: trimmed, state: fallbackState };
  }
}

async function promptManualOAuthInput(
  fallbackState: string,
): Promise<AntigravityTokenExchangeResult> {
  console.log("1. Open the URL above in your browser and complete Google sign-in.");
  console.log("2. After approving, copy the full redirected localhost URL from the address bar.");
  console.log("3. Paste it back here.\n");

  const callbackInput = await promptOAuthCallbackValue(
    "Paste the redirect URL (or just the code) here: ",
  );
  const params = parseOAuthCallbackInput(callbackInput, fallbackState);
  if ("error" in params) {
    return { type: "failed", error: params.error };
  }

  return exchangeAntigravity(params.code, params.state, fallbackState);
}

function clampInt(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.min(max, Math.max(min, Math.floor(value)));
}

async function persistAccountPool(
  results: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>>,
  replaceAll: boolean = false,
): Promise<void> {
  if (results.length === 0) {
    return;
  }

  const now = Date.now();
  
  // If replaceAll is true (fresh login), start with empty accounts
  // Otherwise, load existing accounts and merge
  const stored = replaceAll ? null : await loadAccounts();
  const accounts = stored?.accounts ? [...stored.accounts] : [];

  const indexByRefreshToken = new Map<string, number>();
  const indexByEmail = new Map<string, number>();
  for (let i = 0; i < accounts.length; i++) {
    const acc = accounts[i];
    if (acc?.refreshToken) {
      indexByRefreshToken.set(acc.refreshToken, i);
    }
    if (acc?.email) {
      indexByEmail.set(acc.email, i);
    }
  }

  for (const result of results) {
    const parts = parseRefreshParts(result.refresh);
    if (!parts.refreshToken) {
      continue;
    }

    // First, check for existing account by email (prevents duplicates when refresh token changes)
    // Only use email-based deduplication if the new account has an email
    const existingByEmail = result.email ? indexByEmail.get(result.email) : undefined;
    const existingByToken = indexByRefreshToken.get(parts.refreshToken);
    
    // Prefer email-based match to handle refresh token rotation
    const existingIndex = existingByEmail ?? existingByToken;
    
    if (existingIndex === undefined) {
      // New account - add it
      const newIndex = accounts.length;
      indexByRefreshToken.set(parts.refreshToken, newIndex);
      if (result.email) {
        indexByEmail.set(result.email, newIndex);
      }
      accounts.push({
        email: result.email,
        refreshToken: parts.refreshToken,
        projectId: parts.projectId,
        managedProjectId: parts.managedProjectId,
        addedAt: now,
        lastUsed: now,
        enabled: true,
      });
      continue;
    }

    const existing = accounts[existingIndex];
    if (!existing) {
      continue;
    }

    // Update existing account (this handles both email match and token match cases)
    // When email matches but token differs, this effectively replaces the old token
    const oldToken = existing.refreshToken;
    accounts[existingIndex] = {
      ...existing,
      email: result.email ?? existing.email,
      refreshToken: parts.refreshToken,
      projectId: parts.projectId ?? existing.projectId,
      managedProjectId: parts.managedProjectId ?? existing.managedProjectId,
      lastUsed: now,
    };
    
    // Update the token index if the token changed
    if (oldToken !== parts.refreshToken) {
      indexByRefreshToken.delete(oldToken);
      indexByRefreshToken.set(parts.refreshToken, existingIndex);
    }
  }

  if (accounts.length === 0) {
    return;
  }

  // For fresh logins, always start at index 0
  const activeIndex = replaceAll 
    ? 0 
    : (typeof stored?.activeIndex === "number" && Number.isFinite(stored.activeIndex) ? stored.activeIndex : 0);

  await saveAccounts({
    version: 4,
    accounts,
    activeIndex: clampInt(activeIndex, 0, accounts.length - 1),
    activeIndexByFamily: {
      claude: clampInt(activeIndex, 0, accounts.length - 1),
      gemini: clampInt(activeIndex, 0, accounts.length - 1),
    },
  });
}

function buildAuthSuccessFromStoredAccount(account: {
  refreshToken: string;
  projectId?: string;
  managedProjectId?: string;
  email?: string;
}): Extract<AntigravityTokenExchangeResult, { type: "success" }> {
  const refresh = formatRefreshParts({
    refreshToken: account.refreshToken,
    projectId: account.projectId,
    managedProjectId: account.managedProjectId,
  });

  return {
    type: "success",
    refresh,
    access: "",
    expires: 0,
    email: account.email,
    projectId: account.projectId ?? "",
  };
}

/**
 * Parse Go-style duration strings to milliseconds.
 * Supports compound durations: "1h16m0.667s", "1.5s", "200ms", "5m30s"
 * 
 * @param duration - Duration string in Go format
 * @returns Duration in milliseconds, or null if parsing fails
 */
function parseDurationToMs(duration: string): number | null {
  // Handle simple formats first for backwards compatibility
  const simpleMatch = duration.match(/^(\d+(?:\.\d+)?)(ms|s|m|h)?$/i);
  if (simpleMatch) {
    const value = parseFloat(simpleMatch[1]!);
    const unit = (simpleMatch[2] || "s").toLowerCase();
    switch (unit) {
      case "h": return value * 3600 * 1000;
      case "m": return value * 60 * 1000;
      case "s": return value * 1000;
      case "ms": return value;
      default: return value * 1000;
    }
  }
  
  // Parse compound Go-style durations: "1h16m0.667s", "5m30s", etc.
  const compoundRegex = /(\d+(?:\.\d+)?)(h|m(?!s)|s|ms)/gi;
  let totalMs = 0;
  let matchFound = false;
  let match = compoundRegex.exec(duration);
  while (match !== null) {
    matchFound = true;
    const value = parseFloat(match[1]!);
    const unit = match[2]!.toLowerCase();
    switch (unit) {
      case "h": totalMs += value * 3600 * 1000; break;
      case "m": totalMs += value * 60 * 1000; break;
      case "s": totalMs += value * 1000; break;
      case "ms": totalMs += value; break;
    }
    match = compoundRegex.exec(duration);
  }
  
  return matchFound ? totalMs : null;
}

interface RateLimitBodyInfo {
  retryDelayMs: number | null;
  message?: string;
  quotaResetTime?: string;
  reason?: string;
}

function extractRateLimitBodyInfo(body: unknown): RateLimitBodyInfo {
  if (!body || typeof body !== "object") {
    return { retryDelayMs: null };
  }

  const error = (body as { error?: unknown }).error;
  const rawMessage = error && typeof error === "object" && "message" in error ? error.message : undefined
  const message = typeof rawMessage === "string" ? rawMessage : undefined

  const details = error && typeof error === "object" 
    ? (error as { details?: unknown[] }).details 
    : undefined;

  let reason: string | undefined;
  if (Array.isArray(details)) {
    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (type === "type.googleapis.com/google.rpc.QuotaFailure" && "violations" in detail &&
          Array.isArray(detail.violations) && detail.violations.length) {
        reason ??= "QUOTA_EXHAUSTED"
      }
      if (typeof type === "string" && type.includes("google.rpc.ErrorInfo")) {
        const detailReason = (detail as { reason?: string }).reason;
        if (typeof detailReason === "string") {
          reason = detailReason;
          break;
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const type = (detail as { "@type"?: string })["@type"];
      if (typeof type === "string" && type.includes("google.rpc.RetryInfo")) {
        const retryDelay = (detail as { retryDelay?: string }).retryDelay;
        if (typeof retryDelay === "string") {
          const retryDelayMs = parseDurationToMs(retryDelay);
          if (retryDelayMs !== null) {
            return { retryDelayMs, message, reason };
          }
        }
      }
    }

    for (const detail of details) {
      if (!detail || typeof detail !== "object") continue;
      const metadata = (detail as { metadata?: Record<string, string> }).metadata;
      if (metadata && typeof metadata === "object") {
        const quotaResetDelay = metadata.quotaResetDelay;
        const quotaResetTime = metadata.quotaResetTimeStamp;
        if (typeof quotaResetDelay === "string") {
          const quotaResetDelayMs = parseDurationToMs(quotaResetDelay);
          if (quotaResetDelayMs !== null) {
            return { retryDelayMs: quotaResetDelayMs, message, quotaResetTime, reason };
          }
        }
        if (typeof quotaResetTime === "string" && Number.isFinite(Date.parse(quotaResetTime))) {
          return { retryDelayMs: Math.max(0, Date.parse(quotaResetTime) - Date.now()), message, quotaResetTime, reason }
        }
      }
    }
  }

  if (message) {
    const afterMatch = message.match(/reset after\s+([0-9hms.]+)/i);
    const rawDuration = afterMatch?.[1];
    if (rawDuration) {
      const parsed = parseDurationToMs(rawDuration);
      if (parsed !== null) {
        return { retryDelayMs: parsed, message, reason };
      }
    }
  }

  return { retryDelayMs: null, message, reason };
}

async function extractRetryInfoFromBody(response: Response): Promise<RateLimitBodyInfo> {
  try {
    const text = await response.clone().text();
    try {
      const parsed = JSON.parse(text) as unknown;
      return extractRateLimitBodyInfo(parsed);
    } catch {
      return { retryDelayMs: null };
    }
  } catch {
    return { retryDelayMs: null };
  }
}

async function readRetryEvidence(response: Response) {
  const bodyInfo = await extractRetryInfoFromBody(response)
  const header = retryAfterMs(response.headers)
  const explicitDelay = header === undefined ? bodyInfo.retryDelayMs : Math.max(header, bodyInfo.retryDelayMs ?? 0)
  const reason = parseRateLimitReason(bodyInfo.reason, bodyInfo.message, response.status)
  return { bodyInfo, explicitDelay, reason, unknown429: response.status === 429 && reason === "UNKNOWN" && explicitDelay === null }
}

const retryEvidence = new WeakMap<Response, ReturnType<typeof readRetryEvidence>>()
function getRetryEvidence(response: Response) {
  const evidence = retryEvidence.get(response) ?? readRetryEvidence(response)
  retryEvidence.set(response, evidence)
  return evidence
}

async function shouldRetrySdkResponse(response: Response): Promise<boolean> {
  return isRetryableAgySdkCredentialStatus(response.status) &&
    !(response.status === 429 && (await getRetryEvidence(response)).unknown429)
}

function formatWaitTime(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.ceil(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) {
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function createSoftQuotaBlockedResponse(input: {
  accountCount: number;
  family: ModelFamily;
  threshold: number;
  waitMs: number | null;
  requestedModel?: string;
}): Response {
  const waitTimeFormatted = input.waitMs ? formatWaitTime(input.waitMs) : "unknown";
  const errorMessage = [
    `[Antigravity Error] Quota protection: All ${input.accountCount} account(s) are over ${input.threshold}% usage for ${input.family}.`,
    `Quota resets in ${waitTimeFormatted}.`,
    "",
    "API-key fallback is disabled or unavailable, so the request was not routed to the public Gemini API.",
    "To continue, add more accounts, wait for quota reset, set soft_quota_threshold_percent: 100 to disable soft quota protection, or enable agy_sdk.api_key_fallback with a usable Gemini API key.",
  ].join("\n");
  return createSyntheticErrorResponse(errorMessage, input.requestedModel, input.family);
}

// Progressive rate limit retry delays
const FIRST_RETRY_DELAY_MS = 1000;      // 1s - first 429 quick retry on same account
const SWITCH_ACCOUNT_DELAY_MS = 5000;   // 5s - delay before switching to another account

/**
 * Rate limit state tracking with time-window deduplication.
 * 
 * Problem: When multiple subagents hit 429 simultaneously, each would increment
 * the consecutive counter, causing incorrect exponential backoff (5 concurrent
 * 429s = 2^5 backoff instead of 2^1).
 * 
 * Solution: Track per account+quota with deduplication window. Multiple 429s
 * within RATE_LIMIT_DEDUP_WINDOW_MS are treated as a single event.
 */
const RATE_LIMIT_DEDUP_WINDOW_MS = 2000; // 2 seconds - concurrent requests within this window are deduplicated
const RATE_LIMIT_STATE_RESET_MS = 120_000; // Reset consecutive counter after 2 minutes of no 429s

interface RateLimitState {
  consecutive429: number;
  lastAt: number;
  quotaKey: string; // Track which quota this state is for
}

// Key format: `${accountIndex}:${quotaKey}` for per-account-per-quota tracking
const rateLimitStateByAccountQuota = new Map<string, RateLimitState>();

// Track empty response retry attempts (ported from LLM-API-Key-Proxy)
const emptyResponseAttempts = new Map<string, number>();

/**
 * Get rate limit backoff with time-window deduplication.
 * 
 * @param accountIndex - The account index
 * @param quotaKey - The quota key (e.g., "gemini-antigravity", "claude")
 * @param serverRetryAfterMs - Server-provided retry delay (if any)
 * @param maxBackoffMs - Maximum backoff delay in milliseconds (default 60000)
 * @returns { attempt, delayMs, isDuplicate } - isDuplicate=true if within dedup window
 */
function getRateLimitBackoff(
  accountIndex: number, 
  quotaKey: string,
  serverRetryAfterMs: number | null,
  maxBackoffMs: number = 60_000
): { attempt: number; delayMs: number; isDuplicate: boolean } {
  const now = Date.now();
  const stateKey = `${accountIndex}:${quotaKey}`;
  const previous = rateLimitStateByAccountQuota.get(stateKey);
  
  // Check if this is a duplicate 429 within the dedup window
  if (previous && (now - previous.lastAt < RATE_LIMIT_DEDUP_WINDOW_MS)) {
    // Same rate limit event from concurrent request - don't increment
    const baseDelay = serverRetryAfterMs ?? 1000;
    const backoffDelay = Math.min(baseDelay * Math.pow(2, previous.consecutive429 - 1), maxBackoffMs);
    return { 
      attempt: previous.consecutive429, 
      delayMs: Math.max(baseDelay, backoffDelay),
      isDuplicate: true 
    };
  }
  
  // Check if we should reset (no 429 for 2 minutes) or increment
  const attempt = previous && (now - previous.lastAt < RATE_LIMIT_STATE_RESET_MS) 
    ? previous.consecutive429 + 1 
    : 1;
  
  rateLimitStateByAccountQuota.set(stateKey, { 
    consecutive429: attempt, 
    lastAt: now,
    quotaKey 
  });
  
  const baseDelay = serverRetryAfterMs ?? 1000;
  const backoffDelay = Math.min(baseDelay * Math.pow(2, attempt - 1), maxBackoffMs);
  return { attempt, delayMs: Math.max(baseDelay, backoffDelay), isDuplicate: false };
}

/**
 * Reset rate limit state for an account+quota combination.
 * Only resets the specific quota, not all quotas for the account.
 */
function resetRateLimitState(accountIndex: number, quotaKey: string): void {
  const stateKey = `${accountIndex}:${quotaKey}`;
  rateLimitStateByAccountQuota.delete(stateKey);
}

function headerStyleToQuotaKey(family: ModelFamily): string {
  return family === "claude" ? "claude" : "gemini-antigravity";
}

/**
 * Whether an endpoint follows `index` in ANTIGRAVITY_ENDPOINT_FALLBACKS. Used to
 * decide, after capacity retries are exhausted on the current endpoint, whether
 * trying the next endpoint can make progress or whether we must switch accounts
 * instead.
 */
function hasUsableEndpointAfterIndex(index: number): boolean {
  return index < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1
}

// Track consecutive non-429 failures per account to prevent infinite loops
const accountFailureState = new Map<number, { consecutiveFailures: number; lastFailureAt: number }>();
const MAX_CONSECUTIVE_FAILURES = 5;
const FAILURE_COOLDOWN_MS = 30_000; // 30 seconds cooldown after max failures
const FAILURE_STATE_RESET_MS = 120_000; // Reset failure count after 2 minutes of no failures

function trackAccountFailure(accountIndex: number): { failures: number; shouldCooldown: boolean; cooldownMs: number } {
  const now = Date.now();
  const previous = accountFailureState.get(accountIndex);
  
  // Reset if last failure was more than 2 minutes ago
  const failures = previous && (now - previous.lastFailureAt < FAILURE_STATE_RESET_MS) 
    ? previous.consecutiveFailures + 1 
    : 1;
  
  accountFailureState.set(accountIndex, { consecutiveFailures: failures, lastFailureAt: now });
  
  const shouldCooldown = failures >= MAX_CONSECUTIVE_FAILURES;
  const cooldownMs = shouldCooldown ? FAILURE_COOLDOWN_MS : 0;
  
  return { failures, shouldCooldown, cooldownMs };
}

function resetAccountFailureState(accountIndex: number): void {
  accountFailureState.delete(accountIndex);
}

/**
 * Compute the new numeric index for a per-account state key after the account
 * at `removedIndex` has been spliced out and subsequent indices renumbered
 * down by one (see AccountManager.removeAccount). Returns null when the entry
 * belonged to the removed account and should be dropped.
 */
function remapIndexAfterRemoval(index: number, removedIndex: number): number | null {
  if (index === removedIndex) return null
  return index > removedIndex ? index - 1 : index
}

/**
 * Remap a Set of numeric account indices in place after an account removal.
 * Drops the removed index and shifts higher indices down by one so the set
 * keeps referring to the same accounts after renumbering.
 */
function remapIndexSetAfterRemoval(set: Set<number>, removedIndex: number): void {
  const values = [...set]
  set.clear()
  for (const index of values) {
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) set.add(next)
  }
}

/**
 * Remap all module-level per-account state after the account at `removedIndex`
 * is removed from the pool. AccountManager.removeAccount() splices the account
 * out and renumbers every subsequent account's index down by one; index-keyed
 * state here must follow suit or it silently attaches to the wrong account.
 * Also folds in the old resetAllRateLimitStateForAccount cleanup (the removed
 * account's rate-limit entries are dropped).
 */
function remapAccountStateAfterRemoval(removedIndex: number): void {
  // accountFailureState: Map<accountIndex, ...>
  const failureEntries = [...accountFailureState.entries()]
  accountFailureState.clear()
  for (const [index, state] of failureEntries) {
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) accountFailureState.set(next, state)
  }

  // rateLimitStateByAccountQuota: Map<`${accountIndex}:${quotaKey}`, ...>
  const rateEntries = [...rateLimitStateByAccountQuota.entries()]
  rateLimitStateByAccountQuota.clear()
  for (const [key, state] of rateEntries) {
    const sep = key.indexOf(":")
    const index = Number(key.slice(0, sep))
    const quotaKey = key.slice(sep + 1)
    if (sep < 0 || Number.isNaN(index)) {
      // Malformed key — preserve as-is rather than dropping silently.
      rateLimitStateByAccountQuota.set(key, state)
      continue
    }
    const next = remapIndexAfterRemoval(index, removedIndex)
    if (next !== null) rateLimitStateByAccountQuota.set(`${next}:${quotaKey}`, state)
  }

  // Trackers in rotation.ts are index-keyed too; keep them attached to the right accounts.
  getHealthTracker().remapAfterRemoval(removedIndex)
  getTokenTracker().remapAfterRemoval(removedIndex)
}

/**
 * Test-only hooks. NOT part of the plugin's runtime surface — exported so unit
 * tests can exercise the pure loop-escape / index-remap / warmup helpers and
 * inspect the index-keyed module state they mutate. Kept in one object to avoid
 * scattering `export` across internal helpers.
 */
export const loopEscapeTestHooks = {
  hasUsableEndpointAfterIndex,
  remapIndexAfterRemoval,
  remapIndexSetAfterRemoval,
  remapAccountStateAfterRemoval,
  trackWarmupAttempt,
  getWarmupAttemptCount,
  markWarmupSuccess,
  MAX_WARMUP_SESSIONS,
  seedAccountFailure(index: number, consecutiveFailures: number): void {
    accountFailureState.set(index, { consecutiveFailures, lastFailureAt: Date.now() })
  },
  getAccountFailureCount(index: number): number | undefined {
    return accountFailureState.get(index)?.consecutiveFailures
  },
  seedRateLimitState(index: number, quotaKey: string, consecutive429: number): void {
    rateLimitStateByAccountQuota.set(`${index}:${quotaKey}`, {
      consecutive429,
      lastAt: Date.now(),
      quotaKey,
    })
  },
  getRateLimitConsecutive(index: number, quotaKey: string): number | undefined {
    return rateLimitStateByAccountQuota.get(`${index}:${quotaKey}`)?.consecutive429
  },
  resetAllInternalState(): void {
    accountFailureState.clear()
    rateLimitStateByAccountQuota.clear()
    warmupAttemptCounts.clear()
    warmupSucceededSessionIds.clear()
  },
}

/**
 * Sleep for a given number of milliseconds, respecting an abort signal.
 */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"));
      return;
    }

    const timeout = setTimeout(() => {
      cleanup();
      resolve();
    }, ms);

    const onAbort = () => {
      cleanup();
      reject(signal?.reason instanceof Error ? signal.reason : new Error("Aborted"));
    };

    const cleanup = () => {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
    };

    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/** Cancel this waiter, not another request's shared token/project lookup. */
function waitForShared<T>(task: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return task
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason)
    if (signal.aborted) abort()
    else signal.addEventListener("abort", abort, { once: true })
    task.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort))
  })
}

/**
 * Creates an Antigravity OAuth plugin for a specific provider ID.
 */
let versionCheck: Promise<void> | undefined

export const createAntigravityPlugin = (providerId: string) => async (
  { client, directory, runtime = "v1" }: PluginContext,
): Promise<PluginResult> => {
  // Load configuration from files and environment variables
  const config = loadConfig(directory);
  initRuntimeConfig(config);

  // Cached getAuth function for tool access
  let cachedGetAuth: GetAuth | null = null;
  let instanceAccountManager: AccountManager | null = null;
  const refreshQueues = new Set<ProactiveRefreshQueue>();
  const oauthListeners = new Set<OAuthListener>();
  const loginLifetime = new AbortController()
  
  // Initialize debug with config
  initializeDebug(config);
  
  // Initialize structured logger for TUI integration
  initLogger(client);
  
  // Fetch latest Antigravity version from remote API (non-blocking, falls back to hardcoded)
  versionCheck ??= initAntigravityVersion().catch((error: unknown) => {
    log.debug("version-check-failed", { error: String(error) })
  })
  
  // Initialize health tracker for hybrid strategy
  if (config.health_score) {
    initHealthTracker({
      initial: config.health_score.initial,
      successReward: config.health_score.success_reward,
      rateLimitPenalty: config.health_score.rate_limit_penalty,
      failurePenalty: config.health_score.failure_penalty,
      recoveryRatePerHour: config.health_score.recovery_rate_per_hour,
      minUsable: config.health_score.min_usable,
      maxScore: config.health_score.max_score,
    });
  }

  // Initialize token tracker for hybrid strategy
  if (config.token_bucket) {
    initTokenTracker({
      maxTokens: config.token_bucket.max_tokens,
      regenerationRatePerMinute: config.token_bucket.regeneration_rate_per_minute,
      initialTokens: config.token_bucket.initial_tokens,
    });
  }
  
  // Initialize disk signature cache if keep_thinking is enabled
  // This integrates with the in-memory cacheSignature/getCachedSignature functions
  if (config.keep_thinking) {
    initDiskSignatureCache(config.signature_cache);
  }
  
  // Initialize session recovery hook with full context
  const sessionRecovery = runtime === "v1"
    ? createSessionRecoveryHook({ client, directory }, config)
    : null;
  
  const updateChecker = createAutoUpdateCheckerHook(client, directory, {
    showStartupToast: true,
    autoUpdate: config.auto_update,
  });

  // Event handler for session recovery and updates
  const eventHandler = async (input: { event: { type: string; properties?: unknown } }) => {
    // Forward to update checker
    await updateChecker.event(input);
    
    // Track if this is a child session (subagent, background task)
    // This is used to filter toasts based on toast_scope config
    if (input.event.type === "session.created") {
      const props = input.event.properties as { info?: { id?: string; parentID?: string } } | undefined;
      const sessionID = props?.info?.id;
      const parentID = props?.info?.parentID;
      if (parentID) {
        isChildSession = true;
        childSessionParentID = parentID;
        log.debug("child-session-detected", { sessionID, parentID });
      } else {
        // Reset for root sessions - important when plugin instance is reused
        isChildSession = false;
        childSessionParentID = undefined;
        log.debug("root-session-detected", { sessionID });
      }
    }
    
    // Handle session recovery
    if (sessionRecovery && input.event.type === "session.error") {
      const props = input.event.properties as Record<string, unknown> | undefined;
      const sessionID = props?.sessionID as string | undefined;
      const messageID = props?.messageID as string | undefined;
      const error = props?.error;
      
      if (sessionRecovery.isRecoverableError(error)) {
        const messageInfo = {
          id: messageID,
          role: "assistant" as const,
          sessionID,
          error,
        };
        
        // handleSessionRecovery now does the actual fix (injects tool_result, etc.)
        const recovered = await sessionRecovery.handleSessionRecovery(messageInfo);

        // Only send "continue" AFTER successful tool_result_missing recovery
        // (thinking recoveries already resume inside handleSessionRecovery)
        if (recovered && sessionID && config.auto_resume) {
          // For tool_result_missing, we need to send continue after injecting tool_results
          await client.session.prompt({
            path: { id: sessionID },
            body: { parts: [{ type: "text", text: config.resume_text }] },
            query: { directory },
          }).catch(() => {});
          
          // Show success toast (respects toast_scope for child sessions)
          const successToast = getRecoverySuccessToast();
          log.debug("recovery-toast", { ...successToast, isChildSession, toastScope: config.toast_scope });
          if (!(config.toast_scope === "root_only" && isChildSession)) {
            await client.tui.showToast({
              body: {
                title: successToast.title,
                message: successToast.message,
                variant: "success",
              },
            }).catch(() => {});
          }
        }
      }
    }
  };

  // Create google_search tool with access to auth context
  const googleSearchTool = tool({
    description: "Search the web using Google Search and analyze URLs. Returns real-time information from the internet with source citations. Use this when you need up-to-date information about current events, recent developments, or any topic that may have changed. You can also provide specific URLs to analyze. IMPORTANT: If the user mentions or provides any URLs in their query, you MUST extract those URLs and pass them in the 'urls' parameter for direct analysis.",
    args: {
      query: tool.schema.string().describe("The search query or question to answer using web search"),
      urls: tool.schema.array(tool.schema.string()).optional().describe("List of specific URLs to fetch and analyze. IMPORTANT: Always extract and include any URLs mentioned by the user in their query here."),
      thinking: tool.schema.boolean().optional().default(true).describe("Enable deep thinking for more thorough analysis (default: true)"),
    },
    async execute(args, ctx) {
      log.debug("Google Search tool called", { query: args.query, urlCount: args.urls?.length ?? 0 });

      // Get current auth context
      const auth = cachedGetAuth ? await cachedGetAuth() : null;
      if (!auth || !isOAuthAuth(auth)) {
        return "Error: Not authenticated with Antigravity. Please run `opencode auth login` to authenticate.";
      }

      // Get access token and project ID
      const parts = parseRefreshParts(auth.refresh);
      const projectId = parts.managedProjectId || parts.projectId || "unknown";

      // Ensure we have a valid access token
      let accessToken = auth.access;
      if (!accessToken || accessTokenExpired(auth)) {
        try {
          const refreshed = await refreshAccessToken(auth, client, providerId);
          accessToken = refreshed?.access;
        } catch (error) {
          return `Error: Failed to refresh access token: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (!accessToken) {
        return "Error: No valid access token available. Please run `opencode auth login` to re-authenticate.";
      }

      return executeSearch(
        {
          query: args.query,
          urls: args.urls,
          thinking: args.thinking,
        },
        accessToken,
        projectId,
        ctx.abort,
      );
    },
  });

  return {
    dispose: () => {
      loginLifetime.abort()
      updateChecker.dispose();
      for (const queue of refreshQueues) queue.stop();
      refreshQueues.clear();
      for (const listener of oauthListeners) {
        void listener.close().catch((error: unknown) => {
          log.warn("OAuth listener cleanup failed", { error: String(error) });
        });
      }
      oauthListeners.clear();
    },
    event: eventHandler,
    tool: {
      google_search: googleSearchTool,
    },
    provider: {
      id: providerId,
      async models(provider: Provider, context): Promise<Record<string, ProviderModel>> {
        const fallbackModels = normalizeProviderHookModels(
          providerId,
          provider,
          mergeModelDefinitions(OPENCODE_MODEL_DEFINITIONS, provider.models ?? {}),
        );
        if (!config.model_discovery.enabled) {
          return fallbackModels;
        }

        let auth: AuthDetails | undefined;
        try {
          auth = context.auth ?? (cachedGetAuth ? await cachedGetAuth() : undefined);
        } catch (error) {
          log.debug("model-discovery-fallback", { error: error instanceof Error ? error.message : String(error) });
          return fallbackModels;
        }
        const [geminiResult, antigravityResult] = await Promise.allSettled([
          modelsFromAgySdkCredentials(config, auth),
          modelsFromOAuthAuth(config, auth, client, providerId, instanceAccountManager),
        ]);

        const geminiModels = geminiResult.status === "fulfilled" ? geminiResult.value : {};
        const registry = antigravityResult.status === "fulfilled" ? antigravityResult.value : undefined
        const antigravityModels = modelsFromAntigravityAvailableModels(registry ?? {})
        const unavailable = new Set<string>()
        if (registry) {
          for (const model of GEMINI4_MODELS) {
            const id = `antigravity-${model}`
            if (!(id in antigravityModels)) unavailable.add(id)
          }
          // A nonempty registry can list only backend tier IDs, not the
          // curated aliases. Absence is not an explicit disabled flag.
          if (!Object.keys(registry).length) {
            for (const id of Object.keys(OPENCODE_MODEL_DEFINITIONS)) {
              if (id.startsWith("antigravity-")) unavailable.add(id)
            }
          }
          for (const [sourceId, entry] of Object.entries(registry)) {
            const id = antigravityModelIdFromEntry(sourceId, entry)
            if (id && entry.disabled && !(id in antigravityModels)) unavailable.add(id)
          }
        }
        context.onUnavailable?.(unavailable)
        if (geminiResult.status === "rejected" || antigravityResult.status === "rejected") {
          log.debug("model-discovery-partial-fallback", {
            geminiError: geminiResult.status === "rejected" ? String(geminiResult.reason) : undefined,
            antigravityError: antigravityResult.status === "rejected" ? String(antigravityResult.reason) : undefined,
          });
        }

        const definitions = mergeModelDefinitions(fallbackModels, geminiModels, antigravityModels)
        for (const id of unavailable) delete definitions[id]
        return normalizeProviderHookModels(
          providerId,
          provider,
          definitions,
          fallbackModels,
        );
      },
    },
    auth: {
    provider: providerId,
    loader: async (getAuth: GetAuth, provider: Provider): Promise<LoaderResult | Record<string, unknown>> => {
      for (const queue of refreshQueues) queue.stop();
      refreshQueues.clear();
      // Cache getAuth for tool access
      cachedGetAuth = getAuth;

      const initialAuth = await getAuth();
      // Captured for the OAuth fetch handler's invalid_grant cleanup: only
      // clear OpenCode's stored OAuth credentials when OpenCode itself WAS in
      // OAuth mode at loader time. If we promote OAuth from disk over an
      // API-key auth (oh-my-opencode case), wiping back via client.auth.set
      // would corrupt that API-key state.
      const initialAuthWasOAuth = isOAuthAuth(initialAuth);
      const apiKeyAuth = isApiKeyAuth(initialAuth) ? initialAuth : null;
      const initialAgySdkCredentials = getAgySdkCredentials(config, apiKeyAuth);

      // Promote disk-stored OAuth accounts ahead of the API-key-only branch.
      // When OpenCode hands us non-OAuth auth (e.g. oh-my-opencode flips the
      // google provider into API-key mode, or the user only ever ran OAuth via
      // this plugin's own login flow), `~/.config/opencode/antigravity-accounts.json`
      // may still hold usable OAuth refresh tokens. Synthesize an OAuth `auth`
      // from the active disk account so antigravity-* / Claude requests route
      // through the Antigravity OAuth backend instead of being short-circuited
      // as 404s by the API-key-only interceptor below.
      let auth = initialAuth;
      if (!isOAuthAuth(initialAuth)) {
        const diskAccounts = await loadAccounts();
        const accountsOnDisk = diskAccounts?.accounts ?? [];
        const candidateIndex = typeof diskAccounts?.activeIndex === "number"
          && diskAccounts.activeIndex >= 0
          && diskAccounts.activeIndex < accountsOnDisk.length
          ? diskAccounts.activeIndex
          : 0;
        const activeAccount = accountsOnDisk[candidateIndex]
          ?? accountsOnDisk.find((acc) => !!acc?.refreshToken);
        if (activeAccount?.refreshToken) {
          auth = {
            type: "oauth",
            refresh: formatRefreshParts({
              refreshToken: activeAccount.refreshToken,
              projectId: activeAccount.projectId,
              managedProjectId: activeAccount.managedProjectId,
            }),
            access: "",
            expires: 0,
          };
        }
      }
       
      // If OpenCode has no valid OAuth auth, clear any stale account storage
      if (!isOAuthAuth(auth)) {
        if (initialAgySdkCredentials.length === 0) {
          try {
            await clearAccounts();
          } catch {
            // ignore
          }
          return {};
        }

        return {
          apiKey: "",
          async fetch(input, init) {
            const urlString = toUrlString(input);
            // Antigravity-only models (e.g. gemini-3.1-pro) can't be served by
            // the public Gemini API. Without OAuth there's no quota path that
            // can satisfy them, so short-circuit with actionable guidance
            // instead of forwarding to a guaranteed 404.
            if (isAntigravityOnlyGenerativeLanguageRequest(urlString)) {
              const requestedModel = extractRequestedGeminiModel(urlString);
              if (requestedModel) {
                return createAntigravityOnlyModelErrorResponse(requestedModel);
              }
            }
            if (!isAgySdkSupportedRequest(urlString)) {
              return fetch(input, init);
            }
            const latest = await getAuth();
            const latestCredentials = getAgySdkCredentials(config, isApiKeyAuth(latest) ? latest : apiKeyAuth);
            const response = await tryFetchWithAgySdkCredentials(
              input,
              init,
              latestCredentials,
              (config.default_retry_after_seconds ?? 60) * 1000,
              config.model_discovery.enabled && config.model_discovery.gemini_api,
            );
            if (response) return response;
            return fetch(input, init);
          },
        };
      }

      // Validate that stored accounts are in sync with OpenCode's auth
      // If OpenCode's refresh token doesn't match any stored account, clear stale storage
      const authParts = parseRefreshParts(auth.refresh);
      const storedAccounts = await loadAccounts();
      
      // Note: AccountManager now ensures the current auth is always included in accounts

      const accountManager = await AccountManager.loadFromDisk(auth, config.model_routing);
      if (runtime === "v2" && initialAuthWasOAuth && authParts.refreshToken) {
        accountManager.setPreferredAccount(authParts.refreshToken);
      }
      instanceAccountManager = accountManager;
      activeAccountManager = accountManager;
      if (accountManager.getAccountCount() > 0) {
        // A V2 OAuth credential can seed a new pool before the first disk save.
        // Persist it before the fetch-time eligibility check treats missing
        // storage as unavailable (while preserving the V1 debounce path).
        if (runtime === "v2" && !storedAccounts) await accountManager.saveToDisk();
        else accountManager.requestSaveToDisk();
      }

      // Initialize proactive token refresh queue (ported from LLM-API-Key-Proxy)
      let refreshQueue: ProactiveRefreshQueue | null = null;
      if (config.proactive_token_refresh && accountManager.getAccountCount() > 0) {
        refreshQueue = createProactiveRefreshQueue(client, providerId, {
          enabled: config.proactive_token_refresh,
          bufferSeconds: config.proactive_refresh_buffer_seconds,
          checkIntervalSeconds: config.proactive_refresh_check_interval_seconds,
        });
        refreshQueue.setAccountManager(accountManager);
        refreshQueue.start();
        refreshQueues.add(refreshQueue);
      }

      if (isDebugEnabled()) {
        const logPath = getLogFilePath();
        if (logPath) {
          try {
            await client.tui.showToast({
              body: { message: `Debug log: ${logPath}`, variant: "info" },
            });
          } catch {
            // TUI may not be available
          }
        }
      }

      if (provider.models) {
        for (const model of Object.values(provider.models)) {
          if (model) {
            model.cost = { input: 0, output: 0 };
          }
        }
      }

      return {
        apiKey: "",
        async fetch(input, init) {
          if (!isGenerativeLanguageRequest(input)) {
            return fetch(input, init);
          }

          // The V2 TUI is a separate bundle/process: module-local sync notifications
          // cannot reach this manager. Read the authoritative account controls before
          // routing each new request; never send with a removed or disabled account.
          if (runtime === "v2") accountManager.reconcileEligibility(await loadAccounts());

          // Fall back to the API-key-only sub-branch only when we have no
          // usable OAuth accounts (e.g. all were removed via invalid_grant).
          // Otherwise the OAuth/AccountManager flow below handles routing,
          // including the Antigravity SDK / Gemini API-key fallback when
          // quota is exhausted (see tryAgySdkFallbackForRequest).
          if (accountManager.getAccountCount() === 0) {
            const latestAuth = await getAuth();
            const latestCredentials = getAgySdkCredentials(config, isApiKeyAuth(latestAuth) ? latestAuth : null);
            const urlString = toUrlString(input);
            // Antigravity-only models can't be served by the public Gemini API
            // and there's no OAuth quota path available here — short-circuit
            // with actionable guidance instead of forwarding to a 404.
            if (isAntigravityOnlyGenerativeLanguageRequest(urlString)) {
              const requestedModel = extractRequestedGeminiModel(urlString);
              if (requestedModel) {
                return createAntigravityOnlyModelErrorResponse(requestedModel);
              }
            }
            if (isAgySdkSupportedRequest(urlString)) {
              const response = await tryFetchWithAgySdkCredentials(
                input,
                init,
                latestCredentials,
                (config.default_retry_after_seconds ?? 60) * 1000,
                config.model_discovery.enabled && config.model_discovery.gemini_api,
              );
              if (response) return response;
              const family = gemini4Model(extractRequestedGeminiModel(urlString))
              if (family) return missingGemini4Credential(family.model)
            }
            return fetch(input, init);
          }


          const urlString = toUrlString(input);
          const family = getModelFamilyFromUrl(urlString);
          const model = extractModelFromUrl(urlString);
          const gemini4 = gemini4Model(model)
          const agySdkCredentials = getAgySdkCredentials(config, apiKeyAuth);
          const debugLines: string[] = [];
          const pushDebug = (line: string) => {
            if (!isDebugEnabled()) return;
            debugLines.push(line);
          };
          pushDebug(`request=${sanitizeUrlForLog(urlString)}`);

          type FailureContext = {
            response: Response;
            streaming: boolean;
            debugContext: ReturnType<typeof startAntigravityDebugRequest>;
            requestedModel?: string;
            projectId?: string;
            endpoint?: string;
            effectiveModel?: string;
            sessionId?: string;
            toolDebugMissing?: number;
            toolDebugSummary?: string;
            toolDebugPayload?: string;
          };

          let lastFailure: FailureContext | null = null;
          let lastError: Error | null = null;
          const abortSignal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
          // Accounts already tried (and switched away from) within THIS request.
          // Excluded from re-selection so each "switch account" makes forward
          // progress instead of re-picking the same account forever. Cleared
          // after a rate-limit/quota wait, since resets may free accounts again.
          const triedSwitchIndices = new Set<number>();
          // Absolute safety net: bound total loop iterations so the request can
          // never spin the event loop, regardless of account/quota state.
          let loopGuard = 0;

          // Helper to check if request was aborted
          const checkAborted = () => {
            if (abortSignal?.aborted) {
              throw abortSignal.reason instanceof Error ? abortSignal.reason : new Error("Aborted");
            }
          };

          // Use while(true) loop to handle rate limits with backoff
          // This ensures we wait and retry when all accounts are rate-limited
          const quietMode = config.quiet_mode;
          const toastScope = config.toast_scope;

          // Helper to show toast without blocking on abort (respects quiet_mode and toast_scope)
          const showToast = async (message: string, variant: "info" | "warning" | "success" | "error") => {
            // Always log to debug regardless of toast filtering
            log.debug("toast", { message, variant, isChildSession, toastScope });

            if (quietMode) return;
            if (abortSignal?.aborted) return;

            // Filter toasts for child sessions when toast_scope is "root_only".
            // Uses the last-event heuristic globals (see the KNOWN LIMITATION note
            // where they're declared) — per-request session correlation isn't
            // available from the fetch interceptor.
            if (toastScope === "root_only" && isChildSession) {
              log.debug("toast-suppressed-child-session", { message, variant, parentID: childSessionParentID });
              return;
            }
            
            if (variant === "warning" && message.toLowerCase().includes("rate")) {
              if (!shouldShowRateLimitToast(message)) {
                return;
              }
            }
            
            try {
              await client.tui.showToast({
                body: { message, variant },
              });
            } catch {
              // TUI may not be available
            }
          };
          
          const hasOtherAccountWithAntigravity = (currentAccount: any): boolean => {
            if (family !== "gemini") return false;
            // Use AccountManager method which properly checks for disabled/cooling-down accounts
            return accountManager.hasOtherAccountWithAntigravityAvailable(currentAccount.index, family, model);
          };

          while (true) {
            // Check for abort at the start of each iteration
            checkAborted();
            if (runtime === "v2") accountManager.reconcileEligibility(await loadAccounts());
            
            const accountCount = accountManager.getAccountCount();
            // Safety net: a request can iterate at most a few times per account
            // (select -> refresh -> fetch/switch). If we blow far past that, the
            // routing is not converging (e.g. all accounts exhausted for an
            // Antigravity-only model) — give up gracefully instead of spinning.
            if (++loopGuard > Math.max(50, accountCount * 8)) {
              const guardFallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
              if (guardFallback) return guardFallback;
              throw lastError || new Error(
                `Antigravity request routing did not converge for ${model ?? family}. ` +
                `All ${accountCount} account(s) appear rate-limited or exhausted for this model. ` +
                "Run `opencode auth login` to add accounts or wait for quota reset.",
              );
            }
            const routingDecision = resolveHeaderRoutingDecision(urlString);
            const { preferredHeaderStyle, explicitQuota } = routingDecision;

            if (
              family === "gemini" &&
               (config.agy_sdk.prefer_for_gemini || (gemini4 && apiKeyAuth)) &&
              !explicitQuota &&
              agySdkCredentials.length > 0 &&
              isAgySdkSupportedRequest(urlString)
            ) {
              const response = await tryFetchWithAgySdkCredentials(
                input,
                init,
                agySdkCredentials,
                (config.default_retry_after_seconds ?? 60) * 1000,
                config.model_discovery.enabled && config.model_discovery.gemini_api,
              );
              if (response && !(response instanceof Gemini4CatalogResponse) && !await shouldRetrySdkResponse(response)) {
                return response;
              }
            }
            
            if (accountCount === 0) {
              const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
              if (response) return response;
              throw new Error("No Antigravity accounts available. Run `opencode auth login`.");
            }

            const softQuotaCacheTtlMs = computeSoftQuotaCacheTtlMs(
              config.soft_quota_cache_ttl_minutes,
              config.quota_refresh_interval_minutes,
            );

            let account = accountManager.getCurrentOrNextForFamily(
              family,
              model,
              config.account_selection_strategy,
              preferredHeaderStyle,
              config.pid_offset_enabled,
              config.soft_quota_threshold_percent,
              softQuotaCacheTtlMs,
              triedSwitchIndices,
            );

            if (!account) {
              const eligibleForModel = accountManager.getEligibleAccountsForModel(model);
              if (eligibleForModel.length === 0) {
                const unavailableFallback = await tryAgySdkFallbackForRequest(
                  input,
                  init,
                  config,
                  agySdkCredentials,
                  urlString,
                  Boolean(gemini4),
                );
                if (unavailableFallback && !(unavailableFallback instanceof Gemini4CatalogResponse)) {
                  return unavailableFallback;
                }
                if (gemini4) {
                  return new Gemini4CatalogResponse(
                    `${gemini4.model} is not listed as enabled for any eligible Antigravity account/project. ` +
                    (unavailableFallback
                      ? "The configured Gemini API keys also do not list it."
                      : "Select an account that lists it, or configure a Gemini API key with access."),
                  );
                }
                if (lastFailure) {
                  return transformAntigravityResponse(
                    lastFailure.response,
                    lastFailure.streaming,
                    lastFailure.debugContext,
                    lastFailure.requestedModel,
                    lastFailure.projectId,
                    lastFailure.endpoint,
                    lastFailure.effectiveModel,
                    lastFailure.sessionId,
                    lastFailure.toolDebugMissing,
                    lastFailure.toolDebugSummary,
                    lastFailure.toolDebugPayload,
                    debugLines,
                  );
                }
                const modelLabel = model ?? family;
                return new Response(
                  JSON.stringify({
                    error: {
                      code: 404,
                      status: "NOT_FOUND",
                      message:
                        `No enabled Antigravity account is eligible for model "${modelLabel}". ` +
                        "Check account model availability or rules (`antigravity-accounts models`), or add an account with access.",
                    },
                  }),
                  {
                    status: 404,
                    headers: { "content-type": "application/json" },
                  },
                );
              }

              // Every eligible account for this model was already tried (and switched
              // away from) during THIS request. Nothing left to route to, so give up
              // gracefully rather than waiting on accounts that won't recover mid-request.
              const remainingEligible = accountManager.getEligibleAccountsForModel(model, triedSwitchIndices);
              if (eligibleForModel.length > 0 && remainingEligible.length === 0) {
                // Terminal (last-resort) fallback: every eligible account has been tried, so
                // there is nothing left to rotate to. Intentionally UNguarded — we
                // return whatever the SDK gives, even a retryable failure, as a
                // bubble-able Response (project convention: return a Response rather
                // than throw) instead of falling through to a bare error.
                const exhaustedFallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
                if (exhaustedFallback) return exhaustedFallback;
                if (lastFailure) {
                  return transformAntigravityResponse(
                    lastFailure.response,
                    lastFailure.streaming,
                    lastFailure.debugContext,
                    lastFailure.requestedModel,
                    lastFailure.projectId,
                    lastFailure.endpoint,
                    lastFailure.effectiveModel,
                    lastFailure.sessionId,
                    lastFailure.toolDebugMissing,
                    lastFailure.toolDebugSummary,
                    lastFailure.toolDebugPayload,
                    debugLines,
                  );
                }
                throw lastError || new Error(
                  `All ${eligibleForModel.length} eligible Antigravity account(s) are rate-limited or unavailable for ${model ?? family}. ` +
                  "Run `opencode auth login` to add accounts or wait for quota reset.",
                );
              }
              if (accountManager.areAllAccountsOverSoftQuota(
                family,
                config.soft_quota_threshold_percent,
                softQuotaCacheTtlMs,
                model,
                preferredHeaderStyle,
              )) {
                const threshold = config.soft_quota_threshold_percent;
                const softQuotaWaitMs = accountManager.getMinWaitTimeForSoftQuota(
                  family,
                  threshold,
                  softQuotaCacheTtlMs,
                  model,
                  preferredHeaderStyle,
                );
                const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
                const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
                if (response) return response;
                
                if (softQuotaWaitMs === null || (maxWaitMs > 0 && softQuotaWaitMs > maxWaitMs)) {
                  const waitTimeFormatted = softQuotaWaitMs ? formatWaitTime(softQuotaWaitMs) : "unknown";
                  await showToast(
                    `All accounts over ${threshold}% quota threshold. Resets in ${waitTimeFormatted}.`,
                    "error"
                  );
                  return createSoftQuotaBlockedResponse({
                    accountCount,
                    family,
                    threshold,
                    waitMs: softQuotaWaitMs,
                    requestedModel: model ?? undefined,
                  });
                }
                
                const waitSecValue = Math.max(1, Math.ceil(softQuotaWaitMs / 1000));
                pushDebug(`all-over-soft-quota family=${family} accounts=${accountCount} waitMs=${softQuotaWaitMs}`);
                
                if (!softQuotaToastShown) {
                  await showToast(`All ${accountCount} account(s) over ${threshold}% quota. Waiting ${formatWaitTime(softQuotaWaitMs)}...`, "warning");
                  softQuotaToastShown = true;
                }
                
                triedSwitchIndices.clear();
                await sleep(softQuotaWaitMs, abortSignal);
                continue;
              }

              // All accounts are rate-limited - wait and retry
              const waitMs = accountManager.getMinWaitTimeForFamily(
                family,
                model,
                preferredHeaderStyle,
                true,
              ) || 60_000;
              const waitSecValue = Math.max(1, Math.ceil(waitMs / 1000));

              pushDebug(`all-rate-limited family=${family} accounts=${accountCount} waitMs=${waitMs}`);
              if (isDebugEnabled()) {
                logAccountContext("All accounts rate-limited", {
                  index: -1,
                  family,
                  totalAccounts: accountCount,
                });
                logRateLimitSnapshot(family, accountManager.getAccountsSnapshot());
              }

              // If wait time exceeds max threshold, return error immediately instead of hanging
              // 0 means disabled (wait indefinitely)
              const maxWaitMs = (config.max_rate_limit_wait_seconds ?? 300) * 1000;
              const response = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString);
              if (response) return response;
              if (maxWaitMs > 0 && waitMs > maxWaitMs) {
                const waitTimeFormatted = formatWaitTime(waitMs);
                await showToast(
                  `Rate limited for ${waitTimeFormatted}. Try again later or add another account.`,
                  "error"
                );
                
                // Return a proper rate limit error response
                throw new Error(
                  `All ${accountCount} account(s) rate-limited for ${family}. ` +
                  `Quota resets in ${waitTimeFormatted}. ` +
                  `Add more accounts with \`opencode auth login\` or wait and retry.`
                );
              }

              if (!rateLimitToastShown) {
                await showToast(`All ${accountCount} account(s) rate-limited for ${family}. Waiting ${waitSecValue}s...`, "warning");
                rateLimitToastShown = true;
              }

              // Wait for the rate-limit cooldown to expire, then retry
              triedSwitchIndices.clear();
              await sleep(waitMs, abortSignal);
              continue;
            }

            // Account is available - reset the toast flag
            resetAllAccountsBlockedToasts();

            pushDebug(
              `selected idx=${account.index} email=${account.email ?? ""} family=${family} accounts=${accountCount} strategy=${config.account_selection_strategy}`,
            );
            if (isDebugEnabled()) {
              logAccountContext("Selected", {
                index: account.index,
                email: account.email,
                family,
                totalAccounts: accountCount,
                rateLimitState: account.rateLimitResetTimes,
              });
            }

            // Show toast when switching to a different account (debounced, quiet_mode handled by showToast)
            if (accountCount > 1 && accountManager.shouldShowAccountToast(account.index)) {
              const accountLabel = account.email || `Account ${account.index + 1}`;
              // Calculate position among enabled accounts (not absolute index)
              const enabledAccounts = accountManager.getEnabledAccounts();
              const enabledPosition = enabledAccounts.findIndex(a => a.index === account.index) + 1;
              await showToast(
                `Using ${accountLabel} (${enabledPosition}/${accountCount})`,
                "info"
              );
              accountManager.markToastShown(account.index);
            }

            accountManager.requestSaveToDisk();

            let authRecord = accountManager.toAuthDetails(account);

            if (accessTokenExpired(authRecord)) {
              try {
                const refreshed = await waitForShared(refreshAccessToken(authRecord, client, providerId), abortSignal);
                if (!refreshed) {
                  const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                  getHealthTracker().recordFailure(account.index);
                  lastError = new Error("Antigravity token refresh failed");
                  if (shouldCooldown) {
                    accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                    accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                    pushDebug(`token-refresh-failed: cooldown ${cooldownMs}ms after ${failures} failures`);
                  }
                  continue;
                }
                resetAccountFailureState(account.index);
                accountManager.updateFromAuth(account, refreshed);
                authRecord = refreshed;
                try {
                  await accountManager.saveToDisk();
                } catch (error) {
                  log.error("Failed to persist refreshed auth", { error: String(error) });
                }
              } catch (error) {
                checkAborted()
                if (error instanceof AntigravityTokenRefreshError && error.code === "invalid_grant") {
                  // Capture the index BEFORE removal — removeAccount renumbers all
                  // subsequent accounts, so index-keyed state must be remapped to match.
                  const removedIndex = account.index;
                  const removed = accountManager.removeAccount(account);
                  if (removed) {
                    remapAccountStateAfterRemoval(removedIndex);
                    remapIndexSetAfterRemoval(triedSwitchIndices, removedIndex);
                    log.warn("Removed revoked account from pool - reauthenticate via `opencode auth login`");
                    try {
                      await accountManager.persistAccountRemoval(account.parts.refreshToken);
                    } catch (persistError) {
                      log.error("Failed to persist revoked account removal", { error: String(persistError) });
                    }
                  }

                  if (accountManager.getAccountCount() === 0) {
                    // Only clear OpenCode's stored OAuth credentials when OpenCode
                    // was actually in OAuth mode at loader time. If we promoted
                    // OAuth from disk over an API-key auth, OpenCode's provider
                    // state IS api-key — wiping it would corrupt that.
                    if (initialAuthWasOAuth) {
                      try {
                        if (client.auth.revoke) {
                          await client.auth.revoke(account.parts.refreshToken);
                        } else {
                          await client.auth.set({
                            path: { id: providerId },
                            body: { type: "oauth", refresh: "", access: "", expires: 0 },
                          });
                        }
                      } catch (storeError) {
                        log.error("Failed to clear stored Antigravity OAuth credentials", { error: String(storeError) });
                      }
                    }

                    // Mixed-mode safety net: when promoted-from-disk OAuth fully
                    // fails but OpenCode has api-key auth (or env keys are configured)
                    // and the model is routable via the public Gemini API, attempt
                    // the api-key fallback before declaring the request unservable.
                    // OAuth-only setups still see the helpful "invalid refresh tokens"
                    // message since `tryAgySdkFallbackForRequest` returns null when
                    // no api-key credentials are available.
                    const fallback = await tryAgySdkFallbackForRequest(
                      input,
                      init,
                      config,
                      agySdkCredentials,
                      urlString,
                    );
                    if (fallback) return fallback;

                    throw new Error(
                      "All Antigravity accounts have invalid refresh tokens. Run `opencode auth login` and reauthenticate.",
                    );
                  }

                  lastError = error;
                  continue;
                }

                // Network failures do not invalidate credentials or model quota.
                if (!(error instanceof AntigravityTokenRefreshError)) throw error
                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                getHealthTracker().recordFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markAccountCoolingDown(account, cooldownMs, "auth-failure");
                  accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                  pushDebug(`token-refresh-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                continue;
              }
            }

            const accessToken = authRecord.access;
            if (!accessToken) {
              lastError = new Error("Missing access token");
              if (accountCount <= 1) {
                throw lastError;
              }
              continue;
            }

            let projectContext: ProjectContextResult;
            try {
              projectContext = await waitForShared(ensureProjectContext(authRecord), abortSignal);
              resetAccountFailureState(account.index);
            } catch (error) {
              checkAborted()
              const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
              getHealthTracker().recordFailure(account.index);
              lastError = error instanceof Error ? error : new Error(String(error));
              if (shouldCooldown) {
                accountManager.markAccountCoolingDown(account, cooldownMs, "project-error");
                accountManager.markRateLimited(account, cooldownMs, family, "antigravity", model);
                pushDebug(`project-context-error: cooldown ${cooldownMs}ms after ${failures} failures`);
              }
              continue;
            }

            if (projectContext.auth.refresh !== authRecord.refresh || 
                projectContext.auth.access !== authRecord.access) {
              accountManager.updateFromAuth(account, projectContext.auth);
              authRecord = projectContext.auth;
              try {
                await accountManager.saveToDisk();
              } catch (error) {
                log.error("Failed to persist project context", { error: String(error) });
              }
            }

            let discoveredRoutes: Gemini4Route[] | undefined
            if (gemini4 && config.model_discovery.enabled && config.model_discovery.antigravity) {
              const token = parseRefreshParts(projectContext.auth.refresh).refreshToken
              const project = projectContext.effectiveProjectId
              let registry = getCachedAntigravityAvailableModels(token, project)
              if (!registry) {
                try {
                  registry = (await waitForShared(fetchAvailableModels(accessToken, project), abortSignal)).models
                  if (registry) {
                    recordAntigravityAvailableModels(token, project, registry)
                    accountManager.updateAvailableModelsCache(account.index, registry)
                    accountManager.requestSaveToDisk()
                  }
                } catch (error) {
                  checkAborted()
                  log.debug("gemini4-oauth-discovery-failed", { error: String(error) })
                }
              }
              if (registry) {
                discoveredRoutes = gemini4Routes(registry).get(gemini4.model)
                if (!discoveredRoutes?.length) {
                  accountManager.markModelUnavailable(account, gemini4.model)
                  accountManager.requestSaveToDisk()
                  const nextExcluded = new Set(triedSwitchIndices)
                  nextExcluded.add(account.index)
                  if (accountManager.hasEligibleAccountForModel(model, nextExcluded)) {
                    pushDebug(`gemini4-unavailable-on-account idx=${account.index} model=${gemini4.model}; switching account`)
                    const accountLabel = account.email || `Account ${account.index + 1}`
                    await showToast(
                      `${gemini4.model} is not available on ${accountLabel}. Trying another account...`,
                      "info",
                    )
                    triedSwitchIndices.add(account.index)
                    continue
                  }
                  const fallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString, true)
                  if (fallback && !(fallback instanceof Gemini4CatalogResponse)) return fallback
                  return new Gemini4CatalogResponse(`${gemini4.model} is not listed as enabled for the current Antigravity account/project. ` +
                    (fallback ? "The configured Gemini API keys also do not list it." :
                      "Select an account that lists it, or configure a Gemini API key with access."))
                }
              }
            }

            const runThinkingWarmup = async (
              prepared: Awaited<ReturnType<typeof prepareAntigravityRequest>>,
              projectId: string,
            ): Promise<void> => {
              if (!prepared.needsSignedThinkingWarmup || !prepared.sessionId) {
                return;
              }

              if (!trackWarmupAttempt(prepared.sessionId)) {
                return;
              }

              const warmupBody = buildThinkingWarmupBody(
                typeof prepared.init.body === "string" ? prepared.init.body : undefined,
                Boolean(prepared.effectiveModel?.toLowerCase().includes("claude") && prepared.effectiveModel?.toLowerCase().includes("thinking")),
              );
              if (!warmupBody) {
                return;
              }

              const warmupUrl = toWarmupStreamUrl(prepared.request);
              const warmupHeaders = new Headers(prepared.init.headers ?? {});
              warmupHeaders.set("accept", "text/event-stream");

              const warmupInit: RequestInit = {
                ...prepared.init,
                method: prepared.init.method ?? "POST",
                headers: warmupHeaders,
                body: warmupBody,
              };

              const warmupDebugContext = startAntigravityDebugRequest({
                originalUrl: warmupUrl,
                resolvedUrl: warmupUrl,
                method: warmupInit.method,
                headers: warmupHeaders,
                body: warmupBody,
                streaming: true,
                projectId,
              });

              try {
                pushDebug("thinking-warmup: start");
                const warmupResponse = await fetch(warmupUrl, warmupInit);
                const transformed = await transformAntigravityResponse(
                  warmupResponse,
                  true,
                  warmupDebugContext,
                  prepared.requestedModel,
                  projectId,
                  warmupUrl,
                  prepared.effectiveModel,
                  prepared.sessionId,
                );
                await transformed.text();
                markWarmupSuccess(prepared.sessionId);
                pushDebug("thinking-warmup: done");
              } catch (error) {
                // Do NOT clear the attempt on failure — failed warmups must count
                // toward MAX_WARMUP_RETRIES so a session that always fails warmup
                // stops retrying after the cap instead of priming every request.
                pushDebug(
                  `thinking-warmup: failed ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            };

            // Try endpoint fallbacks with single header style based on model suffix
            let shouldSwitchAccount = false;
            
            // Every model uses the Antigravity quota (Gemini CLI is gone).
            const headerStyle = preferredHeaderStyle;
            pushDebug(`headerStyle=${headerStyle} explicit=${explicitQuota}`);
            if (account.fingerprint) {
              pushDebug(`fingerprint: quotaUser=${account.fingerprint.quotaUser} deviceId=${account.fingerprint.deviceId.slice(0, 8)}...`);
            }
            
            // Check if this header style is rate-limited for this account
            if (accountManager.isRateLimitedForHeaderStyle(account, family, headerStyle, model)) {
              shouldSwitchAccount = true;
            }
            
            while (!shouldSwitchAccount) {
            
            // Flag to force thinking recovery on retry after API error
            let forceThinkingRecovery = false;
            
            // Track if token was consumed (for hybrid strategy refund on error)
            let tokenConsumed = false;
            
            // Track capacity retries per endpoint to prevent infinite loops
            let capacityRetryCount = 0;
            let lastEndpointIndex = -1;
            
            for (let i = 0; i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length; i++) {
              // Reset capacity retry counter when switching to a new endpoint
              if (i !== lastEndpointIndex) {
                capacityRetryCount = 0;
                lastEndpointIndex = i;
              }

              const currentEndpoint = ANTIGRAVITY_ENDPOINT_FALLBACKS[i];
              let dispatched = false
              let responseStatus: number | undefined

              try {
                const prepared = await prepareAntigravityRequest(
                  input,
                  init,
                  accessToken,
                  projectContext.effectiveProjectId,
                  currentEndpoint,
                  headerStyle,
                  forceThinkingRecovery,
                  {
                    claudeToolHardening: config.claude_tool_hardening,
                    claudePromptAutoCaching: config.claude_prompt_auto_caching,
                    fingerprint: account.fingerprint,
                    gemini4Routes: discoveredRoutes,
                  },
                );

                const originalUrl = toUrlString(input);
                const resolvedUrl = toUrlString(prepared.request);
                pushDebug(`endpoint=${currentEndpoint}`);
                pushDebug(`resolved=${sanitizeUrlForLog(resolvedUrl)}`);
                const debugContext = startAntigravityDebugRequest({
                  originalUrl,
                  resolvedUrl,
                  method: prepared.init.method,
                  headers: prepared.init.headers,
                  body: prepared.init.body,
                  streaming: prepared.streaming,
                  projectId: projectContext.effectiveProjectId,
                });

                const createFailureContext = (failureResponse: Response): FailureContext => ({
                  response: failureResponse,
                  streaming: prepared.streaming,
                  debugContext,
                  requestedModel: prepared.requestedModel,
                  projectId: prepared.projectId,
                  endpoint: prepared.endpoint,
                  effectiveModel: prepared.effectiveModel,
                  sessionId: prepared.sessionId,
                  toolDebugMissing: prepared.toolDebugMissing,
                  toolDebugSummary: prepared.toolDebugSummary,
                  toolDebugPayload: prepared.toolDebugPayload,
                });

                await runThinkingWarmup(prepared, projectContext.effectiveProjectId);

                if (config.request_jitter_max_ms > 0) {
                  const jitterMs = Math.floor(Math.random() * config.request_jitter_max_ms);
                  if (jitterMs > 0) {
                    await sleep(jitterMs, abortSignal);
                  }
                }

                // Consume token for hybrid strategy
                // Refunded later if request fails (429 or network error)
                if (config.account_selection_strategy === 'hybrid') {
                  tokenConsumed = getTokenTracker().consume(account.index);
                }

                checkAborted()
                dispatched = true
                const response = await fetch(prepared.request, prepared.init);
                // The POST was delivered: a response exists. Everything after
                // this point is local response processing (empty-response
                // checks, transforms, logging), so delivery is proven and its
                // failures may fall back to the next endpoint/account like any
                // other recoverable error.
                dispatched = false
                responseStatus = response.status
                checkAborted()
                pushDebug(`status=${response.status} ${response.statusText}`);




                // Handle 429 rate limit (or Service Overloaded) with improved logic
                if (response.status === 429 || response.status === 503 || response.status === 529) {
                  // Refund token on rate limit
                  if (tokenConsumed) {
                    getTokenTracker().refund(account.index);
                    tokenConsumed = false;
                  }

                  const defaultRetryMs = (config.default_retry_after_seconds ?? 60) * 1000;
                  const maxBackoffMs = (config.max_backoff_seconds ?? 60) * 1000;
                  const { bodyInfo, explicitDelay, unknown429, reason: rateLimitReason } = await getRetryEvidence(response)
                  const serverRetryMs = explicitDelay ?? defaultRetryMs
                  checkAborted()

                  if (unknown429) {
                    pushDebug("429 without quota or retry information; returning provider response")
                    return response
                  }
                  if (explicitDelay !== null && config.max_rate_limit_wait_seconds > 0 &&
                      explicitDelay > config.max_rate_limit_wait_seconds * 1000) {
                    accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, explicitDelay)
                    accountManager.requestSaveToDisk()
                    if (accountCount <= 1) {
                      const fallback = await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString)
                      if (fallback && !await shouldRetrySdkResponse(fallback)) {
                        return fallback
                      }
                      return response
                    }
                    lastFailure = createFailureContext(response)
                    shouldSwitchAccount = true
                    break
                  }

                  // STRATEGY 1: CAPACITY / SERVER ERROR (Transient)
                  // Goal: Wait and Retry SAME Account. DO NOT LOCK.
                  // We handle this FIRST to avoid calling getRateLimitBackoff() and polluting the global rate limit state for transient errors.
                  if (rateLimitReason === "MODEL_CAPACITY_EXHAUSTED" || rateLimitReason === "SERVER_ERROR") {
                     // Retry the SAME account/endpoint a bounded number of times with
                     // exponential backoff (1s → 2s → 4s → 8s max, ±10% jitter to avoid a
                     // thundering herd). Only the retrying path toasts and sleeps — the
                     // terminal (4th) failure must escape immediately, without a misleading
                     // "retrying" toast or a wasted multi-second wait.
                     if (capacityRetryCount < 3) {
                       const baseDelayMs = 1000;
                       const maxDelayMs = 8000;
                       const exponentialDelay = Math.min(baseDelayMs * Math.pow(2, capacityRetryCount), maxDelayMs);
                       const jitter = exponentialDelay * (0.9 + Math.random() * 0.2);
                       const waitMs = Math.max(Math.round(jitter), explicitDelay ?? 0);
                       const waitSec = Math.round(waitMs / 1000);

                       pushDebug(`Server busy (${rateLimitReason}) on account ${account.index}, exponential backoff ${waitMs}ms (attempt ${capacityRetryCount + 1})`);
                       await showToast(
                         `⏳ Server busy (${response.status}). Retrying in ${waitSec}s...`,
                         "warning",
                       );
                       await sleep(waitMs, abortSignal);

                       // Decrement i so the loop 'continue' retries the SAME endpoint index
                       // (the for-loop's i++ brings it back to the current index).
                       capacityRetryCount++;
                       i -= 1;
                       continue;
                     }

                     // Capacity retries exhausted for this endpoint.
                     pushDebug(`Max capacity retries (3) exhausted for endpoint ${currentEndpoint}, regenerating fingerprint...`);
                     // Regenerate fingerprint to get a fresh device identity before trying elsewhere.
                     const newFingerprint = accountManager.regenerateAccountFingerprint(account.index);
                     if (newFingerprint) {
                       pushDebug(`Fingerprint regenerated for account ${account.index}`);
                     }

                     // Prefer the next usable endpoint on the SAME header style (existing behavior).
                     if (hasUsableEndpointAfterIndex(i)) {
                       continue;
                     }

                     // No further endpoint. Falling through to the for-loop's natural exit
                     // would let `while (!shouldSwitchAccount)` re-enter, reset
                     // capacityRetryCount to 0, and spin this SAME account forever (the outer
                     // loopGuard/account-rotation is never reached). Mark the pool and give the
                     // SDK fallback a chance before excluding the account.
                     accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs);

                     // Try the Antigravity SDK / Gemini API-key fallback before giving up the account.
                     // Only a SUCCESSFUL / non-retryable SDK response is terminal — tryFetch...()
                     // can return its last RETRYABLE failure (401/403/429/500/502/503/504/529, see
                     // isRetryableAgySdkCredentialStatus). Returning that would strand a healthy OAuth
                     // account that never got tried, so on a retryable SDK failure we fall through to
                     // account rotation (same guard as the prefer_for_gemini path).
                     const capacityAgySdkFallback = await tryAgySdkFallbackForRequest(
                       input,
                       init,
                       config,
                       agySdkCredentials,
                       urlString,
                     );
                      if (capacityAgySdkFallback && !await shouldRetrySdkResponse(capacityAgySdkFallback)) {
                       return capacityAgySdkFallback;
                     }

                     // Both quota pools exhausted and no SDK fallback — escape to the outer
                     // account-rotation loop (loopGuard + rotation apply there).
                     pushDebug(
                       `No further usable endpoint or quota for headerStyle=${headerStyle} after capacity exhaustion; switching account`,
                     );
                     lastError = new Error(
                       `Model capacity exhausted (${rateLimitReason}) on account ${account.index} after ${capacityRetryCount} retries`,
                     );
                     lastFailure = createFailureContext(response);
                     shouldSwitchAccount = true;
                     break;
                  }

                  // STRATEGY 2: RATE LIMIT EXCEEDED (RPM) / QUOTA EXHAUSTED / UNKNOWN
                  // Goal: Lock and Rotate (Standard Logic)
                  
                  // Only now do we call getRateLimitBackoff, which increments the global failure tracker
                  const quotaKey = headerStyleToQuotaKey(family);
                  const { attempt, delayMs } = getRateLimitBackoff(account.index, quotaKey, serverRetryMs, maxBackoffMs);
                  
                  // Calculate potential backoffs
                  const smartBackoffMs = calculateBackoffMs(rateLimitReason, account.consecutiveFailures ?? 0, serverRetryMs);
                  const effectiveDelayMs = Math.max(delayMs, smartBackoffMs);

                  pushDebug(
                    `429 idx=${account.index} email=${account.email ?? ""} family=${family} delayMs=${effectiveDelayMs} attempt=${attempt} reason=${rateLimitReason}`,
                  );
                  if (bodyInfo.message) {
                    pushDebug(`429 message=${bodyInfo.message}`);
                  }
                  if (bodyInfo.quotaResetTime) {
                    pushDebug(`429 quotaResetTime=${bodyInfo.quotaResetTime}`);
                  }
                  if (bodyInfo.reason) {
                    pushDebug(`429 reason=${bodyInfo.reason}`);
                  }

                   logRateLimitEvent(
                    account.index,
                    account.email,
                    family,
                    response.status,
                    effectiveDelayMs,
                    bodyInfo,
                  );

                  await logResponseBody(debugContext, response, 429);

                  getHealthTracker().recordRateLimit(account.index);

                  const accountLabel = account.email || `Account ${account.index + 1}`;

                  // Progressive retry for standard 429s: 1st 429 → 1s then switch (if enabled) or retry same
                  if (attempt === 1 && rateLimitReason !== "QUOTA_EXHAUSTED") {
                    
                    // CacheFirst mode: wait for same account if within threshold (preserves prompt cache)
                    if (config.scheduling_mode === 'cache_first') {
                      const maxCacheFirstWaitMs = config.max_cache_first_wait_seconds * 1000;
                      // effectiveDelayMs is the backoff calculated for this account
                      if (effectiveDelayMs <= maxCacheFirstWaitMs) {
                        pushDebug(`cache_first: waiting ${effectiveDelayMs}ms for same account to recover`);
                        await showToast(`⏳ Waiting ${Math.ceil(effectiveDelayMs / 1000)}s for same account (prompt cache preserved)...`, "info");
                        accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs);
                        await sleep(effectiveDelayMs, abortSignal);
                        // Retry same endpoint after wait
                        i -= 1;
                        continue;
                      }
                      // Wait time exceeds threshold, fall through to switch
                      pushDebug(`cache_first: wait ${effectiveDelayMs}ms exceeds max ${maxCacheFirstWaitMs}ms, switching account`);
                    }
                    
                    if (config.switch_on_first_rate_limit && accountCount > 1) {
                      accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);
                      shouldSwitchAccount = true;
                      break;
                    }
                    
                    // Same endpoint retry for first RPM hit
                    await sleep(Math.max(FIRST_RETRY_DELAY_MS, explicitDelay ?? 0), abortSignal)
                    i -= 1; 
                    continue;
                  }

                  accountManager.markRateLimitedWithReason(account, family, headerStyle, model, rateLimitReason, serverRetryMs, config.failure_ttl_seconds * 1000);

                  accountManager.requestSaveToDisk();

                  // For Gemini, move to another account that still has quota for this model.
                  if (family === "gemini" && hasOtherAccountWithAntigravity(account)) {
                    pushDebug(`antigravity exhausted on account ${account.index}, but available on others. Switching account.`);
                    await showToast(`Rate limited again. Switching account in 5s...`, "warning");
                    await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                    shouldSwitchAccount = true;
                    break;
                  }

                  const agySdkFallbackResponse = await tryAgySdkFallbackForRequest(
                    input,
                    init,
                    config,
                    agySdkCredentials,
                    urlString,
                  );
                  // Only a SUCCESSFUL / non-retryable SDK response is terminal here.
                  // tryFetch...() can return its last RETRYABLE failure (401/403/429/
                  // 500/502/503/504/529, see isRetryableAgySdkCredentialStatus); returning
                  // that would short-circuit the account rotation below (shouldSwitchAccount)
                  // and strand a healthy account. On a retryable SDK failure, fall through
                  // to rotate.
                  if (agySdkFallbackResponse && !await shouldRetrySdkResponse(agySdkFallbackResponse)) {
                    return agySdkFallbackResponse;
                  }

                  const quotaName = "Antigravity";

                  if (accountCount > 1) {
                    const quotaMsg = bodyInfo.quotaResetTime 
                      ? ` (quota resets ${bodyInfo.quotaResetTime})`
                      : ``;
                    await showToast(`Rate limited again. Switching account in 5s...${quotaMsg}`, "warning");
                    await sleep(SWITCH_ACCOUNT_DELAY_MS, abortSignal);
                  } else {
                    // Single account: exponential backoff (1s, 2s, 4s, 8s... max 60s)
                    const expBackoffMs = Math.min(FIRST_RETRY_DELAY_MS * Math.pow(2, attempt - 1), 60000);
                    const expBackoffFormatted = expBackoffMs >= 1000 ? `${Math.round(expBackoffMs / 1000)}s` : `${expBackoffMs}ms`;
                    await showToast(`Rate limited. Retrying in ${expBackoffFormatted} (attempt ${attempt})...`, "warning");
                    await sleep(expBackoffMs, abortSignal);
                  }

                  lastFailure = createFailureContext(response);
                  shouldSwitchAccount = true;
                  break;
                }

                // Success - reset rate limit backoff state for this quota
                const quotaKey = headerStyleToQuotaKey(family);
                resetRateLimitState(account.index, quotaKey);
                resetAccountFailureState(account.index);

                let permissionDeniedOnProject = false;
                if (response.status === 403) {
                  const errorBodyText = await response.clone().text().catch(() => "");
                  const extracted = extractVerificationErrorDetails(errorBodyText);

                  if (extracted.validationRequired) {
                    const verificationReason = extracted.message ?? "Google requires account verification.";
                    const cooldownMs = 10 * 60 * 1000;

                    accountManager.markAccountVerificationRequired(account.index, verificationReason, extracted.verifyUrl);
                    accountManager.markAccountCoolingDown(account, cooldownMs, "validation-required");
                    accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);

                    const label = account.email || `Account ${account.index + 1}`;
                    if (accountManager.shouldShowAccountToast(account.index, 60000)) {
                      await showToast(
                        `⚠ ${label} needs verification. Run 'opencode auth login' and use Verify accounts.`,
                        "warning",
                      );
                      accountManager.markToastShown(account.index);
                    }

                    pushDebug(`verification-required: disabled account ${account.index}`);
                    getHealthTracker().recordFailure(account.index);

                    lastFailure = createFailureContext(response);
                    shouldSwitchAccount = true;
                    break;
                  }

                  // Some 403s are not credential/verification problems but a
                  // project-scoped entitlement gate on this specific backend
                  // model id (e.g. a staged rollout of a new variant). See
                  // isModelPermissionDeniedOnProjectError for details.
                  permissionDeniedOnProject = isModelPermissionDeniedOnProjectError(errorBodyText);
                }

                const shouldRetryEndpoint = (
                  (response.status === 403 && !permissionDeniedOnProject) ||
                  response.status === 404 ||
                  response.status >= 500
                );

                if (shouldRetryEndpoint && i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  await logResponseBody(debugContext, response, response.status);
                  lastFailure = createFailureContext(response);
                  continue;
                }

                // Model-availability failure on this Antigravity account/project.
                // A 404 NOT_FOUND or 403 PERMISSION_DENIED ("Permission denied on resource project")
                // means this account/project isn't entitled to the requested model (e.g., tier/plan
                // restriction or staged rollout). First record temporary per-model unavailability
                // on this account and rotate to another eligible OAuth account if one exists.
                // Only when no other OAuth account can serve the model do we fall back to the
                // public Gemini API (agy-sdk path) or return the error response.
                if (response.status === 404 || permissionDeniedOnProject) {
                  if (model) {
                    accountManager.markModelUnavailable(account, model);
                    accountManager.requestSaveToDisk();
                    const nextExcluded = new Set(triedSwitchIndices);
                    nextExcluded.add(account.index);
                    if (accountManager.hasEligibleAccountForModel(model, nextExcluded)) {
                      pushDebug(
                        `model-unavailable (${response.status}) on account ${account.index} for ${model}; switching account`,
                      );
                      const accountLabel = account.email || `Account ${account.index + 1}`;
                      await showToast(
                        `${model} unavailable on ${accountLabel}. Switching account...`,
                        "info",
                      );
                      lastFailure = createFailureContext(response);
                      shouldSwitchAccount = true;
                      break;
                    }
                  }
                }

                if (
                  (response.status === 404 || permissionDeniedOnProject) &&
                  isAgySdkSupportedRequest(urlString)
                ) {
                  const fallbackModelLabel = extractRequestedGeminiModel(urlString) ?? model ?? family;
                  const modelUnavailableFallback = await tryAgySdkFallbackForRequest(
                    input,
                    init,
                    config,
                    agySdkCredentials,
                    urlString,
                  );
                  if (modelUnavailableFallback) {
                    if (modelUnavailableFallback.ok) {
                      pushDebug(`agy-sdk fallback OK after Antigravity ${response.status} for ${fallbackModelLabel}`);
                      // Expected, healthy degradation — info, not warn.
                      log.info("agy-sdk fallback served model unavailable on Antigravity", {
                        antigravityStatus: response.status,
                        model: fallbackModelLabel,
                        account: account.email ?? account.index,
                      });
                      return modelUnavailableFallback;
                    }
                    pushDebug(
                      `agy-sdk fallback failed (${modelUnavailableFallback.status}) after Antigravity ${response.status} for ${fallbackModelLabel}`,
                    );
                    log.warn("agy-sdk fallback also failed for model unavailable on Antigravity", {
                      antigravityStatus: response.status,
                      fallbackStatus: modelUnavailableFallback.status,
                      model: fallbackModelLabel,
                    });
                    return modelUnavailableFallback;
                  }
                  // No api-key fallback available (disabled or no credentials): fall
                  // through and return the Antigravity error below. It's still a Response,
                  // not a throw, so OpenCode continues.
                  pushDebug(
                    `no agy-sdk fallback available for ${fallbackModelLabel} after Antigravity ${response.status}`,
                  );
                }

                // Success or non-retryable error - return the response
                if (response.ok) {
                  account.consecutiveFailures = 0;
                  getHealthTracker().recordSuccess(account.index);
                  accountManager.markAccountUsed(account.index);
                  
                  void triggerAsyncQuotaRefreshForAccount(
                    accountManager,
                    account.index,
                    client,
                    providerId,
                    config.quota_refresh_interval_minutes,
                  );
                }
                // A successful response is logged by transformAntigravityResponse;
                // an error can be handled here without ever reaching it.
                if (!response.ok) {
                  logAntigravityDebugResponse(debugContext, response, {
                    note: `Error ${response.status}`,
                  });
                }
                if (response.ok && !prepared.streaming) {
                  await logResponseBody(debugContext, response, response.status);
                }
                if (!response.ok) {
                  await logResponseBody(debugContext, response, response.status);
                  
                  // Handle 400 "Prompt too long" with synthetic response to avoid session lock
                  if (response.status === 400) {
                    const cloned = response.clone();
                    const bodyText = await cloned.text();
                    if (bodyText.includes("Prompt is too long") || bodyText.includes("prompt_too_long")) {
                      await showToast(
                        "Context too long - use /compact to reduce size",
                        "warning"
                      );
                      const errorMessage = `[Antigravity Error] Context is too long for this model.\n\nPlease use /compact to reduce context size, then retry your request.\n\nAlternatively, you can:\n- Use /clear to start fresh\n- Use /undo to remove recent messages\n- Switch to a model with larger context window`;
                      return createSyntheticErrorResponse(errorMessage, prepared.requestedModel, family);
                    }
                  }
                }
                
                // Empty response retry logic (ported from LLM-API-Key-Proxy)
                // For non-streaming responses, check if the response body is empty
                // and retry if so (up to config.empty_response_max_attempts times)
                if (response.ok && !prepared.streaming) {
                  const maxAttempts = config.empty_response_max_attempts ?? 4;
                  const retryDelayMs = config.empty_response_retry_delay_ms ?? 2000;
                  
                  // Clone to check body without consuming original
                  const clonedForCheck = response.clone();
                  const bodyText = await clonedForCheck.text();
                  
                  if (isEmptyResponseBody(bodyText)) {
                    // Track empty response attempts per request
                    const emptyAttemptKey = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
                    const currentAttempts = (emptyResponseAttempts.get(emptyAttemptKey) ?? 0) + 1;
                    emptyResponseAttempts.set(emptyAttemptKey, currentAttempts);
                    
                    pushDebug(`empty-response: attempt ${currentAttempts}/${maxAttempts}`);
                    
                    if (currentAttempts < maxAttempts) {
                      await showToast(
                        `Empty response received. Retrying (${currentAttempts}/${maxAttempts})...`,
                        "warning"
                      );
                      await sleep(retryDelayMs, abortSignal);
                      continue; // Retry the endpoint loop
                    }
                    
                    // Clean up and throw after max attempts
                    emptyResponseAttempts.delete(emptyAttemptKey);
                    throw new EmptyResponseError(
                      "antigravity",
                      prepared.effectiveModel ?? "unknown",
                      currentAttempts,
                    );
                  }
                  
                  // Clean up successful attempt tracking
                  const emptyAttemptKeyClean = `${prepared.sessionId ?? "none"}:${prepared.effectiveModel ?? "unknown"}`;
                  emptyResponseAttempts.delete(emptyAttemptKeyClean);
                }
                
                const transformedResponse = await transformAntigravityResponse(
                  response,
                  prepared.streaming,
                  debugContext,
                  prepared.requestedModel,
                  prepared.projectId,
                  prepared.endpoint,
                  prepared.effectiveModel,
                  prepared.sessionId,
                  prepared.toolDebugMissing,
                  prepared.toolDebugSummary,
                  prepared.toolDebugPayload,
                  debugLines,
                );

                // Check for context errors and show appropriate toast
                const contextError = transformedResponse.headers.get("x-antigravity-context-error");
                if (contextError) {
                  if (contextError === "prompt_too_long") {
                    await showToast(
                      "Context too long - use /compact to reduce size, or trim your request",
                      "warning"
                    );
                  } else if (contextError === "tool_pairing") {
                    await showToast(
                      "Tool call/result mismatch - use /compact to fix, or /undo last message",
                      "warning"
                    );
                  }
                }

                return transformedResponse;
              } catch (error) {
                // Refund token on network/API error (only if consumed)
                if (tokenConsumed) {
                  getTokenTracker().refund(account.index);
                  tokenConsumed = false;
                }

                checkAborted()
                if (error instanceof Gemini4Unavailable) {
                  if (model) {
                    accountManager.markModelUnavailable(account, model);
                    accountManager.requestSaveToDisk();
                    const nextExcluded = new Set(triedSwitchIndices);
                    nextExcluded.add(account.index);
                    if (accountManager.hasEligibleAccountForModel(model, nextExcluded)) {
                      pushDebug(`gemini4-tier-unavailable on account ${account.index} for ${model}; switching account`);
                      shouldSwitchAccount = true;
                      break;
                    }
                  }
                  return await tryAgySdkFallbackForRequest(input, init, config, agySdkCredentials, urlString) ?? error.response()
                }
                // Handle recoverable thinking errors - retry with forced recovery
                if (responseStatus !== undefined && responseStatus >= 400 && error instanceof Error && error.message === "THINKING_RECOVERY_NEEDED") {
                  // Only retry once with forced recovery to avoid infinite loops
                  if (!forceThinkingRecovery) {
                    pushDebug("thinking-recovery: API error detected, retrying with forced recovery");
                    forceThinkingRecovery = true;
                    i = -1; // Will become 0 after loop increment, restart endpoint loop
                    continue;
                  }
                  
                  // Already tried with forced recovery, give up and return error
                  const recoveryError = error as any;
                  const originalError = recoveryError.originalError || { error: { message: "Thinking recovery triggered" } };
                  
                  const recoveryMessage = `${originalError.error?.message || "Session recovery failed"}\n\n[RECOVERY] Thinking block corruption could not be resolved. Try starting a new session.`;
                  
                  return new Response(JSON.stringify({
                    type: "error",
                    error: {
                      type: "unrecoverable_error",
                      message: recoveryMessage
                    }
                  }), {
                    status: 400,
                    headers: { "Content-Type": "application/json" }
                  });
                }

                // A network/reader error from fetch() itself cannot prove that
                // Google did not process the POST. Local response-processing
                // errors (EmptyResponseError, transforms) already reset the
                // flag once the response arrived, so they keep falling back.
                if (dispatched) throw error
                if (i < ANTIGRAVITY_ENDPOINT_FALLBACKS.length - 1) {
                  lastError = error instanceof Error ? error : new Error(String(error));
                  continue;
                }

                // All endpoints failed for this account - track failure and try next account
                const { failures, shouldCooldown, cooldownMs } = trackAccountFailure(account.index);
                lastError = error instanceof Error ? error : new Error(String(error));
                if (shouldCooldown) {
                  accountManager.markAccountCoolingDown(account, cooldownMs, "network-error");
                  accountManager.markRateLimited(account, cooldownMs, family, headerStyle, model);
                  pushDebug(`endpoint-error: cooldown ${cooldownMs}ms after ${failures} failures`);
                }
                shouldSwitchAccount = true;
                break;
              }
            }
            } // end headerStyleLoop
            
            if (shouldSwitchAccount) {
              // Exclude the account we're switching away from so the next
              // selection picks a DIFFERENT one (or returns null when none are
              // left). Without this, hybrid selection can re-pick the same
              // account and the loop spins forever (no fetch, 100% CPU).
              triedSwitchIndices.add(account.index);
              // Avoid tight retry loops when there's only one account.
              if (accountCount <= 1) {
                if (lastFailure) {
                  return transformAntigravityResponse(
                    lastFailure.response,
                    lastFailure.streaming,
                    lastFailure.debugContext,
                    lastFailure.requestedModel,
                    lastFailure.projectId,
                    lastFailure.endpoint,
                    lastFailure.effectiveModel,
                    lastFailure.sessionId,
                    lastFailure.toolDebugMissing,
                    lastFailure.toolDebugSummary,
                    lastFailure.toolDebugPayload,
                    debugLines,
                  );
                }

                throw lastError || new Error("All Antigravity endpoints failed");
              }

              continue;
            }

            // If we get here without returning, something went wrong
            if (lastFailure) {
              return transformAntigravityResponse(
                lastFailure.response,
                lastFailure.streaming,
                lastFailure.debugContext,
                lastFailure.requestedModel,
                lastFailure.projectId,
                lastFailure.endpoint,
                lastFailure.effectiveModel,
                lastFailure.sessionId,
                lastFailure.toolDebugMissing,
                lastFailure.toolDebugSummary,
                lastFailure.toolDebugPayload,
                debugLines,
              );
            }

            throw lastError || new Error("All Antigravity accounts failed");
          }
        },
      };
    },
    methods: [
      {
        label: "OAuth with Google (Antigravity)",
        type: "oauth",
        authorize: async (inputs?: Record<string, string>) => {
          const isHeadless = !!(
            process.env.SSH_CONNECTION ||
            process.env.SSH_CLIENT ||
            process.env.SSH_TTY ||
            process.env.OPENCODE_HEADLESS
          );

          // CLI flow (`opencode auth login`) passes an inputs object.
          if (inputs && runtime === "v1") {
            const accounts: Array<Extract<AntigravityTokenExchangeResult, { type: "success" }>> = [];
            const noBrowser = inputs.noBrowser === "true" || inputs["no-browser"] === "true";
            const useManualMode = noBrowser || shouldSkipLocalServer();

            // Check for existing accounts and prompt user for login mode
            let startFresh = true;
            let refreshAccountIndex: number | undefined;
            const existingStorage = await loadAccounts();
            if (existingStorage && existingStorage.accounts.length > 0) {
              let menuResult: LoginMenuResult;
              while (true) {
                const now = Date.now();
                const existingAccounts = existingStorage.accounts.map((acc, idx) => {
                  let status: 'active' | 'rate-limited' | 'expired' | 'verification-required' | 'unknown' = 'unknown';

                  if (acc.verificationRequired) {
                    status = 'verification-required';
                  } else {
                    const rateLimits = acc.rateLimitResetTimes;
                    if (rateLimits) {
                      const isRateLimited = Object.values(rateLimits).some(
                        (resetTime) => typeof resetTime === 'number' && resetTime > now
                      );
                      if (isRateLimited) {
                        status = 'rate-limited';
                      } else {
                        status = 'active';
                      }
                    } else {
                      status = 'active';
                    }

                    if (acc.coolingDownUntil && acc.coolingDownUntil > now) {
                      status = 'rate-limited';
                    }
                  }

                  return {
                    email: acc.email,
                    index: idx,
                    addedAt: acc.addedAt,
                    lastUsed: acc.lastUsed,
                    status,
                    isCurrentAccount: idx === (existingStorage.activeIndex ?? 0),
                    enabled: acc.enabled !== false,
                    allowedModels: acc.allowedModels,
                    disabledModels: acc.disabledModels,
                    cachedAvailableModels: acc.cachedAvailableModels,
                  };
                });
                
                menuResult = await promptLoginMode(existingAccounts);

                if (menuResult.mode === "check") {
                  console.log("\n📊 Checking quotas for all accounts...\n");
                  const results = await checkAccountsQuota(existingStorage.accounts, client, providerId);
                  let storageUpdated = false;
                  
                  for (const res of results) {
                    const label = res.email || `Account ${res.index + 1}`;
                    const disabledStr = res.disabled ? " (disabled)" : "";
                    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    console.log(`  ${label}${disabledStr}`);
                    console.log(`━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━`);
                    
                    if (res.status === "error") {
                      console.log(`  ❌ Error: ${res.error}\n`);
                      continue;
                    }

                    // ANSI color codes
                    const colors = {
                      red: '\x1b[31m',
                      orange: '\x1b[33m',  // Yellow/orange
                      green: '\x1b[32m',
                      reset: '\x1b[0m',
                    };

                    // Get color based on remaining percentage
                    const getColor = (remaining?: number): string => {
                      if (typeof remaining !== 'number') return colors.reset;
                      if (remaining < 0.2) return colors.red;
                      if (remaining < 0.6) return colors.orange;
                      return colors.green;
                    };

                    // Helper to create colored progress bar
                    const createProgressBar = (remaining?: number, width: number = 20): string => {
                      if (typeof remaining !== 'number') return '░'.repeat(width) + ' ???';
                      const filled = Math.round(remaining * width);
                      const empty = width - filled;
                      const color = getColor(remaining);
                      const bar = `${color}${'█'.repeat(filled)}${colors.reset}${'░'.repeat(empty)}`;
                      const pct = `${color}${Math.round(remaining * 100)}%${colors.reset}`.padStart(4 + color.length + colors.reset.length);
                      return `${bar} ${pct}`;
                    };

                    const hasAntigravity = res.quota && Object.keys(res.quota.groups).length > 0;
                    console.log(`\n  └─ Antigravity Quota`);
                    if (!hasAntigravity) {
                      const errorMsg = res.quota?.error || "No quota information available";
                      console.log(`     └─ ${errorMsg}`);
                    } else {
                      const groups = res.quota!.groups;
                      const groupItems = [
                        { label: "Claude", data: groups.claude },
                        { label: "Gemini", data: groups.gemini },
                      ].filter((g): g is { label: string; data: NonNullable<typeof g.data> } => Boolean(g.data));

                      groupItems.forEach((g, idx) => {
                        const isLastGroup = idx === groupItems.length - 1;
                        const groupConnector = isLastGroup ? "└─" : "├─";
                        const childPrefix = isLastGroup ? "   " : "│  ";
                        const subEntries: Array<{ name: string; remainingFraction?: number; resetTime?: string }> = [];
                        if (g.data.fiveHour) {
                          subEntries.push({
                            name: "5h",
                            remainingFraction: g.data.fiveHour.remainingFraction,
                            resetTime: g.data.fiveHour.resetTime,
                          });
                        }
                        if (g.data.weekly) {
                          subEntries.push({
                            name: "weekly",
                            remainingFraction: g.data.weekly.remainingFraction,
                            resetTime: g.data.weekly.resetTime,
                          });
                        }

                        if (subEntries.length > 0) {
                          console.log(`     ${groupConnector} ${g.label}`);
                          subEntries.forEach((sub, subIdx) => {
                            const subConnector = subIdx === subEntries.length - 1 ? "└─" : "├─";
                            const bar = createProgressBar(sub.remainingFraction);
                            const reset = formatQuotaResetSuffix(sub.resetTime, Date.now(), {
                              includeWeeklyTag: false,
                            });
                            const subLabel = sub.name.padEnd(26);
                            console.log(`     ${childPrefix}${subConnector} ${subLabel} ${bar}${reset}`);
                          });
                        } else {
                          const bar = createProgressBar(g.data.remainingFraction);
                          const reset = formatQuotaResetSuffix(g.data.resetTime, Date.now(), {
                            includeWeeklyTag: true,
                          });
                          const modelName = g.label.padEnd(29);
                          console.log(`     ${groupConnector} ${modelName} ${bar}${reset}`);
                        }
                      });
                    }
                    console.log("");

                    // Cache quota and available models data for soft quota & model-aware routing
                    if (res.quota?.groups || res.availableModels !== undefined) {
                      const acc = existingStorage.accounts[res.index];
                      if (acc) {
                        if (res.quota?.groups) {
                          acc.cachedQuota = res.quota.groups;
                          acc.cachedQuotaUpdatedAt = Date.now();
                        }
                        if (res.availableModels !== undefined) {
                          acc.cachedAvailableModels = res.availableModels;
                          acc.cachedAvailableModelsUpdatedAt = Date.now();
                        }
                        storageUpdated = true;
                      }
                    }

                    if (res.updatedAccount) {
                      existingStorage.accounts[res.index] = {
                        ...res.updatedAccount,
                        cachedQuota: res.quota?.groups,
                        cachedQuotaUpdatedAt: Date.now(),
                        ...(res.availableModels !== undefined
                          ? {
                              cachedAvailableModels: res.availableModels,
                              cachedAvailableModelsUpdatedAt: Date.now(),
                            }
                          : {}),
                      };
                      storageUpdated = true;
                    }
                  }
                  if (storageUpdated) {
                    await saveAccounts(existingStorage);
                  }
                  console.log("");

                  // Pause so the user can read the quota output before the
                  // menu re-renders with clearScreen and wipes it.
                  await pressEnterToContinue();
                  continue;
                }

                if (menuResult.mode === "manage") {
                  if (menuResult.toggleAccountIndex !== undefined) {
                    const acc = existingStorage.accounts[menuResult.toggleAccountIndex];
                    if (acc) {
                       acc.enabled = acc.enabled === false;
                       acc.controlUpdatedAt = Math.max(Date.now(), (acc.controlUpdatedAt ?? 0) + 1);
                      await saveAccounts(existingStorage);
                      activeAccountManager?.setAccountEnabled(menuResult.toggleAccountIndex, acc.enabled);
                      console.log(`\nAccount ${acc.email || menuResult.toggleAccountIndex + 1} ${acc.enabled ? 'enabled' : 'disabled'}.\n`);
                      await pressEnterToContinue();
                    }
                  }
                  continue;
                }

                if (menuResult.mode === "models") {
                  const accountIndex = menuResult.manageModelsAccountIndex;
                  const acc = accountIndex !== undefined ? existingStorage.accounts[accountIndex] : undefined;
                  if (acc && accountIndex !== undefined) {
                    const label = acc.email || `Account ${accountIndex + 1}`;
                    console.log(`\nModel access for ${label}:`);
                    console.log(
                      `  Cached available models: ${
                        acc.cachedAvailableModels !== undefined
                          ? (acc.cachedAvailableModels.length ? acc.cachedAvailableModels.join(", ") : "none")
                          : "not cached yet (run Check quotas to refresh)"
                      }`,
                    );
                    console.log(`  Allow list: ${acc.allowedModels?.length ? acc.allowedModels.join(", ") : "all (default)"}`);
                    console.log(`  Deny list:  ${acc.disabledModels?.length ? acc.disabledModels.join(", ") : "none"}\n`);
                    if (process.stdin.isTTY) {
                      const actionInput = (await promptOAuthCallbackValue(
                        "Choose: (a)llow list, (d)eny list, (c)lear rules, or Enter to go back: ",
                      )).toLowerCase();
                      if (actionInput === "a" || actionInput === "allow") {
                        const raw = await promptOAuthCallbackValue("Comma-separated model IDs/patterns to ALLOW (empty to clear): ");
                        const patterns = sanitizeModelPatterns(raw.split(",").map((s) => s.trim()).filter(Boolean));
                        acc.allowedModels = patterns;
                        acc.controlUpdatedAt = Math.max(Date.now(), (acc.controlUpdatedAt ?? 0) + 1);
                        await saveAccounts(existingStorage);
                        activeAccountManager?.setAccountModelRules(accountIndex, {
                          allowedModels: acc.allowedModels,
                          disabledModels: acc.disabledModels,
                        });
                        console.log(`\nUpdated allow list for ${label}.\n`);
                      } else if (actionInput === "d" || actionInput === "deny") {
                        const raw = await promptOAuthCallbackValue("Comma-separated model IDs/patterns to DENY (empty to clear): ");
                        const patterns = sanitizeModelPatterns(raw.split(",").map((s) => s.trim()).filter(Boolean));
                        acc.disabledModels = patterns;
                        acc.controlUpdatedAt = Math.max(Date.now(), (acc.controlUpdatedAt ?? 0) + 1);
                        await saveAccounts(existingStorage);
                        activeAccountManager?.setAccountModelRules(accountIndex, {
                          allowedModels: acc.allowedModels,
                          disabledModels: acc.disabledModels,
                        });
                        console.log(`\nUpdated deny list for ${label}.\n`);
                      } else if (actionInput === "c" || actionInput === "clear") {
                        acc.allowedModels = undefined;
                        acc.disabledModels = undefined;
                        acc.controlUpdatedAt = Math.max(Date.now(), (acc.controlUpdatedAt ?? 0) + 1);
                        await saveAccounts(existingStorage);
                        activeAccountManager?.setAccountModelRules(accountIndex, {});
                        console.log(`\nCleared manual model rules for ${label}.\n`);
                      }
                    }
                    await pressEnterToContinue();
                  }
                  continue;
                }

                if (menuResult.mode === "verify" || menuResult.mode === "verify-all") {
                  const verifyAll = menuResult.mode === "verify-all" || menuResult.verifyAll === true;

                  if (verifyAll) {
                    if (existingStorage.accounts.length === 0) {
                      console.log("\nNo accounts available to verify.\n");
                      await pressEnterToContinue();
                      continue;
                    }

                    console.log(`\nChecking verification status for ${existingStorage.accounts.length} account(s)...\n`);

                    let okCount = 0;
                    let blockedCount = 0;
                    let errorCount = 0;
                    let storageUpdated = false;

                    const blockedResults: Array<{ label: string; message: string; verifyUrl?: string }> = [];

                    for (let i = 0; i < existingStorage.accounts.length; i++) {
                      const account = existingStorage.accounts[i];
                      if (!account) continue;

                      const label = account.email || `Account ${i + 1}`;
                      process.stdout.write(`- [${i + 1}/${existingStorage.accounts.length}] ${label} ... `);

                      const verification = await verifyAccountAccess(account, client, providerId);
                      if (verification.status === "ok") {
                        const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);
                        if (changed) {
                          account.controlUpdatedAt = Math.max(Date.now(), (account.controlUpdatedAt ?? 0) + 1);
                          storageUpdated = true;
                        }
                        activeAccountManager?.clearAccountVerificationRequired(i, wasVerificationRequired);
                        okCount += 1;
                        console.log("ok");
                        continue;
                      }

                      if (verification.status === "blocked") {
                        const changed = markStoredAccountVerificationRequired(
                          account,
                          verification.message,
                          verification.verifyUrl,
                        );
                        if (changed) {
                          account.controlUpdatedAt = Math.max(Date.now(), (account.controlUpdatedAt ?? 0) + 1);
                          storageUpdated = true;
                        }
                        activeAccountManager?.markAccountVerificationRequired(i, verification.message, verification.verifyUrl);

                        blockedCount += 1;
                        console.log("needs verification");
                        const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
                        blockedResults.push({
                          label,
                          message: verification.message,
                          verifyUrl,
                        });
                        continue;
                      }

                      errorCount += 1;
                      console.log(`error (${verification.message})`);
                    }

                    if (storageUpdated) {
                      await saveAccounts(existingStorage);
                    }

                    console.log(`\nVerification summary: ${okCount} ready, ${blockedCount} need verification, ${errorCount} errors.`);

                    if (blockedResults.length > 0) {
                      console.log("\nAccounts needing verification:");
                      for (const result of blockedResults) {
                        console.log(`\n- ${result.label}`);
                        console.log(`  ${result.message}`);
                        if (result.verifyUrl) {
                          console.log(`  URL: ${result.verifyUrl}`);
                        } else {
                          console.log("  URL: not provided by API response");
                        }
                      }
                      console.log("");
                    } else {
                      console.log("");
                    }

                    await pressEnterToContinue();
                    continue;
                  }

                  let verifyAccountIndex = menuResult.verifyAccountIndex;
                  if (verifyAccountIndex === undefined) {
                    verifyAccountIndex = await promptAccountIndexForVerification(existingAccounts);
                  }

                  if (verifyAccountIndex === undefined) {
                    console.log("\nVerification cancelled.\n");
                    await pressEnterToContinue();
                    continue;
                  }

                  const account = existingStorage.accounts[verifyAccountIndex];
                  if (!account) {
                    console.log(`\nAccount ${verifyAccountIndex + 1} not found.\n`);
                    await pressEnterToContinue();
                    continue;
                  }

                  const label = account.email || `Account ${verifyAccountIndex + 1}`;
                  console.log(`\nChecking verification status for ${label}...\n`);

                  const verification = await verifyAccountAccess(account, client, providerId);

                  if (verification.status === "ok") {
                    const { changed, wasVerificationRequired } = clearStoredAccountVerificationRequired(account, true);
                    if (changed) {
                      account.controlUpdatedAt = Math.max(Date.now(), (account.controlUpdatedAt ?? 0) + 1);
                      await saveAccounts(existingStorage);
                    }
                    activeAccountManager?.clearAccountVerificationRequired(verifyAccountIndex, wasVerificationRequired);

                    if (wasVerificationRequired) {
                      console.log(`✓ ${label} is ready for requests and has been re-enabled.\n`);
                    } else {
                      console.log(`✓ ${label} is ready for requests.\n`);
                    }
                    await pressEnterToContinue();
                    continue;
                  }

                  if (verification.status === "blocked") {
                    const changed = markStoredAccountVerificationRequired(
                      account,
                      verification.message,
                      verification.verifyUrl,
                    );
                    if (changed) {
                      account.controlUpdatedAt = Math.max(Date.now(), (account.controlUpdatedAt ?? 0) + 1);
                      await saveAccounts(existingStorage);
                    }
                    activeAccountManager?.markAccountVerificationRequired(
                      verifyAccountIndex,
                      verification.message,
                      verification.verifyUrl,
                    );

                    const verifyUrl = verification.verifyUrl ?? account.verificationUrl;
                    console.log(`⚠ ${label} needs Google verification before it can be used.`);
                    if (verification.message) {
                      console.log(verification.message);
                    }
                    console.log(`${label} has been disabled until verification is completed.`);
                    if (verifyUrl) {
                      console.log(`\nVerification URL:\n${verifyUrl}\n`);
                      if (await promptOpenVerificationUrl()) {
                        const opened = await openBrowser(verifyUrl);
                        if (opened) {
                          console.log("Opened verification URL in your browser.\n");
                        } else {
                          console.log("Could not open browser automatically. Please open the URL manually.\n");
                        }
                      }
                    } else {
                      console.log("No verification URL was returned. Try re-authenticating this account.\n");
                    }
                    await pressEnterToContinue();
                    continue;
                  }

                  console.log(`✗ ${label}: ${verification.message}\n`);
                  await pressEnterToContinue();
                  continue;
                }

                break;
              }
              
              if (menuResult.mode === "cancel") {
                return {
                  url: "",
                  instructions: "Authentication cancelled",
                  method: "auto",
                  callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
                };
              }
              
              if (menuResult.deleteAccountIndex !== undefined) {
                const deletedAccount = existingStorage.accounts[menuResult.deleteAccountIndex];
                const updatedAccounts = existingStorage.accounts.filter(
                  (_, idx) => idx !== menuResult.deleteAccountIndex
                );
                if (deletedAccount) {
                  await removeAccountFromStorage(deletedAccount.refreshToken);
                }
                // Sync in-memory state so deleted account stops being used immediately
                const removedFromPool = activeAccountManager?.removeAccountByIndex(menuResult.deleteAccountIndex);
                if (removedFromPool) {
                  // Renumbering shifted subsequent account indices down by one —
                  // remap index-keyed module state to keep it attached correctly.
                  remapAccountStateAfterRemoval(menuResult.deleteAccountIndex);
                }
                console.log("\nAccount deleted.\n");

                if (updatedAccounts.length > 0) {
                  const fallbackAccount = updatedAccounts[0];
                  if (fallbackAccount?.refreshToken) {
                    const fallbackResult = buildAuthSuccessFromStoredAccount(fallbackAccount);
                    try {
                      await client.auth.set({
                        path: { id: providerId },
                        body: { type: "oauth", refresh: fallbackResult.refresh, access: "", expires: 0 },
                      });
                    } catch (storeError) {
                      log.error("Failed to update stored Antigravity OAuth credentials", { error: String(storeError) });
                    }

                    const label = fallbackAccount.email || `Account ${1}`;
                    return {
                      url: "",
                      instructions: `Account deleted. Using ${label} for future requests.`,
                      method: "auto",
                      callback: async () => fallbackResult,
                    };
                  }
                }

                try {
                  await client.auth.set({
                    path: { id: providerId },
                    body: { type: "oauth", refresh: "", access: "", expires: 0 },
                  });
                } catch (storeError) {
                  log.error("Failed to clear stored Antigravity OAuth credentials", { error: String(storeError) });
                }

                return {
                  url: "",
                  instructions: "All accounts deleted. Run `opencode auth login` to reauthenticate.",
                  method: "auto",
                  callback: async () => ({
                    type: "failed",
                    error: "All accounts deleted. Reauthentication required.",
                  }),
                };
              }

              if (menuResult.refreshAccountIndex !== undefined) {
                refreshAccountIndex = menuResult.refreshAccountIndex;
                const refreshEmail = existingStorage.accounts[refreshAccountIndex]?.email;
                console.log(`\nRe-authenticating ${refreshEmail || 'account'}...\n`);
                startFresh = false;
              }
              
              if (menuResult.deleteAll) {
                await clearAccounts();
                console.log("\nAll accounts deleted.\n");
                startFresh = true;
                try {
                  await client.auth.set({
                    path: { id: providerId },
                    body: { type: "oauth", refresh: "", access: "", expires: 0 },
                  });
                } catch (storeError) {
                  log.error("Failed to clear stored Antigravity OAuth credentials", { error: String(storeError) });
                }
              } else {
                startFresh = menuResult.mode === "fresh";
              }
              
              if (startFresh && !menuResult.deleteAll) {
                console.log("\nStarting fresh - existing accounts will be replaced.\n");
              } else if (!startFresh) {
                console.log("\nAdding to existing accounts.\n");
              }
            }

            while (accounts.length < MAX_OAUTH_ACCOUNTS) {
              console.log(`\n=== Antigravity OAuth (Account ${accounts.length + 1}) ===`);

              const projectId = await promptProjectId();

              const authorization = await authorizeAntigravity(projectId, loginLifetime.signal);
              const fallbackState = getStateFromAuthorizationUrl(authorization.url);
              const result = await (async (): Promise<AntigravityTokenExchangeResult> => {
                console.log("\nOAuth URL:\n" + authorization.url + "\n");

                if (useManualMode) {
                  const browserOpened = await openBrowser(authorization.url);
                  if (!browserOpened) {
                    console.log("Could not open browser automatically.");
                    console.log("Please open the URL above manually in your local browser.\n");
                  }
                  return await promptManualOAuthInput(fallbackState);
                }

                let listener: OAuthListener | null = null;
                if (!isHeadless) {
                  try {
                    listener = await startOAuthListener();
                  } catch {
                    listener = null;
                  }
                }

                if (!isHeadless) {
                  await openBrowser(authorization.url);
                }

                if (listener) {
                  try {
                    const SOFT_TIMEOUT_MS = 30000;
                    const callbackPromise = listener.waitForCallback();
                    const timeoutPromise = new Promise<never>((_, reject) =>
                      setTimeout(() => reject(new Error("SOFT_TIMEOUT")), SOFT_TIMEOUT_MS)
                    );

                    let callbackUrl: URL;
                    try {
                      callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
                    } catch (err) {
                      if (err instanceof Error && err.message === "SOFT_TIMEOUT") {
                        console.log("\n⏳ Automatic callback not received after 30 seconds.");
                        console.log("You can paste the redirect URL manually.\n");
                        console.log("OAuth URL (in case you need it again):");
                        console.log(authorization.url + "\n");
                        
                        try {
                          await listener.close();
                        } catch {}
                        
                        return await promptManualOAuthInput(fallbackState);
                      }
                      throw err;
                    }

                    const params = extractOAuthCallbackParams(callbackUrl);
                    if (!params) {
                      return { type: "failed", error: "Missing code or state in callback URL" };
                    }

                    return await exchangeAntigravity(params.code, params.state, fallbackState);
                  } catch (error) {
                    if (error instanceof Error && error.message !== "SOFT_TIMEOUT") {
                      return {
                        type: "failed",
                        error: error.message,
                      };
                    }
                    return {
                      type: "failed",
                      error: error instanceof Error ? error.message : "Unknown error",
                    };
                  } finally {
                    try {
                      await listener.close();
                    } catch {}
                  }
                }

                return await promptManualOAuthInput(fallbackState);
              })().finally(() => cancelAuthorization(fallbackState));

              if (result.type === "failed") {
                if (accounts.length === 0) {
                  return {
                    url: "",
                    instructions: `Authentication failed: ${result.error}`,
                    method: "auto",
                    callback: async () => result,
                  };
                }

                console.warn(
                  `[opencode-antigravity-auth] Skipping failed account ${accounts.length + 1}: ${result.error}`,
                );
                break;
              }

              accounts.push(result);

              try {
                await client.tui.showToast({
                  body: {
                    message: `Account ${accounts.length} authenticated${result.email ? ` (${result.email})` : ""}`,
                    variant: "success",
                  },
                });
              } catch {
              }

              try {
                if (refreshAccountIndex !== undefined) {
                  const currentStorage = await loadAccounts();
                  if (currentStorage) {
                    const updatedAccounts = [...currentStorage.accounts];
                    const parts = parseRefreshParts(result.refresh);
                    if (parts.refreshToken) {
                      updatedAccounts[refreshAccountIndex] = {
                        email: result.email ?? updatedAccounts[refreshAccountIndex]?.email,
                        refreshToken: parts.refreshToken,
                        projectId: parts.projectId ?? updatedAccounts[refreshAccountIndex]?.projectId,
                        managedProjectId: parts.managedProjectId ?? updatedAccounts[refreshAccountIndex]?.managedProjectId,
                        addedAt: updatedAccounts[refreshAccountIndex]?.addedAt ?? Date.now(),
                        lastUsed: Date.now(),
                      };
                      await saveAccounts({
                        version: 4,
                        accounts: updatedAccounts,
                        activeIndex: currentStorage.activeIndex,
                        activeIndexByFamily: currentStorage.activeIndexByFamily,
                      });
                    }
                  }
                } else {
                  const isFirstAccount = accounts.length === 1;
                  await persistAccountPool([result], isFirstAccount && startFresh);
                }
              } catch {
              }

              if (refreshAccountIndex !== undefined) {
                break;
              }

              if (accounts.length >= MAX_OAUTH_ACCOUNTS) {
                break;
              }

              // Get the actual deduplicated account count from storage for the prompt
              let currentAccountCount = accounts.length;
              try {
                const currentStorage = await loadAccounts();
                if (currentStorage) {
                  currentAccountCount = currentStorage.accounts.length;
                }
              } catch {
                // Fall back to accounts.length if we can't read storage
              }

              const addAnother = await promptAddAnotherAccount(currentAccountCount);
              if (!addAnother) {
                break;
              }
            }

            const primary = accounts[0];
            if (!primary) {
              return {
                url: "",
                instructions: "Authentication cancelled",
                method: "auto",
                callback: async () => ({ type: "failed", error: "Authentication cancelled" }),
              };
            }

            let actualAccountCount = accounts.length;
            try {
              const finalStorage = await loadAccounts();
              if (finalStorage) {
                actualAccountCount = finalStorage.accounts.length;
              }
            } catch {
            }

            const successMessage = refreshAccountIndex !== undefined
              ? `Token refreshed successfully.`
              : `Multi-account setup complete (${actualAccountCount} account(s)).`;

            return {
              url: "",
              instructions: successMessage,
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => primary,
            };
          }

          // TUI flow (`/connect`) does not support per-account prompts.
          // Default to adding new accounts (non-destructive).
          // Users can run `opencode auth logout` first if they want a fresh start.
          const projectId = "";

          // Check existing accounts count for toast message
          const existingStorage = await loadAccounts();
          const existingCount = existingStorage?.accounts.length ?? 0;

          const useManualFlow = isHeadless || inputs?.noBrowser === "true" || shouldSkipLocalServer();

          let listener: OAuthListener | null = null;
          if (!useManualFlow) {
            try {
              listener = await startOAuthListener();
              if (runtime === "v2") oauthListeners.add(listener);
            } catch {
              listener = null;
            }
          }

          const authorization = await authorizeAntigravity(projectId, loginLifetime.signal);
          const fallbackState = getStateFromAuthorizationUrl(authorization.url);

          if (!useManualFlow) {
            const browserOpened = await openBrowser(authorization.url);
            if (!browserOpened) {
              if (listener) oauthListeners.delete(listener);
              listener?.close().catch(() => {});
              listener = null;
            }
          }

          if (listener) {
            return {
              url: authorization.url,
              instructions:
                "Complete sign-in in your browser. We'll automatically detect the redirect back to localhost.",
              method: "auto",
              callback: async (): Promise<AntigravityTokenExchangeResult> => {
                const CALLBACK_TIMEOUT_MS = 30000;
                let callbackTimer: ReturnType<typeof setTimeout> | undefined;
                try {
                  const callbackPromise = listener.waitForCallback();
                  const timeoutPromise = new Promise<never>((_, reject) =>
                    callbackTimer = setTimeout(() => reject(new Error("CALLBACK_TIMEOUT")), CALLBACK_TIMEOUT_MS),
                  );

                  let callbackUrl: URL;
                  try {
                    callbackUrl = await Promise.race([callbackPromise, timeoutPromise]);
                  } catch (err) {
                    if (err instanceof Error && err.message === "CALLBACK_TIMEOUT") {
                      return {
                        type: "failed",
                        error: "Callback timeout - please use CLI with --no-browser flag for manual input",
                      };
                    }
                    throw err;
                  }

                  const params = extractOAuthCallbackParams(callbackUrl);
                  if (!params) {
                    return { type: "failed", error: "Missing code or state in callback URL" };
                  }
                  if (params.state !== fallbackState) {
                    return { type: "failed", error: "Invalid OAuth callback state" };
                  }

                  const result = await exchangeAntigravity(params.code, params.state, fallbackState);
                  if (result.type === "success") {
                    try {
                      await persistAccountPool([result], false);
                    } catch {
                    }

                    const newTotal = existingCount + 1;
                    const toastMessage = existingCount > 0
                      ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                      : `Authenticated${result.email ? ` (${result.email})` : ""}`;

                    try {
                      await client.tui.showToast({
                        body: {
                          message: toastMessage,
                          variant: "success",
                        },
                      });
                    } catch {
                    }
                  }

                  return result;
                } catch (error) {
                  return {
                    type: "failed",
                    error: error instanceof Error ? error.message : "Unknown error",
                  };
                } finally {
                  cancelAuthorization(fallbackState)
                  if (callbackTimer !== undefined) clearTimeout(callbackTimer);
                  oauthListeners.delete(listener);
                  try {
                    await listener.close();
                  } catch {
                  }
                }
              },
            };
          }

          return {
            url: authorization.url,
            instructions:
              "Visit the URL above, complete OAuth, then paste either the full redirect URL or the authorization code.",
            method: "code",
            callback: async (codeInput: string): Promise<AntigravityTokenExchangeResult> => {
              const params = parseOAuthCallbackInput(codeInput, fallbackState);
              if ("error" in params) {
                return { type: "failed", error: params.error };
              }
              if (params.state !== fallbackState) {
                return { type: "failed", error: "Invalid OAuth callback state" };
              }

              const result = await exchangeAntigravity(params.code, params.state, fallbackState);
              if (result.type === "success") {
                try {
                  // TUI flow adds to existing accounts (non-destructive)
                  await persistAccountPool([result], false);
                } catch {
                  // ignore
                }

                // Show appropriate toast message
                const newTotal = existingCount + 1;
                const toastMessage = existingCount > 0
                  ? `Added account${result.email ? ` (${result.email})` : ""} - ${newTotal} total`
                  : `Authenticated${result.email ? ` (${result.email})` : ""}`;

                try {
                  await client.tui.showToast({
                    body: {
                      message: toastMessage,
                      variant: "success",
                    },
                  });
                } catch {
                  // TUI may not be available
                }
              }

              return result;
            },
          };
        },
      },
      {
        label: "Gemini API key (Antigravity SDK / Google AI)",
        type: "api",
        prompts: [
          {
            type: "text",
            key: "key",
            message: "Gemini API key",
            placeholder: "GEMINI_API_KEY or Google AI API key",
            validate: (value: string) => value.trim() ? undefined : "API key is required",
          },
        ],
      },
    ],
  },
  };
};

export const AntigravityCLIOAuthPlugin = createAntigravityPlugin(ANTIGRAVITY_PROVIDER_ID);
export const GoogleOAuthPlugin = AntigravityCLIOAuthPlugin;

function toUrlString(value: RequestInfo): string {
  if (typeof value === "string") {
    return value;
  }
  const candidate = (value as Request).url;
  if (candidate) {
    return candidate;
  }
  return value.toString();
}

function toWarmupStreamUrl(value: RequestInfo): string {
  const urlString = toUrlString(value);
  try {
    const url = new URL(urlString);
    if (!url.pathname.includes(":streamGenerateContent")) {
      url.pathname = url.pathname.replace(":generateContent", ":streamGenerateContent");
    }
    url.searchParams.set("alt", "sse");
    return url.toString();
  } catch {
    return urlString;
  }
}

function extractModelFromUrl(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/?]+)(?::\w+)?/);
  return match?.[1] ?? null;
}

function extractModelFromUrlWithSuffix(urlString: string): string | null {
  const match = urlString.match(/\/models\/([^:\/\?]+)/);
  return match?.[1] ?? null;
}

function getModelFamilyFromUrl(urlString: string): ModelFamily {
  const model = extractModelFromUrl(urlString);
  let family: ModelFamily = "gemini";
  if (model && model.includes("claude")) {
    family = "claude";
  }
  if (isDebugEnabled()) {
    logModelFamily(urlString, model, family);
  }
  return family;
}

type HeaderRoutingDecision = {
  preferredHeaderStyle: HeaderStyle;
  explicitQuota: boolean;
};

/**
 * Every model goes to the Antigravity quota: Google deprecated the Gemini CLI
 * quota the plugin used to fall back to.
 */
function resolveHeaderRoutingDecision(urlString: string): HeaderRoutingDecision {
  const modelWithSuffix = extractModelFromUrlWithSuffix(urlString);
  const resolvedModel = modelWithSuffix ? resolveModelWithTier(modelWithSuffix) : null;
  return {
    preferredHeaderStyle: "antigravity",
    explicitQuota: resolvedModel?.explicitQuota ?? false,
  };
}

export const __testExports = {
  triggerAsyncQuotaRefreshForAccount,
  createSoftQuotaBlockedResponse,
  tryFetchWithAgySdkCredentials,
  verifyAccountAccess,
  resolveHeaderRoutingDecision,
};
