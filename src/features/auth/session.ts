/**
 * The signed-in session, and where its two tokens live.
 *
 * **The access token is kept in memory only.** It lasts fifteen minutes and is
 * replaced by a refresh whenever it runs out, so persisting it buys nothing and
 * widens the window in which a copy is useful.
 *
 * **The refresh token is persisted**, which is a deliberate exception to the rule
 * that credentials never touch local storage — see `features/lookup/keys.ts` for why
 * an API key must not. The difference is what a stolen one is worth:
 *
 * - It **rotates on every use**, so a copy works at most once.
 * - Using a stolen one **breaks the legitimate device's next refresh**, which is a
 *   signal the author sees rather than a silent compromise.
 * - It is scoped to this application and revocable per device.
 * - The alternative is signing in on every reload, which pushes people towards
 *   shorter passwords and password reuse — a worse trade than the one it avoids.
 *
 * The mitigation that makes this defensible is the CSP: script runs by hash, there is
 * no `unsafe-inline`, and no third-party script is loaded at all. If that ever
 * loosens, this decision needs revisiting.
 */

export const SESSION_STORAGE_KEY = "noveltea.session";

export interface Session {
  serverUrl: string;
  userId: string;
  deviceId: string;
  refreshToken: string;
  /** Email, for showing who is signed in and prefilling a re-authentication. */
  email: string;
  /**
   * The server is holding this account until it chooses a password of its own — a
   * first-run administrator, or an account someone else created.
   *
   * Never trusted as a permission. The server refuses every route but the one that
   * fixes it, so this is here to show the right screen, not to enforce anything; a
   * client that ignored it would simply see 403s.
   */
  mustChangePassword?: boolean;
  /**
   * This account administers the server it is signed in to.
   *
   * Only ever used to decide whether to offer the administration screen. The server
   * re-reads the flag on every administration call, so it is a hint about what to show,
   * never a permission — setting it by hand would produce a screen that answers 404.
   */
  isAdmin?: boolean;
}

/** What the server returns from register, login, refresh and pair. */
export interface SessionResponse {
  userId: string;
  deviceId: string;
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
  mustChangePassword?: boolean;
  isAdmin?: boolean;
}

export function isSessionResponse(value: unknown): value is SessionResponse {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.userId === "string" &&
    typeof row.deviceId === "string" &&
    typeof row.accessToken === "string" &&
    typeof row.refreshToken === "string"
  );
}

function isSession(value: unknown): value is Session {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  return (
    typeof row.serverUrl === "string" &&
    typeof row.userId === "string" &&
    typeof row.deviceId === "string" &&
    typeof row.refreshToken === "string" &&
    typeof row.email === "string"
  );
}

export function readSession(storage: Pick<Storage, "getItem"> | undefined): Session | null {
  if (!storage) return null;
  try {
    const raw = storage.getItem(SESSION_STORAGE_KEY);
    if (raw === null) return null;
    const parsed: unknown = JSON.parse(raw);
    return isSession(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function writeSession(
  storage: Pick<Storage, "setItem" | "removeItem"> | undefined,
  session: Session | null,
): void {
  if (!storage) return;
  try {
    if (session === null) storage.removeItem(SESSION_STORAGE_KEY);
    else storage.setItem(SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    // Held for this session only.
  }
}
