import { isSessionResponse, type SessionResponse } from "./session";

/**
 * The auth calls, and the one rule that governs how their failures are reported.
 *
 * The server answers every credential failure with one identical message, so login
 * cannot be used to find out which addresses have accounts. This client must not
 * undo that by inferring more than it was told — so there is exactly one message for
 * a rejected sign-in here too, whatever the server said.
 */

export type Platform = "web" | "tauri" | "ios" | "android";

export interface Credentials {
  email: string;
  password: string;
  deviceName: string;
  platform: Platform;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "AuthError";
  }
}

/** Reachability, told apart from rejection, because the remedies are different. */
export class ServerUnreachable extends Error {
  constructor(
    readonly serverUrl: string,
    // `cause` is Error's own field; naming it here would shadow rather than set it.
    reason?: unknown,
  ) {
    super(
      `Could not reach ${serverUrl}. Check the address and that you are online. If the ` +
        `server is running and you are using a browser, its origin may need to be listed ` +
        `in noveltea.cors.allowed-origins — a blocked request looks exactly like this one.`,
      { cause: reason },
    );
    this.name = "ServerUnreachable";
  }
}

/** One message for every rejected credential, matching the server's own discipline. */
const REJECTED = "That email address and password do not match an account on this server.";

interface ApiErrorBody {
  code?: unknown;
  message?: unknown;
}

async function post(
  serverUrl: string,
  path: string,
  body: unknown,
  fetcher: typeof fetch,
): Promise<SessionResponse> {
  let response: Response;
  try {
    response = await fetcher(`${serverUrl}/api/v1/auth/${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      // No cookies: the API is bearer-token only, and sending credentials would make
      // every self-hosted origin a CORS negotiation it does not need.
      credentials: "omit",
    });
  } catch (cause) {
    // fetch rejects with a TypeError for a DNS failure, a refused connection and a
    // CORS block alike; the browser deliberately does not say which.
    throw new ServerUnreachable(serverUrl, cause);
  }

  if (response.ok) {
    const payload: unknown = await response.json();
    if (!isSessionResponse(payload)) {
      throw new AuthError(
        `${serverUrl} answered in a shape this version does not understand. It may be running a different version of NovelTea.`,
        "unexpected_response",
      );
    }
    return payload;
  }

  const problem = (await response.json().catch(() => ({}))) as ApiErrorBody;
  const code = typeof problem.code === "string" ? problem.code : `http_${String(response.status)}`;

  if (response.status === 401 || code === "invalid_credentials") {
    throw new AuthError(REJECTED, "invalid_credentials");
  }
  if (code === "email_registered") {
    // Registration is not an enumeration oracle in the same way: the person is
    // holding the address and needs to know it is taken.
    throw new AuthError("That email address already has an account on this server.", code);
  }
  if (response.status === 429) {
    throw new AuthError("Too many attempts. Wait a minute and try again.", "rate_limited");
  }

  const message = typeof problem.message === "string" ? problem.message : "";
  throw new AuthError(
    message.length > 0 ? message : `The server refused the request (${String(response.status)}).`,
    code,
  );
}

export const login = (serverUrl: string, credentials: Credentials, fetcher: typeof fetch = fetch) =>
  post(serverUrl, "login", credentials, fetcher);

export const register = (serverUrl: string, credentials: Credentials, fetcher: typeof fetch = fetch) =>
  post(serverUrl, "register", credentials, fetcher);

export const refresh = (serverUrl: string, refreshToken: string, fetcher: typeof fetch = fetch) =>
  post(serverUrl, "refresh", { refreshToken }, fetcher);

export const pair = (
  serverUrl: string,
  input: { code: string; deviceName: string; platform: Platform },
  fetcher: typeof fetch = fetch,
) => post(serverUrl, "pair", input, fetcher);
