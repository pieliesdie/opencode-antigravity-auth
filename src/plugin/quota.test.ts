import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ANTIGRAVITY_CLI_USER_AGENT,
  ANTIGRAVITY_ENDPOINT,
  ANTIGRAVITY_ENDPOINT_PROD,
  ANTIGRAVITY_HUB_USER_AGENT,
} from "../constants.ts";
import {
  __testExports,
  fetchAvailableModels,
  fetchUserQuotaSummary,
  formatQuotaGroupEntries,
  formatQuotaResetSuffix,
} from "./quota.ts";

describe("Antigravity quota aggregation", () => {
  it("uses the best available Gemini variant instead of the most exhausted rollout variant", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 1,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0,
          resetTime: "2026-05-27T18:00:00Z",
        },
      },
    });

    expect(summary.groups.gemini?.remainingFraction).toBe(1);
    expect(summary.groups.gemini?.resetTime).toBe("2026-05-26T18:00:00Z");
    expect(summary.groups.gemini?.modelCount).toBe(2);
  });

  it("keeps resetTime coupled to the model whose remainingFraction is displayed", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 1,
          resetTime: "2026-05-27T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
    });

    // The displayed remainingFraction (1) belongs to gemini-3.5-flash-low, so the
    // reset time must be that same model's reset time, not the earliest across models.
    expect(summary.groups.gemini?.remainingFraction).toBe(1);
    expect(summary.groups.gemini?.resetTime).toBe("2026-05-27T18:00:00Z");
  });

  it("takes the resetTime of the winning model regardless of iteration order", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.2,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 0.9,
          resetTime: "2026-05-28T18:00:00Z",
        },
      },
    });

    expect(summary.groups.gemini?.remainingFraction).toBe(0.9);
    expect(summary.groups.gemini?.resetTime).toBe("2026-05-28T18:00:00Z");
  });

  it("breaks equal-remainingFraction ties by keeping the earliest reset time", () => {
    // Both models are equally drained; the representative reset time must be the
    // earliest, regardless of iteration order (the later-reset model is first).
    const summary = __testExports.aggregateQuota({
      "gemini-3.5-flash-low": {
        displayName: "Gemini 3.5 Flash Low",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "2026-05-28T18:00:00Z",
        },
      },
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "2026-05-26T18:00:00Z",
        },
      },
    });

    expect(summary.groups.gemini?.remainingFraction).toBe(0.5);
    expect(summary.groups.gemini?.resetTime).toBe("2026-05-26T18:00:00Z");
  });

  it("ignores unparseable reset times", () => {
    const summary = __testExports.aggregateQuota({
      "gemini-3-flash-agent": {
        displayName: "Gemini 3 Flash Agent",
        quotaInfo: {
          remainingFraction: 0.5,
          resetTime: "not-a-date",
        },
      },
    });

    expect(summary.groups.gemini?.remainingFraction).toBe(0.5);
    expect(summary.groups.gemini?.resetTime).toBeUndefined();
  });

  it("formats reset time suffixes with weekly indicator for multi-day resets", () => {
    const now = Date.parse("2026-06-01T12:00:00Z");
    expect(formatQuotaResetSuffix(undefined, now)).toBe("");
    expect(formatQuotaResetSuffix("not-a-date", now)).toBe("");
    expect(formatQuotaResetSuffix("2026-06-01T11:59:00Z", now)).toBe(" (resetting...)");
    expect(formatQuotaResetSuffix("2026-06-01T16:20:00Z", now)).toBe(" (resets in 4h 20m)");
    expect(formatQuotaResetSuffix("2026-06-02T00:15:00Z", now)).toBe(" (resets in 12h 15m)");
    expect(formatQuotaResetSuffix("2026-06-06T20:00:00Z", now)).toBe(" (resets in 5d 8h · weekly)");
  });
});

describe("mapWithConcurrency", () => {
  it("preserves result ordering by input index", async () => {
    const items = [10, 20, 30, 40, 50];
    const results = await __testExports.mapWithConcurrency(items, 3, async (item, index) => {
      // Stagger completion so out-of-order finishes would surface ordering bugs.
      await new Promise((resolve) => setTimeout(resolve, (items.length - index) * 2));
      return item * 2;
    });
    expect(results).toEqual([20, 40, 60, 80, 100]);
  });

  it("never exceeds the concurrency limit", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 12 }, (_, i) => i);
    await __testExports.mapWithConcurrency(items, 3, async (item) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return item;
    });
    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("returns an empty array for empty input", async () => {
    const results = await __testExports.mapWithConcurrency([], 3, async (item) => item);
    expect(results).toEqual([]);
  });
});

describe("fetchAvailableModels", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("queries the daily endpoint with the Antigravity CLI user-agent", async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), ua: new Headers(init?.headers).get("user-agent") });
      return Response.json({ models: { "gemini-4-hydrogen-high": { displayName: "Gemini 4 Hydrogen (High)" } } });
    }));

    const result = await fetchAvailableModels("token", "proj");
    expect(result.models?.["gemini-4-hydrogen-high"]?.displayName).toBe("Gemini 4 Hydrogen (High)");
    expect(calls).toEqual([
      { url: `${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`, ua: ANTIGRAVITY_CLI_USER_AGENT },
    ]);
  });

  it("falls back to prod when the daily endpoint fails", async () => {
    const urls: string[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      urls.push(url);
      if (url.startsWith(ANTIGRAVITY_ENDPOINT)) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({ models: { "gemini-4-argon-high": {} } });
    }));

    const result = await fetchAvailableModels("token", "proj");
    expect(result.models?.["gemini-4-argon-high"]).toEqual({});
    expect(urls).toEqual([
      `${ANTIGRAVITY_ENDPOINT}/v1internal:fetchAvailableModels`,
      `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:fetchAvailableModels`,
    ]);
  });
});

