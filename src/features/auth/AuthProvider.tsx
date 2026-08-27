import { useCallback, useMemo, useRef, useState, type ReactNode } from "react";
import { changePassword as changePasswordRequest, login, register, type Credentials } from "./api";
import { AuthContext, type AuthContextValue } from "./AuthContext";
import { createAuthenticator, type Authenticator } from "./authenticate";
import { readSession, writeSession, type Session, type SessionResponse } from "./session";
import { readServers, rememberServer, writeServers } from "./servers";

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function AuthProvider({
  children,
  initialSession,
  fetcher,
}: {
  children: ReactNode;
  /** Injectable for tests; production reads storage. */
  initialSession?: Session | null;
  fetcher?: typeof fetch;
}) {
  const [session, setSession] = useState<Session | null>(
    () => initialSession ?? readSession(safeStorage()),
  );
  // Seeded when signing in, so the first request after does not spend a refresh.
  const [freshToken, setFreshToken] = useState<string | null>(null);
  const authenticatorRef = useRef<Authenticator | null>(null);

  const persist = useCallback((next: Session | null) => {
    setSession(next);
    writeSession(safeStorage(), next);
  }, []);

  const adopt = useCallback(
    (serverUrl: string, email: string, response: SessionResponse) => {
      const next: Session = {
        serverUrl,
        userId: response.userId,
        deviceId: response.deviceId,
        refreshToken: response.refreshToken,
        email,
        mustChangePassword: response.mustChangePassword === true,
        isAdmin: response.isAdmin === true,
      };
      persist(next);
      setFreshToken(response.accessToken);
      // Remembered so the next sign-in offers this server first, with the address
      // already filled in.
      const storage = safeStorage();
      writeServers(storage, rememberServer(readServers(storage), serverUrl, email));
    },
    [persist],
  );

  const signIn = useCallback(
    async (serverUrl: string, credentials: Credentials) => {
      adopt(serverUrl, credentials.email, await login(serverUrl, credentials, fetcher));
    },
    [adopt, fetcher],
  );

  const signUp = useCallback(
    async (serverUrl: string, credentials: Credentials) => {
      adopt(serverUrl, credentials.email, await register(serverUrl, credentials, fetcher));
    },
    [adopt, fetcher],
  );

  const changePassword = useCallback(
    async (currentPassword: string, newPassword: string) => {
      if (session === null) throw new Error("Not signed in.");
      // The token in hand rather than one from the authenticator: an account being held
      // at the door can reach exactly this route, so there is nothing to refresh against
      // if the in-memory token has lapsed — and a refresh here would spend the rotation
      // for no reason. If it has lapsed, the authenticator is the only way to renew.
      const token = freshToken ?? (await authenticatorRef.current?.accessToken());
      if (token === undefined || token === null) throw new Error("Not signed in.");
      const response = await changePasswordRequest(
        session.serverUrl,
        token,
        currentPassword,
        newPassword,
        fetcher,
      );
      adopt(session.serverUrl, session.email, response);
      return response.devicesSignedOut;
    },
    [adopt, fetcher, freshToken, session],
  );

  const signOut = useCallback(() => {
    persist(null);
    setFreshToken(null);
    // The local replica is deliberately left alone. It is the author's work, it is
    // theirs whether or not they are signed in, and wiping it on sign-out would make
    // a routine action destroy a novel on a device with unsynced changes.
  }, [persist]);

  const authenticator = useMemo<Authenticator | null>(() => {
    if (session === null) return null;
    return createAuthenticator({
      session,
      onRotate: persist,
      // Only ever called when the server actually rejected the refresh token.
      onExpired: () => persist(null),
      ...(fetcher ? { fetcher } : {}),
      ...(freshToken !== null ? { initialAccessToken: freshToken } : {}),
    });
    // Keyed on identity rather than on `session` itself, and deliberately so: the
    // authenticator rotates the refresh token and calls back with a new session, and
    // depending on the whole object would rebuild it on every rotation — throwing
    // away the access token it just obtained and refreshing again, forever.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session?.serverUrl, session?.userId, session?.deviceId, freshToken, persist, fetcher]);

  // The authenticator changePassword needs is built below it, and a hook cannot read a
  // later `const`. A ref keeps the ordering honest rather than reordering the file around
  // one fallback path.
  authenticatorRef.current = authenticator;

  const value = useMemo<AuthContextValue>(
    () => ({ session, authenticator, signIn, signUp, signOut, changePassword }),
    [session, authenticator, signIn, signUp, signOut, changePassword],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
