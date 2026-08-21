/**
 * The message contract between the app and the database worker.
 *
 * SQLite runs in a worker because OPFS synchronous access handles are only
 * available off the main thread, and because a long query must never block
 * rendering. Everything the app can ask of the database goes through here.
 */
import type { SqlValue } from "@noveltea/client-db";

export type DbRequest =
  | { id: number; kind: "query"; sql: string; params: readonly SqlValue[] }
  | { id: number; kind: "run"; sql: string; params: readonly SqlValue[] }
  /** A list of statements applied in one transaction, all or nothing. */
  | {
      id: number;
      kind: "transaction";
      statements: readonly { sql: string; params: readonly SqlValue[] }[];
    };

/**
 * Errors are flattened rather than passed as `Error`.
 *
 * `postMessage` uses structured clone, which carries an Error's `message` and
 * `name` but drops any subclass and any property the subclass added — so a
 * SQLite constraint violation would arrive as a bare Error and the code deciding
 * whether to retry could not tell it apart from a bug. Flattening makes what
 * survives explicit instead of incidental.
 */
export interface DbErrorPayload {
  message: string;
  name: string;
}

export type DbResponse =
  | { id: number; ok: true; rows: Record<string, unknown>[] }
  | { id: number; ok: false; error: DbErrorPayload };

/** Sent once, unprompted, when the worker has opened the database and migrated it. */
export type DbLifecycle =
  | { kind: "ready"; storage: StorageKind; appliedVersions: number[]; schemaVersion: number }
  | { kind: "fatal"; error: DbErrorPayload };

/**
 * Which backing store the worker ended up with. Reported rather than assumed:
 * "your work is not being saved" is the single most important thing this layer
 * can tell an author, and it must never be inferred from a silent fallback.
 */
export type StorageKind = "opfs" | "memory";

export type WorkerOutbound = DbResponse | DbLifecycle;

export function isLifecycle(message: WorkerOutbound): message is DbLifecycle {
  return !("id" in message);
}

export function toErrorPayload(error: unknown): DbErrorPayload {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error), name: "Error" };
}
