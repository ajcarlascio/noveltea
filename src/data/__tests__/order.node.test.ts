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
  it("has vectors covering every shape a binder produces", () => {
    // Guards the loop below: an empty or truncated fixture would make it vacuous.
    const labels = (vectors as Vector[]).map((v) => v.label);
    expect(labels.length).toBeGreaterThan(600);
    for (const family of ["append-", "prepend-", "squeeze-", "walk-", "pair-", "open-"]) {
      expect(labels.filter((l) => l.startsWith(family)).length).toBeGreaterThan(0);
    }
    // Refusals are half the contract: an algorithm that happily returns a key for a
    // reversed pair corrupts the order instead of reporting a bug.
    expect((vectors as Vector[]).filter((v) => v.expected === null).length).toBeGreaterThan(50);
  });

  it("has a fixture that is itself internally consistent", () => {
    // The vectors come from another program. If its generator were wrong, this port
    // would be held to a wrong standard and every test would agree with it. So each
    // accepted answer is checked against the property the algorithm exists to have.
    for (const { label, after, before, expected } of vectors as Vector[]) {
      if (expected === null) continue;
      if (after !== null && after !== "") {
        expect(expected > after, `${label}: ${expected} should sort after ${after}`).toBe(true);
      }
      if (before !== null) {
        expect(expected < before, `${label}: ${expected} should sort before ${before}`).toBe(true);
      }
      expect(expected.endsWith("0"), `${label}: keys must not end in 0`).toBe(false);
    }
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

describe("properties, over many random insertions", () => {
  /** A deterministic generator, so a failure can be reproduced from the seed. */
  function makeRandom(seed: number) {
    let state = seed >>> 0;
    return () => {
      // xorshift32: small, deterministic, and good enough to hit odd positions.
      state ^= state << 13;
      state ^= state >>> 17;
      state ^= state << 5;
      state >>>= 0;
      return state / 0x100000000;
    };
  }

  it("keeps a list sorted through two thousand insertions at random positions", () => {
    // The arithmetic in this algorithm is where a misplaced bracket or a sign error
    // hides: it produces keys that look plausible and sort wrongly only sometimes.
    // A long random walk is what finds that, not a handful of chosen examples.
    const random = makeRandom(0x51ed_2026);
    const keys: string[] = [];
    for (let i = 0; i < 40; i += 1) {
      keys.push(between(keys[keys.length - 1] ?? null, null));
    }

    for (let step = 0; step < 2000; step += 1) {
      keys.sort();
      const at = Math.floor(random() * (keys.length + 1));
      const lower = at === 0 ? null : keys[at - 1]!;
      const upper = at === keys.length ? null : keys[at]!;

      const made = between(lower, upper);

      if (lower !== null) {
        expect(made > lower, `step ${step}: ${made} must sort after ${lower}`).toBe(true);
      }
      if (upper !== null) {
        expect(made < upper, `step ${step}: ${made} must sort before ${upper}`).toBe(true);
      }
      expect(made.endsWith("0")).toBe(false);
      expect(keys.includes(made), `step ${step}: ${made} collides with an existing key`).toBe(false);

      keys.push(made);
    }

    const sorted = [...keys].sort();
    expect(keys.length).toBe(2040);
    expect(new Set(keys).size).toBe(keys.length);
    expect([...keys].sort()).toEqual(sorted);
  });

  it("grows a key by about one character per six inserts into the same gap", () => {
    // This is the real cost of fractional indexing and it is worth stating exactly,
    // because "keys stay short" is not true and assuming it leads to a surprise.
    //
    // Each insertion into the *same* gap halves what is left of it, and a base-62
    // digit carries log2(62) ~ 5.95 bits, so N consecutive inserts at one position
    // cost roughly N/5.95 characters. Five hundred of them — an author inserting in
    // the same spot five hundred times — reach about 84. That is nothing to store.
    // The float scheme this replaces does not reach 50 at all; it runs out of
    // mantissa and starts returning a key equal to one of its bounds.
    const low = first();
    let high = between(low, null);
    for (let i = 0; i < 500; i += 1) high = between(low, high);

    expect(high.length).toBeGreaterThan(500 / 8); // growth is real, not magic
    expect(high.length).toBeLessThan(500 / 4); // and it is bounded by the digit width
    expect(high.length).toBeLessThan(200); // and far from anything a column minds

  });

  it("grows an appended key linearly too — a known deficiency, pinned here", () => {
    // Measured, not assumed. Appending is the commonest operation in a binder, and
    // in this algorithm it costs about one character every five items:
    //
    //     10 appends ->   2 chars      500 appends -> 100 chars
    //     50 appends ->  10 chars     2000 appends -> 400 chars ("zzzz…")
    //
    // That is not what the published fractional-indexing algorithm does. That one
    // carries a length-prefixed integer part — a0, a1, … az, b00 — so appending N
    // items keeps keys at O(log N), a few characters for thousands of items. The
    // server's FractionalIndex has no such prefix, so once the leading digit reaches
    // 'z' every further append adds a digit.
    //
    // Ordering is still correct, so nothing breaks. It costs storage, index size and
    // comparison time on the hottest path, and it is cheapest to change before any
    // real binder exists — changing it later means migrating every key. This test
    // exists to state the current behaviour, so a fix on the server side turns it red
    // and forces this port to be regenerated with it, rather than diverging silently.
    // Counting from an empty list, so the numbers above are the numbers here.
    let appended: string | null = null;
    for (let i = 0; i < 500; i += 1) appended = between(appended, null);

    expect(appended).not.toBeNull();
    expect(appended!.length).toBe(100);
    expect(appended!).toMatch(/^z+/);
  });
});
