/**
 * The message contract between the app and the database worker.
 *
 * SQLite runs in a worker because OPFS synchronous access handles are only
 * available off the main thread, and because a long query must never block
 * rendering. Everything the app can ask of the database goes through here.
 */
import type { SqlValue } from "@noveltea/client-db";
import type { CommandInput, CommandName } from "./commands";

export type DbRequest =
  | { id: number; kind: "query"; sql: string; params: readonly SqlValue[] }
  | { id: number; kind: "run"; sql: string; params: readonly SqlValue[] }
  /** A list of statements applied in one transaction, all or nothing. */
  | {
      id: number;
      kind: "transaction";
      statements: readonly { sql: string; params: readonly SqlValue[] }[];
    }
  /**
   * A named write, run in the worker in one transaction.
   *
   * Writes that have to update rows *and* queue a pending change cannot be
   * assembled from `run` calls on this side: `enqueueChange` is synchronous by
   * design, and re-implementing its merge rules against an async client would be a
   * second copy of them, which is precisely how they drift. So the operation is
   * named here and executed there, next to the database, atomically.
   */
  | { id: number; kind: "command"; name: CommandName; input: CommandInput<CommandName> };

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
  /** Rows for a query; whatever the command returned for a command; undefined otherwise. */
  | { id: number; ok: true; result: unknown }
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
export type StorageKind = "opfs" | "memory" | "host";

/**
 * Sent once by the main thread to start the worker off.
 *
 * The worker cannot fetch the database itself under a desktop host: Tauri's bridge
 * hangs off `window`, and a worker has none. So the main thread reads the bytes and
 * hands them over, and requests queue in the dispatcher until they arrive.
 */
export interface DbOpen {
  kind: "open";
  /** The stored database, or null to open the way a browser tab would. */
  initial: ArrayBuffer | null;
  /** True when a desktop host is present and will accept flushes. */
  hosted: boolean;
}

export type WorkerInbound = DbRequest | DbOpen;

export function isOpen(message: WorkerInbound): message is DbOpen {
  return "kind" in message && message.kind === "open" && !("id" in message);
}

/**
 * The worker asking the main thread to persist the whole database.
 *
 * The whole file, because SQLite has no smaller unit to hand out from an in-memory
 * database — and because a partial write of a database is worse than a slow one.
 */
export interface DbPersist {
  kind: "persist";
  bytes: ArrayBuffer;
}

export type WorkerOutbound = DbResponse | DbLifecycle | DbPersist;

export function isLifecycle(message: WorkerOutbound): message is DbLifecycle {
  return !("id" in message) && (message.kind === "ready" || message.kind === "fatal");
}

export function isPersist(message: WorkerOutbound): message is DbPersist {
  return !("id" in message) && message.kind === "persist";
}

export function toErrorPayload(error: unknown): DbErrorPayload {
  if (error instanceof Error) {
    return { message: error.message, name: error.name };
  }
  return { message: String(error), name: "Error" };
}
