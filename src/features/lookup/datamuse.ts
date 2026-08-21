import type { KeyStore } from "./keys";
import type { LookupKind, LookupProvider, LookupResult } from "./types";

/**
 * Datamuse: rhymes, near-matches and associations a dictionary cannot give.
 *
 * This is the only code in NovelTea that sends an author's words to a third party,
 * and it is written so that it cannot do so by accident:
 *
 * - `consented()` is checked immediately before the request, not at construction.
 *   Withdrawing consent takes effect on the very next lookup rather than at the next
 *   reload.
 * - Only the single term is sent. Never the sentence around it, never the document,
 *   never an identifier. There is nothing in the request that says who asked.
 * - It is only ever called from an explicit lookup. Nothing here runs on a timer, on
 *   a keystroke, or ahead of a request the author has not made.
 */

const ENDPOINT = "https://api.datamuse.com/words";

const PARAMETER: Record<LookupKind, string> = {
  synonym: "rel_syn",
  related: "ml",
  rhyme: "rel_rhy",
};

export interface DatamuseOptions {
  /** Consent *and* the switch. Read at call time, deliberately. */
  consented: () => boolean;
  keys?: KeyStore;
  fetcher?: typeof fetch;
  endpoint?: string;
}

export class ConsentRequired extends Error {
  constructor() {
    super("Datamuse lookups are turned off. Turn them on in Settings to use them.");
    this.name = "ConsentRequired";
  }
}

export function datamuseLookup({
  consented,
  keys,
  fetcher = fetch,
  endpoint = ENDPOINT,
}: DatamuseOptions): LookupProvider {
  return {
    id: "datamuse",
    kinds: ["synonym", "related", "rhyme"],
    available: consented,

    async look(word: string, kind: LookupKind): Promise<LookupResult> {
      // Before anything is built, let alone sent.
      if (!consented()) throw new ConsentRequired();

      const term = word.trim().toLowerCase();
      if (term.length === 0) {
        return { word: term, kind, words: [], source: "Datamuse", wasNetworked: false };
      }

      const url = new URL(endpoint);
      url.searchParams.set(PARAMETER[kind], term);
      url.searchParams.set("max", "24");

      const key = (await keys?.get("datamuse")) ?? null;
      if (key !== null && key.length > 0) url.searchParams.set("key", key);

      const response = await fetcher(url.toString(), {
        // No cookies, no credentials: there is nothing to authenticate and nothing
        // that should identify the author.
        credentials: "omit",
        referrerPolicy: "no-referrer",
      });
      if (!response.ok) {
        throw new Error(`Datamuse could not answer (${String(response.status)}).`);
      }

      const payload: unknown = await response.json();
      const words = Array.isArray(payload)
        ? payload
            .map((entry) =>
              entry !== null && typeof entry === "object" && "word" in entry
                ? (entry as { word: unknown }).word
                : null,
            )
            .filter((value): value is string => typeof value === "string")
        : [];

      return { word: term, kind, words, source: "Datamuse (datamuse.com)", wasNetworked: true };
    },
  };
}
