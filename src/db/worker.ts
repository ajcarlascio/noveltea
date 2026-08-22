/// <reference lib="webworker" />
import { runMigrations, targetVersion } from "@noveltea/client-db";
import { fromSqliteWasm } from "./adapter";
import { createDispatcher } from "./dispatch";
import { exportDatabase, openDatabase } from "./open";
import { isOpen, type WorkerInbound } from "./protocol";

/**
 * Owns the SQLite connection; nothing else in the app touches it. The behaviour
 * lives in `dispatch.ts` so it can be tested without a worker — this file is only
 * the wiring to the worker globals and to sqlite-wasm.
 *
 * Opening waits for the main thread's `open` message. Under a desktop host the
 * database file is on the host filesystem and only the main thread can reach it, so
 * the bytes are handed in rather than fetched. Requests arriving first are queued by
 * the dispatcher, so nothing is lost by waiting.
 */
let flush: () => void = () => undefined;

const dispatcher = createDispatcher(
  (message) => self.postMessage(message),
  () => flush(),
);

self.addEventListener("message", (event: MessageEvent<WorkerInbound>) => {
  const message = event.data;
  if (isOpen(message)) {
    void start(message.initial, message.hosted);
    return;
  }
  dispatcher.handle(message);
});

async function start(initial: ArrayBuffer | null, hosted: boolean): Promise<void> {
  try {
    const { db, storage, sqlite3 } = await openDatabase(initial, hosted);
    const adapter = fromSqliteWasm(db);
    // runMigrations applies the connection PRAGMAs itself, foreign_keys among them.
    // That setting is per-connection, not per-database: skipping it on any one
    // connection silently disables every ON DELETE CASCADE in the schema.
    const appliedVersions = runMigrations(adapter);

    if (sqlite3 !== undefined) {
      flush = () => {
        const bytes = exportDatabase(sqlite3, db);
        // Transferred, not copied: the manuscript can be tens of megabytes and this
        // runs after every write. The buffer is dead here the moment it is sent.
        const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        self.postMessage({ kind: "persist", bytes: buffer }, [buffer]);
      };
      // The migrations just ran and may have changed the schema; the host has not
      // seen that yet, and a crash before the first edit would replay them forever.
      flush();
    }

    dispatcher.opened({ adapter, storage, appliedVersions, schemaVersion: targetVersion() });
  } catch (error) {
    dispatcher.failed(error);
  }
}
