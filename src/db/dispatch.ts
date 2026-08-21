import type { SqliteAdapter } from "@noveltea/client-db";
import { COMMANDS } from "./commands";
import {
  toErrorPayload,
  type DbRequest,
  type DbResponse,
  type StorageKind,
  type WorkerOutbound,
} from "./protocol";

export interface OpenResult {
  adapter: SqliteAdapter;
  storage: StorageKind;
  appliedVersions: number[];
  schemaVersion: number;
}

/**
 * The database worker's behaviour, with the worker globals factored out so it can
 * be driven directly by a test.
 *
 * Two things here are worth more than they look:
 *
 * Requests that arrive before the database is open are **queued**, not rejected.
 * The app renders immediately and issues its first reads before migrations can
 * have finished, and failing those would put an error in front of the author on
 * every cold start.
 *
 * If opening **fails**, the queue is drained as failures rather than discarded. A
 * request that is silently dropped leaves a promise pending forever, which in an
 * offline-first client is indistinguishable from a lost write: the author sees
 * "saving…" and nothing ever contradicts it.
 */
export function createDispatcher(post: (message: WorkerOutbound) => void) {
  let adapter: SqliteAdapter | null = null;
  let fatal: unknown = null;
  const queued: DbRequest[] = [];

  function handle(request: DbRequest): void {
    if (fatal !== null) {
      post({ id: request.id, ok: false, error: toErrorPayload(fatal) });
      return;
    }
    if (adapter === null) {
      queued.push(request);
      return;
    }

    let response: DbResponse;
    try {
      response = { id: request.id, ok: true, result: execute(adapter, request) };
    } catch (error) {
      // Contained per request: one failing statement must not take down the
      // dispatcher and with it every request that comes after.
      response = { id: request.id, ok: false, error: toErrorPayload(error) };
    }
    post(response);
  }

  function drain(): void {
    const pending = queued.splice(0, queued.length);
    for (const request of pending) handle(request);
  }

  return {
    handle,

    opened(result: OpenResult): void {
      adapter = result.adapter;
      post({
        kind: "ready",
        storage: result.storage,
        appliedVersions: result.appliedVersions,
        schemaVersion: result.schemaVersion,
      });
      drain();
    },

    failed(error: unknown): void {
      fatal = error;
      post({ kind: "fatal", error: toErrorPayload(error) });
      drain();
    },
  };
}

function execute(db: SqliteAdapter, request: DbRequest): unknown {
  switch (request.kind) {
    case "query":
      return db.query(request.sql, request.params);
    case "run":
      db.run(request.sql, request.params);
      return undefined;
    case "command":
      return inTransaction(db, () => {
        const command = COMMANDS[request.name];
        if (!command) {
          // Reachable only from a message this app did not send, or a version skew
          // between a cached bundle and a newer worker.
          throw new Error(`Unknown database command: ${String(request.name)}`);
        }
        return command(db, request.input as never);
      });
    case "transaction":
      return inTransaction(db, () => {
        for (const statement of request.statements) db.run(statement.sql, statement.params);
        return undefined;
      });
  }
}

/** All-or-nothing. SQLite DDL and DML are both transactional, so a failure leaves nothing. */
function inTransaction<T>(db: SqliteAdapter, body: () => T): T {
  db.exec("BEGIN;");
  try {
    const result = body();
    db.exec("COMMIT;");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK;");
    } catch {
      // The transaction is already gone. Report the cause, not the cleanup — the
      // original error is the one that explains what went wrong.
    }
    throw error;
  }
}
