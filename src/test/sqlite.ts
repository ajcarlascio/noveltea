// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { fromNodeSqlite, runMigrations, type SqliteAdapter, type SqlValue } from "@noveltea/client-db";
import type { Reader } from "@/data/projects";
import { COMMANDS, READ_ONLY_COMMANDS, type CommandInput, type CommandName, type CommandResult } from "@/db/commands";
import type { DatabaseClient } from "@/db/client";

/**
 * A real, migrated SQLite database for tests, over `node:sqlite`.
 *
 * The browser runs sqlite-wasm and the tests run node:sqlite, but both go through
 * the same `SqliteAdapter` and the same migrations, so SQL verified here is SQL
 * the browser will accept. Testing the data layer against a stub instead would
 * verify only that the stub agrees with itself.
 */
export interface TestDatabase extends Reader {
  adapter: SqliteAdapter;
  raw: DatabaseSync;
  exec(sql: string): void;
  run(sql: string, params?: readonly SqlValue[]): void;
  /**
   * A DatabaseClient over this database, dispatching through the real commands.
   *
   * Lets code written against the worker be tested against real SQLite with nothing
   * mocked but the worker boundary itself — the commands, the schema and the SQL are
   * all the ones that ship.
   */
  client: DatabaseClient;
  close(): void;
}

export function openTestDatabase(): TestDatabase {
  const raw = new DatabaseSync(":memory:");
  const adapter = fromNodeSqlite(raw);
  runMigrations(adapter);

  const changeListeners = new Set<() => void>();
  const client = {
    query: <T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []) =>
      Promise.resolve(adapter.query<T>(sql, params)),
    command: <K extends CommandName>(name: K, input: CommandInput<K>) => {
      const run = COMMANDS[name] as (db: SqliteAdapter, value: unknown) => CommandResult<K>;
      const result = run(adapter, input);
      if (!READ_ONLY_COMMANDS.has(name)) {
        for (const listener of changeListeners) listener();
      }
      return Promise.resolve(result);
    },
    subscribeToChanges: (listener: () => void) => {
      changeListeners.add(listener);
      return () => changeListeners.delete(listener);
    },
  } as unknown as DatabaseClient;

  return {
    adapter,
    raw,
    client,
    exec: (sql) => adapter.exec(sql),
    run: (sql, params = []) => adapter.run(sql, params),
    // Async to match the worker-backed client, which is what production passes in.
    query: <T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []) =>
      Promise.resolve(adapter.query<T>(sql, params)),
    close: () => raw.close(),
  };
}

/** ISO-8601 UTC, the format every timestamp column in the client schema stores. */
export function isoNow(offsetMs = 0): string {
  return new Date(Date.UTC(2026, 0, 1) + offsetMs).toISOString().replace(/\.\d{3}Z$/, "Z");
}
