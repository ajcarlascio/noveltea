import { AuthError, ServerUnreachable, refresh } from "./api";
import type { Session } from "./session";

/**
 * Holds the access token and renews it, without a React dependency so it can be
 * tested directly.
 *
 * The rule that shapes this: **being offline is not being signed out.** A refresh
 * that fails because the server is unreachable leaves the session exactly as it was,
 * because the author is still the author and their work is still local. Only the
 * server actually rejecting the refresh token ends a session — that is a real answer
 * ("this token is spent or revoked"), and the only one worth acting on.
 */
export interface Authenticator {
  /** A usable access token, refreshing first if there is none. */
  accessToken(): Promise<string>;
  /** Attaches the bearer token, and retries once if the token had just expired. */
  fetch(path: string, init?: RequestInit): Promise<Response>;
  /** Replaces the stored refresh token after a rotation. */
  onRotate: (session: Session) => void;
  /** Called when the server rejects the refresh token: the session is over. */
  onExpired: () => void;
}

export interface AuthenticatorOptions {
  session: Session;
  onRotate: (session: Session) => void;
  onExpired: () => void;
  fetcher?: typeof fetch;
  /** Seeds the in-memory token, e.g. straight after signing in. */
  initialAccessToken?: string;
}

export function createAuthenticator({
  session,
  onRotate,
  onExpired,
  fetcher = fetch,
  initialAccessToken,
}: AuthenticatorOptions): Authenticator {
  let current: Session = session;
  let token: string | null = initialAccessToken ?? null;
  let renewing: Promise<string> | null = null;

  async function renew(): Promise<string> {
    // One renewal even if several requests notice the expiry at once. A second would
    // rotate the token again and invalidate the first — the app locking itself out.
    renewing ??= (async () => {
      try {
        const response = await refresh(current.serverUrl, current.refreshToken, fetcher);
        current = { ...current, refreshToken: response.refreshToken };
        token = response.accessToken;
        onRotate(current);
        return response.accessToken;
      } catch (error) {
        if (error instanceof AuthError) {
          // The server answered, and the answer was no.
          onExpired();
        }
        // A ServerUnreachable falls through untouched: offline is not signed out.
        throw error;
      } finally {
        renewing = null;
      }
    })();
    return renewing;
  }

  return {
    onRotate,
    onExpired,

    async accessToken() {
      if (token !== null) return token;
      return renew();
    },

    async fetch(path: string, init: RequestInit = {}) {
      const send = async (bearer: string) => {
        try {
          return await fetcher(`${current.serverUrl}${path}`, {
            ...init,
            headers: { ...init.headers, authorization: `Bearer ${bearer}` },
            credentials: "omit",
          });
        } catch (cause) {
          throw new ServerUnreachable(current.serverUrl, cause);
        }
      };

      let response = await send(await this.accessToken());
      if (response.status === 401) {
        // The access token lasts fifteen minutes; a 401 usually just means it ran
        // out mid-session. Renew and retry exactly once — a loop here would hammer
        // the server with a token it has already refused.
        token = null;
        response = await send(await renew());
      }
      return response;
    },
  };
}
