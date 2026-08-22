// @vitest-environment node
import sqlite3InitModule, { type Sqlite3Static } from "@sqlite.org/sqlite-wasm";
import { beforeAll, describe, expect, it } from "vitest";
import { exportDatabase, restore } from "@/db/open";

/**
 * The desktop host keeps the database as a file and the webview holds it in memory, so
 * everything depends on these two functions being exact inverses — and on the restored
 * database still being writable afterwards.
 *
 * sqlite-wasm runs under Node, so this exercises the real wasm build rather than a
 * stand-in. The rest of the suite uses node:sqlite, which has no deserialize at all.
 */

let sqlite3: Sqlite3Static;

beforeAll(async () => {
  sqlite3 = await sqlite3InitModule();
});

const fresh = () => new sqlite3.oo1.DB(":memory:");

function seed(db: ReturnType<typeof fresh>, rows: number, text = "prose"): void {
  db.exec("CREATE TABLE chapter (id INTEGER PRIMARY KEY, body TEXT);");
  for (let i = 0; i < rows; i += 1) {
    db.exec({ sql: "INSERT INTO chapter (body) VALUES (?);", bind: [`${text} ${String(i)}`] });
  }
}

const count = (db: ReturnType<typeof fresh>) =>
  db.exec({ sql: "SELECT count(*) AS n FROM chapter;", rowMode: "object", returnValue: "resultRows" })[0]?.n;

describe("export and restore", () => {
  it("brings back exactly what was stored", () => {
    const original = fresh();
    seed(original, 25);
    const bytes = exportDatabase(sqlite3, original);
    original.close();

    const reopened = fresh();
    restore(sqlite3, reopened, bytes);
    expect(count(reopened)).toBe(25);
    reopened.close();
  });

  it("KEEPS ACCEPTING WRITES PAST THE SIZE IT WAS RESTORED AT", () => {
    // Without SQLITE_DESERIALIZE_RESIZEABLE, SQLite refuses to grow the database
    // beyond the buffer it was handed. Everything works until the author has written
    // enough to need another page, and then writing fails — which is the worst shape
    // a bug can have in this app, because it looks like nothing is wrong for a while.
    const original = fresh();
    seed(original, 5);
    const bytes = exportDatabase(sqlite3, original);
    original.close();

    const reopened = fresh();
    restore(sqlite3, reopened, bytes);

    // Far more than the restored file could hold in place.
    for (let i = 0; i < 4000; i += 1) {
      reopened.exec({
        sql: "INSERT INTO chapter (body) VALUES (?);",
        bind: ["a sentence long enough to force the database to grow several pages"],
      });
    }
    expect(count(reopened)).toBe(4005);

    // And it must still round-trip after growing.
    const grown = exportDatabase(sqlite3, reopened);
    expect(grown.byteLength).toBeGreaterThan(bytes.byteLength);
    reopened.close();

    const third = fresh();
    restore(sqlite3, third, grown);
    expect(count(third)).toBe(4005);
    third.close();
  });

  it("survives a round trip through a plain array, as the host bridge does", () => {
    // Tauri's IPC is JSON, so the bytes become numbers and come back again.
    const original = fresh();
    seed(original, 10);
    const viaJson = Uint8Array.from(Array.from(exportDatabase(sqlite3, original)));
    original.close();

    const reopened = fresh();
    restore(sqlite3, reopened, viaJson);
    expect(count(reopened)).toBe(10);
    reopened.close();
  });
});
