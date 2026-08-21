// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import type { Authenticator } from "@/features/auth/authenticate";
import { syncProject } from "../engine";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

/**
 * The engine against real SQLite and the real commands. Only the network is faked, so
 * a cursor that moves wrongly or a queue entry cleared too early shows up here as it
 * would in a replica rather than as a mock assertion.
 */
let db: TestDatabase;
let projectId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const ok = (body: unknown) =>
  Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));

/** An authenticator whose fetch is scripted per URL and method. */
function fakeAuth(handler: (path: string, init?: RequestInit) => Promise<Response>): {
  auth: Authenticator;
  calls: { path: string; method: string }[];
} {
  const calls: { path: string; method: string }[] = [];
  const auth = {
    accessToken: () => Promise.resolve("token"),
    fetch: (path: string, init?: RequestInit) => {
      calls.push({ path, method: (init?.method ?? "GET").toUpperCase() });
      return handler(path, init);
    },
    onRotate: () => undefined,
    onExpired: () => undefined,
  } as unknown as Authenticator;
  return { auth, calls };
}

const pullBody = (over: Record<string, unknown> = {}) => ({
  changes: [],
  latestId: 0,
  hasMore: false,
  resyncRequired: false,
  syncEpoch: 1,
  ...over,
});

const pushBody = (over: Record<string, unknown> = {}) => ({
  applied: [],
  conflicts: [],
  latestId: 0,
  ...over,
});

const binderRow = (id: string, over: Record<string, unknown> = {}) => ({
  id: id,
  project_id: projectId,
  parent_id: null,
  type: "folder",
  title: id,
  order_key: "m",
  version: 1,
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  ...over,
});

const state = () => COMMANDS.syncState(db.adapter, { projectId });
const queued = () => db.adapter.query<PendingChange>("SELECT * FROM pending_change ORDER BY id;");

describe("pulling", () => {
  it("applies a page and advances the cursor to latestId", async () => {
    const { auth } = fakeAuth(() =>
      ok(
        pullBody({
          latestId: 12,
          changes: [{ id: 12, entityType: "binder_item", entityId: "b1", op: "update", data: binderRow("b1") }],
        }),
      ),
    );

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    expect(outcome.pulled).toBe(1);
    expect(state().lastChangeId).toBe(12);
    expect(db.adapter.query("SELECT id FROM binder_item WHERE id = 'b1';")).toHaveLength(1);
  });

  it("keeps pulling while the server says there is more", async () => {
    let page = 0;
    const { auth } = fakeAuth(() => {
      page += 1;
      if (page === 1) return ok(pullBody({ latestId: 5, hasMore: true }));
      if (page === 2) return ok(pullBody({ latestId: 9, hasMore: false }));
      return ok(pushBody());
    });

    await syncProject({ db: db.client, auth }, projectId);
    expect(state().lastChangeId).toBe(9);
  });

  it("resumes from the cursor it stored", async () => {
    const { auth, calls } = fakeAuth(() => ok(pullBody({ latestId: 30 })));
    await syncProject({ db: db.client, auth }, projectId);
    await syncProject({ db: db.client, auth }, projectId);

    expect(calls[0]!.path).toContain("since=0");
    // Never re-reading rows it has already applied.
    expect(calls[1]!.path).toContain("since=30");
  });

  it("stops rather than looping forever on a server that always says hasMore", async () => {
    const { auth, calls } = fakeAuth(() => ok(pullBody({ latestId: 1, hasMore: true })));
    await syncProject({ db: db.client, auth, maxPages: 4 }, projectId);
    // Four pulls and one push, not an unbounded loop.
    expect(calls.filter((c) => c.method === "GET")).toHaveLength(4);
  });

  it("ignores a row that is not a change rather than stalling the feed", async () => {
    const { auth } = fakeAuth(() =>
      ok(
        pullBody({
          latestId: 3,
          changes: [
            null,
            { id: 2 },
            { id: 3, entityType: "binder_item", entityId: "b1", op: "update", data: binderRow("b1") },
          ],
        }),
      ),
    );

    const outcome = await syncProject({ db: db.client, auth }, projectId);
    expect(outcome.pulled).toBe(1);
    expect(state().lastChangeId).toBe(3);
  });
});

