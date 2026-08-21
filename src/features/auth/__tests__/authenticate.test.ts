import { describe, expect, it, vi } from "vitest";
import { calledInit, calledUrl, type FetchMock } from "@/test/fetch";
import { createAuthenticator } from "../authenticate";
import { AuthError, ServerUnreachable } from "../api";
import type { Session } from "../session";

const SESSION: Session = {
  serverUrl: "https://write.example.com",
  userId: "u1",
  deviceId: "d1",
  refreshToken: "refresh-1",
  email: "author@example.com",
};

const sessionBody = (n: number) =>
  new Response(
    JSON.stringify({
      userId: "u1",
      deviceId: "d1",
      accessToken: `access-${String(n)}`,
      refreshToken: `refresh-${String(n)}`,
      expiresIn: 900,
    }),
    { status: 200 },
  );

function setup(fetcher: FetchMock) {
  const rotated: Session[] = [];
  const expired = vi.fn();
  const auth = createAuthenticator({
    session: SESSION,
    onRotate: (s) => rotated.push(s),
    onExpired: expired,
    fetcher,
  });
  return { auth, rotated, expired };
}

describe("renewal", () => {
  it("gets a token by refreshing when it has none", async () => {
    const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValue(sessionBody(2));
    const { auth, rotated } = setup(fetcher);

    expect(await auth.accessToken()).toBe("access-2");
    // The rotated refresh token must be stored, or the next renewal presents a spent
    // one and the session ends for no reason.
    expect(rotated.at(-1)?.refreshToken).toBe("refresh-2");
  });

  it("renews once even when several requests notice at the same time", async () => {
    const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValue(sessionBody(2));
    const { auth } = setup(fetcher);

    await Promise.all([auth.accessToken(), auth.accessToken(), auth.accessToken()]);

    // Refresh tokens rotate on use: a second concurrent renewal would invalidate the
    // first, and the app would lock itself out.
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reuses the token it already holds", async () => {
    const fetcher = vi.fn<typeof fetch>()
    .mockResolvedValue(sessionBody(2));
    const { auth } = setup(fetcher);
    await auth.accessToken();
    await auth.accessToken();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
});

describe("being offline", () => {
  it("does not end the session when the server cannot be reached", async () => {
    const fetcher = vi.fn<typeof fetch>()
    .mockRejectedValue(new TypeError("Failed to fetch"));
    const { auth, expired } = setup(fetcher);

    await expect(auth.accessToken()).rejects.toBeInstanceOf(ServerUnreachable);
    // Offline is not signed out. The author is still the author and the work is
    // still local; clearing the session would strand them behind a login screen
    // they cannot pass until the network returns.
    expect(expired).not.toHaveBeenCalled();
  });

  it("can still renew once the server comes back", async () => {
    const fetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValue(sessionBody(3));
    const { auth } = setup(fetcher);

    await expect(auth.accessToken()).rejects.toBeInstanceOf(ServerUnreachable);
    // A cached rejected promise would replay the failure forever.
    expect(await auth.accessToken()).toBe("access-3");
  });
});

describe("when the refresh token is spent", () => {
  it("ends the session, because the server actually answered", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ code: "invalid_credentials" }), { status: 401 }));
    const { auth, expired } = setup(fetcher);

    await expect(auth.accessToken()).rejects.toBeInstanceOf(AuthError);
    expect(expired).toHaveBeenCalledTimes(1);
  });
});

describe("authorised requests", () => {
  it("sends the bearer token and no cookies", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sessionBody(2))
      .mockResolvedValueOnce(new Response("{}", { status: 200 }));
    const { auth } = setup(fetcher);

    await auth.fetch("/api/v1/projects");

    expect(calledUrl(fetcher, 1)).toBe("https://write.example.com/api/v1/projects");
    const headers = calledInit(fetcher, 1).headers as Record<string, string>;
    expect(headers.authorization).toBe("Bearer access-2");
    expect(calledInit(fetcher, 1).credentials).toBe("omit");
  });

  it("renews and retries once on a 401, then stops", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sessionBody(2)) // first token
      .mockResolvedValueOnce(new Response("", { status: 401 })) // expired mid-session
      .mockResolvedValueOnce(sessionBody(3)) // renewal
      .mockResolvedValueOnce(new Response("", { status: 401 })); // still refused
    const { auth } = setup(fetcher);

    const response = await auth.fetch("/api/v1/projects");

    // Retrying more than once would hammer the server with a token it has already
    // refused; the caller gets the 401 and decides.
    expect(response.status).toBe(401);
    expect(fetcher).toHaveBeenCalledTimes(4);
  });

  it("reports an unreachable server rather than a bare TypeError", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(sessionBody(2))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"));
    const { auth } = setup(fetcher);

    await expect(auth.fetch("/api/v1/projects")).rejects.toBeInstanceOf(ServerUnreachable);
  });
});
