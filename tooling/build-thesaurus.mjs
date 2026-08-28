import { createWriteStream } from "node:fs";
import { mkdir, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// `fileURLToPath`, never `.pathname`: on Windows a file URL's pathname is
// `/D:/a/...` — a leading slash in front of a drive letter — which resolves to
// `D:\D:\a\...` and fails with ENOENT on a path that looks almost right.

/**
 * Builds a compact offline thesaurus from WordNet 3.0.
 *
 * The WordNet database is ~35MB and carries glosses, pointers and sense counts that
 * a thesaurus does not need. This keeps only what a synonym lookup uses, stores each
 * word once, and refers to words by index — which is most of the saving, because the
 * same word appears in many synsets.
 *
 *   words       sorted vocabulary, so a lookup is a binary search
 *   synsets     each an array of indices into `words`
 *   wordSynsets parallel to `words`: the synsets each word belongs to
 *
 * WordNet is distributed under Princeton University's licence, which permits use and
 * redistribution without fee provided the notice travels with it. The notice is
 * copied next to the generated file.
 */
const require = createRequire(import.meta.url);
const dict = require("wordnet-db").path;
const OUT_DIR = fileURLToPath(new URL("../public/thesaurus/", import.meta.url));

const POS_FILES = { n: "data.noun", v: "data.verb", a: "data.adj", r: "data.adv" };

/** WordNet escapes spaces as underscores and tags adjective positions as "(a)". */
function normalise(word) {
  return word.replace(/_/g, " ").replace(/\(\w+\)$/, "").toLowerCase();
}

async function readSynsets() {
  const synsets = [];
  for (const [pos, file] of Object.entries(POS_FILES)) {
    const text = await readFile(join(dict, file), "latin1");
    for (const line of text.split("\n")) {
      // Licence header lines start with two spaces; data lines start with an offset.
      if (line.length === 0 || line.startsWith("  ")) continue;
      const [fields] = line.split("|");
      const parts = fields.trim().split(/\s+/);
      // synset_offset lex_filenum ss_type w_cnt word lex_id ...
      const wordCount = Number.parseInt(parts[3], 16);
      if (!Number.isFinite(wordCount) || wordCount < 1) continue;

      const words = [];
      for (let i = 0; i < wordCount; i += 1) {
        const word = parts[4 + i * 2];
        if (word) words.push(normalise(word));
      }
      // A synset of one word offers no synonym; keeping it only adds bytes.
      const unique = [...new Set(words)];
      if (unique.length > 1) synsets.push({ pos, words: unique });
    }
  }
  return synsets;
}

const synsets = await readSynsets();

// Vocabulary, sorted so the client can binary-search it.
const vocabulary = [...new Set(synsets.flatMap((s) => s.words))].sort();
const indexOfWord = new Map(vocabulary.map((word, i) => [word, i]));

const encodedSynsets = synsets.map((s) => s.words.map((w) => indexOfWord.get(w)));
const wordSynsets = vocabulary.map(() => []);
encodedSynsets.forEach((words, synsetId) => {
  for (const wordId of words) wordSynsets[wordId].push(synsetId);
});

await mkdir(OUT_DIR, { recursive: true });
const path = join(OUT_DIR, "wordnet.json");
const stream = createWriteStream(path);

// Streamed rather than one JSON.stringify: the whole structure is larger than the
// default string limit is comfortable with, and this keeps peak memory flat.
stream.write('{"source":"WordNet 3.0, Princeton University","words":');
stream.write(JSON.stringify(vocabulary));
stream.write(',"pos":');
stream.write(JSON.stringify(synsets.map((s) => s.pos).join("")));
stream.write(',"synsets":[');
encodedSynsets.forEach((words, i) => {
  if (i > 0) stream.write(",");
  stream.write(JSON.stringify(words));
});
stream.write('],"wordSynsets":[');
wordSynsets.forEach((ids, i) => {
  if (i > 0) stream.write(",");
  stream.write(JSON.stringify(ids));
});
stream.write("]}");
await new Promise((resolve, reject) => {
  stream.end(resolve);
  stream.on("error", reject);
});

const licence = await readFile(join(dict, "..", "LICENSE"), "utf8").catch(() =>
  readFile(fileURLToPath(new URL("../node_modules/wordnet-db/LICENSE", import.meta.url)), "utf8"),
);
await import("node:fs/promises").then((fs) =>
  fs.writeFile(join(OUT_DIR, "WORDNET-LICENSE.txt"), licence),
);

const { size } = await stat(path);
console.log(
  `${vocabulary.length} words, ${encodedSynsets.length} synsets -> ${(size / 1e6).toFixed(1)}MB at ${path}`,
);
