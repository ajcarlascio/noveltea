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
 * The database as the host last stored it. `null` means there is genuinely no file yet.
 *
 * **A failed read throws, and that distinction is the whole point of this function.**
 * The host already separates the two cases — `read_database` answers `Ok(None)` only for
 * `NotFound` and errors for every other I/O failure — and collapsing them here would
 * undo it at the one place it matters.
 *
 * What collapsing them costs: `null` opens an empty database, and the worker flushes
 * immediately after migrating, which hands the host an empty file to write atomically
 * over the author's book. An empty database is a valid SQLite file, so the magic-number
 * guard passes and nothing downstream notices. One transient read failure — an antivirus
 * or backup process holding the file open on Windows, a permissions change, a disk going
 * read-only — and the manuscript is gone before the author has touched a key.
 *
 * The comment that used to sit here argued the opposite, on the grounds that the sync
 * engine would pull the work back from the server. That is wrong twice: this app is
 * built to be used with no server at all, and an author who has one may not have synced
 * since yesterday.
 */
export async function loadDatabase(): Promise<Uint8Array | null> {
  const bytes = await invokeHost("db_load");
  if (bytes === null || bytes === undefined) return null;
  if (bytes instanceof Uint8Array) return bytes;
  if (Array.isArray(bytes)) return Uint8Array.from(bytes as number[]);
  if (bytes instanceof ArrayBuffer) return new Uint8Array(bytes);
  // Not a first run either. Something is wrong with the bridge, and guessing "empty"
  // here would write that guess over the file.
  throw new Error("The desktop host returned something that is not a database.");
}

/** Hands the whole database back to the host, which writes it atomically. */
export async function saveDatabase(bytes: Uint8Array): Promise<void> {
  // Sent as a plain array: Tauri's IPC serialises through JSON, and a Uint8Array
  // arrives on the Rust side as an object with numeric keys rather than a byte slice.
  await invokeHost("db_save", { bytes: Array.from(bytes) });
}
