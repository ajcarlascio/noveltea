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
}

export const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const value = useContext(AuthContext);
  if (value === null) throw new Error("useAuth must be used within <AuthProvider>");
  return value;
}
