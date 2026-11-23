import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PROACTIVE_REFRESH_CONFIG, ProactiveRefreshQueue } from "./refresh-queue";
import { AccountManager } from "./accounts";
import type { AccountStorageV4 } from "./storage";
import type { OAuthAuthDetails, PluginClient } from "./types";
import { refreshAccessToken } from "./token";

vi.mock("./token", () => ({
  refreshAccessToken: vi.fn(),
}));

const mockedRefresh = vi.mocked(refreshAccessToken);

// Mock PluginClient
const mockClient: PluginClient = {
  toast: vi.fn(),
  auth: {
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
  },
} as unknown as PluginClient;

describe("ProactiveRefreshQueue", () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe("getAccountsNeedingRefresh", () => {
    it("skips disabled accounts", () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "r1",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
          {
            refreshToken: "r2",
            projectId: "p2",
            addedAt: now,
            lastUsed: 0,
            enabled: false, // disabled account
          },
          {
            refreshToken: "r3",
            projectId: "p3",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      // Set all accounts to expire soon (within buffer)
      const accounts = manager.getAccounts();
      const expiringSoon = now + 1000 * 60 * 10; // 10 minutes from now
      accounts.forEach((acc) => {
        acc.expires = expiringSoon;
      });

      const needsRefresh = queue.getAccountsNeedingRefresh();

      // Should only include enabled accounts (indices 0 and 2)
      expect(needsRefresh.length).toBe(2);
      expect(needsRefresh.map((a) => a.index)).toEqual([0, 2]);
      expect(needsRefresh.every((a) => a.enabled !== false)).toBe(true);
    });

    it("includes accounts with undefined enabled (default to enabled)", () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "r1",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            // enabled is undefined - should be treated as enabled
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      // Set account to expire soon
      const accounts = manager.getAccounts();
      accounts[0]!.expires = now + 1000 * 60 * 10; // 10 minutes from now

      const needsRefresh = queue.getAccountsNeedingRefresh();

      expect(needsRefresh.length).toBe(1);
      expect(needsRefresh[0]!.index).toBe(0);
    });

    it("skips expired accounts", () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "r1",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      // Set account to already expired
      const accounts = manager.getAccounts();
      accounts[0]!.expires = now - 1000; // 1 second ago

      const needsRefresh = queue.getAccountsNeedingRefresh();

      expect(needsRefresh.length).toBe(0);
    });

    it("skips accounts that don't need refresh yet", () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "r1",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800, // 30 minutes
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      // Set account to expire in 1 hour (outside 30 min buffer)
      const accounts = manager.getAccounts();
      accounts[0]!.expires = now + 1000 * 60 * 60; // 1 hour from now

      const needsRefresh = queue.getAccountsNeedingRefresh();

      expect(needsRefresh.length).toBe(0);
    });
  });

  describe("proactive-refresh failure backoff", () => {
    function makeQueueWithOneExpiringAccount() {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            refreshToken: "r1",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      // Expire within buffer so the account is always a refresh candidate.
      const accounts = manager.getAccounts();
      accounts[0]!.expires = now + 1000 * 60 * 10; // 10 minutes from now

      // Private members are reached via bracket notation for testing only.
      const runRefreshCheck = (): Promise<void> =>
        (queue as unknown as { runRefreshCheck: () => Promise<void> }).runRefreshCheck();
      (queue as unknown as { state: { isRunning: boolean } }).state.isRunning = true;

      return { queue, manager, runRefreshCheck };
    }

    beforeEach(() => {
      mockedRefresh.mockReset();
    });

    it("stops retrying an account after consecutive failures (enters backoff)", async () => {
      const { runRefreshCheck } = makeQueueWithOneExpiringAccount();

      // Every proactive refresh fails (e.g. revoked-but-unexpired token).
      mockedRefresh.mockResolvedValue(undefined);

      // Three failing checks cross the threshold of 3.
      await runRefreshCheck();
      await runRefreshCheck();
      await runRefreshCheck();
      expect(mockedRefresh).toHaveBeenCalledTimes(3);

      // The account is now in a backoff window; the next check should skip it.
      await runRefreshCheck();
      expect(mockedRefresh).toHaveBeenCalledTimes(3);
    });

    it("resets the failure counter after a successful refresh", async () => {
      const { runRefreshCheck } = makeQueueWithOneExpiringAccount();

      const goodAuth: OAuthAuthDetails = {
        type: "oauth",
        refresh: "r1|p1",
        access: "fresh-access",
        // Keep expiry within the buffer so the account stays a refresh candidate.
        expires: Date.now() + 1000 * 60 * 10,
      };

      // Two failures, then a success (which should reset the counter), then two
      // more failures. That is only two consecutive failures post-reset, so the
      // account never enters backoff and is retried on every check (5 total).
      mockedRefresh
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(goodAuth)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined);

      for (let i = 0; i < 5; i++) {
        await runRefreshCheck();
      }

      expect(mockedRefresh).toHaveBeenCalledTimes(5);
    });

    it("clears both old and new keys when a successful refresh rotates the token", async () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          {
            // No email → tracking key is the refresh token, which rotates on success.
            refreshToken: "old-token",
            projectId: "p1",
            addedAt: now,
            lastUsed: 0,
            enabled: true,
          },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      const accounts = manager.getAccounts();
      accounts[0]!.expires = now + 1000 * 60 * 10; // within buffer

      const runRefreshCheck = (): Promise<void> =>
        (queue as unknown as { runRefreshCheck: () => Promise<void> }).runRefreshCheck();
      (queue as unknown as { state: { isRunning: boolean } }).state.isRunning = true;
      const failureTracking = (queue as unknown as { failureTracking: Map<string, unknown> })
        .failureTracking;

      // First check fails, recording a failure entry under the OLD refresh token.
      mockedRefresh.mockResolvedValueOnce(undefined);
      await runRefreshCheck();
      expect(failureTracking.has("old-token")).toBe(true);

      // Second check succeeds AND rotates the refresh token to "new-token".
      const rotatedAuth: OAuthAuthDetails = {
        type: "oauth",
        refresh: "new-token|p1",
        access: "fresh-access",
        expires: now + 1000 * 60 * 10,
      };
      mockedRefresh.mockResolvedValueOnce(rotatedAuth);
      await runRefreshCheck();

      // Neither the old key nor the new key should retain a stale failure entry.
      expect(failureTracking.has("old-token")).toBe(false);
      expect(failureTracking.has("new-token")).toBe(false);
      expect(failureTracking.size).toBe(0);
    });

    it("prunes failure-tracking entries for accounts removed from the manager", async () => {
      const now = Date.now();
      const stored: AccountStorageV4 = {
        version: 4,
        accounts: [
          // No emails → tracking keys are the refresh tokens.
          { refreshToken: "r1", projectId: "p1", addedAt: now, lastUsed: 0, enabled: true },
          { refreshToken: "r2", projectId: "p2", addedAt: now, lastUsed: 0, enabled: true },
        ],
        activeIndex: 0,
      };

      const manager = new AccountManager(undefined, stored);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider", {
        enabled: true,
        bufferSeconds: 1800,
        checkIntervalSeconds: 300,
      });
      queue.setAccountManager(manager);

      const withinBuffer = now + 1000 * 60 * 10;
      manager.getAccounts().forEach((acc) => {
        acc.expires = withinBuffer;
      });

      const runRefreshCheck = (): Promise<void> =>
        (queue as unknown as { runRefreshCheck: () => Promise<void> }).runRefreshCheck();
      (queue as unknown as { state: { isRunning: boolean } }).state.isRunning = true;
      const failureTracking = (queue as unknown as { failureTracking: Map<string, unknown> })
        .failureTracking;

      // Both accounts fail once → both tracked.
      mockedRefresh.mockResolvedValue(undefined);
      await runRefreshCheck();
      expect(failureTracking.has("r1")).toBe(true);
      expect(failureTracking.has("r2")).toBe(true);

      // Remove the "r1" account; its identity no longer exists.
      expect(manager.removeAccountByIndex(0)).toBe(true);
      // Keep the surviving account a refresh candidate.
      manager.getAccounts().forEach((acc) => {
        acc.expires = withinBuffer;
      });

      // Next check should prune the orphaned "r1" entry (and keep the live "r2").
      await runRefreshCheck();
      expect(failureTracking.has("r1")).toBe(false);
      expect(failureTracking.has("r2")).toBe(true);
    });
  });

  describe("default configuration", () => {
    it("disables proactive refresh by default", () => {
      expect(DEFAULT_PROACTIVE_REFRESH_CONFIG.enabled).toBe(false);
      const queue = new ProactiveRefreshQueue(mockClient, "test-provider");
      queue.start();
      expect(queue.isRunning()).toBe(false);
    });
  });
});
