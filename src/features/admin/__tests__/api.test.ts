import { describe, expect, it, vi } from "vitest";
import type { Authenticator } from "@/features/auth/authenticate";
import { AdminError, createUser, listUsers, setPassword } from "../api";

/**
 * A minimal Authenticator: these tests are about what the administration calls send and
 * how they read a refusal, not about token rotation, which authenticate.test.ts owns.
 */
function authenticator(...responses: Response[]): {
  auth: Authenticator;
  calls: { path: string; init?: RequestInit }[];
} {
  const calls: { path: string; init?: RequestInit }[] = [];
  let index = 0;
  const auth = {
    accessToken: () => Promise.resolve("token"),
    fetch: (path: string, init?: RequestInit) => {
      calls.push({ path, ...(init ? { init } : {}) });
      return Promise.resolve(responses[index++] ?? responses[responses.length - 1]!);
    },
    onRotate: vi.fn(),
    onExpired: vi.fn(),
  } as unknown as Authenticator;
  return { auth, calls };
}

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** The JSON body a recorded call was sent with. `init.body` is a union that includes Blob. */
const bodyOf = (init?: RequestInit): unknown =>
  JSON.parse(typeof init?.body === "string" ? init.body : "null");

const ACCOUNT = { id: "u2", email: "someone@example.com", password: "Qh4k-mR7p-w2Bt-x9Le" };

describe("listing accounts", () => {
  it("asks the administration route and normalises what comes back", async () => {
    const { auth, calls } = authenticator(
      json([
        {
          id: "u1",
          email: "admin@localhost",
          displayName: null,
          admin: true,
          guest: false,
          mustChangePassword: true,
          createdAt: "2026-08-27T00:00:00Z",
          deletionRequestedAt: null,
        },
      ]),
    );

    const users = await listUsers(auth);

    expect(calls[0]?.path).toBe("/api/v1/admin/users");
    expect(users).toEqual([
      {
        id: "u1",
        email: "admin@localhost",
        displayName: null,
        admin: true,
        guest: false,
        mustChangePassword: true,
        createdAt: "2026-08-27T00:00:00Z",
        deletionRequestedAt: null,
      },
    ]);
  });

  it("treats a 404 as 'you do not administer this server', because that is what it means", async () => {
    // The API answers a non-administrator 404 rather than 403, so a signed-in stranger
    // cannot confirm the surface exists. That leaves this indistinguishable from an older
    // server, and it says so rather than guessing.
    const { auth } = authenticator(json({ error: "not_found" }, 404));

    await expect(listUsers(auth)).rejects.toBeInstanceOf(AdminError);
    await expect(listUsers(auth)).rejects.toThrow(/does not administer this server|older/i);
  });
});

describe("creating an account", () => {
  it("posts what the form collected", async () => {
    const { auth, calls } = authenticator(json(ACCOUNT, 201));

    const created = await createUser(auth, {
      email: "someone@example.com",
      displayName: "Someone",
      admin: false,
    });

    expect(calls[0]?.path).toBe("/api/v1/admin/users");
    expect(calls[0]?.init?.method).toBe("POST");
    expect(bodyOf(calls[0]?.init)).toEqual({
      email: "someone@example.com",
      displayName: "Someone",
      admin: false,
    });
    expect(created.password).toBe(ACCOUNT.password);
  });

  it("says plainly when the address is taken", async () => {
    const { auth } = authenticator(json({ error: "email_registered" }, 409));
    await expect(createUser(auth, { email: "taken@example.com" })).rejects.toThrow(
      /already has an account/i,
    );
  });

  it("refuses a response with no password rather than leaving a silent dead account", async () => {
    // The password is returned once and is unrecoverable. A response without one has
    // created an account nobody can ever sign in to, and quietly showing success would
    // hide that until somebody tried.
    const { auth } = authenticator(json({ id: "u2", email: "someone@example.com" }, 201));
    await expect(createUser(auth, { email: "someone@example.com" })).rejects.toThrow(
      /did not return a password/i,
    );
  });

  it("passes through a message the server authored", async () => {
    const { auth } = authenticator(
      json({ error: "bad_request", message: "password must be at least 12 characters" }, 400),
    );
    await expect(createUser(auth, { email: "a@b.test", password: "short" })).rejects.toThrow(
      "password must be at least 12 characters",
    );
  });
});

describe("setting somebody else's password", () => {
  it("posts to that account's password route, with the id escaped", async () => {
    const { auth, calls } = authenticator(json(ACCOUNT));

    const reset = await setPassword(auth, "u 2/../admin");

    expect(calls[0]?.path).toBe("/api/v1/admin/users/u%202%2F..%2Fadmin/password");
    expect(reset.password).toBe(ACCOUNT.password);
  });

  it("asks the server to generate one when none is given", async () => {
    const { auth, calls } = authenticator(json(ACCOUNT));
    await setPassword(auth, "u2");
    expect(bodyOf(calls[0]?.init)).toEqual({ password: null });
  });
});
