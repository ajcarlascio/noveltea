import { describe, expect, it, vi } from "vitest";
import { ConsentRequired, datamuseLookup } from "../datamuse";
import { sessionKeyStore } from "../keys";

/**
 * This is the only code that sends an author's words to a third party. Every test
 * here is a way it could do that when it should not, or send more than it should.
 */
/** fetch accepts a string, a URL or a Request; only the first two occur here. */
function urlOf(input: Parameters<typeof fetch>[0]): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function okResponse(words: string[]) {
  return Promise.resolve(
    new Response(JSON.stringify(words.map((word) => ({ word, score: 1 }))), { status: 200 }),
  );
}

describe("consent", () => {
  it("makes no request at all when consent is absent", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = datamuseLookup({ consented: () => false, fetcher });

    await expect(provider.look("lighthouse", "synonym")).rejects.toBeInstanceOf(ConsentRequired);
    // Not "the request failed" — the request must never be built.
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("is read at call time, so withdrawing takes effect immediately", async () => {
    let allowed = true;
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => okResponse(["beacon"]));
    const provider = datamuseLookup({ consented: () => allowed, fetcher });

    await provider.look("lighthouse", "synonym");
    expect(fetcher).toHaveBeenCalledTimes(1);

    // Checking at construction would leave a provider that keeps working until the
    // page is reloaded, long after the author turned it off.
    allowed = false;
    await expect(provider.look("lighthouse", "synonym")).rejects.toBeInstanceOf(ConsentRequired);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports itself unavailable without consent", () => {
    expect(datamuseLookup({ consented: () => false }).available()).toBe(false);
    expect(datamuseLookup({ consented: () => true }).available()).toBe(true);
  });
});

describe("what is sent", () => {
  it("sends the single term and nothing else", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => okResponse(["beacon"]));
    const provider = datamuseLookup({ consented: () => true, fetcher });

    await provider.look("Lighthouse", "synonym");

    const [url, init] = fetcher.mock.calls[0]!;
    const sent = new URL(urlOf(url));
    expect(sent.searchParams.get("rel_syn")).toBe("lighthouse");
    // Nothing that identifies the author or the surrounding work.
    expect([...sent.searchParams.keys()].sort()).toEqual(["max", "rel_syn"]);
    expect(init?.credentials).toBe("omit");
    expect(init?.referrerPolicy).toBe("no-referrer");
  });

  it("adds a key only when one is held", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => okResponse([]));
    const keys = sessionKeyStore();
    const provider = datamuseLookup({ consented: () => true, fetcher, keys });

    await provider.look("x", "synonym");
    expect(new URL(urlOf(fetcher.mock.calls[0]![0])).searchParams.has("key")).toBe(false);

    await keys.set("datamuse", "abc123");
    await provider.look("x", "synonym");
    expect(new URL(urlOf(fetcher.mock.calls[1]![0])).searchParams.get("key")).toBe("abc123");
  });

  it("does not call out for an empty term", async () => {
    const fetcher = vi.fn<typeof fetch>();
    const provider = datamuseLookup({ consented: () => true, fetcher });

    const result = await provider.look("   ", "synonym");
    expect(result.words).toEqual([]);
    expect(result.wasNetworked).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe("answers", () => {
  it("maps each supported kind to its own query", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => okResponse([]));
    const provider = datamuseLookup({ consented: () => true, fetcher });

    await provider.look("light", "synonym");
    await provider.look("light", "related");
    await provider.look("light", "rhyme");

    const params = fetcher.mock.calls.map(
      ([url]) => [...new URL(urlOf(url)).searchParams.keys()].find((k) => k !== "max"),
    );
    expect(params).toEqual(["rel_syn", "ml", "rel_rhy"]);
  });

  it("survives a payload that is not the shape it expects", async () => {
    // A third party can change its response, and an author mid-sentence should get
    // "no results" rather than a crash.
    for (const body of ["{}", "[]", '[{"nope":1}]', '["bare string"]', "null"]) {
      const fetcher = vi
        .fn<typeof fetch>()
        .mockImplementation(() => Promise.resolve(new Response(body, { status: 200 })));
      const provider = datamuseLookup({ consented: () => true, fetcher });
      await expect(provider.look("x", "synonym")).resolves.toMatchObject({ words: [] });
    }
  });

  it("reports a failure with its status rather than silently returning nothing", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockImplementation(() => Promise.resolve(new Response("", { status: 429 })));
    const provider = datamuseLookup({ consented: () => true, fetcher });
    await expect(provider.look("x", "synonym")).rejects.toThrow(/429/);
  });

  it("marks its answers as having left the device", async () => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(() => okResponse(["beacon"]));
    const provider = datamuseLookup({ consented: () => true, fetcher });
    // The interface shows this, so an author always knows which answers were private.
    await expect(provider.look("lighthouse", "synonym")).resolves.toMatchObject({
      wasNetworked: true,
      words: ["beacon"],
    });
  });
});
