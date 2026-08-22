/**
 * The desktop host, when there is one.
 *
 * WebKitGTK — the engine Tauri uses on Linux — has no `navigator.storage` at all, so
 * no OPFS, so the replica would open in memory and lose every word on restart. That is
 * measured, not assumed: see `tooling/webview-probe`.
 *
 * So under Tauri the database file lives on the host filesystem, and the webview holds
 * it in memory between loads. The command layer is untouched by this: it stays
 * synchronous, next to an in-memory SQLite, exactly as it is on the web. The only
 * difference is where the bytes come from at startup and go to afterwards.
 *
 * All of this runs on the **main thread**. Tauri's bridge hangs off `window`, which a
 * worker does not have, so the worker asks for a flush and the main thread performs it.
 */

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const found = (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  return found !== null && typeof found === "object" ? found : null;
}

/** True when running inside the desktop shell rather than a browser tab. */
export function isHosted(): boolean {
  return typeof internals()?.invoke === "function";
}

async function invoke(command: string, args?: Record<string, unknown>): Promise<unknown> {
  const bridge = internals();
  if (typeof bridge?.invoke !== "function") throw new Error("No desktop host to call.");
  return bridge.invoke(command, args);
}

/**
 * The database as the host last stored it, or null the first time.
 *
 * A read failure is reported as null rather than thrown. Refusing to start because a
 * file could not be read would leave an author with no app at all; starting empty
 * leaves them with one, and the sync engine will pull their work back from the server.
 * Which of those is worse is not a close call.
 */
export async function loadDatabase(): Promise<Uint8Array | null> {
  try {
    const bytes = await invoke("db_load");
    if (bytes === null || bytes === undefined) return null;
    if (bytes instanceof Uint8Array) return bytes;
    if (Array.isArray(bytes)) return Uint8Array.from(bytes as number[]);
    if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
    return null;
  } catch {
    return null;
  }
}

/** Hands the whole database back to the host, which writes it atomically. */
export async function saveDatabase(bytes: Uint8Array): Promise<void> {
  // Sent as a plain array: Tauri's IPC serialises through JSON, and a Uint8Array
  // arrives on the Rust side as an object with numeric keys rather than a byte slice.
  await invoke("db_save", { bytes: Array.from(bytes) });
}
