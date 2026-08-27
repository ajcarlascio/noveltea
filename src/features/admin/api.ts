import type { Authenticator } from "@/features/auth/authenticate";

/**
 * The three administration calls, and the one thing to know about their failures.
 *
 * A caller who is not an administrator is answered **404, not 403** — the API's rule that
 * absence beats forbidden, applied here so a signed-in stranger cannot confirm that an
 * administration surface is there to be attacked. Which means this module cannot tell "you
 * are not an administrator" apart from "this server is older than this screen", and says
 * so rather than guessing.
 */

export interface AdminUser {
  id: string;
  email: string;
  displayName: string | null;
  admin: boolean;
  guest: boolean;
  mustChangePassword: boolean;
  createdAt: string | null;
  deletionRequestedAt: string | null;
}

/** Carries the password exactly once. The server keeps only its hash. */
export interface NewAccount {
  id: string;
  email: string;
  password: string;
}

export class AdminError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AdminError";
  }
}

const NOT_ADMINISTERED =
  "This account does not administer this server, or the server is older than this screen.";

async function call(
  authenticator: Authenticator,
  path: string,
  init?: RequestInit,
): Promise<unknown> {
  const response = await authenticator.fetch(`/api/v1${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...init?.headers },
  });

  if (response.status === 404) throw new AdminError(NOT_ADMINISTERED, "not_administered");

  if (!response.ok) {
    const problem = (await response.json().catch(() => ({}))) as {
      error?: unknown;
      message?: unknown;
    };
    const code = typeof problem.error === "string" ? problem.error : `http_${String(response.status)}`;
    if (code === "email_registered") {
      throw new AdminError("That address already has an account on this server.", code);
    }
    const message = typeof problem.message === "string" ? problem.message : "";
    throw new AdminError(
      message.length > 0 ? message : `The server refused the request (${String(response.status)}).`,
      code,
    );
  }

  return response.json();
}

const asUser = (row: Record<string, unknown>): AdminUser => ({
  id: String(row.id),
  email: String(row.email),
  displayName: typeof row.displayName === "string" ? row.displayName : null,
  admin: row.admin === true,
  guest: row.guest === true,
  mustChangePassword: row.mustChangePassword === true,
  createdAt: typeof row.createdAt === "string" ? row.createdAt : null,
  deletionRequestedAt:
    typeof row.deletionRequestedAt === "string" ? row.deletionRequestedAt : null,
});

const asAccount = (value: unknown): NewAccount => {
  const row = (value ?? {}) as Record<string, unknown>;
  if (typeof row.password !== "string" || typeof row.email !== "string") {
    // The password comes back once and is unrecoverable. A response that did not carry
    // one has left an account nobody can sign in to, and saying so is the only useful
    // thing to do about it.
    throw new AdminError(
      "The server did not return a password for the account. It may have been created " +
        "without one — check the account list.",
      "unexpected_response",
    );
  }
  return { id: String(row.id), email: row.email, password: row.password };
};

export async function listUsers(authenticator: Authenticator): Promise<AdminUser[]> {
  const payload = await call(authenticator, "/admin/users");
  return Array.isArray(payload) ? payload.map((row) => asUser(row as Record<string, unknown>)) : [];
}

export async function createUser(
  authenticator: Authenticator,
  input: { email: string; displayName?: string; password?: string; admin?: boolean },
): Promise<NewAccount> {
  return asAccount(
    await call(authenticator, "/admin/users", { method: "POST", body: JSON.stringify(input) }),
  );
}

/** For an account locked out on an instance with no mail server. */
export async function setPassword(
  authenticator: Authenticator,
  userId: string,
  password?: string,
): Promise<NewAccount> {
  return asAccount(
    await call(authenticator, `/admin/users/${encodeURIComponent(userId)}/password`, {
      method: "POST",
      body: JSON.stringify({ password: password ?? null }),
    }),
  );
}
