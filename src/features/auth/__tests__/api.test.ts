import { describe, expect, it } from "vitest";
import { calledBody, calledInit, calledUrl, fetchMock } from "@/test/fetch";
import { AuthError, login, register, ServerUnreachable, type Credentials } from "../api";

const SERVER = "https://write.example.com";
const CREDENTIALS: Credentials = {
  email: "author@example.com",
  password: "correct horse battery staple",
  deviceName: "Laptop",
  platform: "web",
};

/** Awaits a rejection and hands back the error, typed. tsc cannot narrow a catch. */
async function rejection<T>(promise: Promise<unknown>, kind: new (...args: never[]) => T): Promise<T> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof kind) return error;
    throw error;
  }
  throw new Error("expected the call to fail, and it did not");
}

const session = () =>
  new Response(
    JSON.stringify({
      userId: "u1",
      deviceId: "d1",
      accessToken: "a",
      refreshToken: "r",
      expiresIn: 900,
    }),
    { status: 200 },
  );

const problem = (status: number, body: unknown = {}) =>
  new Response(JSON.stringify(body), { status });

describe("a successful sign-in", () => {
  it("posts to the server's auth route and returns the session", async () => {
    const fetcher = fetchMock(() => Promise.resolve(session()));
    const result = await login(SERVER, CREDENTIALS, fetcher);

    expect(calledUrl(fetcher)).toBe("https://write.example.com/api/v1/auth/login");
    expect(calledInit(fetcher).credentials).toBe("omit");
    expect(calledBody(fetcher)).toEqual(CREDENTIALS);
    expect(result).toMatchObject({ userId: "u1", refreshToken: "r" });
  });

  it("refuses a response shaped like something else", async () => {
    // A different NovelTea version, or something else answering on that address.
    const fetcher = fetchMock(() => Promise.resolve(new Response('{"hello":true}', { status: 200 })));
    await expect(login(SERVER, CREDENTIALS, fetcher)).rejects.toThrow(
      /does not understand/i,
    );
  });
});

describe("rejected credentials", () => {
  it("says the same thing whatever the server distinguished", async () => {
    // The server answers every credential failure identically so that login cannot
    // be used to discover which addresses have accounts. Reporting more here would
    // undo that from the client side.
    const messages: string[] = [];
    for (const body of [
      { code: "invalid_credentials", message: "no such account" },
      { code: "invalid_credentials", message: "wrong password" },
      {},
    ]) {
      const fetcher = fetchMock(() => Promise.resolve(problem(401, body)));
      await login(SERVER, CREDENTIALS, fetcher).catch((e: unknown) => {
        messages.push((e as Error).message);
      });
    }
    expect(new Set(messages).size).toBe(1);
    expect(messages[0]).toMatch(/do not match an account/i);
  });

  it("does not leak the server's wording for a 401", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(problem(401, { code: "invalid_credentials", message: "user not found" }));
    await expect(login(SERVER, CREDENTIALS, fetcher)).rejects.not.toThrow(
      /not found/i,
    );
  });
});

describe("registration", () => {
  it("says plainly when the address is taken", async () => {
    // Not the same enumeration concern: the person is holding the address and needs
    // to know it already has an account.
    const fetcher = fetchMock(() => Promise.resolve(problem(409, { code: "email_registered" })));
    await expect(register(SERVER, CREDENTIALS, fetcher)).rejects.toThrow(
      /already has an account/i,
    );
  });
});

describe("other refusals", () => {
  it("explains a rate limit as something to wait out", async () => {
    const fetcher = fetchMock(() => Promise.resolve(problem(429)));
    await expect(login(SERVER, CREDENTIALS, fetcher)).rejects.toThrow(
      /wait a minute/i,
    );
  });

  it("passes through a message the server did author", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValue(problem(400, { code: "weak_password", message: "password is too short" }));
    const error = await rejection(
      login(SERVER, CREDENTIALS, fetcher),
      AuthError,
    );
    expect(error.message).toBe("password is too short");
    expect(error.code).toBe("weak_password");
  });

  it("still reports something useful when the body is not JSON", async () => {
    const fetcher = fetchMock(() => Promise.resolve(new Response("<html>502</html>", { status: 502 })));
    await expect(login(SERVER, CREDENTIALS, fetcher)).rejects.toThrow(
      /502/,
    );
  });
});

describe("an unreachable server", () => {
  it("is told apart from a rejection, and mentions CORS", async () => {
    // A browser reports a DNS failure, a refused connection and a CORS block with
    // the same opaque TypeError. The CORS case is the one a self-hoster hits and the
    // one that looks least like what it is, so the message names it.
    const fetcher = fetchMock(() => Promise.reject(new TypeError("Failed to fetch")));
    const error = await rejection(
      login(SERVER, CREDENTIALS, fetcher),
      ServerUnreachable,
    );

    expect(error.message).toContain("noveltea.cors.allowed-origins");
    expect(error.message).toContain(SERVER);
    // Not an AuthError: the credentials were never judged, and telling someone their
    // password is wrong when the server was unreachable sends them the wrong way.
    expect(error).not.toBeInstanceOf(AuthError);
  });

  it("keeps the original failure as the cause", async () => {
    const cause = new TypeError("Failed to fetch");
    const fetcher = fetchMock(() => Promise.reject(cause));
    const error = await rejection(
      login(SERVER, CREDENTIALS, fetcher),
      ServerUnreachable,
    );
    expect(error.cause).toBe(cause);
  });
});
