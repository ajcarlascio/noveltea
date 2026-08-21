/**
 * Plain text and a word count, taken from ProseMirror JSON.
 *
 * The client does this because only the client parses documents — the JVM stores
 * `document.content` as opaque jsonb and never walks it. `document.search_text` is
 * what offline search matches against and what the server is given on push, so it
 * has to be produced here or it does not exist.
 */

export interface ProseMirrorNode {
  type?: string;
  text?: string;
  content?: ProseMirrorNode[];
}

/** Node types that end a block, so their text does not run into the next one's. */
const BLOCK_TYPES = new Set([
  "paragraph",
  "heading",
  "blockquote",
  "listItem",
  "codeBlock",
  "horizontalRule",
]);

/**
 * Flattens a document to text, one block per line.
 *
 * Block separation matters: without it "end of chapter" and "Chapter Two" run
 * together into "chapterChapter", which then matches neither search term.
 */
export function documentText(doc: ProseMirrorNode | null | undefined): string {
  if (!doc) return "";
  const parts: string[] = [];

  const walk = (node: ProseMirrorNode): void => {
    if (typeof node.text === "string") parts.push(node.text);
    if (node.type === "hardBreak") parts.push("\n");
    for (const child of node.content ?? []) walk(child);
    if (node.type !== undefined && BLOCK_TYPES.has(node.type)) parts.push("\n");
  };

  walk(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Words, counted the way an author counts them.
 *
 * Whitespace separates, and so do en and em dashes — which is what Word and
 * Scrivener do, and those are the numbers an author compares against. It also makes
 * the count independent of a habit: "stopped—then" and "stopped — then" are four
 * words either way, so tidying punctuation does not appear to change the day's work.
 *
 * A hyphen does not separate: "well-lit" is one word to everyone who counts.
 *
 * Deliberately not a locale-aware segmenter. Intl.Segmenter would count Chinese by
 * character and change every existing total, and the familiar number is the useful
 * one here.
 */
const WORD_SEPARATORS = /[\s\u2013\u2014]+/u;

export function wordCount(text: string): number {
  const trimmed = text.trim();
  if (trimmed.length === 0) return 0;
  return trimmed.split(WORD_SEPARATORS).filter((word) => word.length > 0).length;
}

/** Both, from a document, in one walk of the tree. */
export function summarise(doc: ProseMirrorNode | null | undefined): {
  searchText: string;
  words: number;
} {
  const searchText = documentText(doc);
  return { searchText, words: wordCount(searchText) };
}
