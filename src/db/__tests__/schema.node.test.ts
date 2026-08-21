// @vitest-environment node
import { DatabaseSync } from "node:sqlite";
import { MIGRATIONS, appliedVersions, fromNodeSqlite, runMigrations, targetVersion } from "@noveltea/client-db";
import { afterEach, describe, expect, it } from "vitest";
import { isoNow, openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * The schema comes from the server repo, pinned as a submodule. These tests are not
 * a second copy of that package's own suite — they check that *this* repo's
 * integration of it is sound: that the migrations it ships still apply cleanly, and
 * that the connection this client opens has the settings the schema depends on.
 */

let db: TestDatabase | null = null;

afterEach(() => {
  db?.close();
  db = null;
});

describe("client migrations", () => {
  it("brings an empty database up to the version the package ships", () => {
    db = openTestDatabase();
    expect(appliedVersions(db.adapter)).toEqual(
      MIGRATIONS.map((m) => m.version).sort((a, b) => a - b),
    );
    expect(targetVersion()).toBeGreaterThan(0);
  });

  it("is idempotent", () => {
    db = openTestDatabase();
    // Second run against an already-migrated database must apply nothing. If it
    // applied anything, a returning author's data would be dropped by a CREATE TABLE.
    expect(runMigrations(db.adapter)).toEqual([]);
  });

  it("numbers migrations contiguously from 1", () => {
    // A gap means a migration was removed after being applied somewhere. The runner
    // records versions individually, so the missing one would never be reapplied and
    // the schema would differ between an old client and a fresh install.
    const versions = MIGRATIONS.map((m) => m.version).sort((a, b) => a - b);
    expect(versions).toEqual(versions.map((_, index) => index + 1));
  });
});

describe("connection settings", () => {
  it("enables foreign keys, and they actually cascade", () => {
    db = openTestDatabase();

    // Reporting the pragma is not enough — it is per connection, and the failure
    // mode is that every ON DELETE CASCADE in the schema silently stops working.
    // So this deletes a parent and checks the child is really gone.
    expect(db.adapter.query<{ foreign_keys: number }>("PRAGMA foreign_keys;")).toEqual([
      { foreign_keys: 1 },
    ]);

    db.run(
      "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      ["p1", "Lighthouse", isoNow(), isoNow()],
    );
    db.run(
      `INSERT INTO binder_item (id, project_id, type, title, order_key, created_at, updated_at)
       VALUES (?, ?, 'folder', ?, 'a0', ?, ?)`,
      ["b1", "p1", "Act I", isoNow(), isoNow()],
    );

    db.run("DELETE FROM project WHERE id = ?", ["p1"]);

    expect(db.adapter.query("SELECT id FROM binder_item")).toEqual([]);
  });

  it("rejects a foreign key that names nothing", () => {
    db = openTestDatabase();
    expect(() =>
      db!.run(
        `INSERT INTO binder_item (id, project_id, type, title, order_key, created_at, updated_at)
         VALUES ('orphan', 'no-such-project', 'folder', 'Stray', 'a0', ?, ?)`,
        [isoNow(), isoNow()],
      ),
    ).toThrow();
  });
});

describe("STRICT tables", () => {
  it("refuses a value of the wrong type instead of coercing it", () => {
    db = openTestDatabase();
    db.run("INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      "p1",
      "Lighthouse",
      isoNow(),
      isoNow(),
    ]);
    // word_count is INTEGER. Without STRICT, SQLite would store the string happily
    // and the number would come back as text on the next read.
    expect(() =>
      db!.run(
        `INSERT INTO document (id, word_count, created_at, updated_at)
         VALUES ('p1', 'lots', ?, ?)`,
        [isoNow(), isoNow()],
      ),
    ).toThrow();
  });

  it("refuses document content that is not valid JSON", () => {
    db = openTestDatabase();
    db.run("INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)", [
      "p1",
      "Lighthouse",
      isoNow(),
      isoNow(),
    ]);
    db.run(
      `INSERT INTO binder_item (id, project_id, type, title, order_key, created_at, updated_at)
       VALUES ('d1', 'p1', 'document', 'Chapter One', 'a0', ?, ?)`,
      [isoNow(), isoNow()],
    );
    expect(() =>
      db!.run(
        "INSERT INTO document (id, content, created_at, updated_at) VALUES ('d1', ?, ?, ?)",
        ["{not json", isoNow(), isoNow()],
      ),
    ).toThrow();
  });
});

describe("the harness itself", () => {
  it("opens a database that is genuinely empty of projects", () => {
    // Guards the tests above: a harness that silently reused a database would make
    // "excludes deleted projects" pass for the wrong reason.
    db = openTestDatabase();
    expect(db.adapter.query("SELECT id FROM project")).toEqual([]);
  });

  it("uses a real SQLite, not a stand-in", () => {
    const raw = new DatabaseSync(":memory:");
    const adapter = fromNodeSqlite(raw);
    adapter.exec("CREATE TABLE t (a INTEGER) STRICT;");
    expect(() => adapter.run("INSERT INTO t (a) VALUES (?)", ["text"])).toThrow();
    raw.close();
  });
});
