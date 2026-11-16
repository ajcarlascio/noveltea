// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COMMANDS } from "@/db/commands";
import type { Authenticator } from "@/features/auth/authenticate";
import { adoptServerProjects, syncProject } from "../engine";
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
      const method = (init?.method ?? "GET").toUpperCase();
      if (path === "/api/v1/projects" && method === "POST") {
        return Promise.resolve(new Response("{}", { status: 201 }));
      }
      calls.push({ path, method });
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

  it("applies an item whose label's own row comes later in the same feed", async () => {
    // Feed rows carry an entity's current state, so an item's oldest row already names a
    // label created after it. Refusing that row would fail the page every time.
    const labelled = binderRow("b1", { label_id: "l1" });
    const { auth } = fakeAuth(() =>
      ok(
        pullBody({
          latestId: 11,
          changes: [
            { id: 5, entityType: "binder_item", entityId: "b1", op: "create", data: labelled },
            {
              id: 10, entityType: "taxonomy", entityId: "l1", op: "create",
              data: { id: "l1", project_id: projectId, kind: "label", name: "Draft", order_key: "m", created_at: "2026-01-01T00:00:00Z", updated_at: "2026-01-01T00:00:00Z" },
            },
            { id: 11, entityType: "binder_item", entityId: "b1", op: "update", data: labelled },
          ],
        }),
      ),
    );

    await syncProject({ db: db.client, auth }, projectId);
    expect(db.adapter.query("SELECT label_id FROM binder_item WHERE id = 'b1';")).toEqual([{ label_id: "l1" }]);
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
      if (path.endsWith("/sync/state")) return ok([]);
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

  it("rebuilds a labelled item from a server too old to list its label", async () => {
    // A server without /sync/state cannot send the label, so the item's label_id names
    // a row this device will not get from the rebuild. The item must still arrive: a
    // foreign-key failure would fail every sync of the project.
    const { auth } = fakeAuth((path) => {
      if (path.endsWith("/sync/state")) return Promise.resolve(new Response("", { status: 500 }));
      if (path.includes("/binder")) {
        return ok([{ id: "b1", type: "folder", title: "Labelled", orderKey: "m", version: 2, labelId: "label-from-elsewhere" }]);
      }
      if (path.includes("/sync")) {
        return ok(pullBody({ resyncRequired: true, latestId: 9, syncEpoch: 2 }));
      }
      return ok(pushBody());
    });

    await syncProject({ db: db.client, auth }, projectId);

    expect(db.adapter.query("SELECT title FROM binder_item WHERE id = 'b1';")).toEqual([
      { title: "Labelled" },
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
      if (path.endsWith("/sync/state")) return ok([]);
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
      if (path.endsWith("/sync/state")) return ok([]);
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
      if (path.endsWith("/sync/state")) return ok([]);
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
      if (path.endsWith("/sync/state")) return ok([]);
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

describe("a resync restores everything the feed carries", () => {
  const stamp = "2026-03-01T00:00:00Z";
  const row = (entityType: string, id: string, data: Record<string, unknown>) => ({
    entityType,
    entityId: id,
    data: { id, version: 1, updated_by_device_id: null, created_at: stamp, updated_at: stamp, ...data },
  });
  const label = (id: string, name: string) =>
    row("taxonomy", id, { project_id: projectId, kind: "label", name, color: "#cc3300", order_key: "m", deleted_at: null });

  /** A server whose feed is purged: the first pull asks for a rebuild, the rest are empty. */
  const purgedServer = (server: {
    state: unknown[] | number;
    binder?: unknown[];
    documents?: unknown[] | number;
    /** Whether the resync answer says /sync/state exists. Servers before it do not. */
    advertised?: boolean;
    /** The epoch the server answers with. A different one than the replica's is a restore. */
    epoch?: number;
  }) => {
    let pulls = 0;
    const fail = (status: number) => Promise.resolve(new Response("", { status }));
    return fakeAuth((path) => {
      if (path.endsWith("/sync/state")) {
        return typeof server.state === "number" ? fail(server.state) : ok(server.state);
      }
      if (path.includes("/binder")) return ok(server.binder ?? []);
      if (path.includes("/documents")) {
        if (typeof server.documents === "number") return fail(server.documents);
        return ok({ documents: server.documents ?? [], nextCursor: null, hasMore: false });
      }
      if (path.includes("/sync")) {
        pulls += 1;
        return ok(
          pullBody({
            resyncRequired: pulls === 1,
            latestId: 60,
            syncEpoch: server.epoch ?? 2,
            stateAvailable: server.advertised ?? true,
          }),
        );
      }
      return ok(pushBody());
    }).auth;
  };

  /** Every row of every table, for "nothing changed" — sync_state aside, which records the failure. */
  const everything = () =>
    db.adapter
      .query<{ name: string }>(
        "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'sync_state' ORDER BY name;",
      )
      .map(({ name }) => ({
        name,
        rows: db.adapter.query(`SELECT * FROM ${name};`).map((row) => JSON.stringify(row)).sort(),
      }));

  const ids = (table: string, where = "1") =>
    db.adapter.query<{ id: string }>(`SELECT id FROM ${table} WHERE ${where} ORDER BY id;`).map((r) => r.id);
  const live = (table: string) => ids(table, "deleted_at IS NULL");

  it("gives a new device on a purged project every type, not only the tree and the prose", async () => {
    const thread = row("comment", "c1", {
      project_id: projectId, document_id: "d1", parent_comment_id: null, author_user_id: "u1",
      body: "Tighten this", anchor: { from: 1, to: 4, quotedText: "The" },
      resolved_at: null, resolved_by_user_id: null, deleted_at: null,
    });
    const auth = purgedServer({
      state: [
        label("l1", "Draft"),
        row("taxonomy", "s1", { project_id: projectId, kind: "status", name: "First pass", color: null, order_key: "m", deleted_at: null }),
        row("custom_metadata_field", "f1", { project_id: projectId, name: "POV", field_type: "text", options: null, order_key: "m", deleted_at: null }),
        row("collection", "k1", { project_id: projectId, name: "Act I", query: null, is_smart: false, color: null, order_key: "m", deleted_at: null }),
        row("compile_preset", "p1", {
          project_id: projectId, name: "Manuscript", format: "md", included_binder_items: ["d1"],
          include_query: null, separator_rules: {}, title_page: null, front_matter: null, deleted_at: null,
        }),
        row("custom_metadata_value", "v1", { binder_item_id: "d1", field_id: "f1", value: "Ann" }),
        row("collection_item", "i1", { collection_id: "k1", binder_item_id: "d1", order_key: "m" }),
        thread,
        row("comment", "c2", { ...thread.data, id: "c2", parent_comment_id: "c1", anchor: null, body: "Agreed" }),
        row("snapshot", "n1", {
          project_id: projectId, document_id: "d1", word_count: 3, label: "Before the cut",
          is_automatic: false, created_by_device_id: null,
        }),
      ],
      binder: [{ id: "d1", type: "document", title: "Chapter One", orderKey: "m", labelId: "l1", statusId: "s1", version: 3 }],
      documents: [{ id: "d1", content: { type: "doc" }, searchText: "The light", wordCount: 2, version: 3, updatedAt: stamp }],
    });

    await syncProject({ db: db.client, auth }, projectId);

    expect(live("taxonomy")).toEqual(["l1", "s1"]);
    expect(live("custom_metadata_field")).toEqual(["f1"]);
    expect(live("collection")).toEqual(["k1"]);
    expect(live("compile_preset")).toEqual(["p1"]);
    expect(ids("collection_item")).toEqual(["i1"]);
    expect(live("comment")).toEqual(["c1", "c2"]);
    expect(ids("snapshot")).toEqual(["n1"]);
    // Stored as JSON text, the way a value set on this device is.
    expect(db.adapter.query("SELECT value FROM custom_metadata_value;")).toEqual([{ value: '"Ann"' }]);
    // Taxonomy arrives first, so the item keeps the label it names.
    expect(db.adapter.query("SELECT label_id, status_id FROM binder_item WHERE id = 'd1';")).toEqual([
      { label_id: "l1", status_id: "s1" },
    ]);
    expect(state().lastChangeId).toBe(60);
  });

  it("loses ghosts, gains what it missed, and keeps every unsynced edit", async () => {
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    const ghostLabel = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    const field = COMMANDS.createMetadataField(db.adapter, { projectId, name: "POV", fieldType: "text" });
    const ghostValue = COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: chapter.id, fieldId: field.id, value: "Ann" });
    const automatic = COMMANDS.captureSnapshot(db.adapter, { projectId, documentId: chapter.id, label: null, automatic: true });
    db.adapter.run("DELETE FROM pending_change;");

    // Made offline after the last sync: the server has never heard of either.
    const offlineLabel = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Revise", color: null });
    const offlineCollection = COMMANDS.createCollection(db.adapter, { projectId, name: "Mine", color: null, query: null });
    COMMANDS.addToCollection(db.adapter, { projectId, collectionId: offlineCollection.id, binderItemId: chapter.id });

    const auth = purgedServer({
      state: [
        // Draft was deleted and made again on another device, under a new id; so was
        // the value, which the unique (item, field) index would refuse beside the ghost.
        label("l2", "Draft"),
        row("custom_metadata_field", field.id, { project_id: projectId, name: "POV", field_type: "text", options: null, order_key: "m", deleted_at: null }),
        row("custom_metadata_value", "v2", { binder_item_id: chapter.id, field_id: field.id, value: "Bea" }),
      ],
      binder: [{ id: chapter.id, type: "document", title: "Chapter One", orderKey: "m", version: 2 }],
    });

    await syncProject({ db: db.client, auth }, projectId);

    expect(live("taxonomy")).toEqual([offlineLabel.id, "l2"].sort());
    expect(live("taxonomy")).not.toContain(ghostLabel.id);
    expect(ids("custom_metadata_value")).toEqual(["v2"]);
    expect(ghostValue.id).not.toBe("v2");
    expect(live("collection")).toEqual([offlineCollection.id]);
    expect(ids("collection_item")).toHaveLength(1);
    // Automatic captures never leave the device; the server's silence about one means nothing.
    expect(ids("snapshot")).toEqual([automatic.id]);
    expect(queued().map((q) => q.entity_type).sort()).toEqual(["collection", "collection_item", "taxonomy"]);
  });

  describe("a manual snapshot the server does not list", () => {
    /** A chapter and a manual snapshot of it taken here, both synced as far as this device knows. */
    const snapshotHere = () => {
      const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
      const taken = COMMANDS.captureSnapshot(db.adapter, { projectId, documentId: chapter.id, label: "Before the cut", automatic: false });
      db.adapter.run("DELETE FROM pending_change;");
      const binder = [{ id: chapter.id, type: "document", title: "Chapter One", orderKey: "m", version: 1 }];
      const documents = [{ id: chapter.id, content: { type: "doc" }, version: 1, updatedAt: stamp }];
      return { chapter, taken, binder, documents };
    };
    const held = (id: string) =>
      db.adapter.query("SELECT 1 FROM snapshot WHERE id = ? AND content IS NOT NULL;", [id]).length;

    it("is queued again when the server was restored from a backup", async () => {
      const { taken, binder, documents } = snapshotHere();
      const auth = purgedServer({ state: [], binder, documents, epoch: 2 });

      await syncProject({ db: db.client, auth }, projectId);

      expect(held(taken.id)).toBe(1);
      expect(queued().map((q) => [q.entity_type, q.entity_id, q.op])).toEqual([["snapshot", taken.id, "create"]]);
    });

    it("is kept, and not re-created, when a purge of the change log is all that happened", async () => {
      // Its absence may be another device's delete, and creating it again would undo that.
      const { taken, binder, documents } = snapshotHere();
      const auth = purgedServer({ state: [], binder, documents, epoch: 1 });

      const outcome = await syncProject({ db: db.client, auth }, projectId);

      expect(outcome.resynced).toBe(true);
      expect(held(taken.id)).toBe(1);
      expect(queued()).toHaveLength(0);
    });
  });

  it("falls back to the tree and the bodies on a server that does not advertise the endpoint", async () => {
    const kept = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    db.adapter.run("DELETE FROM pending_change;");

    const auth = purgedServer({ state: 500, advertised: false });
    await syncProject({ db: db.client, auth }, projectId);

    // It could not list labels, so its silence about this one says nothing.
    expect(live("taxonomy")).toEqual([kept.id]);
    expect(state().lastChangeId).toBe(60);
  });

  it("fails, and retries from the same cursor, when an advertised /sync/state fails", async () => {
    // A transient 500 on a current server is not an old server. Taking it for one rebuilt
    // without labels, metadata or comments and moved the cursor past any chance of them.
    const kept = COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    db.adapter.run("DELETE FROM pending_change;");
    const before = everything();

    for (const status of [404, 500]) {
      await expect(
        syncProject({ db: db.client, auth: purgedServer({ state: status }) }, projectId),
      ).rejects.toThrow(new RegExp(String(status)));
      expect(state().lastChangeId).toBe(0);
    }
    expect(everything()).toEqual(before);

    await syncProject({ db: db.client, auth: purgedServer({ state: [label(kept.id, "Draft")] }) }, projectId);
    expect(live("taxonomy")).toEqual([kept.id]);
    expect(state().lastChangeId).toBe(60);
  });

  it("leaves every table exactly as it was when a fetch fails partway", async () => {
    // Pruning before fetching would leave a ghost-free but gutted replica: no values, no
    // collection items, no manual snapshots, for as long as the device stays offline.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    const field = COMMANDS.createMetadataField(db.adapter, { projectId, name: "POV", fieldType: "text" });
    COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: chapter.id, fieldId: field.id, value: "Ann" });
    const collection = COMMANDS.createCollection(db.adapter, { projectId, name: "Act I", color: null, query: null });
    COMMANDS.addToCollection(db.adapter, { projectId, collectionId: collection.id, binderItemId: chapter.id });
    COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name: "Draft", color: null });
    db.adapter.run("DELETE FROM pending_change;");
    const before = everything();

    // The server lists none of it, which would prune all of it, and then fails.
    const auth = purgedServer({ state: [], binder: [], documents: 500 });
    await expect(syncProject({ db: db.client, auth }, projectId)).rejects.toThrow(/500/);

    expect(everything()).toEqual(before);
    expect(state().lastChangeId).toBe(0);
  });

  it("leaves every table as it was when applying the rebuild fails", async () => {
    // Everything is fetched by then; the prune, the rows and the cursor are one write.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    const field = COMMANDS.createMetadataField(db.adapter, { projectId, name: "POV", fieldType: "text" });
    COMMANDS.setMetadataValue(db.adapter, { projectId, binderItemId: chapter.id, fieldId: field.id, value: "Ann" });
    db.adapter.run("DELETE FROM pending_change;");
    const before = everything();

    const auth = purgedServer({
      state: [],
      binder: [{ id: "bad", type: "not-a-type", title: "Refused by a CHECK", orderKey: "m", version: 1 }],
    });
    await expect(syncProject({ db: db.client, auth }, projectId)).rejects.toThrow();

    expect(everything()).toEqual(before);
    expect(state().lastChangeId).toBe(0);
  });
});

