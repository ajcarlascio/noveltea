/**
 * Where third-party API keys live.
 *
 * **Not in local storage, not in IndexedDB, not in the SQLite replica.** All three
 * are readable by any script that reaches the page, and the replica is also written
 * to disk in the clear and copied into every backup an author takes. A key stored
 * there is a key that leaks with the first XSS or the first shared laptop.
 *
 * That leaves three honest options, in the order the app should prefer them:
 *
 * 1. **The operator's key, held by the server.** NovelTea is self-hosted, so the
 *    natural place for a shared credential is the instance the author already
 *    trusts. The client never sees it, nothing has to be stored on the device, and
 *    revoking it is one change in one place. This is the recommended arrangement and
 *    the only one that is straightforwardly safe on the web.
 * 2. **The OS keychain, under Tauri.** Keychain on macOS and iOS, DPAPI-backed
 *    credential storage on Windows, the Secret Service on Linux. Reached through the
 *    Rust side, so the key never enters the webview at all — which also lets the
 *    request itself be made from Rust and `connect-src` stay tight.
 * 3. **Memory, for this session only, on the web.** A browser has no secure storage;
 *    anything persistent is readable by script. So a key typed into the web client is
 *    kept in a variable, used, and forgotten when the tab closes. The author is told
 *    that plainly rather than being quietly given weaker storage than they assumed.
 *
 * The interface below is the same in all three cases, so the feature does not care
 * which one it got — but `describe()` exists so the interface can tell the author.
 */

export type KeyStoreKind = "server" | "keychain" | "session";

export interface KeyStore {
  readonly kind: KeyStoreKind;
  /** Null when no key is held. */
  get(name: string): Promise<string | null>;
  set(name: string, value: string): Promise<void>;
  clear(name: string): Promise<void>;
  /** One sentence for the interface, explaining what happens to the key. */
  describe(): string;
}

/**
 * The web fallback: this tab, this session, gone on reload.
 *
 * Deliberately a closure rather than a module-level object, so a test cannot leak a
 * key into the next one and nothing can enumerate what is held.
 */
export function sessionKeyStore(): KeyStore {
  const held = new Map<string, string>();
  return {
    kind: "session",
    get: (name) => Promise.resolve(held.get(name) ?? null),
    set: (name, value) => {
      held.set(name, value);
      return Promise.resolve();
    },
    clear: (name) => {
      held.delete(name);
      return Promise.resolve();
    },
    describe: () =>
      "Kept in memory for this tab only. A browser has no storage that is safe for a key, so you will be asked again next time you open NovelTea. To avoid that, set the key on your server instead.",
  };
}

/**
 * A key the server holds. The client never sees it and never sends one.
 *
 * `get` returns null because there is nothing to return: requests that need the key
 * are made by the server on the client's behalf.
 */
export function serverKeyStore(): KeyStore {
  const unavailable = () =>
    Promise.reject(new Error("This key is configured on the server and cannot be changed here."));
  return {
    kind: "server",
    get: () => Promise.resolve(null),
    set: unavailable,
    clear: unavailable,
    describe: () =>
      "Configured on your NovelTea server. The key never reaches this device, and your administrator can change or revoke it in one place.",
  };
}
