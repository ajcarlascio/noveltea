// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { offlineThesaurus } from "../thesaurus";

/** A hand-built index, so the lookup logic is tested without a 3.7MB fixture. */
const SMALL = {
  source: "test",
  words: ["angry", "beacon", "enraged", "furious", "lighthouse", "pharos"],
  pos: "an",
  synsets: [
    [0, 2, 3], // angry, enraged, furious
    [1, 4, 5], // beacon, lighthouse, pharos
  ],
  wordSynsets: [[0], [1], [0], [0], [1], [1]],
};

function provider(index: unknown = SMALL, enabled = () => true) {
  const fetcher = vi
    .fn<typeof fetch>()
    .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(index), { status: 200 })));
  return { provider: offlineThesaurus({ fetcher, enabled }), fetcher };
}

describe("lookups", () => {
  it("returns the other words in each synset", async () => {
    const { provider: p } = provider();
    const result = await p.look("furious", "synonym");
    expect(result.words.sort()).toEqual(["angry", "enraged"]);
  });

  it("never returns the word itself", async () => {
    const { provider: p } = provider();
    expect((await p.look("lighthouse", "synonym")).words).not.toContain("lighthouse");
  });

  it("is case and whitespace insensitive", async () => {
    const { provider: p } = provider();
    expect((await p.look("  FURIOUS ", "synonym")).words.sort()).toEqual(["angry", "enraged"]);
  });

  it("returns nothing for a word it does not know, rather than failing", async () => {
    const { provider: p } = provider();
    // An author inventing a name should get an empty answer, not an error.
    await expect(p.look("zzzyx", "synonym")).resolves.toMatchObject({ words: [] });
  });

  it("refuses a kind it cannot answer", async () => {
    const { provider: p } = provider();
    await expect(p.look("furious", "rhyme")).rejects.toThrow(/only offers synonyms/i);
  });

  it("marks its answers as never having left the device", async () => {
    const { provider: p } = provider();
    // The entire reason this provider exists.
    expect((await p.look("furious", "synonym")).wasNetworked).toBe(false);
  });
});

describe("loading", () => {
  it("fetches nothing until the first lookup", async () => {
    const { provider: p, fetcher } = provider();
    // 1.3MB compressed. Most sessions never open a thesaurus.
    expect(fetcher).not.toHaveBeenCalled();
    await p.look("furious", "synonym");
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("loads once, however many lookups race", async () => {
    const { provider: p, fetcher } = provider();
    await Promise.all([
      p.look("furious", "synonym"),
      p.look("lighthouse", "synonym"),
      p.look("angry", "synonym"),
    ]);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports a failed load and allows a retry", async () => {
    let attempt = 0;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => {
      attempt += 1;
      return Promise.resolve(
        attempt === 1
          ? new Response("", { status: 503 })
          : new Response(JSON.stringify(SMALL), { status: 200 }),
      );
    });
    const p = offlineThesaurus({ fetcher, enabled: () => true });

    await expect(p.look("furious", "synonym")).rejects.toThrow(/503/);
    // A cached rejected promise would replay the failure forever.
    await expect(p.look("furious", "synonym")).resolves.toMatchObject({
      words: expect.arrayContaining(["angry"]) as string[],
    });
  });

  it("follows the setting for availability", () => {
    let on = false;
    const p = offlineThesaurus({ enabled: () => on, fetcher: vi.fn<typeof fetch>() });
    expect(p.available()).toBe(false);
    on = true;
    expect(p.available()).toBe(true);
  });
});

describe("the generated index", () => {
  // Contract between tooling/build-thesaurus.mjs and the reader above. The builder
  // runs separately from the app, so nothing else would notice if its shape changed.
  const path = "public/thesaurus/wordnet.json";
  let index: typeof SMALL & { words: string[] };
  try {
    index = JSON.parse(readFileSync(path, "utf8")) as typeof index;
  } catch {
    index = null as unknown as typeof index;
  }

  it.runIf(index !== null)("has a sorted vocabulary, which the binary search needs", () => {
    // Out of order, and lookups silently miss words that are present.
    const sample = index.words.filter((_, i) => i % 500 === 0);
    expect([...sample].sort()).toEqual(sample);
  });

  it.runIf(index !== null)("keeps every parallel array the same length", () => {
    expect(index.wordSynsets).toHaveLength(index.words.length);
    expect(index.pos).toHaveLength(index.synsets.length);
  });

  it.runIf(index !== null)("answers a real word with real synonyms", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response(JSON.stringify(index), { status: 200 })));
    const p = offlineThesaurus({ fetcher, enabled: () => true });

    const result = await p.look("furious", "synonym");
    expect(result.words).toContain("enraged");
    expect(result.source).toMatch(/WordNet/);
  });
});
