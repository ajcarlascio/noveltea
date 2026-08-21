import sqlite3InitModule, { type Database, type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import type { StorageKind } from "./protocol";

/** Where the replica lives inside OPFS. One database per origin. */
const VFS_NAME = "noveltea";
const VFS_DIRECTORY = ".noveltea";
const DATABASE_FILE = "/noveltea.sqlite3";

export interface OpenedDatabase {
  db: Database;
  storage: StorageKind;
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
export async function openDatabase(): Promise<OpenedDatabase> {
  const sqlite3: Sqlite3Static = await sqlite3InitModule();

  if (typeof sqlite3.installOpfsSAHPoolVfs === "function") {
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
    }
  }

  return { db: new sqlite3.oo1.DB(":memory:"), storage: "memory" };
}
