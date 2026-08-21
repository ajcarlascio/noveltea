import type { LookupKind, LookupProvider, LookupResult } from "./types";

/**
 * The offline thesaurus: WordNet 3.0, on this device.
 *
 * The index is fetched once, on the first lookup, and held in memory. It is not
 * bundled: it is ~1.3MB compressed and most sessions never open a thesaurus, so
 * paying for it at startup would slow every launch for a minority of uses.
 *
 * The shape it loads is described in `tooling/build-thesaurus.mjs`. Words are stored
 * once and referred to by index, which is where most of the compression comes from.
 */

interface Index {
  source: string;
  /** Sorted, so a lookup is a binary search. */
  words: string[];
  /** One character per synset: n, v, a, r. */
  pos: string;
  synsets: number[][];
  wordSynsets: number[][];
}

/** Sorted-array lookup. The vocabulary is ~110k words; a linear scan is wasteful. */
function findWord(words: readonly string[], target: string): number {
  let low = 0;
  let high = words.length - 1;
  while (low <= high) {
    // (low + high) can be written without risk of overflow here, but the shifted
    // form is the habit worth keeping in code that indexes arrays.
    const middle = low + ((high - low) >> 1);
    const value = words[middle]!;
    if (value === target) return middle;
    if (value < target) low = middle + 1;
    else high = middle - 1;
  }
  return -1;
}

export interface ThesaurusOptions {
  /** Where the index lives. Overridden in tests. */
  url?: string;
  fetcher?: typeof fetch;
  /** Whether the author has the feature switched on. */
  enabled: () => boolean;
}

export function offlineThesaurus({
  url = "/thesaurus/wordnet.json",
  fetcher = fetch,
  enabled,
}: ThesaurusOptions): LookupProvider {
  let index: Index | null = null;
  let loading: Promise<Index> | null = null;

  async function load(): Promise<Index> {
    if (index !== null) return index;
    // One load even if several lookups race: a second fetch of 1.3MB is pure waste.
    loading ??= (async () => {
      const response = await fetcher(url);
      if (!response.ok) {
        throw new Error(`The thesaurus could not be loaded (${String(response.status)}).`);
      }
      index = (await response.json()) as Index;
      return index;
    })();

    try {
      return await loading;
    } catch (error) {
      // Cleared so a later attempt can retry rather than replaying the failure.
      loading = null;
      throw error;
    }
  }

  return {
    id: "wordnet",
    kinds: ["synonym"],
    available: enabled,

    async look(word: string, kind: LookupKind): Promise<LookupResult> {
      if (kind !== "synonym") {
        throw new Error("The offline thesaurus only offers synonyms.");
      }
      const data = await load();
      const normalised = word.trim().toLowerCase();
      const at = findWord(data.words, normalised);

      const synonyms = new Set<string>();
      if (at !== -1) {
        for (const synsetId of data.wordSynsets[at] ?? []) {
          for (const wordId of data.synsets[synsetId] ?? []) {
            const candidate = data.words[wordId];
            if (candidate !== undefined && candidate !== normalised) synonyms.add(candidate);
          }
        }
      }

      return {
        word: normalised,
        kind: "synonym",
        words: [...synonyms],
        source: data.source,
        // The whole point of this provider.
        wasNetworked: false,
      };
    },
  };
}
