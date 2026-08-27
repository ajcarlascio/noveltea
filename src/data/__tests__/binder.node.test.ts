// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assemble, flatten } from "@/data/binder";

/**
 * Tree assembly, without a database. The ordering rule and the orphan rule are the
 * parts worth pinning, and neither needs SQL to exercise.
 */

type Row = Parameters<typeof assemble>[0][number];

const row = (over: Partial<Row> & Pick<Row, "id">): Row => ({
  parent_id: null,
  conflict_of_id: null,
  type: "folder",
  title: over.id,
  order_key: "V",
  trashed_from_parent_id: null,
  label_id: null,
  status_id: null,
  ...over,
});

describe("assemble", () => {
  it("nests children under their parent", () => {
    const binder = assemble([
      row({ id: "act", order_key: "V" }),
      row({ id: "scene", parent_id: "act", order_key: "V" }),
    ]);
    expect(binder.roots).toHaveLength(1);
    expect(binder.roots[0]!.children.map((n) => n.id)).toEqual(["scene"]);
  });

  it("orders siblings by key within each group, not globally", () => {
    // The query returns rows ordered by key across the whole project, and keys are
    // only comparable between siblings. A global order would interleave a deep
    // child into its uncle's position.
    const binder = assemble([
      row({ id: "b", order_key: "m" }),
      row({ id: "a", order_key: "V" }),
      row({ id: "a2", parent_id: "a", order_key: "z" }),
      row({ id: "a1", parent_id: "a", order_key: "G" }),
    ]);
    expect(binder.roots.map((n) => n.id)).toEqual(["a", "b"]);
    expect(binder.roots[0]!.children.map((n) => n.id)).toEqual(["a1", "a2"]);
  });

  it("separates the trash from the binder", () => {
    const binder = assemble([
      row({ id: "trash", type: "trash" }),
      row({ id: "kept" }),
      row({ id: "discarded", parent_id: "trash" }),
    ]);
    expect(binder.roots.map((n) => n.id)).toEqual(["kept"]);
    expect(binder.trash.map((n) => n.id)).toEqual(["discarded"]);
    expect(binder.trashId).toBe("trash");
    // The trash node itself is never a row in the binder.
    expect(flatten(binder.roots).some((n) => n.type === "trash")).toBe(false);
  });

  it("shows an item whose parent is missing rather than dropping it", () => {
    // A tombstoned parent, or a row that arrived before its parent. Rendering it at
    // the root lets the author move it back; dropping it loses a chapter silently.
    const binder = assemble([row({ id: "orphan", parent_id: "gone" })]);
    expect(binder.roots.map((n) => n.id)).toEqual(["orphan"]);
  });

  it("keeps a deep tree in reading order", () => {
    const binder = assemble([
      row({ id: "a", order_key: "V" }),
      row({ id: "b", order_key: "m" }),
      row({ id: "a1", parent_id: "a", order_key: "G" }),
      row({ id: "a1x", parent_id: "a1", order_key: "V" }),
    ]);
    expect(flatten(binder.roots).map((n) => n.id)).toEqual(["a", "a1", "a1x", "b"]);
  });

  it("returns an empty binder for an empty project", () => {
    // Guards the tests above: assemble returning nothing for everything would make
    // several of them pass for the wrong reason.
    expect(assemble([])).toEqual({ roots: [], trash: [], trashId: null });
  });
});
