// @vitest-environment node
import { describe, expect, it } from "vitest";
import { DatabaseClient, DatabaseError } from "@/db/client";
import { fakeWorker } from "@/test/worker";

describe("request correlation", () => {
  it("routes each response to the request that asked for it, whatever the order", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);

    const first = db.query("SELECT 1");
    const second = db.query("SELECT 2");
    const third = db.query("SELECT 3");

    const ids = fake.sent.map((r) => r.id);
    expect(new Set(ids).size).toBe(3);

    // Answered out of order on purpose: a client that assumed FIFO would hand the
    // author another document's contents, and nothing about that looks like a bug
    // until someone notices the wrong chapter on screen.
    fake.reply({ id: ids[2]!, ok: true, result: [{ n: 3 }] });
    fake.reply({ id: ids[0]!, ok: true, result: [{ n: 1 }] });
    fake.reply({ id: ids[1]!, ok: true, result: [{ n: 2 }] });

    await expect(first).resolves.toEqual([{ n: 1 }]);
    await expect(second).resolves.toEqual([{ n: 2 }]);
    await expect(third).resolves.toEqual([{ n: 3 }]);
  });

  it("ignores a response for an id it never sent, and keeps working", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const pending = db.query("SELECT 1");

    fake.reply({ id: 9999, ok: true, result: [{ stray: true }] });
    fake.reply({ id: fake.sent[0]!.id, ok: true, result: [{ n: 1 }] });

    await expect(pending).resolves.toEqual([{ n: 1 }]);
  });

  it("ignores a duplicated response rather than throwing in the listener", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const first = db.query("SELECT 1");
    const id = fake.sent[0]!.id;

    fake.reply({ id, ok: true, result: [{ n: 1 }] });
    // A throw here would take down the message listener and with it every future
    // response — the whole app would go quiet.
    expect(() => fake.reply({ id, ok: true, result: [{ n: 1 }] })).not.toThrow();

    await expect(first).resolves.toEqual([{ n: 1 }]);
    const second = db.query("SELECT 2");
    fake.reply({ id: fake.sent[1]!.id, ok: true, result: [{ n: 2 }] });
    await expect(second).resolves.toEqual([{ n: 2 }]);
  });
});

describe("errors", () => {
  it("preserves the error name across the worker boundary", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const pending = db.run("INSERT ...");

    fake.reply({
      id: fake.sent[0]!.id,
      ok: false,
      error: { name: "SQLite3Error", message: "UNIQUE constraint failed: project.id" },
    });

    await expect(pending).rejects.toBeInstanceOf(DatabaseError);
    // Whether a write can be retried depends on which error it was. A bare Error
    // would make a constraint violation indistinguishable from a bug.
    await expect(pending).rejects.toMatchObject({
      name: "SQLite3Error",
      message: "UNIQUE constraint failed: project.id",
    });
  });
});

describe("when the worker stops", () => {
  it("rejects everything in flight instead of leaving it pending", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const first = db.query("SELECT 1");
    const second = db.run("INSERT ...");

    fake.crash("out of memory");

    await expect(first).rejects.toThrow(/out of memory/);
    await expect(second).rejects.toThrow(/out of memory/);
    expect(db.status).toMatchObject({ state: "failed" });
  });

  it("reports a fatal open failure and rejects in-flight requests", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const pending = db.query("SELECT 1");

    fake.reply({ kind: "fatal", error: { name: "OpenError", message: "OPFS refused" } });

    await expect(pending).rejects.toThrow(/OPFS refused/);
    expect(db.status).toEqual({
      state: "failed",
      error: { name: "OpenError", message: "OPFS refused" },
    });
  });

  it("rejects after close and terminates the worker", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const inFlight = db.query("SELECT 1");

    db.close();

    await expect(inFlight).rejects.toThrow(/closed/i);
    await expect(db.query("SELECT 2")).rejects.toThrow(/closed/i);
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });

  it("does not terminate twice", () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    db.close();
    db.close();
    expect(fake.terminate).toHaveBeenCalledTimes(1);
  });
});

describe("status", () => {
  it("starts as opening and becomes ready", () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    expect(db.status).toEqual({ state: "opening" });

    fake.reply({ kind: "ready", storage: "opfs", appliedVersions: [1], schemaVersion: 11 });
    expect(db.status).toEqual({
      state: "ready",
      storage: "opfs",
      schemaVersion: 11,
      appliedVersions: [1],
    });
  });

  it("reports in-memory storage rather than passing it off as persistent", () => {
    // The author has to be told. Nothing else in the app can tell the difference,
    // and the consequence is that a session's writing disappears on reload.
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    fake.reply({ kind: "ready", storage: "memory", appliedVersions: [1], schemaVersion: 11 });
    expect(db.status).toMatchObject({ state: "ready", storage: "memory" });
  });

  it("notifies subscribers and stops after unsubscribe", () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    const seen: string[] = [];
    const unsubscribe = db.subscribe((status) => seen.push(status.state));

    fake.reply({ kind: "ready", storage: "opfs", appliedVersions: [], schemaVersion: 11 });
    unsubscribe();
    fake.crash();

    expect(seen).toEqual(["ready"]);
  });
});

describe("change notification", () => {
  it("announces a write so screens can re-read", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    let notified = 0;
    db.subscribeToChanges(() => (notified += 1));

    const pending = db.command("renameBinderItem", { projectId: "p", id: "b", title: "x" });
    fake.reply({ id: fake.sent[0]!.id, ok: true, result: {} });
    await pending;

    expect(notified).toBe(1);
  });

  it("says nothing after a write that failed", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    let notified = 0;
    db.subscribeToChanges(() => (notified += 1));

    const pending = db.command("renameBinderItem", { projectId: "p", id: "b", title: "x" });
    fake.reply({
      id: fake.sent[0]!.id,
      ok: false,
      error: { name: "Error", message: "no" },
    });
    await expect(pending).rejects.toThrow();

    // Sending every screen to re-read state that did not change is pure waste.
    expect(notified).toBe(0);
  });

  it("says nothing for a command that only reads", async () => {
    // The loop this prevents: a listener refreshes by calling syncState, syncState
    // announces a change, the listener refreshes again. The page spins instead of
    // rendering, and it is invisible until something times out waiting for it.
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    let notified = 0;
    db.subscribeToChanges(() => (notified += 1));

    const pending = db.command("syncState", { projectId: "p" });
    fake.reply({ id: fake.sent[0]!.id, ok: true, result: { lastChangeId: 0 } });
    await pending;

    expect(notified).toBe(0);
  });

  it("stops notifying after unsubscribe", async () => {
    const fake = fakeWorker();
    const db = new DatabaseClient(fake.worker);
    let notified = 0;
    const stop = db.subscribeToChanges(() => (notified += 1));
    stop();

    const pending = db.command("renameBinderItem", { projectId: "p", id: "b", title: "x" });
    fake.reply({ id: fake.sent[0]!.id, ok: true, result: {} });
    await pending;

    expect(notified).toBe(0);
  });
});
