import {
  ANTIGRAVITY_CLI_USER_AGENT,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_HUB_USER_AGENT,
  ANTIGRAVITY_PROVIDER_ID,
} from "../constants";
import { accessTokenExpired, formatRefreshParts, parseRefreshParts } from "./auth";
import { logQuotaFetch, logQuotaStatus } from "./debug";
import { ensureProjectContext } from "./project";
import { refreshAccessToken } from "./token";
import { isGemini3OrLaterModel } from "./transform/model-resolver";
import { recordAntigravityAvailableModels } from "./model-catalog";
import { extractAvailableModelsFromRegistry } from "./model-availability.ts";
import type { PluginClient, OAuthAuthDetails } from "./types";
import type { AccountMetadataV3 } from "./storage";

const FETCH_TIMEOUT_MS = 10000;

export type QuotaGroup = "claude" | "gemini";

export interface QuotaWindowSummary {
  remainingFraction?: number;
  resetTime?: string;
}

export interface QuotaGroupSummary {
  remainingFraction?: number;
  resetTime?: string;
  modelCount: number;
  /** Short-window (5h) quota bucket from retrieveUserQuotaSummary, when available. */
  fiveHour?: QuotaWindowSummary;
  /** Weekly quota bucket from retrieveUserQuotaSummary, when available. */
  weekly?: QuotaWindowSummary;
}

export interface QuotaSummary {
  groups: Partial<Record<QuotaGroup, QuotaGroupSummary>>;
  modelCount: number;
  error?: string;
}

export interface UserQuotaSummaryBucket {
  bucketId?: string;
  modelId?: string;
  displayName?: string;
  window?: string;
  remainingFraction?: number;
  remainingPercent?: number;
  usedFraction?: number;
  resetTime?: string;
  description?: string;
}

export interface UserQuotaSummaryGroup {
  displayName?: string;
  description?: string;
  buckets?: UserQuotaSummaryBucket[];
  quotaBuckets?: UserQuotaSummaryBucket[];
}

export interface RetrieveUserQuotaSummaryResponse {
  response?: {
    groups?: UserQuotaSummaryGroup[];
    buckets?: UserQuotaSummaryBucket[];
    quotaBuckets?: UserQuotaSummaryBucket[];
  };
  groups?: UserQuotaSummaryGroup[];
  buckets?: UserQuotaSummaryBucket[];
  quotaBuckets?: UserQuotaSummaryBucket[];
}

export type AccountQuotaStatus = "ok" | "disabled" | "error";

export interface AccountQuotaResult {
  index: number;
  email?: string;
  status: AccountQuotaStatus;
  error?: string;
  disabled?: boolean;
  quota?: QuotaSummary;
  /** Canonical model IDs reported available by fetchAvailableModels for this account. */
  availableModels?: string[];
  updatedAccount?: AccountMetadataV3;
}

export interface FetchAvailableModelsResponse {
  models?: Record<string, FetchAvailableModelEntry>;
}

export interface FetchAvailableModelEntry {
  disabled?: boolean
  supportsThinking?: boolean
  quotaInfo?: {
    remainingFraction?: number;
    resetTime?: string;
  };
  displayName?: string;
  modelName?: string;
}

function buildAuthFromAccount(account: AccountMetadataV3): OAuthAuthDetails {
  return {
    type: "oauth",
    refresh: formatRefreshParts({
      refreshToken: account.refreshToken,
      projectId: account.projectId,
      managedProjectId: account.managedProjectId,
    }),
    access: undefined,
    expires: undefined,
  };
}

