import type { SqliteAdapter, SqlValue } from "@noveltea/client-db";
import type { Database } from "@sqlite.org/sqlite-wasm";

/**
 * Adapts sqlite-wasm's oo1 `Database` to the `SqliteAdapter` interface that
 * `@noveltea/client-db` migrates and queries through.
 *
 * The interface is deliberately tiny so the same migration runner drives
 * node:sqlite in tests, sqlite-wasm in the browser, and GRDB on iOS. Keeping the
 * browser-specific part to this file is what makes the migration code testable
 * against real SQLite in Node rather than only in a headless browser.
 */
export function fromSqliteWasm(db: Database): SqliteAdapter {
  return {
    exec(sql: string): void {
      db.exec(sql);
    },

    run(sql: string, params: readonly SqlValue[] = []): void {
      // `bind` is only accepted when there is something to bind; passing an empty
      // array to a statement with no parameters is an error in sqlite-wasm.
      if (params.length === 0) db.exec({ sql });
      else db.exec({ sql, bind: params });
    },

    query<T = Record<string, unknown>>(sql: string, params: readonly SqlValue[] = []): T[] {
      const rows = db.exec({
        sql,
        ...(params.length > 0 ? { bind: params } : {}),
        rowMode: "object",
        returnValue: "resultRows",
      });
      return rows as T[];
    },
  };
}
