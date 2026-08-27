// @vitest-environment node
import type { PendingChange } from "@noveltea/client-db";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { COMMANDS } from "@/db/commands";
import { openTestDatabase, type TestDatabase } from "@/test/sqlite";

let db: TestDatabase;
let projectId: string;
let chapterId: string;

beforeEach(() => {
  db = openTestDatabase();
  projectId = COMMANDS.createProject(db.adapter, { title: "The Lighthouse" }).id;
  chapterId = COMMANDS.createBinderItem(db.adapter, {
    projectId,
    parentId: null,
    type: "document",
    title: "Chapter One",
  }).id;
  db.adapter.run("DELETE FROM pending_change;");
});

afterEach(() => db.close());

const label = (name: string, color: string | null = "#c8553d") =>
  COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "label", name, color });

const status = (name: string) =>
  COMMANDS.createTaxonomy(db.adapter, { projectId, kind: "status", name, color: null });

const item = (id: string) =>
  db.adapter.query<{ label_id: string | null; status_id: string | null }>(
    "SELECT label_id, status_id FROM binder_item WHERE id = ?;",
    [id],
  )[0]!;

const queued = () =>
  db.adapter.query<PendingChange>(
    "SELECT * FROM pending_change ORDER BY entity_type, id;",
  );

const queuedFor = (entityType: string, entityId: string) =>
  queued().find((row) => row.entity_type === entityType && row.entity_id === entityId);

describe("creating terms", () => {
  it("keeps labels and statuses apart, and orders each kind on its own", () => {
    const first = label("Bob's POV");
    const second = label("Ada's POV");
    const only = status("First draft");

    const live = COMMANDS.listTaxonomy(db.adapter, { projectId });
    // Author order, not alphabetical: these are a list the author arranges.
    expect(live.map((row) => row.name)).toEqual(["Bob's POV", "Ada's POV", "First draft"]);
    // Ordered by kind then key, and the two labels got successive keys of their own
    // rather than sharing a sequence with the status.
    expect(first.order_key < second.order_key).toBe(true);
    expect(only.order_key).toBe(first.order_key);
  });

  it("gives a status no colour, whatever it is offered", () => {
    // The design says colour is meaningful on a label only. Storing one anyway would
    // mean a value nothing draws, which the next reader has to guess the meaning of.
    const row = COMMANDS.createTaxonomy(db.adapter, {
      projectId,
      kind: "status",
      name: "First draft",
      color: "#c8553d",
    });
    expect(row.color).toBeNull();
  });

  it("refuses a blank name and a name already taken by the same kind", () => {
    label("Bob's POV");
    expect(() => label("   ")).toThrow(/needs a name/i);
    expect(() => label("Bob's POV")).toThrow(/already a label/i);
    // Same word, other kind: not a clash. The unique index is per kind.
    expect(() => status("Bob's POV")).not.toThrow();
  });

  it("frees the name again once the term is deleted", () => {
    const first = label("Bob's POV");
    COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: first.id });
    const second = label("Bob's POV");
    expect(second.id).not.toBe(first.id);
  });

  it("queues the whole row, so a rename after a create still carries the colour", () => {
    const row = label("Bob's POV");
    COMMANDS.updateTaxonomy(db.adapter, {
      projectId,
      id: row.id,
      name: "Bob",
      color: "#3d5a80",
    });

    const entry = queuedFor("taxonomy", row.id)!;
    // Coalesced onto the create, which is what the server needs to see for a row it
    // has never heard of.
    expect(entry.op).toBe("create");
    const payload = JSON.parse(entry.payload!) as Record<string, unknown>;
    expect(payload).toMatchObject({ name: "Bob", color: "#3d5a80", kind: "label" });
  });
});