describe("unsynced writing", () => {
  const prose = (text: string) => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
  const bodyOf = (id: string) =>
    db.adapter.query<{ content: string }>("SELECT content FROM document WHERE id = ?;", [id])[0]?.content;

  it("survives a rebuild over it: pushed intact, kept as a conflict copy, replaced by the server's only after", async () => {
    // Applying the server's body over a document with a queued change left the author's
    // text in the queue alone; an editor reopened on the replica showed the server's, and
    // the next keystroke replaced the queued text for good.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("written offline"), searchText: "written offline", wordCount: 2 });

    const server = prose("written elsewhere");
    let pulls = 0;
    let pushed: { baseVersion: number; data: { content: unknown } } | undefined;
    let localAtPush: string | undefined;
    const { auth } = fakeAuth((path, init) => {
      if (path.endsWith("/sync/state")) return ok([]);
      if (path.includes("/binder")) return ok([{ id: chapter.id, type: "document", title: "Chapter One", orderKey: "m", version: 2 }]);
      if (path.includes("/documents")) {
        return ok({
          documents: [{ id: chapter.id, content: server, searchText: "written elsewhere", wordCount: 2, version: 2, updatedAt: "2026-02-01T00:00:00Z" }],
          nextCursor: null,
          hasMore: false,
        });
      }
      if ((init?.method ?? "GET") === "POST") {
        localAtPush = bodyOf(chapter.id);
        pushed = (JSON.parse(init?.body as string) as { changes: NonNullable<typeof pushed>[] }).changes[0];
        return ok(pushBody({
          conflicts: [{ entityId: chapter.id, entityType: "document", reason: "version_mismatch", conflictCopyId: "copy-1", serverVersion: 2, detail: null }],
        }));
      }
      pulls += 1;
      if (pulls === 1) return ok(pullBody({ resyncRequired: true, latestId: 60, syncEpoch: 2, stateAvailable: true }));
      if (pulls === 2) return ok(pullBody({ latestId: 60, syncEpoch: 2 }));
      // What the server feeds after the conflict: the copy holding the pushed text, and the
      // original put back on the feed for this device.
      return ok(pullBody({
        latestId: 63,
        syncEpoch: 2,
        changes: [
          { id: 61, entityType: "binder_item", entityId: "copy-1", op: "create", data: binderRow("copy-1", { type: "document", order_key: "n", title: "Chapter One (Conflicted Copy)" }) },
          { id: 62, entityType: "document", entityId: "copy-1", op: "create", data: { id: "copy-1", content: pushed?.data.content, version: 1, created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" } },
          { id: 63, entityType: "document", entityId: chapter.id, op: "update", data: { id: chapter.id, content: server, version: 2, created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" } },
        ],
      }));
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    expect(outcome.resynced).toBe(true);
    // Through the rebuild, the replica still showed what the author wrote...
    expect(JSON.parse(localAtPush ?? "null")).toEqual(prose("written offline"));
    // ...and the push sent it against the version it was written on.
    expect(pushed).toMatchObject({ baseVersion: 1, data: { content: prose("written offline") } });
    // Once it was safe in the copy, the original took the server's text.
    expect(JSON.parse(bodyOf(chapter.id) ?? "null")).toEqual(server);
    expect(JSON.parse(bodyOf("copy-1") ?? "null")).toEqual(prose("written offline"));
    expect(queued()).toHaveLength(0);
    expect(state().lastChangeId).toBe(63);
  });

  it("stays queued when it is edited while its push is in flight", async () => {
    // The edit merges into the entry being pushed; clearing that entry by id dropped it.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("first"), searchText: "first", wordCount: 1 });

    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("first and more"), searchText: "first and more", wordCount: 3 });
        return ok(pushBody({ applied: [{ entityId: chapter.id, entityType: "document", version: 2 }] }));
      }
      return ok(pullBody());
    });

    await syncProject({ db: db.client, auth }, projectId);

    const [entry] = queued();
    expect(JSON.parse(entry?.payload ?? "null")).toMatchObject({ content: prose("first and more") });
    // Based on the write the server just took, so the next push is not a stale one.
    expect(entry?.base_version).toBe(2);
    expect(db.adapter.query("SELECT version FROM document WHERE id = ?;", [chapter.id])).toEqual([{ version: 2 }]);
  });

  /**
   * The server's document rules, as `SyncService` applies them: a push whose base is the
   * current version is taken; any other becomes a sibling copy, the original stays as it
   * was, and goes back on the feed for the device that lost.
   */
  function documentServer(chapterId: string, held: { content: unknown; version: number }) {
    const docs = new Map<string, { content: unknown; version: number }>([[chapterId, held]]);
    const feed: Record<string, unknown>[] = [];
    const log = (entityType: string, entityId: string, op: string, data: Record<string, unknown>) =>
      feed.push({ id: feed.length + 1, entityType, entityId, op, data: { id: entityId, ...data } });
    const doc = (id: string) => ({ id, content: docs.get(id)?.content, version: docs.get(id)?.version, created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" });
    const copies: string[] = [];
    log("document", chapterId, "update", doc(chapterId));

    const { auth } = fakeAuth((path, init) => {
      if ((init?.method ?? "GET") !== "POST") {
        const since = Number(/since=(\d+)/.exec(path)?.[1] ?? 0);
        return ok(pullBody({ changes: feed.filter((row) => (row.id as number) > since), latestId: feed.length }));
      }
      const body = JSON.parse(init?.body as string) as { changes: { entityId: string; baseVersion: number; data: { content: unknown } }[] };
      const applied: unknown[] = [];
      const conflicts: unknown[] = [];
      for (const change of body.changes) {
        const current = docs.get(change.entityId);
        if (current?.version === change.baseVersion) {
          docs.set(change.entityId, { content: change.data.content, version: current.version + 1 });
          log("document", change.entityId, "update", doc(change.entityId));
          applied.push({ entityId: change.entityId, entityType: "document", version: current.version + 1 });
        } else if (current !== undefined) {
          const copyId = `copy-${String(copies.length + 1)}`;
          copies.push(copyId);
          docs.set(copyId, { content: change.data.content, version: 1 });
          log("binder_item", copyId, "create", binderRow(copyId, { type: "document", order_key: "n" }));
          log("document", copyId, "create", doc(copyId));
          log("document", change.entityId, "update", doc(change.entityId));
          conflicts.push({ entityId: change.entityId, entityType: "document", reason: "version_mismatch", conflictCopyId: copyId, serverVersion: current.version, detail: null });
        }
      }
      return ok(pushBody({ applied, conflicts, latestId: feed.length }));
    });
    return { auth, docs, copies };
  }

  it("makes one copy, not two, of a document edited while its push was a conflict", async () => {
    // The edit made in flight merged into the entry that was sent, so the entry stayed,
    // still based on the version the server had moved past: its next push conflicted
    // again and made a second copy of nearly the same text. The first copy holds the
    // earlier text, so the later text goes there, and the original is free to take the
    // server's.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("first"), searchText: "first", wordCount: 1 });

    const server = documentServer(chapter.id, { content: prose("theirs"), version: 2 });
    const racing = {
      ...server.auth,
      fetch: (path: string, init?: RequestInit) => {
        if ((init?.method ?? "GET") === "POST" && path.endsWith("/sync") && server.copies.length === 0) {
          COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("first and more"), searchText: "first and more", wordCount: 3 });
        }
        return server.auth.fetch(path, init);
      },
    };

    const first = await syncProject({ db: db.client, auth: racing }, projectId);
    expect(first.conflicts).toHaveLength(1);
    // The original already shows the server's text; the author's is queued on the copy.
    expect(JSON.parse(bodyOf(chapter.id) ?? "null")).toEqual(prose("theirs"));
    expect(JSON.parse(bodyOf("copy-1") ?? "null")).toEqual(prose("first and more"));
    expect(queued().map((row) => [row.entity_id, row.op, row.base_version])).toEqual([["copy-1", "update", 1]]);

    await syncProject({ db: db.client, auth: racing }, projectId);
    await syncProject({ db: db.client, auth: racing }, projectId);

    expect(server.copies).toEqual(["copy-1"]);
    expect(server.docs.get(chapter.id)).toEqual({ content: prose("theirs"), version: 2 });
    expect(server.docs.get("copy-1")).toEqual({ content: prose("first and more"), version: 2 });
    expect(queued()).toHaveLength(0);
    expect(JSON.parse(bodyOf(chapter.id) ?? "null")).toEqual(prose("theirs"));
    expect(JSON.parse(bodyOf("copy-1") ?? "null")).toEqual(prose("first and more"));
  });

  it("keeps a document the server refused, with the server's newer row skipped, and says so", async () => {
    // The pull skipped the server's row because this device had unsynced text, and the
    // cursor moved past it. A refusal with no copy used to clear the entry: the device
    // stayed on its own text with a stale version, and nothing said it never arrived.
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveDocument(db.adapter, { projectId, id: chapter.id, content: prose("mine"), searchText: "mine", wordCount: 1 });

    let accept = false;
    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") !== "POST") {
        return ok(pullBody({
          latestId: 4,
          changes: [{ id: 4, entityType: "document", entityId: chapter.id, op: "update", data: { id: chapter.id, content: prose("theirs"), version: 3, created_at: "2026-02-01T00:00:00Z", updated_at: "2026-02-01T00:00:00Z" } }],
        }));
      }
      return ok(accept
        ? pushBody({ applied: [{ entityId: chapter.id, entityType: "document", version: 4 }] })
        : pushBody({ conflicts: [{ entityId: chapter.id, entityType: "document", reason: "invalid_request", conflictCopyId: null, serverVersion: null, detail: "content is too large" }] }));
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    expect(outcome.conflicts).toHaveLength(1);
    expect(queued()).toHaveLength(1);
    expect(JSON.parse(bodyOf(chapter.id) ?? "null")).toEqual(prose("mine"));
    expect(state().lastError).toMatch(/content is too large/);

    // Retried on the next sync, and the error stays visible while it keeps being refused.
    await syncProject({ db: db.client, auth }, projectId);
    expect(queued()).toHaveLength(1);
    expect(state().lastError).toMatch(/content is too large/);

    accept = true;
    await syncProject({ db: db.client, auth }, projectId);
    expect(queued()).toHaveLength(0);
    expect(state().lastError).toBeNull();
  });

  it("never pushes a label it dropped for want of the label's row as a removal", async () => {
    // An older server's rebuild names a label this device cannot hold, so the item lands
    // unlabelled. Its next rename must not tell every other device to clear the label.
    const { auth } = fakeAuth((path) => {
      if (path.includes("/binder")) {
        return ok([{ id: "b1", type: "folder", title: "Labelled", orderKey: "m", version: 2, labelId: "label-from-elsewhere" }]);
      }
      if (path.includes("/documents")) return ok({ documents: [], nextCursor: null, hasMore: false });
      return ok(pullBody({ resyncRequired: true, latestId: 9, syncEpoch: 2 }));
    });
    await syncProject({ db: db.client, auth }, projectId);
    expect(db.adapter.query("SELECT label_id FROM binder_item WHERE id = 'b1';")).toEqual([{ label_id: null }]);

    COMMANDS.renameBinderItem(db.adapter, { projectId, id: "b1", title: "Renamed" });

    const payload = JSON.parse(queued()[0]?.payload ?? "{}") as Record<string, unknown>;
    expect(payload.title).toBe("Renamed");
    expect(payload).not.toHaveProperty("label_id");
    expect(payload).not.toHaveProperty("status_id");
  });
});

