// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import type { Database } from "@sqlite.org/sqlite-wasm";
import { fromSqliteWasm } from "@/db/adapter";

/**
 * sqlite-wasm is a browser-only wasm module, so this drives a recording double
 * instead. What is being checked is the shape of the calls, and one branch in
 * particular: sqlite-wasm rejects a `bind` on a statement that takes no
 * parameters, so passing an empty array through would break every parameterless
 * statement — including the PRAGMAs the migration runner issues on open.
 */
function recorder() {
  const calls: unknown[] = [];
  const exec = vi.fn((arg: unknown) => {
    calls.push(arg);
    return [] as unknown;
  });
  return { db: { exec } as unknown as Database, exec, calls };
}

describe("fromSqliteWasm", () => {
  it("passes exec straight through as a string", () => {
    const { db, exec } = recorder();
    fromSqliteWasm(db).exec("PRAGMA foreign_keys = ON;");
    expect(exec).toHaveBeenCalledWith("PRAGMA foreign_keys = ON;");
  });

  it("omits bind entirely when there are no parameters", () => {
    const { db, calls } = recorder();
    fromSqliteWasm(db).run("DELETE FROM project");
    expect(calls[0]).toEqual({ sql: "DELETE FROM project" });
    expect(calls[0]).not.toHaveProperty("bind");
  });

  it("binds parameters when there are some", () => {
    const { db, calls } = recorder();
    fromSqliteWasm(db).run("DELETE FROM project WHERE id = ?", ["p1"]);
    expect(calls[0]).toEqual({ sql: "DELETE FROM project WHERE id = ?", bind: ["p1"] });
  });

  it("asks for object rows so column names survive", () => {
    const { db, calls } = recorder();
    fromSqliteWasm(db).query("SELECT id FROM project");
    // Array row mode would hand the data layer positional tuples, and every
    // mapping would then depend on the order of the SELECT list.
    expect(calls[0]).toMatchObject({ rowMode: "object", returnValue: "resultRows" });
  });

  it("does not bind an empty array on a parameterless query either", () => {
    const { db, calls } = recorder();
    fromSqliteWasm(db).query("SELECT 1");
    expect(calls[0]).not.toHaveProperty("bind");
  });
});
