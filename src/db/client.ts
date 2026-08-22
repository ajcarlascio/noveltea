import type { SqlValue } from "@noveltea/client-db";
import { READ_ONLY_COMMANDS } from "./commands";
import type { CommandInput, CommandName, CommandResult } from "./commands";
import { isHosted, loadDatabase, saveDatabase } from "./host";
import {
  isLifecycle,
  isPersist,
  type DbErrorPayload,
  type DbRequest,
  type StorageKind,
  type WorkerInbound,
  type WorkerOutbound,
} from "./protocol";

/** The part of `Worker` this client uses, so tests can drive it with a double. */
export interface WorkerLike {
  postMessage(message: WorkerInbound): void;
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
  resolve: (result: unknown) => void;
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
  #changeListeners = new Set<() => void>();
  #closed = false;
  #pendingBytes: ArrayBuffer | null = null;
  #flushing = false;

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

  /**
   * Notified after any successful command — that is, after anything that wrote.
   *
   * Without this every screen has to be told individually that something changed, and
   * the ones nobody remembered go stale: a pending-changes count that only updates on
   * sync, a binder that does not show what sync just pulled. Reads are cheap and
   * local, so re-running them on a write is the simpler and more reliable answer than
   * threading invalidation through by hand.
   */
  subscribeToChanges(listener: () => void): () => void {
    this.#changeListeners.add(listener);
    return () => this.#changeListeners.delete(listener);
  }

  query<T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): Promise<T[]> {
    return this.#send({ id: this.#nextId++, kind: "query", sql, params }) as Promise<T[]>;
  }

  /**
   * Runs a named write in the worker, in one transaction.
   *
   * The command's implementation is never imported here — only its types — so the
   * worker's code does not end up in the main bundle.
   */
  async command<K extends CommandName>(name: K, input: CommandInput<K>): Promise<CommandResult<K>> {
    const result = (await this.#send({
      id: this.#nextId++,
      kind: "command",
      name,
      input,
    })) as CommandResult<K>;

    // Only after it succeeded, and only for commands that write: announcing a failed
    // write would send every screen to re-read state that did not change, and
    // announcing a read would wake whatever just performed it.
    if (!READ_ONLY_COMMANDS.has(name)) {
      for (const listener of this.#changeListeners) listener();
    }
    return result;
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

  #send(request: DbRequest): Promise<unknown> {
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
    if (isPersist(message)) {
      this.#persist(message.bytes);
      return;
    }
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

    if (message.ok) pending.resolve(message.result);
    else pending.reject(new DatabaseError(message.error));
  }

  /**
   * Writes the database back to the desktop host.
   *
   * Coalesced rather than queued: while one flush is in the air, a later one only
   * marks the database dirty, and the next flush takes the newest bytes. Queueing
   * every flush would mean a burst of edits writing the whole file once per edit,
   * each one already stale by the time it landed.
   *
   * A failure is not surfaced. The words are in the worker's memory and in the
   * outbox, the next write flushes again, and interrupting someone mid-sentence to
   * report a disk hiccup they cannot act on is not worth the interruption.
   */
  #persist(bytes: ArrayBuffer): void {
    this.#pendingBytes = bytes;
    if (this.#flushing) return;
    this.#flushing = true;
    void (async () => {
      try {
        while (this.#pendingBytes !== null) {
          const next = this.#pendingBytes;
          this.#pendingBytes = null;
          await saveDatabase(new Uint8Array(next));
        }
      } catch {
        // Left for the next write to retry.
      } finally {
        this.#flushing = false;
      }
    })();
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
  const worker = new Worker(new URL("./worker.ts", import.meta.url), {
    type: "module",
    name: "noveltea-db",
  });
  const client = new DatabaseClient(worker);

  // The worker waits for this before opening anything. Under a desktop host the file
  // is on the host filesystem and only this thread can reach it, so the bytes are read
  // here and handed over; in a browser tab there is nothing to hand and the worker
  // takes its usual OPFS path.
  void (async () => {
    const hosted = isHosted();
    const initial = hosted ? await loadDatabase() : null;
    const buffer =
      initial === null
        ? null
        : initial.buffer.slice(initial.byteOffset, initial.byteOffset + initial.byteLength);
    worker.postMessage({ kind: "open", initial: buffer, hosted });
  })();

  return client;
}