describe("the trash node", () => {
  // The server never makes a trash node on the sync path: only its REST trash endpoint
  // does (`ensureTrash`), and this client never calls it. So a locally made project's
  // trash node exists on the server only if the client pushes it, and a push that moves
  // an item under a parent the server has never heard of is refused (`BinderItemNotFound`
  // inside `requireReparentIsSafe`, reported as invalid_request).
  const trashOf = (id: string) =>
    db.adapter.query<{ id: string }>("SELECT id FROM binder_item WHERE project_id = ? AND type = 'trash';", [id]).map((r) => r.id);

  /** The server's binder, as far as pushes and `GET /binder` go. */
  function binderServer(over: { rebuild?: boolean } = {}) {
    const items = new Map<string, Record<string, unknown>>();
    let pulls = 0;
    const { auth } = fakeAuth((path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        const body = JSON.parse(init?.body as string) as { changes: { entityId: string; op: string; data: Record<string, unknown> }[] };
        const applied: unknown[] = [];
        const conflicts: unknown[] = [];
        for (const change of body.changes) {
          const parent = change.data.parent_id;
          if (typeof parent === "string" && !items.has(parent)) {
            conflicts.push({ entityId: change.entityId, entityType: "binder_item", reason: "invalid_request", conflictCopyId: null, serverVersion: null, detail: `no binder item ${parent}` });
            continue;
          }
          items.set(change.entityId, { ...items.get(change.entityId), ...change.data });
          applied.push({ entityId: change.entityId, entityType: "binder_item", version: 1 });
        }
        return ok(pushBody({ applied, conflicts }));
      }
      if (path.endsWith("/sync/state")) return ok([]);
      if (path.includes("/binder")) {
        return ok([...items.values()].map((i) => ({ id: i.id, parentId: i.parent_id, type: i.type, title: i.title, orderKey: i.order_key, version: 1 })));
      }
      if (path.includes("/documents")) return ok({ documents: [], nextCursor: null, hasMore: false });
      pulls += 1;
      return ok(pullBody({ resyncRequired: over.rebuild === true && pulls === 1, latestId: 9, syncEpoch: 1, stateAvailable: true }));
    });
    return { auth, items };
  }

  it("reaches the server with the project, so what is trashed there can be synced", async () => {
    const project = COMMANDS.createProject(db.adapter, { title: "Salt" }).id;
    const [trash] = trashOf(project);
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId: project, parentId: null, type: "folder", title: "Act I" });
    COMMANDS.trashBinderItem(db.adapter, { projectId: project, id: chapter.id });
    const server = binderServer();

    const outcome = await syncProject({ db: db.client, auth: server.auth }, project);

    expect(outcome.conflicts).toEqual([]);
    expect(server.items.get(trash!)).toMatchObject({ type: "trash", parent_id: null });
    expect(server.items.get(chapter.id)).toMatchObject({ parent_id: trash });
    expect(db.adapter.query("SELECT 1 FROM pending_change WHERE project_id = ?;", [project])).toHaveLength(0);
  });

  it("is the same node after a rebuild from the server's tree", async () => {
    const project = COMMANDS.createProject(db.adapter, { title: "Salt" }).id;
    const [trash] = trashOf(project);
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId: project, parentId: null, type: "folder", title: "Act I" });
    COMMANDS.trashBinderItem(db.adapter, { projectId: project, id: chapter.id });
    const server = binderServer();
    await syncProject({ db: db.client, auth: server.auth }, project);

    const rebuilding = binderServer({ rebuild: true });
    for (const [id, item] of server.items) rebuilding.items.set(id, item);
    const outcome = await syncProject({ db: db.client, auth: rebuilding.auth }, project);

    expect(outcome.resynced).toBe(true);
    expect(trashOf(project)).toEqual([trash]);
    expect(db.adapter.query("SELECT parent_id FROM binder_item WHERE id = ?;", [chapter.id])).toEqual([{ parent_id: trash }]);
  });

  it("is replaced by the server's when the server minted its own under another id", async () => {
    // A project made before the trash node was pushed, to which something else has since
    // added a trash node. Two would break the one-per-project index and fail every rebuild.
    const project = COMMANDS.createProject(db.adapter, { title: "Salt" }).id;
    db.adapter.run("DELETE FROM pending_change;");
    const [mine] = trashOf(project);
    const chapter = COMMANDS.createBinderItem(db.adapter, { projectId: project, parentId: null, type: "folder", title: "Act I" });
    COMMANDS.trashBinderItem(db.adapter, { projectId: project, id: chapter.id });

    const server = binderServer({ rebuild: true });
    server.items.set("server-trash", { id: "server-trash", parent_id: null, type: "trash", title: "Trash", order_key: "z" });
    const outcome = await syncProject({ db: db.client, auth: server.auth }, project);

    // What was still queued for the old id went to the server's, and was accepted.
    expect(outcome.conflicts).toEqual([]);
    expect(server.items.get(chapter.id)).toMatchObject({ parent_id: "server-trash" });

    expect(mine).not.toBe("server-trash");
    expect(trashOf(project)).toEqual(["server-trash"]);
    expect(db.adapter.query("SELECT parent_id FROM binder_item WHERE id = ?;", [chapter.id])).toEqual([{ parent_id: "server-trash" }]);
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

  it("still reports a conflict copy when the pull that follows it fails", async () => {
    // The push had already made the copy. Throwing past it meant the author was never
    // told one existed.
    const item = COMMANDS.createBinderItem(db.adapter, { projectId, parentId: null, type: "document", title: "Chapter One" });
    db.adapter.run("DELETE FROM pending_change;");
    COMMANDS.saveDocument(db.adapter, { projectId, id: item.id, content: { type: "doc", content: [] }, searchText: "", wordCount: 0 });
    let pulls = 0;
    const { auth } = fakeAuth((_path, init) => {
      if ((init?.method ?? "GET") === "POST") {
        return ok(pushBody({ conflicts: [{ entityId: item.id, entityType: "document", reason: "version_mismatch", conflictCopyId: "copy-1", serverVersion: 4, detail: null }] }));
      }
      pulls += 1;
      return pulls === 1 ? ok(pullBody()) : Promise.resolve(new Response("", { status: 503 }));
    });

    const outcome = await syncProject({ db: db.client, auth }, projectId);

    expect(outcome.conflicts).toHaveLength(1);
    expect(queued()).toHaveLength(0);
    // The failed pull is still recorded, and the next sync takes the original back.
    expect(state().lastError).toMatch(/503/);
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

describe("adopting the account's projects on a new device", () => {
  const serverProject = { id: "0b0e7c1e-3f0a-4d7e-9a53-0d1f6f0a9c11", title: "Salt", settings: { target: 90000 } };

  const adoptingAuth = (projects: unknown) =>
    fakeAuth((path) => (path === "/api/v1/projects" ? ok(projects) : ok(pullBody())));

  const titles = () =>
    db.adapter.query<{ title: string }>("SELECT title FROM project ORDER BY title;").map((r) => r.title);

  it("creates the local row under the server's id and syncs it at once", async () => {
    const { auth, calls } = adoptingAuth([serverProject]);

    expect(await adoptServerProjects({ db: db.client, auth })).toBe(1);

    expect(titles()).toEqual(["Salt", "The Lighthouse"]);
    const row = db.adapter.query<{ settings: string }>("SELECT settings FROM project WHERE id = ?;", [serverProject.id])[0];
    expect(JSON.parse(row?.settings ?? "null")).toEqual({ target: 90000 });
    expect(calls.some((c) => c.path.startsWith(`/api/v1/projects/${serverProject.id}/sync`))).toBe(true);
  });

  it("creates no binder rows itself, and a second pass adopts nothing", async () => {
    const { auth } = adoptingAuth([serverProject]);
    const items = () =>
      db.adapter.query("SELECT id FROM binder_item WHERE project_id = ?;", [serverProject.id]);

    expect(await adoptServerProjects({ db: db.client, auth })).toBe(1);
    expect(items()).toHaveLength(0);
    expect(await adoptServerProjects({ db: db.client, auth })).toBe(0);
  });

  it("reports adoption before the first sync finishes", async () => {
    const { auth } = fakeAuth((path) =>
      path === "/api/v1/projects" ? ok([serverProject]) : new Promise<Response>(() => undefined),
    );
    const seen: string[][] = [];
    void adoptServerProjects({ db: db.client, auth, onAdopted: () => seen.push(titles()) });

    await vi.waitFor(() => expect(seen).toHaveLength(1));
    expect(seen[0]).toContain("Salt");
  });

  it("leaves a project that is already here alone, title included", async () => {
    const { auth } = adoptingAuth([{ id: projectId, title: "Renamed on the server" }]);

    expect(await adoptServerProjects({ db: db.client, auth })).toBe(0);
    expect(titles()).toEqual(["The Lighthouse"]);
  });

  it("skips rows it cannot read instead of failing the rest", async () => {
    const { auth } = adoptingAuth([null, { id: 7 }, { id: "x", title: " " }, serverProject]);

    expect(await adoptServerProjects({ db: db.client, auth })).toBe(1);
  });
});