describe("a resync", () => {
  it("rebuilds the tree and resumes at latestId, not at zero", async () => {
    const { auth, calls } = fakeAuth((path) => {
      if (path.includes("/binder")) return ok([{ id: "b1", type: "folder", title: "From the server", orderKey: "m", version: 2 }]);
      if (path.includes("/sync") && calls.filter((c) => c.path.includes("/sync") && c.method === "GET").length === 1) {
        return ok(pullBody({ resyncRequired: true, latestId: 88, syncEpoch: 5 }));
      }
      if (path.includes("/sync")) return ok(pullBody({ latestId: 88, syncEpoch: 5 }));
      return ok(pushBody());
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    expect(outcome.resynced).toBe(true);
    // Pulling from 0 would land below the purge point and ask for a resync forever.
    expect(state()).toMatchObject({ lastChangeId: 88, syncEpoch: 5 });
    expect(db.adapter.query("SELECT title FROM binder_item WHERE id = 'b1';")).toEqual([
      { title: "From the server" },
    ]);
  });

  it("does not ask to be rebuilt over and over", async () => {
    // A purged server answers `resyncRequired` for *any* cursor below its purge
    // point, not just the first time. Resuming at 0 rather than at latestId walks
    // straight back into the same answer, and the client rebuilds on every page until
    // it runs out of them — burning the author's connection and never catching up.
    const purgedBelow = 50;
    let binderFetches = 0;

    const { auth } = fakeAuth((path) => {
      if (path.includes("/binder")) {
        binderFetches += 1;
        return ok([]);
      }
      if (path.includes("/sync")) {
        const since = Number(/since=(\d+)/.exec(path)?.[1] ?? "0");
        if (since < purgedBelow) {
          return ok(pullBody({ resyncRequired: true, latestId: 88, syncEpoch: 3 }));
        }
        return ok(pullBody({ latestId: 88, syncEpoch: 3 }));
      }
      return ok(pushBody());
    });

    const outcome = await syncProject({ db: db.client, auth, maxPages: 10 }, projectId);

    expect(outcome.resynced).toBe(true);
    expect(binderFetches).toBe(1);
    expect(state().lastChangeId).toBe(88);
  });

  it("fetches every document body back", async () => {
    // The endpoint this uses exists only for a rebuild: the feed carries content, but
    // only on rows since a cursor, so a client starting from nothing cannot otherwise
    // recover a document nobody has edited recently.
    const item = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "document",
      title: "Chapter One",
    });
    db.adapter.run("DELETE FROM pending_change;");

    let firstSync = true;
    const { auth } = fakeAuth((path) => {
      if (path.includes("/binder")) {
        return ok([{ id: item.id, type: "document", title: "Chapter One", orderKey: "m", version: 9 }]);
      }
      if (path.includes("/documents")) {
        return ok({
          documents: [
            {
              id: item.id,
              title: "Chapter One",
              content: { type: "doc", content: [{ type: "paragraph" }] },
              searchText: "the light swung out",
              wordCount: 4,
              version: 9,
              updatedAt: "2026-02-01T00:00:00Z",
            },
          ],
          nextCursor: null,
          hasMore: false,
        });
      }
      if (firstSync) {
        firstSync = false;
        return ok(pullBody({ resyncRequired: true, latestId: 40, syncEpoch: 2 }));
      }
      return ok(pullBody({ latestId: 40, syncEpoch: 2 }));
    });

    await syncProject({ db: db.client, auth }, projectId);

    const row = db.adapter.query<{ search_text: string; word_count: number }>(
      "SELECT search_text, word_count FROM document WHERE id = ?;",
      [item.id],
    )[0]!;
    expect(row.search_text).toBe("the light swung out");
    expect(row.word_count).toBe(4);
  });

  it("pages through the bodies rather than assuming one response holds them all", async () => {
    const ids = ["aaaa1111-0000-0000-0000-000000000001", "aaaa1111-0000-0000-0000-000000000002"];
    let firstSync = true;
    const seen: string[] = [];

    const { auth } = fakeAuth((path) => {
      if (path.includes("/binder")) {
        return ok(ids.map((id, i) => ({ id, type: "document", title: `Doc ${String(i)}`, orderKey: `m${String(i)}`, version: 1 })));
      }
      if (path.includes("/documents")) {
        const after = /after=([^&]+)/.exec(path)?.[1];
        seen.push(after ?? "start");
        const index = after === undefined ? 0 : 1;
        return ok({
          documents: [
            {
              id: ids[index],
              title: `Doc ${String(index)}`,
              content: { type: "doc" },
              searchText: `body ${String(index)}`,
              wordCount: 2,
              version: 1,
              updatedAt: "2026-02-01T00:00:00Z",
            },
          ],
          nextCursor: index === 0 ? ids[0] : null,
          hasMore: index === 0,
        });
      }
      if (firstSync) {
        firstSync = false;
        return ok(pullBody({ resyncRequired: true, latestId: 40, syncEpoch: 2 }));
      }
      return ok(pullBody({ latestId: 40, syncEpoch: 2 }));
    });

    await syncProject({ db: db.client, auth }, projectId);

    // A rebuild that stopped after one page would silently restore part of a novel.
    expect(seen).toEqual(["start", ids[0]]);
    expect(
      db.adapter.query("SELECT id FROM document WHERE search_text IS NOT NULL;"),
    ).toHaveLength(2);
  });

  it("removes what the server no longer has, and keeps what it has never seen", async () => {
    const ghost = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Deleted while away",
    });
    db.adapter.run("DELETE FROM pending_change;");
    const mine = COMMANDS.createBinderItem(db.adapter, {
      projectId, parentId: null, type: "folder", title: "Written offline",
    });

    let firstSync = true;
    const { auth } = fakeAuth((path) => {
      if (path.includes("/binder")) return ok([]);
      if (path.includes("/documents")) return ok({ documents: [], nextCursor: null, hasMore: false });
      if (firstSync) {
        firstSync = false;
        return ok(pullBody({ resyncRequired: true, latestId: 7, syncEpoch: 2 }));
      }
      return ok(pullBody({ latestId: 7, syncEpoch: 2 }));
    });

    await syncProject({ db: db.client, auth }, projectId);

    const deleted = (id: string) =>
      db.adapter.query<{ deleted_at: string | null }>(
        "SELECT deleted_at FROM binder_item WHERE id = ?;",
        [id],
      )[0]?.deleted_at;

    // Its delete row was purged, so nothing is left to say it is gone except absence.
    expect(deleted(ghost.id)).not.toBeNull();
    // The server cannot have listed this: it has never been pushed. Its absence says
    // nothing about whether the author still wants it.
    expect(deleted(mine.id)).toBeNull();
  });
});

