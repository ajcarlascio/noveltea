import { createContext, useContext } from "react";
import type { Authenticator } from "./authenticate";
import type { Session } from "./session";
import type { Credentials } from "./api";

export interface AuthContextValue {
  session: Session | null;
  /** Present only while signed in. */
  authenticator: Authenticator | null;
  signIn: (serverUrl: string, credentials: Credentials) => Promise<void>;
  signUp: (serverUrl: string, credentials: Credentials) => Promise<void>;
  signOut: () => void;
  /**
   * Changes the signed-in account's password and adopts the session that comes back.
   *
   * @returns how many other devices the change signed out, which is worth telling
   *   someone about rather than doing silently.
   */
  changePassword: (currentPassword: string, newPassword: string) => Promise<number>;
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within <AuthProvider>");
  return value;
}
