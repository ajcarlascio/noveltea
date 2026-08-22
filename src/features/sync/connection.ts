/**
 * Whether this connection costs money to use.
 *
 * The Network Information API is the only thing a browser offers, and it is not
 * offered everywhere: Chromium exposes `connection`, Safari and Firefox do not, and
 * `type` — the one field that actually names the bearer — is largely Android-only.
 * So this reports three states rather than a boolean, and the third is honest.
 *
 * **Unknown never blocks a sync.** Withholding an author's work from their server
 * because a browser would not say what it is connected to is a guess made with
 * somebody else's manuscript. The warning is what handles the uncertain case: it says
 * what it does not know, rather than acting on it.
 *
 * Under Tauri this can be answered properly by the host. That is the point of keeping
 * the question behind one function.
 */

export type Metering = "metered" | "unmetered" | "unknown";

/**
 * The slice of NetworkInformation this needs.
 *
 * Declared rather than imported: `NetworkInformation` is not in the DOM lib, and the
 * shapes differ between engines, so what is written down here is exactly what is read.
 */
interface NetworkInformationLike {
  type?: string;
  effectiveType?: string;
  saveData?: boolean;
  addEventListener?: (type: string, listener: () => void) => void;
  removeEventListener?: (type: string, listener: () => void) => void;
}

interface NavigatorWithConnection {
  connection?: NetworkInformationLike;
}

export function connectionOf(nav: unknown): NetworkInformationLike | null {
  if (nav === null || typeof nav !== "object") return null;
  const connection = (nav as NavigatorWithConnection).connection;
  return connection !== null && typeof connection === "object" ? connection : null;
}

/** Bearers that bill by the byte. `wimax` is included because it is billed like cellular. */
const METERED_TYPES = new Set(["cellular", "wimax"]);
const UNMETERED_TYPES = new Set(["wifi", "ethernet", "bluetooth", "none", "other"]);

/**
 * Reads the metering state of the current connection.
 *
 * `saveData` is treated as metered even when the bearer is unknown. It is the author
 * telling the whole platform they are counting bytes, and ignoring it because the
 * `type` field is missing would be reading past the clearest signal available.
 */
export function meteringOf(nav: unknown): Metering {
  const connection = connectionOf(nav);
  if (connection === null) return "unknown";

  if (connection.saveData === true) return "metered";

  const type = typeof connection.type === "string" ? connection.type : null;
  if (type !== null) {
    if (METERED_TYPES.has(type)) return "metered";
    if (UNMETERED_TYPES.has(type)) return "unmetered";
    // "unknown" is a value this API actually returns, and it means what it says.
    return "unknown";
  }

  // No `type` at all — Chromium desktop. effectiveType describes speed, not cost: a
  // slow connection is not a charged one, and a fast one can still be tethering. It
  // is deliberately not consulted.
  return "unknown";
}

/**
 * Notifies when the connection changes.
 *
 * Returns a no-op unsubscribe where the API is missing, so callers need no branch of
 * their own.
 */
export function subscribeToConnection(nav: unknown, listener: () => void): () => void {
  const connection = connectionOf(nav);
  if (connection?.addEventListener === undefined) return () => {};
  try {
    connection.addEventListener("change", listener);
  } catch {
    return () => {};
  }
  return () => {
    try {
      connection.removeEventListener?.("change", listener);
    } catch {
      // Nothing to undo.
    }
  };
}

/**
 * Whether an automatic sync may run.
 *
 * Only three inputs, and the honest case is the one worth stating: with the setting on
 * and the connection unknown, the sync runs. The alternative is an author whose work
 * silently stops reaching their server on every browser that does not implement the
 * API — which is most of them.
 */
export function mayAutoSync(wifiOnly: boolean, metering: Metering): boolean {
  if (!wifiOnly) return true;
  return metering !== "metered";
}
