/// <reference lib="webworker" />
import { runMigrations, targetVersion } from "@noveltea/client-db";
import { fromSqliteWasm } from "./adapter";
import { createDispatcher } from "./dispatch";
import { openDatabase } from "./open";
import type { DbRequest } from "./protocol";

/**
 * Owns the SQLite connection; nothing else in the app touches it. The behaviour
 * lives in `dispatch.ts` so it can be tested without a worker — this file is only
 * the wiring to the worker globals and to sqlite-wasm.
 */
const dispatcher = createDispatcher((message) => self.postMessage(message));

self.addEventListener("message", (event: MessageEvent<DbRequest>) =>
  dispatcher.handle(event.data),
);

void (async () => {
  try {
    const { db, storage } = await openDatabase();
    const adapter = fromSqliteWasm(db);
    // runMigrations applies the connection PRAGMAs itself, foreign_keys among them.
    // That setting is per-connection, not per-database: skipping it on any one
    // connection silently disables every ON DELETE CASCADE in the schema.
    const appliedVersions = runMigrations(adapter);
    dispatcher.opened({ adapter, storage, appliedVersions, schemaVersion: targetVersion() });
  } catch (error) {
    dispatcher.failed(error);
  }
})();
