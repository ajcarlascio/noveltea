// @vitest-environment node
import { describe, expect, it, vi } from "vitest";
import { createDispatcher } from "@/db/dispatch";
import type { WorkerOutbound } from "@/db/protocol";
import { isoNow, openTestDatabase } from "@/test/sqlite";

function harness() {
  const posted: WorkerOutbound[] = [];
  const wrote: true[] = [];
  const dispatcher = createDispatcher(
    (message) => posted.push(message),
    () => wrote.push(true),
  );
  return { dispatcher, posted, wrote };
}

function opened(db = openTestDatabase()) {
  return { adapter: db.adapter, storage: "opfs" as const, appliedVersions: [], schemaVersion: 11, db };
}

describe("requests arriving before the database is open", () => {
  it("are answered once it opens, not rejected", () => {
    const { dispatcher, posted } = harness();
    dispatcher.handle({ id: 1, kind: "query", sql: "SELECT 1 AS n", params: [] });

    // Nothing yet: the app renders and reads before migrations can have finished,
    // and failing that read would show an error on every cold start.
    expect(posted).toEqual([]);

    dispatcher.opened(opened());
    expect(posted[0]).toMatchObject({ kind: "ready" });
    expect(posted[1]).toEqual({ id: 1, ok: true, result: [{ n: 1 }] });
  });

  it("are answered as failures if the database never opens", () => {
    const { dispatcher, posted } = harness();
    dispatcher.handle({ id: 1, kind: "query", sql: "SELECT 1", params: [] });
    dispatcher.failed(new Error("OPFS refused"));

    // Silently dropping the queue would leave the promise pending forever, which
    // an author reads as "still saving".
    expect(posted[0]).toMatchObject({ kind: "fatal" });
    expect(posted[1]).toMatchObject({ id: 1, ok: false, error: { message: "OPFS refused" } });
  });

  it("keeps failing afterwards rather than hanging", () => {
    const { dispatcher, posted } = harness();
    dispatcher.failed(new Error("OPFS refused"));
    dispatcher.handle({ id: 7, kind: "query", sql: "SELECT 1", params: [] });
    expect(posted.at(-1)).toMatchObject({ id: 7, ok: false });
  });
});

describe("failures are contained per request", () => {
  it("answers a bad statement with an error and keeps serving", () => {
    const { dispatcher, posted } = harness();
    dispatcher.opened(opened());

    dispatcher.handle({ id: 1, kind: "query", sql: "SELECT * FROM nope", params: [] });
    dispatcher.handle({ id: 2, kind: "query", sql: "SELECT 2 AS n", params: [] });

    expect(posted[1]).toMatchObject({ id: 1, ok: false });
    expect(posted[2]).toEqual({ id: 2, ok: true, result: [{ n: 2 }] });
  });

  it("carries the error message across, not a generic one", () => {
    const { dispatcher, posted } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({ id: 1, kind: "query", sql: "SELECT * FROM nope", params: [] });
    const response = posted[1];
    expect(response).toMatchObject({ ok: false });
    if (response && "error" in response) {
      expect(response.error.message).toMatch(/nope/);
    }
  });
});

describe("transactions", () => {
  it("commits every statement together", () => {
    const { dispatcher, posted } = harness();
    const state = opened();
    dispatcher.opened(state);

    dispatcher.handle({
      id: 1,
      kind: "transaction",
      statements: [
        {
          sql: "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          params: ["p1", "One", isoNow(), isoNow()],
        },
        {
          sql: "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          params: ["p2", "Two", isoNow(), isoNow()],
        },
      ],
    });

    expect(posted[1]).toMatchObject({ id: 1, ok: true });
    expect(state.adapter.query("SELECT id FROM project ORDER BY id")).toEqual([
      { id: "p1" },
      { id: "p2" },
    ]);
  });

  it("rolls the whole thing back when one statement fails", () => {
    const { dispatcher, posted } = harness();
    const state = opened();
    dispatcher.opened(state);

    dispatcher.handle({
      id: 1,
      kind: "transaction",
      statements: [
        {
          sql: "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
          params: ["p1", "One", isoNow(), isoNow()],
        },
        { sql: "INSERT INTO project (id) VALUES ('broken')", params: [] },
      ],
    });

    expect(posted[1]).toMatchObject({ id: 1, ok: false });
    // The first insert must not survive. A half-applied transaction is how a
    // binder ends up with an item whose document was never written.
    expect(state.adapter.query("SELECT id FROM project")).toEqual([]);
  });

  it("reports the original error even if the rollback also fails", () => {
    const posted: WorkerOutbound[] = [];
    const dispatcher = createDispatcher((message) => posted.push(message));
    const adapter = {
      exec: vi.fn((sql: string) => {
        if (sql.startsWith("ROLLBACK")) throw new Error("rollback exploded");
      }),
      run: vi.fn(() => {
        throw new Error("the real problem");
      }),
      query: vi.fn(() => []),
    };
    dispatcher.opened({ adapter, storage: "memory", appliedVersions: [], schemaVersion: 1 });

    dispatcher.handle({ id: 1, kind: "transaction", statements: [{ sql: "INSERT", params: [] }] });

    const response = posted[1];
    expect(response).toMatchObject({ ok: false });
    if (response && "error" in response) {
      // Reporting the cleanup failure would hide the one that explains what happened.
      expect(response.error.message).toBe("the real problem");
    }
  });
});

describe("run", () => {
  it("returns nothing and applies the statement", () => {
    const { dispatcher, posted } = harness();
    const state = opened();
    dispatcher.opened(state);
    dispatcher.handle({
      id: 1,
      kind: "run",
      sql: "INSERT INTO project (id, title, created_at, updated_at) VALUES (?, ?, ?, ?)",
      params: ["p1", "One", isoNow(), isoNow()],
    });
    expect(posted[1]).toEqual({ id: 1, ok: true, result: undefined });
    expect(state.adapter.query("SELECT id FROM project")).toEqual([{ id: "p1" }]);
  });
});

describe("telling the host something changed", () => {
  it("announces a write after a command that changes rows", () => {
    const { dispatcher, wrote } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({
      id: 1,
      kind: "command",
      name: "createProject",
      input: { title: "The Lighthouse" },
    });
    expect(wrote).toHaveLength(1);
  });

  it("SAYS NOTHING AFTER A READ", () => {
    // Every panel that refreshes runs queries. Flushing on those would rewrite the
    // whole database file each time one of them re-rendered.
    const { dispatcher, wrote } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({ id: 1, kind: "query", sql: "SELECT 1 AS n;", params: [] });
    expect(wrote).toHaveLength(0);
  });

  it("says nothing after a read-only command", () => {
    const { dispatcher, wrote } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({ id: 1, kind: "command", name: "syncState", input: { projectId: "p1" } });
    expect(wrote).toHaveLength(0);
  });

  it("says nothing when the write failed", () => {
    // There is nothing worth persisting, and the previous file is still correct.
    const { dispatcher, wrote } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({ id: 1, kind: "run", sql: "NOT VALID SQL;", params: [] });
    expect(wrote).toHaveLength(0);
  });

  it("assumes raw SQL writes, rather than trying to parse it", () => {
    const { dispatcher, wrote } = harness();
    dispatcher.opened(opened());
    dispatcher.handle({ id: 1, kind: "run", sql: "PRAGMA user_version;", params: [] });
    expect(wrote).toHaveLength(1);
  });
});