describe("pushing", () => {
  it("sends what is queued and clears what the server accepted", async () => {
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });

    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return ok(pushBody({ applied: [{ entityId: item.id, entityType: "binder_item", version: 1 }] }));
      }
      return ok(pullBody());
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);
    expect(outcome.pushed).toBe(1);
    expect(queued()).toHaveLength(0);
  });

  it("pulls before it pushes", async () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    const { auth, calls } = fakeAuth((_path, init) =>
      (init?.method ?? "GET") === "POST" ? ok(pushBody()) : ok(pullBody()),
    );

    await syncProject({ db: db.client, auth }, projectId);

    // Pushing into a stale picture is how a client resurrects something another
    // device deleted.
    expect(calls.map((c) => c.method)).toEqual(["GET", "POST"]);
  });

  it("clears a document conflict instead of retrying it", async () => {
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });

    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return ok(
          pushBody({
            conflicts: [
              {
                entityId: item.id,
                entityType: "binder_item",
                reason: "version_mismatch",
                conflictCopyId: "copy-1",
                serverVersion: 4,
                detail: null,
              },
            ],
          }),
        );
      }
      return ok(pullBody());
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    // The server kept its version and preserved the author's text as a conflict copy.
    // Retrying would make another copy on every push, and copies would breed.
    expect(queued()).toHaveLength(0);
    expect(outcome.conflicts[0]).toMatchObject({ reason: "version_mismatch", conflictCopyId: "copy-1" });
  });

  it("keeps a change the server cannot handle yet", async () => {
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });

    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return ok(
          pushBody({
            conflicts: [
              { entityId: item.id, entityType: "binder_item", reason: "not_implemented", conflictCopyId: null, serverVersion: null, detail: null },
            ],
          }),
        );
      }
      return ok(pullBody());
    });

    await syncProject({ db: db.client, auth }, projectId);
    // A later server version may accept it, and the change is still valid.
    expect(queued()).toHaveLength(1);
  });

  it("leaves the queue alone when there is nothing to send", async () => {
    const { auth, calls } = fakeAuth(() => ok(pullBody()));
    await syncProject({ db: db.client, auth }, projectId);
    expect(calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("failure", () => {
  it("records why, keeps the cursor, and lets the caller know", async () => {
    const { auth } = fakeAuth(() => Promise.resolve(new Response("", { status: 503 })));

    await expect(syncProject({ db: db.client, auth }, projectId)).rejects.toThrow(/503/);

    const after = state();
    expect(after.lastError).toMatch(/503/);
    // A failed attempt must not look like progress.
    expect(after.lastChangeId).toBe(0);
  });

  it("does not clear the queue when the push fails", async () => {
    COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "folder", title: "Act I" });
    const { auth } = fakeAuth((_path, init) =>
      (init?.method ?? "GET") === "POST"
        ? Promise.resolve(new Response("", { status: 500 }))
        : ok(pullBody()),
    );

    await expect(syncProject({ db: db.client, auth }, projectId)).rejects.toThrow();
    // Losing the queue here would lose writing that never left the device.
    expect(queued()).toHaveLength(1);
  });

  it("survives a response that is not JSON", async () => {
    const { auth } = fakeAuth(() => Promise.resolve(new Response("<html>", { status: 200 })));
    await expect(syncProject({ db: db.client, auth }, projectId)).rejects.toThrow(/not readable/i);
  });
});

describe("unknown entity types", () => {
  it("reports them once and keeps going", async () => {
    const { auth } = fakeAuth(() =>
      ok(
        pullBody({
          latestId: 4,
          changes: [
            { id: 2, entityType: "mood_board", entityId: "x", op: "update", data: { id: "x" } },
            { id: 3, entityType: "mood_board", entityId: "y", op: "update", data: { id: "y" } },
            { id: 4, entityType: "binder_item", entityId: "b1", op: "update", data: binderRow("b1") },
          ],
        }),
      ),
    );

    const outcome = await syncProject({ db: db.client, auth }, projectId);
    expect(outcome.skipped).toEqual(["mood_board"]);
    expect(outcome.pulled).toBe(1);
    expect(state().lastChangeId).toBe(4);
  });
});

describe("the harness", () => {
  it("really writes to SQLite through the client the engine uses", async () => {
    // Guards everything above: a client that silently discarded commands would make
    // most of these pass for the wrong reason. Checked by running a command and
    // reading the row back, rather than by inspecting the double.
    await db.client.command("applyPull", {
      projectId,
      changes: [{ id: 1, entityType: "binder_item", entityId: "proof", op: "update", data: binderRow("proof") }],
      latestId: 1,
      syncEpoch: 1,
    });
    expect(db.adapter.query("SELECT id FROM binder_item WHERE id = 'proof';")).toHaveLength(1);
  });
});
