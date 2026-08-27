// @vitest-environment node
import { describe, expect, it } from "vitest";
import { assembleTaxonomy, term } from "@/data/taxonomy";

/**
 * Turning taxonomy rows into the two lists the interface draws from, without a
 * database. The split by kind and the dangling-id rule are the parts worth pinning.
 */

type Row = Parameters<typeof assembleTaxonomy>[0][number];

const row = (over: Partial<Row> & Pick<Row, "id">): Row => ({
  kind: "label",
  name: over.id,
  color: "#c8553d",
  ...over,
});

describe("assembling the project's terms", () => {
  it("keeps the two kinds in their own lists, in the order given", () => {
    const taxonomy = assembleTaxonomy([
      row({ id: "bob" }),
      row({ id: "drafted", kind: "status", color: null }),
      row({ id: "ada" }),
    ]);

    expect(taxonomy.labels.map((t) => t.id)).toEqual(["bob", "ada"]);
    expect(taxonomy.statuses.map((t) => t.id)).toEqual(["drafted"]);
  });

  it("drops the colour from a status, whatever the row carries", () => {
    // Colour is meaningful on a label only. A status that arrived from an older
    // client with one would otherwise be drawn with a dot nothing explains.
    const taxonomy = assembleTaxonomy([row({ id: "drafted", kind: "status" })]);
    expect(taxonomy.statuses[0]?.color).toBeNull();
  });

  it("ignores a kind this build does not know", () => {
    // The column has a CHECK for exactly two values, so a third means a row from a
    // schema ahead of this one. Skipped, rather than shown in whichever list is not
    // the other.
    const taxonomy = assembleTaxonomy([row({ id: "odd", kind: "keyword" })]);
    expect(taxonomy.labels).toEqual([]);
    expect(taxonomy.statuses).toEqual([]);
  });
});

describe("resolving an item's term", () => {
  const taxonomy = assembleTaxonomy([row({ id: "bob", name: "Bob's POV" })]);

  it("finds the term an id names", () => {
    expect(term(taxonomy, "bob")?.name).toBe("Bob's POV");
  });

  it("reads an unset column, and a deleted term, as no term at all", () => {
    // The second is the case that matters: a tombstone can arrive from another
    // device before the items that wore the label do, and for that moment the id
    // points at nothing. No label is the right answer; throwing would be a blank
    // binder.
    expect(term(taxonomy, null)).toBeNull();
    expect(term(taxonomy, "a-label-deleted-elsewhere")).toBeNull();
  });
});
