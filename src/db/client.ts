import type { SqlValue } from "@noveltea/client-db";
import {
  isLifecycle,
  type DbErrorPayload,
  type DbRequest,
  type StorageKind,
  type WorkerOutbound,
} from "./protocol";

/** The part of `Worker` this client uses, so tests can drive it with a double. */
export interface WorkerLike {
  postMessage(message: DbRequest): void;
  addEventListener(type: "message", listener: (event: MessageEvent<WorkerOutbound>) => void): void;
  addEventListener(type: "error", listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

export type DbStatus =
  | { state: "opening" }
  | {
      state: "ready";
      storage: StorageKind;
      schemaVersion: number;
      /** Migrations applied during *this* open. Empty means the replica was already current. */
      appliedVersions: number[];
    }
  | { state: "failed"; error: DbErrorPayload };

/** An error that crossed the worker boundary, with the SQLite name preserved. */
export class DatabaseError extends Error {
  constructor(payload: DbErrorPayload) {
    super(payload.message);
    this.name = payload.name;
  }
}

interface Deferred {
  resolve: (rows: Record<string, unknown>[]) => void;
  reject: (error: Error) => void;
}

/**
 * Typed request/response over the database worker.
 *
 * Every in-flight request is tracked so that a worker which dies — an OPFS
 * failure, an out-of-memory kill, a browser reclaiming a background tab — rejects
 * them all rather than leaving promises pending. In an offline-first client a
 * promise that never settles is indistinguishable from a lost write: the author
 * sees "saving…" and nothing ever contradicts it.
 */
export class DatabaseClient {
  #worker: WorkerLike;
  #nextId = 1;
  #inFlight = new Map<number, Deferred>();
  #status: DbStatus = { state: "opening" };
  #listeners = new Set<(status: DbStatus) => void>();
  #closed = false;

  constructor(worker: WorkerLike) {
    this.#worker = worker;
    worker.addEventListener("message", (event) => this.#receive(event.data));
    worker.addEventListener("error", (event) =>
      this.#fail({
        name: "WorkerError",
        message: event.message || "The database worker stopped unexpectedly.",
      }),
    );
  }

  get status(): DbStatus {
    return this.#status;
  }

  /** Returns an unsubscribe function. */
  subscribe(listener: (status: DbStatus) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.#send({ id: this.#nextId++, kind: "query", sql, params }) as Promise<T[]>;
  }

  async run(sql: string, params: readonly SqlValue[] = []): Promise<void> {
    await this.#send({ id: this.#nextId++, kind: "run", sql, params });
  }

  /** All statements commit together or none do. */
  async transaction(
    statements: readonly { sql: string; params?: readonly SqlValue[] }[],
  ): Promise<void> {
    await this.#send({
      id: this.#nextId++,
      kind: "transaction",
      statements: statements.map((s) => ({ sql: s.sql, params: s.params ?? [] })),
    });
  }

  close(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#rejectAll(new DatabaseError({ name: "DatabaseClosed", message: "Database closed." }));
    this.#worker.terminate();
  }

  #send(request: DbRequest): Promise<Record<string, unknown>[]> {
    if (this.#closed) {
      return Promise.reject(
        new DatabaseError({ name: "DatabaseClosed", message: "Database closed." }),
      );
    }
    return new Promise((resolve, reject) => {
      this.#inFlight.set(request.id, { resolve, reject });
      this.#worker.postMessage(request);
    });
  }

  #receive(message: WorkerOutbound): void {
    if (isLifecycle(message)) {
      if (message.kind === "ready") {
        this.#setStatus({
          state: "ready",
          storage: message.storage,
          schemaVersion: message.schemaVersion,
          appliedVersions: message.appliedVersions,
        });
      } else {
        this.#fail(message.error);
      }
      return;
    }

    const pending = this.#inFlight.get(message.id);
    // An unknown id means a response arrived twice or for a request this client
    // never made. Dropping it is right; throwing would take down the listener and
    // with it every future response.
    if (!pending) return;
    this.#inFlight.delete(message.id);

    if (message.ok) pending.resolve(message.rows);
    else pending.reject(new DatabaseError(message.error));
  }

  #fail(error: DbErrorPayload): void {
    this.#setStatus({ state: "failed", error });
    this.#rejectAll(new DatabaseError(error));
  }

  #rejectAll(error: Error): void {
    const pending = [...this.#inFlight.values()];
    this.#inFlight.clear();
    for (const deferred of pending) deferred.reject(error);
  }

  #setStatus(status: DbStatus): void {
    this.#status = status;
    for (const listener of this.#listeners) listener(status);
  }
}

/** Spawns the real worker. Kept separate so tests never need one. */
export function createDatabaseClient(): DatabaseClient {
  return new DatabaseClient(
    new Worker(new URL("./worker.ts", import.meta.url), {
      type: "module",
      name: "noveltea-db",
    }),
  );
}
