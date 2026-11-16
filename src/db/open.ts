import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { REPLICA_LOCK, type StorageKind } from "./protocol";

/** Where the replica lives inside OPFS. One database per origin. */
const VFS_NAME = "noveltea";
const VFS_DIRECTORY = ".noveltea";
const DATABASE_FILE = "/noveltea.sqlite3";

const REPLICA_LOCK_WAIT_MS = 3000;

export interface OpenedDatabase {
  db: Database;
  storage: StorageKind;
  /** Present only for a host-backed database, which is the thing that can be exported. */
  sqlite3?: Sqlite3Static;
}

/**
 * Opens the local replica.
 *
 * Uses the **SAH Pool** OPFS VFS rather than the plain `opfs` one. The plain VFS
 * needs `SharedArrayBuffer`, which needs COOP/COEP response headers, which a
 * self-hosted operator behind an arbitrary reverse proxy cannot be assumed to
 * have set — and getting that wrong would take persistence away from the author
 * with no obvious cause. The SAH Pool VFS needs no cross-origin isolation and is
 * faster besides.
 *
 * If OPFS is unavailable the database is opened in memory so the app still runs,
 * but the caller is told which it got. That distinction must reach the author:
 * an in-memory replica loses every word on reload, and a writing app that fails
 * that way quietly is worse than one that refuses to start.
 */
/**
 * Takes the replica's Web Lock and keeps it for as long as this worker lives.
 *
 * The SAH pool's file handles are exclusive, and a page being reloaded can still hold
 * them for a moment after its replacement has started. Losing that race used to mean
 * opening in memory — a whole session written into a database that was never going to
 * be kept. Queueing behind the lock lets the old worker finish dying first.
 *
 * A genuine second tab never gets the lock, so the wait is bounded: after it, the open
 * is attempted anyway, fails, and the interface says why. The queued request is aborted
 * then, so this worker never takes the lock behind the blocked page's back.
 *
 * Resolves to whether the lock was obtained; without Web Locks there is nothing to lose.
 */
async function waitForReplicaLock(ms = REPLICA_LOCK_WAIT_MS): Promise<boolean> {
  const locks = (globalThis.navigator as Navigator | undefined)?.locks;
  if (locks === undefined) return true;
  const abort = new AbortController();
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      abort.abort();
      resolve(false);
    }, ms);
    locks
      .request(REPLICA_LOCK, { signal: abort.signal }, () => {
        clearTimeout(timer);
        resolve(true);
        return new Promise<never>(() => undefined);
      })
      .catch(() => undefined); // The abort above; nothing else to report.
  });
}

export async function openDatabase(initial: ArrayBuffer | null = null,
                                   hosted = false): Promise<OpenedDatabase> {
  const sqlite3: Sqlite3Static = await sqlite3InitModule();

  // A desktop host keeps the file; the webview only ever holds it in memory. That is
  // not a downgrade — it is the only durable option on WebKitGTK, which has no
  // navigator.storage at all (see tooling/webview-probe). "memory" would be a lie
  // here, because the bytes do outlive the window; they just live on the host.
  if (hosted) {
    const db = new sqlite3.oo1.DB(":memory:");
    if (initial !== null && initial.byteLength > 0) {
      restore(sqlite3, db, new Uint8Array(initial));
    }
    return { db, storage: "host", sqlite3 };
  }

  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
    const locked = await waitForReplicaLock();
    try {
      const pool = await sqlite3.installOpfsSAHPoolVfs({
        name: VFS_NAME,
        directory: VFS_DIRECTORY,
      });
      return { db: new pool.OpfsSAHPoolDb(DATABASE_FILE), storage: "opfs" };
    } catch (error) {
      // Private browsing, a storage quota refusal, or another tab holding the
      // pool. Fall through rather than leaving the app with nothing at all.
      console.warn("OPFS unavailable; the local replica will not survive a reload.", error);
      // Without the lock the cause is another tab, not the browser: tell the caller, because
      // writing into this memory database would be losing work the other tab never sees.
      if (!locked) return { db: new sqlite3.oo1.DB(":memory:"), storage: "contended" };
    }
  }

  return { db: new sqlite3.oo1.DB(":memory:"), storage: "memory" };
}

/**
 * Loads stored bytes into an open in-memory database.
 *
 * RESIZEABLE matters: without it SQLite refuses to grow the database past the buffer
 * it was handed, so the first write past the restored size fails — which would look
 * like the app working perfectly until an author had written enough to matter.
 *
 * FREEONCLOSE hands the allocation to SQLite, so closing the database frees it rather
 * than leaking a copy of the whole manuscript per open.
 */
export function restore(sqlite3: Sqlite3Static, db: Database, bytes: Uint8Array): void {
  const pointer = sqlite3.wasm.allocFromTypedArray(bytes);
  const rc = sqlite3.capi.sqlite3_deserialize(
    db.pointer!,
    "main",
    pointer,
    bytes.length,
    bytes.length,
    sqlite3.capi.SQLITE_DESERIALIZE_FREEONCLOSE | sqlite3.capi.SQLITE_DESERIALIZE_RESIZEABLE,
  );
  db.checkRc(rc);
}

/** The whole database as bytes, for the host to write. */
export function exportDatabase(sqlite3: Sqlite3Static, db: Database): Uint8Array {
  return sqlite3.capi.sqlite3_js_db_export(db.pointer!);
}
