/**
 * The database, as the desktop host stores it.
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

import { invokeHost, isHosted } from "@/platform/host";

// Re-exported because most of this codebase asks "is there a host?" in order to decide
// where the database lives, and this is the module it already imports to find out.
export { isHosted };

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
    const bytes = await invokeHost("db_load");
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
  await invokeHost("db_save", { bytes: Array.from(bytes) });
}