function normalizeRemainingFraction(value: unknown): number {
  // If value is missing or invalid, treat as exhausted (0%)
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

function parseResetTime(resetTime?: string): number | null {
  if (!resetTime) return null;
  const timestamp = Date.parse(resetTime);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return timestamp;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Formats a quota reset timestamp into a concise suffix such as
 * `" (resets in 4h 20m)"` or `" (resets in 5d 12h · weekly)"`.
 * Returns `""` when `resetTime` is missing or unparseable.
 */
export function formatQuotaResetSuffix(
  resetTime?: string,
  now: number = Date.now(),
  options?: { includeWeeklyTag?: boolean },
): string {
  const timestamp = parseResetTime(resetTime);
  if (timestamp === null) return "";

  const ms = timestamp - now;
  if (ms <= 0) return " (resetting...)";

  const totalSeconds = Math.ceil(ms / 1000);
  let duration: string;
  if (totalSeconds < 60) {
    duration = `${totalSeconds}s`;
  } else if (totalSeconds < 3600) {
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    duration = seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  } else if (ms < DAY_MS) {
    const totalMinutes = Math.floor(totalSeconds / 60);
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    duration = minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  } else {
    const totalHours = Math.floor(ms / (60 * 60 * 1000));
    const days = Math.floor(totalHours / 24);
    const hours = totalHours % 24;
    duration = hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  }

  const includeWeeklyTag = options?.includeWeeklyTag ?? true;
  const windowTag = includeWeeklyTag && ms > DAY_MS ? " · weekly" : "";

  return ` (resets in ${duration}${windowTag})`;
}

/**
 * Formats a quota group as one or more subgroup entries.
 * When separate 5h and/or weekly buckets are available from retrieveUserQuotaSummary,
 * returns separate entries (`["claude (5h): 100% (resets in 4h)", "claude (weekly): 90% (resets in 5d)"]`).
 * Otherwise falls back to a single aggregate entry (`["claude: 50% (resets in 4h)"]`).
 */
export function formatQuotaGroupEntries(
  groupName: string,
  quota: QuotaGroupSummary,
  now: number = Date.now(),
): string[] {
  const entries: string[] = [];
  if (quota.fiveHour?.remainingFraction !== undefined) {
    const pct = Math.round(quota.fiveHour.remainingFraction * 100);
    const reset = formatQuotaResetSuffix(quota.fiveHour.resetTime, now, { includeWeeklyTag: false });
    entries.push(`${groupName} (5h): ${pct}%${reset}`);
  }
  if (quota.weekly?.remainingFraction !== undefined) {
    const pct = Math.round(quota.weekly.remainingFraction * 100);
    const reset = formatQuotaResetSuffix(quota.weekly.resetTime, now, { includeWeeklyTag: false });
    entries.push(`${groupName} (weekly): ${pct}%${reset}`);
  }
  if (entries.length > 0) {
    return entries;
  }
  return [`${groupName}: ${Math.round((quota.remainingFraction ?? 0) * 100)}%${formatQuotaResetSuffix(quota.resetTime, now)}`];
}

function classifyQuotaGroup(modelName: string, displayName?: string): QuotaGroup | null {
  const combined = `${modelName} ${displayName ?? ""}`.toLowerCase();
  if (combined.includes("claude")) {
    return "claude";
  }
  const isGemini3 = isGemini3OrLaterModel(combined) || /gemini (?:[3-9]|[1-9]\d+)\b/.test(combined);
  if (!isGemini3) {
    return null;
  }
  return "gemini";
}

function aggregateQuota(models?: Record<string, FetchAvailableModelEntry>): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = {};
  if (!models) {
    return { groups, modelCount: 0 };
  }

  let totalCount = 0;
  for (const [modelName, entry] of Object.entries(models)) {
    if (entry.disabled === true) {
      continue;
    }
    const group = classifyQuotaGroup(modelName, entry.displayName ?? entry.modelName);
    if (!group) {
      continue;
    }
    const quotaInfo = entry.quotaInfo;
    const remainingFraction = quotaInfo
      ? normalizeRemainingFraction(quotaInfo.remainingFraction)
      : undefined;
    const resetTime = quotaInfo?.resetTime;
    const resetTimestamp = parseResetTime(resetTime);

    // Only report a reset time we can actually parse; keep it coupled to the
    // model whose remainingFraction we display.
    const validResetTime = resetTimestamp !== null ? resetTime : undefined;

    totalCount += 1;

    const existing = groups[group];
    const nextCount = (existing?.modelCount ?? 0) + 1;

    // Keep remainingFraction and resetTime coupled to the SAME model. The
    // representative model for a group is the one with the highest remaining
    // fraction; when a model wins that comparison we take its resetTime too.
    let nextRemaining = existing?.remainingFraction;
    let nextResetTime = existing?.resetTime;

    if (existing === undefined) {
      // First model in the group establishes the baseline coupled pair.
      nextRemaining = remainingFraction;
      nextResetTime = validResetTime;
    } else if (
      remainingFraction !== undefined &&
      (existing.remainingFraction === undefined || remainingFraction > existing.remainingFraction)
    ) {
      // This model has strictly more remaining quota — it becomes representative.
      nextRemaining = remainingFraction;
      nextResetTime = validResetTime;
    } else if (
      remainingFraction !== undefined &&
      existing.remainingFraction !== undefined &&
      remainingFraction === existing.remainingFraction
    ) {
      // Tie on remaining fraction: break deterministically by keeping the
      // earliest valid reset time so we never report a far-future reset when an
      // equally-drained sibling model resets sooner.
      const existingResetTimestamp = parseResetTime(existing.resetTime);
      if (
        resetTimestamp !== null &&
        (existingResetTimestamp === null || resetTimestamp < existingResetTimestamp)
      ) {
        nextResetTime = validResetTime;
      }
    }
    // Otherwise keep the existing coupled (remainingFraction, resetTime) pair.

    groups[group] = {
      remainingFraction: nextRemaining,
      resetTime: nextResetTime,
      modelCount: nextCount,
    };
  }

  return { groups, modelCount: totalCount };
}

type QuotaWindowKind = "fiveHour" | "weekly";

const PRIMARY_BUCKET_IDS = new Set([
  "gemini-5h",
  "gemini-weekly",
  "3p-5h",
  "3p-weekly",
  "claude-5h",
  "claude-weekly",
]);

function classifySummaryBucketGroup(
  bucket: UserQuotaSummaryBucket,
  groupDisplayName?: string,
): QuotaGroup | null {
  const bucketId = (bucket.bucketId ?? "").toLowerCase();
  const groupName = (groupDisplayName ?? "").toLowerCase();
  const combined = `${bucketId} ${groupName} ${(bucket.displayName ?? "").toLowerCase()}`;

  if (
    bucketId.startsWith("3p") ||
    bucketId.includes("claude") ||
    groupName.includes("claude") ||
    groupName.includes("3p") ||
    combined.includes("claude")
  ) {
    return "claude";
  }
  if (bucketId.includes("gemini") || groupName.includes("gemini")) {
    return "gemini";
  }
  return null;
}

function classifySummaryBucketWindow(bucket: UserQuotaSummaryBucket): QuotaWindowKind | null {
  const windowStr = (bucket.window ?? "").toLowerCase();
  const bucketId = (bucket.bucketId ?? "").toLowerCase();
  const displayName = (bucket.displayName ?? "").toLowerCase();

  if (windowStr === "weekly" || windowStr.includes("week") || bucketId.includes("weekly") || displayName.includes("weekly")) {
    return "weekly";
  }
  if (
    windowStr === "5h" ||
    windowStr.includes("5h") ||
    bucketId.includes("5h") ||
    displayName.includes("five hour") ||
    displayName.includes("5 hour") ||
    displayName.includes("5h")
  ) {
    return "fiveHour";
  }
  return null;
}

function extractBucketRemainingFraction(bucket: UserQuotaSummaryBucket): number | undefined {
  if (typeof bucket.remainingFraction === "number" && Number.isFinite(bucket.remainingFraction)) {
    return normalizeRemainingFraction(bucket.remainingFraction);
  }
  if (typeof bucket.remainingPercent === "number" && Number.isFinite(bucket.remainingPercent)) {
    return normalizeRemainingFraction(bucket.remainingPercent > 1 ? bucket.remainingPercent / 100 : bucket.remainingPercent);
  }
  if (typeof bucket.usedFraction === "number" && Number.isFinite(bucket.usedFraction)) {
    return normalizeRemainingFraction(1 - bucket.usedFraction);
  }
  return undefined;
}

function aggregateUserQuotaSummary(
  payload?: RetrieveUserQuotaSummaryResponse,
): Partial<Record<QuotaGroup, { fiveHour?: QuotaWindowSummary; weekly?: QuotaWindowSummary }>> {
  const out: Partial<Record<QuotaGroup, { fiveHour?: QuotaWindowSummary; weekly?: QuotaWindowSummary }>> = {};
  if (!payload) return out;

  const root = payload.response ?? payload;
  const entries: Array<{ bucket: UserQuotaSummaryBucket; groupDisplayName?: string }> = [];

  for (const group of root.groups ?? []) {
    for (const bucket of group.buckets ?? group.quotaBuckets ?? []) {
      entries.push({ bucket, groupDisplayName: group.displayName });
    }
  }
  for (const bucket of root.buckets ?? root.quotaBuckets ?? []) {
    entries.push({ bucket });
  }

  // Track whether the chosen bucket for each (group, window) is a primary bucket id
  // so specialized sub-buckets (e.g. gemini-argon-wtu-weekly) don't overwrite gemini-weekly.
  const isPrimarySelected: Partial<Record<QuotaGroup, Partial<Record<QuotaWindowKind, boolean>>>> = {};

  for (const { bucket, groupDisplayName } of entries) {
    const group = classifySummaryBucketGroup(bucket, groupDisplayName);
    const windowKind = classifySummaryBucketWindow(bucket);
    if (!group || !windowKind) continue;
    const remainingFraction = extractBucketRemainingFraction(bucket);
    if (remainingFraction === undefined) {
      continue;
    }

    const resetTimestamp = parseResetTime(bucket.resetTime);
    const validResetTime = resetTimestamp !== null ? bucket.resetTime : undefined;
    const isPrimary = PRIMARY_BUCKET_IDS.has((bucket.bucketId ?? "").toLowerCase());

    const groupEntry = out[group] ?? (out[group] = {});
    const primaryFlags = isPrimarySelected[group] ?? (isPrimarySelected[group] = {});
    const existing = groupEntry[windowKind];
    const existingIsPrimary = primaryFlags[windowKind] === true;

    let shouldReplace = false;
    if (!existing) {
      shouldReplace = true;
    } else if (isPrimary && !existingIsPrimary) {
      shouldReplace = true;
    } else if (isPrimary === existingIsPrimary) {
      // Among equal-priority buckets, prefer the lower (more used / active) remainingFraction
      // so an unused sibling bucket at 100% does not mask actual consumption.
      if (
        existing.remainingFraction === undefined ||
        remainingFraction < existing.remainingFraction
      ) {
        shouldReplace = true;
      } else if (remainingFraction === existing.remainingFraction && resetTimestamp !== null) {
        const existingResetTimestamp = parseResetTime(existing.resetTime);
        if (existingResetTimestamp === null || resetTimestamp < existingResetTimestamp) {
          shouldReplace = true;
        }
      }
    }

    if (shouldReplace) {
      groupEntry[windowKind] = {
        remainingFraction,
        resetTime: validResetTime,
      };
      primaryFlags[windowKind] = isPrimary;
    }
  }

  return out;
}

function selectConstrainingWindow(
  fiveHour?: QuotaWindowSummary,
  weekly?: QuotaWindowSummary,
): QuotaWindowSummary | undefined {
  if (fiveHour && weekly) {
    const f = fiveHour.remainingFraction ?? 1;
    const w = weekly.remainingFraction ?? 1;
    return w < f ? weekly : fiveHour;
  }
  return fiveHour ?? weekly;
}

function mergeQuotaWithSummary(
  base: QuotaSummary,
  summaryGroups: Partial<Record<QuotaGroup, { fiveHour?: QuotaWindowSummary; weekly?: QuotaWindowSummary }>>,
): QuotaSummary {
  const groups: Partial<Record<QuotaGroup, QuotaGroupSummary>> = { ...base.groups };

  for (const group of ["claude", "gemini"] as QuotaGroup[]) {
    const summary = summaryGroups[group];
    if (!summary || (!summary.fiveHour && !summary.weekly)) continue;

    const existing = groups[group];
    const constraining = selectConstrainingWindow(summary.fiveHour, summary.weekly);

    groups[group] = {
      remainingFraction: constraining?.remainingFraction ?? existing?.remainingFraction,
      resetTime: constraining?.resetTime ?? existing?.resetTime,
      modelCount: existing?.modelCount ?? 0,
      ...(summary.fiveHour ? { fiveHour: summary.fiveHour } : {}),
      ...(summary.weekly ? { weekly: summary.weekly } : {}),
    };
  }

  const hasGroups = Object.keys(groups).length > 0;
  return {
    groups,
    modelCount: base.modelCount,
    ...(hasGroups ? {} : base.error ? { error: base.error } : {}),
  };
}

async function fetchWithTimeout(url: string, options: RequestInit, timeoutMs = FETCH_TIMEOUT_MS): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

const FETCH_AVAILABLE_MODELS_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;

// Query daily first (where Antigravity requests are served and live consumption is tracked),
// then supplement/reconcile with prod (which reliably exposes both Gemini and 3p groups).
const FETCH_USER_QUOTA_SUMMARY_ENDPOINTS = [
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
] as const;

function pickMoreAccurateWindow(
  current: QuotaWindowSummary | undefined,
  incoming: QuotaWindowSummary | undefined,
): QuotaWindowSummary | undefined {
  if (!incoming) return current;
  if (!current) return incoming;
  const curFrac = current.remainingFraction;
  const incFrac = incoming.remainingFraction;
  if (curFrac === undefined) return incoming;
  if (incFrac === undefined) return current;
  // Prefer the lower (actually consumed) remainingFraction so a static 1.0 from a
  // different gateway environment does not hide real usage.
  if (incFrac < curFrac) return incoming;
  if (incFrac === curFrac && !current.resetTime && incoming.resetTime) return incoming;
  return current;
}

export async function fetchUserQuotaSummary(
  accessToken: string,
  projectId: string,
): Promise<Partial<Record<QuotaGroup, { fiveHour?: QuotaWindowSummary; weekly?: QuotaWindowSummary }>>> {
  const body = JSON.stringify(projectId ? { project: projectId } : {});
  const merged: Partial<Record<QuotaGroup, { fiveHour?: QuotaWindowSummary; weekly?: QuotaWindowSummary }>> = {};

  for (const endpoint of FETCH_USER_QUOTA_SUMMARY_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:retrieveUserQuotaSummary`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": ANTIGRAVITY_HUB_USER_AGENT,
        },
        body,
      });

      if (!response.ok) {
        const snippet = (await response.text().catch(() => "")).trim().slice(0, 160);
        logQuotaFetch(
          "error",
          undefined,
          `retrieveUserQuotaSummary ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`,
        );
        continue;
      }

      const payload = (await response.json()) as RetrieveUserQuotaSummaryResponse;
      const parsed = aggregateUserQuotaSummary(payload);
      for (const group of ["claude", "gemini"] as QuotaGroup[]) {
        const incoming = parsed[group];
        if (!incoming) continue;
        const current = merged[group] ?? (merged[group] = {});
        current.fiveHour = pickMoreAccurateWindow(current.fiveHour, incoming.fiveHour);
        current.weekly = pickMoreAccurateWindow(current.weekly, incoming.weekly);
      }
    } catch (error) {
      logQuotaFetch(
        "error",
        undefined,
        `retrieveUserQuotaSummary error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return merged;
}

export async function fetchAvailableModels(
  accessToken: string,
  projectId: string,
): Promise<FetchAvailableModelsResponse> {
  const errors: string[] = [];
  const body = JSON.stringify(projectId ? { project: projectId } : {});

  for (const endpoint of FETCH_AVAILABLE_MODELS_ENDPOINTS) {
    try {
      const response = await fetchWithTimeout(`${endpoint}/v1internal:fetchAvailableModels`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          "Content-Type": "application/json",
          "User-Agent": ANTIGRAVITY_CLI_USER_AGENT,
        },
        body,
      });

      if (response.ok) {
        return (await response.json()) as FetchAvailableModelsResponse;
      }

      const message = await response.text().catch(() => "");
      const snippet = message.trim().slice(0, 200);
      errors.push(
        `fetchAvailableModels ${response.status} at ${endpoint}${snippet ? `: ${snippet}` : ""}`,
      );
    } catch (error) {
      errors.push(
        `fetchAvailableModels error at ${endpoint}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  throw new Error(errors.join("; ") || "fetchAvailableModels failed");
}

function applyAccountUpdates(account: AccountMetadataV3, auth: OAuthAuthDetails): AccountMetadataV3 | undefined {
  const parts = parseRefreshParts(auth.refresh);
  if (!parts.refreshToken) {
    return undefined;
  }

  const updated: AccountMetadataV3 = {
    ...account,
    refreshToken: parts.refreshToken,
    projectId: parts.projectId ?? account.projectId,
    managedProjectId: parts.managedProjectId ?? account.managedProjectId,
  };

  const changed =
    updated.refreshToken !== account.refreshToken ||
    updated.projectId !== account.projectId ||
    updated.managedProjectId !== account.managedProjectId;

  return changed ? updated : undefined;
}

// Max accounts to check simultaneously. Bounded to avoid bursting the provider
// with a token refresh + project-context resolution + quota fetch per account.
const QUOTA_CHECK_CONCURRENCY = 3;

/**
 * Run an async mapper over items with a bounded number of concurrent workers.
 * Results preserve the original item order regardless of completion order.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  if (items.length === 0) {
    return results;
  }

  const workerCount = Math.max(1, Math.min(concurrency, items.length));
  let cursor = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = cursor;
      cursor += 1;
      if (index >= items.length) {
        break;
      }
      const item = items[index];
      if (item === undefined) {
        continue;
      }
      results[index] = await fn(item, index);
    }
  };

  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return results;
}

/**
 * Fetch and aggregate quota for a single account.
 * Never throws — failures are captured in the returned result's status/error.
 */
async function checkSingleAccountQuota(
  account: AccountMetadataV3,
  index: number,
  client: PluginClient,
  providerId: string,
): Promise<AccountQuotaResult> {
  const disabled = account.enabled === false;

  let auth = buildAuthFromAccount(account);

  try {
    if (accessTokenExpired(auth)) {
      const refreshed = await refreshAccessToken(auth, client, providerId);
      if (!refreshed) {
        throw new Error("Token refresh failed");
      }
      auth = refreshed;
    }

    const projectContext = await ensureProjectContext(auth);
    auth = projectContext.auth;
    const updatedAccount = applyAccountUpdates(account, auth);

    let quotaResult: QuotaSummary;
    let availableModels: string[] | undefined;

    const [antigravityResponse, summaryGroups] = await Promise.all([
      fetchAvailableModels(
        auth.access ?? "",
        projectContext.effectiveProjectId,
      ).catch((): FetchAvailableModelsResponse => ({ models: undefined })),
      fetchUserQuotaSummary(
        auth.access ?? "",
        projectContext.effectiveProjectId,
      ).catch(() => ({})),
    ]);

    // Process Antigravity quota
    if (antigravityResponse.models === undefined) {
      quotaResult = {
        groups: {},
        modelCount: 0,
        error: "Failed to fetch Antigravity quota",
      };
    } else {
      recordAntigravityAvailableModels(parseRefreshParts(auth.refresh).refreshToken, projectContext.effectiveProjectId, antigravityResponse.models)
      availableModels = extractAvailableModelsFromRegistry(antigravityResponse.models).available
      quotaResult = aggregateQuota(antigravityResponse.models);
    }

    quotaResult = mergeQuotaWithSummary(quotaResult, summaryGroups);

    // Log quota status for each family
    for (const [family, groupQuota] of Object.entries(quotaResult.groups)) {
      const remainingPercent = (groupQuota.remainingFraction ?? 0) * 100;
      logQuotaStatus(account.email, index, remainingPercent, family);
    }

    return {
      index,
      email: account.email,
      status: "ok",
      disabled,
      quota: quotaResult,
      ...(availableModels !== undefined ? { availableModels } : {}),
      updatedAccount,
    };
  } catch (error) {
    logQuotaFetch(
      "error",
      undefined,
      `account=${account.email ?? index} error=${error instanceof Error ? error.message : String(error)}`,
    );
    return {
      index,
      email: account.email,
      status: "error",
      disabled,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function checkAccountsQuota(
  accounts: AccountMetadataV3[],
  client: PluginClient,
  providerId = ANTIGRAVITY_PROVIDER_ID,
): Promise<AccountQuotaResult[]> {
  logQuotaFetch("start", accounts.length);

  // Check accounts with bounded concurrency; results stay ordered by index.
  const results = await mapWithConcurrency(accounts, QUOTA_CHECK_CONCURRENCY, (account, index) =>
    checkSingleAccountQuota(account, index, client, providerId),
  );

  logQuotaFetch(
    "complete",
    accounts.length,
    `ok=${results.filter((r) => r.status === "ok").length} errors=${results.filter((r) => r.status === "error").length}`,
  );
  return results;
}

export const __testExports = {
  aggregateQuota,
  aggregateUserQuotaSummary,
  mergeQuotaWithSummary,
  mapWithConcurrency,
}
