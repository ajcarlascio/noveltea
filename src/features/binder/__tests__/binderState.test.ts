import { describe, expect, it } from "vitest";
import type { BinderNode } from "@/data/binder";
import {
  ancestorIds,
  readExpandedIds,
  readLastDocumentId,
  writeExpandedIds,
  writeLastDocumentId,
} from "../binderState";

/** A node with no children, for building trees tersely. */
const leaf = (id: string, type: "folder" | "document" = "document"): BinderNode => ({
  id,
  parentId: null,
  type,
  title: id,
  orderKey: "a0",
  trashedFromParentId: null,
  conflictOfId: null,
  children: [],
});

const folder = (id: string, children: BinderNode[]): BinderNode => ({
  ...leaf(id, "folder"),
  children,
});

/** A working in-memory Storage, for round-trip tests. */
function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => void map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

describe("expanded ids", () => {
  it("round-trips the set of open folders", () => {
    const fake = memoryStorage();
    writeExpandedIds(fake, "p1", new Set(["f1", "f2"]));
    expect(readExpandedIds(fake, "p1").sort()).toEqual(["f1", "f2"]);
  });

  it("keeps projects apart", () => {
    const fake = memoryStorage();
    writeExpandedIds(fake, "p1", new Set(["f1"]));
    expect(readExpandedIds(fake, "p2")).toEqual([]);
  });

  it("treats unparseable storage as nothing remembered", () => {
    const fake = {
      getItem: () => "{not json",
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
    expect(readExpandedIds(fake, "p1")).toEqual([]);
  });

  it("drops non-string entries rather than trusting them", () => {
    const fake = {
      getItem: () => JSON.stringify(["ok", 42, null, { id: "x" }]),
      setItem: () => {},
      removeItem: () => {},
    } as unknown as Storage;
    expect(readExpandedIds(fake, "p1")).toEqual(["ok"]);
  });
});

describe("last document", () => {
  it("round-trips the document an author was last reading", () => {
    const fake = memoryStorage();
    writeLastDocumentId(fake, "p1", "d1");
    expect(readLastDocumentId(fake, "p1")).toBe("d1");
    expect(readLastDocumentId(fake, "p2")).toBeNull();
  });
});

describe("ancestorIds", () => {
  const tree = [
    folder("f1", [folder("f2", [leaf("d1")]), leaf("d2")]),
    leaf("d3"),
  ];

  it("lists the folders above a nested document, root first", () => {
    expect(ancestorIds(tree, "d1")).toEqual(["f1", "f2"]);
  });

  it("is empty for a top-level node", () => {
    expect(ancestorIds(tree, "d3")).toEqual([]);
  });

  it("is empty for an id the tree does not contain", () => {
    // A stale id from storage: it must expand nothing, not throw.
    expect(ancestorIds(tree, "gone")).toEqual([]);
  });
});
