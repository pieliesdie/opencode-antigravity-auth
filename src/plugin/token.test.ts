import { beforeEach, describe, expect, it, vi } from "vitest";

import { ANTIGRAVITY_PROVIDER_ID } from "../constants";
import { AntigravityTokenRefreshError, refreshAccessToken } from "./token";
import type { OAuthAuthDetails, PluginClient } from "./types";

const baseAuth: OAuthAuthDetails = {
  type: "oauth",
  refresh: "refresh-token|project-123",
  access: "old-access",
  expires: Date.now() - 1000,
};

function createClient() {
  return {
    auth: {
      set: vi.fn(async () => {}),
    },
  } as PluginClient & {
    auth: { set: ReturnType<typeof vi.fn> };
  };
}

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("updates the caller when refresh token is unchanged", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "new-access",
          expires_in: 3600,
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("new-access");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("handles Google refresh token rotation", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          access_token: "next-access",
          expires_in: 3600,
          refresh_token: "rotated-token",
        }),
        { status: 200 },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const result = await refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID);

    expect(result?.access).toBe("next-access");
    expect(result?.refresh).toContain("rotated-token");
    expect(client.auth.set.mock.calls.length).toBe(0);
  });

  it("shares a renewal but keeps each caller's project", async () => {
    const network = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ access_token: "shared", expires_in: 3600 }))
    const [a, b] = await Promise.all(["one", "two"].map(project =>
      refreshAccessToken({ ...baseAuth, refresh: `same|${project}` }, createClient(), "google")))
    expect(network).toHaveBeenCalledTimes(1)
    expect([a?.refresh, b?.refresh]).toEqual(["same|one", "same|two"])
    expect([a?.access, b?.access]).toEqual(["shared", "shared"])
  })

  it("preserves timeout cause and allows a later refresh", async () => {
    const reason = new DOMException("timeout", "TimeoutError")
    const network = vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async (_url, init) => {
        expect(init?.signal).toBeInstanceOf(AbortSignal)
        throw reason
      }).mockResolvedValue(Response.json({ access_token: "restored", expires_in: 3600 }))
    await expect(refreshAccessToken(baseAuth, createClient(), "google")).rejects.toMatchObject({ cause: reason })
    expect((await refreshAccessToken(baseAuth, createClient(), "google"))?.access).toBe("restored")
    expect(network).toHaveBeenCalledTimes(2)
  })

  it("throws a typed error on invalid_grant", async () => {
    const client = createClient();
    const fetchMock = vi.fn(async () => {
      return new Response(
        JSON.stringify({
          error: "invalid_grant",
          error_description: "Refresh token revoked",
        }),
        { status: 400, statusText: "Bad Request" },
      );
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(refreshAccessToken(baseAuth, client, ANTIGRAVITY_PROVIDER_ID)).rejects.toMatchObject({
      name: "AntigravityTokenRefreshError",
      code: "invalid_grant",
    });
  });
});
