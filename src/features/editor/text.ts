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
  "list_item",
  "codeBlock",
  "code_block",
  "horizontalRule",
  "horizontal_rule",
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
    if (node.type === "hardBreak" || node.type === "hard_break") parts.push("\n");
    for (const child of node.content ?? []) walk(child);
    if (node.type !== undefined && BLOCK_TYPES.has(node.type)) parts.push("\n\n");
  };

  walk(doc);
  return parts.join("").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Words, counted the same way as the server compiler.
 *
 * Whitespace separates words. Keeping this rule identical to the compiler means the
 * editor count and exported manuscript count cannot disagree.
 *
 * A hyphen does not separate: "well-lit" is one word to everyone who counts.
 *
 * Deliberately not a locale-aware segmenter. Intl.Segmenter would count Chinese by
 * character and change every existing total, and the familiar number is the useful
 * one here.
 */
const WORD_SEPARATORS = /\s+/u;

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

/**
 * Words on a standard manuscript page.
 *
 * 250 is the publishing convention — 12pt, double-spaced, one-inch margins, which is
 * what a submission is expected to look like. It is not what fits on this screen, and
 * it deliberately does not move when an author changes their reading font or size:
 * "how long is my book" has an answer the industry already agreed on, and making it
 * depend on personal display settings would make two writers' page counts
 * incomparable.
 */
export const WORDS_PER_MANUSCRIPT_PAGE = 250;

/**
 * Manuscript pages, rounded up.
 *
 * Anything at all is one page, because a page with two words on it is still a page an
 * editor has to turn. Zero words is zero pages.
 */
export function manuscriptPages(words: number): number {
  if (!Number.isFinite(words) || words <= 0) return 0;
  return Math.ceil(words / WORDS_PER_MANUSCRIPT_PAGE);
}

/** "1 page" / "12 pages", for a count an author glances at. */
export function describePages(words: number): string {
  const pages = manuscriptPages(words);
  return pages === 1 ? "1 page" : `${String(pages)} pages`;
}
