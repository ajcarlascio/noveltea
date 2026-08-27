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
  /**
   * The API's own field name for its stable error code. This was read as `code` and the
   * server has always sent `error`, so every branch keyed on a code was unreachable and
   * fell through to `http_<status>` — which the status checks happened to cover for
   * rejected credentials and did not for anything else. Both are accepted now: `error`
   * because it is what the server sends, `code` because a client that guesses about a
   * self-hosted server's version should guess generously.
   */
  error?: unknown;
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

  throw errorFrom(response, serverUrl, await response.json().catch(() => ({})));
}

/** Turns an error body into the one message a person can act on. */
function errorFrom(response: Response, serverUrl: string, body: unknown): AuthError {
  const problem = (body ?? {}) as ApiErrorBody;
  const code =
    typeof problem.error === "string"
      ? problem.error
      : typeof problem.code === "string"
        ? problem.code
        : `http_${String(response.status)}`;

  if (response.status === 401 || code === "invalid_credentials") {
    return new AuthError(REJECTED, "invalid_credentials");
  }
  if (code === "registration_closed") {
    // Not a credential problem and not a typo in the address, so neither of those
    // messages would send someone anywhere useful.
    return new AuthError(
      `${serverUrl} does not accept new accounts. Ask whoever runs it to make you one.`,
      code,
    );
  }
  if (code === "password_change_required") {
    return new AuthError(
      "Choose a new password before using this account.",
      code,
    );
  }
  if (code === "email_registered") {
    // Registration is not an enumeration oracle in the same way: the person is
    // holding the address and needs to know it is taken.
    return new AuthError("That email address already has an account on this server.", code);
  }
  if (response.status === 429) {
    return new AuthError("Too many attempts. Wait a minute and try again.", "rate_limited");
  }

  const message = typeof problem.message === "string" ? problem.message : "";
  return new AuthError(
    message.length > 0 ? message : `The server refused the request (${String(response.status)}).`,
    code,
  );
}

/**
 * What comes back from changing your own password.
 *
 * A whole session, because the access token that made the request was minted before the
 * change and, for an account the server was holding, still says so. Carrying on with it
 * would look like the change had failed.
 */
export interface PasswordChanged extends SessionResponse {
  devicesSignedOut: number;
}

/**
 * Changes the signed-in account's password.
 *
 * Takes a bearer token rather than an Authenticator: this is the one call an account
 * being held at the door can make, and at that moment nothing else it might do is
 * available to build one from.
 */
export async function changePassword(
  serverUrl: string,
  accessToken: string,
  currentPassword: string,
  newPassword: string,
  fetcher: typeof fetch = fetch,
): Promise<PasswordChanged> {
  let response: Response;
  try {
    response = await fetcher(`${serverUrl}/api/v1/account/password`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${accessToken}` },
      body: JSON.stringify({ currentPassword, newPassword }),
      credentials: "omit",
    });
  } catch (cause) {
    throw new ServerUnreachable(serverUrl, cause);
  }

  if (!response.ok) {
    throw errorFrom(response, serverUrl, await response.json().catch(() => ({})));
  }

  const payload: unknown = await response.json();
  if (!isSessionResponse(payload)) {
    throw new AuthError(
      `${serverUrl} answered in a shape this version does not understand.`,
      "unexpected_response",
    );
  }
  const devicesSignedOut = (payload as { devicesSignedOut?: unknown }).devicesSignedOut;
  return {
    ...payload,
    devicesSignedOut: typeof devicesSignedOut === "number" ? devicesSignedOut : 0,
  };
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
