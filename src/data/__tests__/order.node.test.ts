// @vitest-environment node
import { describe, expect, it } from "vitest";
import { between, betweenMany, first, OrderKeyError } from "@/data/order";
import vectors from "../__fixtures__/fractional-index-vectors.json";

interface Vector {
  label: string;
  after: string | null;
  before: string | null;
  /** null means the Java implementation rejected the pair. */
  expected: string | null;
}

/**
 * The vectors were produced by compiling and running the server's
 * com.noveltea.order.FractionalIndex — see README, "Ordering keys". They are the
 * only thing keeping this port and the Java from drifting apart, and drift here does
 * not fail anywhere: it silently reorders an author's chapters differently on each
 * device.
 */
describe("conformance with the server implementation", () => {
  it("has vectors covering appending, prepending, squeezing and rejection", () => {
    // Guards the loop below: an empty or truncated fixture would make it vacuous.
    const labels = (vectors as Vector[]).map((v) => v.label);
    expect(labels.length).toBeGreaterThan(100);
    expect(labels.some((l) => l.startsWith("append-"))).toBe(true);
    expect(labels.some((l) => l.startsWith("prepend-"))).toBe(true);
    expect(labels.filter((l) => l.startsWith("squeeze-")).length).toBeGreaterThanOrEqual(60);
    expect(labels.filter((l) => l.startsWith("reject-")).length).toBeGreaterThan(0);
  });

  it.each(vectors as Vector[])("$label", ({ after, before, expected }) => {
    if (expected === null) {
      expect(() => between(after, before)).toThrow(OrderKeyError);
    } else {
      expect(between(after, before)).toBe(expected);
    }
  });
});

describe("ordering behaviour", () => {
  it("never exhausts precision, however many inserts go between the same pair", () => {
    // The float-indexing failure this replaces gives up after about 50. A thousand
    // is far past anything an author would do, and the keys still sort correctly.
    const low = first();
    let high = between(low, null);
    const inserted: string[] = [];
    for (let i = 0; i < 1000; i += 1) {
      high = between(low, high);
      inserted.push(high);
    }
    expect(new Set(inserted).size).toBe(inserted.length);
    for (const key of inserted) {
      expect(key > low).toBe(true);
    }
    // Each insert lands before the one it displaced, so reading them back in
    // generated order gives descending keys.
    expect([...inserted].sort().reverse()).toEqual(inserted);
  });

  it("keeps a long sibling list in the order it was built", () => {
    const keys: string[] = [];
    let previous: string | null = null;
    for (let i = 0; i < 200; i += 1) {
      previous = between(previous, null);
      keys.push(previous);
    }
    expect([...keys].sort()).toEqual(keys);
  });

  it("gives distinct keys when several items land in the same gap", () => {
    const low = first();
    const high = between(low, null);
    const keys = betweenMany(low, high, 5);
    // Calling between(low, high) five times would return the same key five times and
    // collide on the sibling-order unique index.
    expect(new Set(keys).size).toBe(5);
    expect([...keys].sort()).toEqual(keys);
    expect(keys.every((k) => k > low && k < high)).toBe(true);
  });

  it("rejects a reversed or equal pair rather than inventing a key", () => {
    expect(() => between("b", "a")).toThrow(OrderKeyError);
    expect(() => between("a", "a")).toThrow(OrderKeyError);
  });
});
