import { useMemo, useState, type FormEvent } from "react";
import { currentPlatform, suggestDeviceName } from "@/platform/platform";
import { useAuth } from "./AuthContext";
import { InvalidServerUrl, isInsecure, normaliseServerUrl, readServers } from "./servers";
import "./SignIn.css";

/** Sentinel for "not one of the remembered servers". Never a valid origin. */
const ANOTHER = "\u0000another";

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

/**
 * Sign in, or make an account, on a server the author names.
 *
 * There is no default instance and never will be. NovelTea is self-hosted, so the
 * address is the first thing asked for rather than something buried in settings.
 * Servers already used are offered in a dropdown, most recent first, because people
 * move between two or three in practice and retyping an address is a tax on the
 * common case.
 */
export function SignIn() {
  const { signIn, signUp } = useAuth();
  const known = useMemo(() => readServers(safeStorage()), []);

  const [choice, setChoice] = useState<string>(known[0]?.url ?? ANOTHER);
  const [typedServer, setTypedServer] = useState("");
  const [email, setEmail] = useState(known[0]?.lastEmail ?? "");
  const [password, setPassword] = useState("");
  const [deviceName, setDeviceName] = useState(suggestDeviceName);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const rawServer = choice === ANOTHER ? typedServer : choice;
  let normalised: string | null = null;
  try {
    normalised = rawServer.trim().length > 0 ? normaliseServerUrl(rawServer) : null;
  } catch {
    // Shown only once the form is submitted; warning while someone types is noise.
    normalised = null;
  }

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setError(null);

    let serverUrl: string;
    try {
      serverUrl = normaliseServerUrl(rawServer);
    } catch (cause) {
      setError(cause instanceof InvalidServerUrl ? cause.message : String(cause));
      return;
    }

    setBusy(true);
    const credentials = { email, password, deviceName, platform: currentPlatform() };
    const attempt = creating ? signUp(serverUrl, credentials) : signIn(serverUrl, credentials);
    attempt
      .catch((cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => setBusy(false));
  };

  return (
    <section className="page signin">
      <h1>{creating ? "Create an account" : "Sign in"}</h1>
      <p className="page__note">
        NovelTea has no central service. Sign in to the server you, or someone you trust,
        runs.
      </p>

      <form className="signin__form" onSubmit={onSubmit}>
        {known.length > 0 ? (
          <label className="signin__field">
            <span>Server</span>
            <select
              value={choice}
              onChange={(event) => {
                setChoice(event.target.value);
                const match = known.find((server) => server.url === event.target.value);
                if (match?.lastEmail) setEmail(match.lastEmail);
              }}
            >
              {known.map((server) => (
                <option key={server.url} value={server.url}>
                  {server.url}
                </option>
              ))}
              <option value={ANOTHER}>Another server</option>
            </select>
          </label>
        ) : null}

        {(choice === ANOTHER || known.length === 0) && (
          <label className="signin__field">
            <span>Server address</span>
            <input
              name="server"
              value={typedServer}
              placeholder="write.example.com"
              autoComplete="url"
              inputMode="url"
              onChange={(event) => setTypedServer(event.target.value)}
            />
          </label>
        )}

        {normalised !== null && isInsecure(normalised) && (
          <p className="signin__warning" role="alert">
            <strong>{normalised}</strong> is not encrypted. Your password and your writing
            would cross the network in the clear. Use https unless this server is on your
            own machine.
          </p>
        )}

        <label className="signin__field">
          <span>Email</span>
          <input
            name="email"
            type="email"
            value={email}
            autoComplete="username"
            required
            onChange={(event) => setEmail(event.target.value)}
          />
        </label>

        <label className="signin__field">
          <span>Password</span>
          <input
            name="password"
            type="password"
            value={password}
            autoComplete={creating ? "new-password" : "current-password"}
            required
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>

        <label className="signin__field">
          <span>Name this device</span>
          <input
            name="deviceName"
            value={deviceName}
            onChange={(event) => setDeviceName(event.target.value)}
          />
          <span className="signin__hint">
            Shown in your device list, so you can revoke this one later.
          </span>
        </label>

        {error !== null && (
          <p className="signin__error" role="alert">
            {error}
          </p>
        )}

        <div className="signin__actions">
          <button type="submit" className="button button--confirm" disabled={busy}>
            {busy ? "Working" : creating ? "Create account" : "Sign in"}
          </button>
          <button
            type="button"
            className="button"
            onClick={() => {
              setCreating((current) => !current);
              setError(null);
            }}
          >
            {creating ? "I already have an account" : "Create an account instead"}
          </button>
        </div>
      </form>
    </section>
  );
}