describe("assigning terms to an item", () => {
  it("sets a label and a status, and leaves the other alone when only one is given", () => {
    const pov = label("Bob's POV");
    const draft = status("First draft");

    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: pov.id });
    expect(item(chapterId)).toEqual({ label_id: pov.id, status_id: null });

    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, statusId: draft.id });
    // The label survived a write that never mentioned it.
    expect(item(chapterId)).toEqual({ label_id: pov.id, status_id: draft.id });
  });

  it("clears one with null without disturbing the other", () => {
    const pov = label("Bob's POV");
    const draft = status("First draft");
    COMMANDS.setItemTaxonomy(db.adapter, {
      projectId,
      id: chapterId,
      labelId: pov.id,
      statusId: draft.id,
    });

    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: null });
    expect(item(chapterId)).toEqual({ label_id: null, status_id: draft.id });
  });

  it("refuses a status in the label slot, and a term from another project", () => {
    const draft = status("First draft");
    expect(() =>
      COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: draft.id }),
    ).toThrow(/not a label/i);

    const other = COMMANDS.createProject(db.adapter, { title: "Another book" }).id;
    const theirs = COMMANDS.createTaxonomy(db.adapter, {
      projectId: other,
      kind: "label",
      name: "Their POV",
      color: null,
    });
    expect(() =>
      COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: theirs.id }),
    ).toThrow(/not in this project/i);
    expect(item(chapterId)).toEqual({ label_id: null, status_id: null });
  });

  it("queues the binder item as a whole row, title included", () => {
    const pov = label("Bob's POV");
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: pov.id });

    const entry = queuedFor("binder_item", chapterId)!;
    const payload = JSON.parse(entry.payload!) as Record<string, unknown>;
    // The whole row, not just the field that moved: pending_change holds one entry per
    // entity, so a partial payload would drop the title of a rename queued beside it.
    expect(payload).toMatchObject({ label_id: pov.id, title: "Chapter One", type: "document" });
  });
});

describe("deleting a term", () => {
  it("takes it off every item wearing it, and queues each of them", () => {
    const pov = label("Bob's POV");
    const second = COMMANDS.createBinderItem(db.adapter, {
      projectId,
      parentId: null,
      type: "document",
      title: "Chapter Two",
    }).id;
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: chapterId, labelId: pov.id });
    COMMANDS.setItemTaxonomy(db.adapter, { projectId, id: second, labelId: pov.id });

    const outcome = COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: pov.id });

    expect(outcome.cleared).toBe(2);
    expect(item(chapterId).label_id).toBeNull();
    expect(item(second).label_id).toBeNull();
    // Without an entry per item, another device would keep drawing a label whose row
    // it can no longer resolve.
    expect(queuedFor("binder_item", chapterId)).toBeDefined();
    expect(queuedFor("binder_item", second)).toBeDefined();
  });

  it("leaves the other kind alone", () => {
    const pov = label("Bob's POV");
    const draft = status("First draft");
    COMMANDS.setItemTaxonomy(db.adapter, {
      projectId,
      id: chapterId,
      labelId: pov.id,
      statusId: draft.id,
    });

    COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: pov.id });
    expect(item(chapterId)).toEqual({ label_id: null, status_id: draft.id });
  });

  it("tombstones rather than removes, and drops it out of the list", () => {
    const pov = label("Bob's POV");
    COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: pov.id });

    expect(COMMANDS.listTaxonomy(db.adapter, { projectId })).toEqual([]);
    // The row is still there: a tombstone is what tells another device it is gone.
    const row = db.adapter.query<{ deleted_at: string | null }>(
      "SELECT deleted_at FROM taxonomy WHERE id = ?;",
      [pov.id],
    )[0]!;
    expect(row.deleted_at).not.toBeNull();
  });

  it("refuses a term that is already gone", () => {
    const pov = label("Bob's POV");
    COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: pov.id });
    expect(() => COMMANDS.deleteTaxonomy(db.adapter, { projectId, id: pov.id })).toThrow(
      /not in this project/i,
    );
  });
});