describe("retrieveUserQuotaSummary", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parses 5h and weekly buckets for gemini and claude and prefers primary bucket IDs", () => {
    const parsed = __testExports.aggregateUserQuotaSummary({
      response: {
        groups: [
          {
            displayName: "Gemini Models",
            buckets: [
              {
                bucketId: "gemini-argon-wtu-weekly",
                window: "weekly",
                remainingFraction: 0.2,
                resetTime: "2026-07-30T12:00:00Z",
              },
              {
                bucketId: "gemini-weekly",
                window: "weekly",
                remainingFraction: 0.958,
                resetTime: "2026-07-30T12:05:10Z",
              },
              {
                bucketId: "gemini-5h",
                window: "5h",
                remainingFraction: 1,
                resetTime: "2026-07-23T17:00:00Z",
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              {
                bucketId: "3p-weekly",
                window: "weekly",
                remainingFraction: 0.75,
                resetTime: "2026-07-30T12:05:10Z",
              },
              {
                bucketId: "3p-5h",
                window: "5h",
                remainingFraction: 0.5,
                resetTime: "2026-07-23T17:00:00Z",
              },
            ],
          },
        ],
      },
    });

    expect(parsed.gemini).toEqual({
      fiveHour: { remainingFraction: 1, resetTime: "2026-07-23T17:00:00Z" },
      weekly: { remainingFraction: 0.958, resetTime: "2026-07-30T12:05:10Z" },
    });
    expect(parsed.claude).toEqual({
      fiveHour: { remainingFraction: 0.5, resetTime: "2026-07-23T17:00:00Z" },
      weekly: { remainingFraction: 0.75, resetTime: "2026-07-30T12:05:10Z" },
    });

    const merged = __testExports.mergeQuotaWithSummary(
      { groups: { gemini: { remainingFraction: 1, modelCount: 2 } }, modelCount: 2 },
      parsed,
    );
    // Most constraining window drives top-level remainingFraction/resetTime for soft-quota protection
    expect(merged.groups.gemini?.remainingFraction).toBe(0.958);
    expect(merged.groups.gemini?.resetTime).toBe("2026-07-30T12:05:10Z");
    expect(merged.groups.claude?.remainingFraction).toBe(0.5);
    expect(merged.groups.claude?.resetTime).toBe("2026-07-23T17:00:00Z");

    const now = Date.parse("2026-07-23T12:00:00Z");
    expect(formatQuotaGroupEntries("gemini", merged.groups.gemini!, now)).toEqual([
      "gemini (5h): 100% (resets in 5h)",
      "gemini (weekly): 96% (resets in 7d)",
    ]);
  });

  it("queries daily and prod with the Antigravity Hub UA and prefers lower (consumed) fractions", async () => {
    const calls: Array<{ url: string; ua: string | null }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, ua: new Headers(init?.headers).get("user-agent") });
      if (url.startsWith(ANTIGRAVITY_ENDPOINT)) {
        return Response.json({
          response: {
            groups: [
              {
                displayName: "Claude and GPT models",
                buckets: [
                  { bucketId: "3p-5h", window: "5h", remainingFraction: 0.45, resetTime: "2026-07-23T17:00:00Z" },
                  { bucketId: "3p-weekly", window: "weekly", remainingFraction: 0.6, resetTime: "2026-07-30T12:00:00Z" },
                ],
              },
            ],
          },
        });
      }
      return Response.json({
        response: {
          groups: [
            {
              displayName: "Gemini Models",
              buckets: [
                { bucketId: "gemini-5h", window: "5h", remainingFraction: 0.9, resetTime: "2026-07-23T17:00:00Z" },
                { bucketId: "gemini-weekly", window: "weekly", remainingFraction: 0.8, resetTime: "2026-07-30T12:00:00Z" },
              ],
            },
            {
              displayName: "Claude and GPT models",
              buckets: [
                { bucketId: "3p-5h", window: "5h", remainingFraction: 1, resetTime: "2026-07-23T17:00:00Z" },
                { bucketId: "3p-weekly", window: "weekly", remainingFraction: 1, resetTime: "2026-07-30T12:00:00Z" },
              ],
            },
          ],
        },
      });
    }));

    const result = await fetchUserQuotaSummary("token", "proj");
    expect(calls).toEqual([
      { url: `${ANTIGRAVITY_ENDPOINT}/v1internal:retrieveUserQuotaSummary`, ua: ANTIGRAVITY_HUB_USER_AGENT },
      { url: `${ANTIGRAVITY_ENDPOINT_PROD}/v1internal:retrieveUserQuotaSummary`, ua: ANTIGRAVITY_HUB_USER_AGENT },
    ]);
    expect(result.gemini?.weekly?.remainingFraction).toBe(0.8);
    expect(result.claude?.fiveHour?.remainingFraction).toBe(0.45);
    expect(result.claude?.weekly?.remainingFraction).toBe(0.6);
  });
});
