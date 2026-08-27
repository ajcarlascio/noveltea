/**
 * Turning a text or Markdown file into a document this editor can hold.
 *
 * The only direction that did not exist. `packages/compile` walks a ProseMirror
 * document out to txt, md and html; nothing walked one back in, so an author with
 * a chapter already written had no way to bring it here short of pasting it.
 *
 * **Local, and therefore offline.** This is string parsing and nothing else: no
 * fetch, no worker, no server. Making it wait for a connection would break the
 * first invariant this app has — the UI never awaits the network — for no gain,
 * since there is nothing on the other end to ask. A format that genuinely needs a
 * converter (DOCX and the rest) is a different feature with a different answer.
 *
 * **Deliberately not a CommonMark implementation.** It handles the constructs
 * prose actually uses, listed in {@link SUPPORTED}, and anything it does not
 * recognise survives as the text it was rather than being dropped. That trade is
 * the same one `packages/compile` makes in the other direction: the words always
 * survive, the formatting is best-effort. What it does not do is guess — there is
 * no construct here that is parsed one way in one place and another way elsewhere.
 *
 * The output is checked against the editor's own schema in the tests, because the
 * schema is a contract with the server and a document that does not satisfy it
 * throws inside ProseMirror on first render.
 */

/** A ProseMirror node, in the JSON shape the replica stores. */
export interface Node {
  type: string;
  attrs?: Record<string, unknown>;
  content?: Node[];
  marks?: { type: string; attrs?: Record<string, unknown> }[];
  text?: string;
}

/** What the Markdown reader understands. Anything else arrives as its own text. */
export const SUPPORTED = [
  "headings (#…######)",
  "blockquotes (>)",
  "bullet and numbered lists, one level",
  "fenced code blocks (``` and ~~~)",
  "horizontal rules (---, ***, ___)",
  "bold, italic, strikethrough, inline code, links",
] as const;

/** The schemes the editor allows on a link. A Markdown file is untrusted input. */
const SAFE_SCHEMES = ["http:", "https:", "mailto:"];

/**
 * Whether a link may be carried across.
 *
 * Allowlisted rather than escaped, exactly as the editor and the export pipeline
 * do it: there is nothing in `javascript:alert(1)` that escaping fixes. A refused
 * link keeps its text and loses only the href, so the sentence still reads.
 */
export function isSafeHref(href: string): boolean {
  const normalised = href
    // Control characters and whitespace are ignored by URL parsers but defeat a naive
    // check, which is how `java\tscript:` gets through one.
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0020\u007f-\u009f]/g, "")
    .toLowerCase();
  if (normalised === "") return false;
  if (normalised.startsWith("#") || normalised.startsWith("/") || normalised.startsWith("./")
      || normalised.startsWith("../")) {
    return true;
  }
  const scheme = /^([a-z][a-z0-9+.-]*:)/.exec(normalised);
  if (scheme === null) return true; // no scheme at all: a relative reference
  return scheme[1] !== undefined && SAFE_SCHEMES.includes(scheme[1]);
}

/* -------------------------------------------------------------------------- */
/* Inline                                                                      */
/* -------------------------------------------------------------------------- */

type Mark = { type: string; attrs?: Record<string, unknown> };

const text = (value: string, marks: Mark[]): Node =>
  marks.length > 0 ? { type: "text", text: value, marks } : { type: "text", text: value };

/**
 * Reads one line of inline Markdown into text nodes.
 *
 * Code spans are matched before everything else and do not recurse, because a
 * backtick run is meant to be read literally — `**not bold**` inside one is four
 * asterisks and two words, and treating it otherwise silently edits the author.
 */
function inline(source: string, marks: Mark[] = []): Node[] {
  if (source === "") return [];

  // Order is load-bearing twice over. The earliest match in the line wins, and ties
  // go to whichever pattern is listed first — which is how `**` is read as bold
  // rather than as an italic run that happens to start with an asterisk. The bodies
  // are lazy and allow their own delimiter inside, so emphasis nests instead of
  // failing to match and arriving as literal punctuation.
  //
  // The `_` forms carry word-boundary guards that the `*` forms do not need:
  // snake_case_names appear in prose about code often enough that reading them as
  // emphasis would be a visible wrong answer, and CommonMark declines them too.
  const patterns: { re: RegExp; mark?: Mark; literal?: boolean; href?: boolean }[] = [
    { re: /`([^`]+)`/, literal: true },
    // The href allows one level of balanced parentheses, so a URL that ends in `(1)`
    // is not truncated at its first bracket — which would leave the stray `)` in the
    // author's sentence.
    { re: /\[([^\]]*)\]\(([^()\s]*(?:\([^()]*\)[^()\s]*)*)\)/, href: true },
    { re: /\*\*([\s\S]+?)\*\*/, mark: { type: "bold" } },
    { re: /(?<!\w)__([\s\S]+?)__(?!\w)/, mark: { type: "bold" } },
    { re: /~~([\s\S]+?)~~/, mark: { type: "strike" } },
    { re: /\*([\s\S]+?)\*/, mark: { type: "italic" } },
    { re: /(?<!\w)_([\s\S]+?)_(?!\w)/, mark: { type: "italic" } },
  ];

  let earliest: { index: number; match: RegExpExecArray; spec: (typeof patterns)[number] } | null =
    null;
  for (const spec of patterns) {
    const match = spec.re.exec(source);
    if (match !== null && (earliest === null || match.index < earliest.index)) {
      earliest = { index: match.index, match, spec };
    }
  }

  if (earliest === null) return [text(source, marks)];

  const { match, spec } = earliest;
  const before = source.slice(0, match.index);
  const after = source.slice(match.index + match[0].length);
  const nodes: Node[] = [];
  if (before !== "") nodes.push(text(before, marks));

  const inner = match[1] ?? "";
  if (spec.literal === true) {
    if (inner !== "") nodes.push(text(inner, [...marks, { type: "code" }]));
  } else if (spec.href === true) {
    const href = match[2] ?? "";
    // A refused or empty href leaves the label as ordinary text. The words are the
    // part worth keeping; a link that cannot be trusted is not.
    const linked = href !== "" && isSafeHref(href);
    const label = inner === "" ? href : inner;
    if (label !== "") {
      nodes.push(...inline(label, linked ? [...marks, { type: "link", attrs: { href } }] : marks));
    }
  } else if (spec.mark !== undefined) {
    nodes.push(...inline(inner, [...marks, spec.mark]));
  }

  nodes.push(...inline(after, marks));
  return nodes;
}

const paragraph = (source: string): Node => {
  const content = inline(source);
  return content.length > 0 ? { type: "paragraph", content } : { type: "paragraph" };
};

/* -------------------------------------------------------------------------- */
/* Blocks                                                                      */
/* -------------------------------------------------------------------------- */

const FENCE = /^\s{0,3}(```|~~~)/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])(\s*\1){2,}\s*$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;
const BULLET = /^\s{0,3}[-*+]\s+(.*)$/;
const ORDERED = /^\s{0,3}\d{1,9}[.)]\s+(.*)$/;
const BLANK = /^\s*$/;

/** Turns Markdown source into the document body. */
function markdownBlocks(source: string): Node[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: Node[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";

    if (BLANK.test(line)) {
      i += 1;
      continue;
    }

    // A fence wins over everything: its contents are not Markdown.
    const fence = FENCE.exec(line);
    if (fence !== null) {
      const marker = fence[1] ?? "```";
      const body: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith(marker)) {
        body.push(lines[i] ?? "");
        i += 1;
      }
      // An unterminated fence runs to the end of the file rather than failing: the
      // author's text is still their text, whatever the fence was doing.
      i += 1;
      out.push(
        body.length > 0
          ? { type: "codeBlock", content: [{ type: "text", text: body.join("\n") }] }
          : { type: "codeBlock" },
      );
      continue;
    }

    if (RULE.test(line)) {
      out.push({ type: "horizontalRule" });
      i += 1;
      continue;
    }

    const heading = HEADING.exec(line);
    if (heading !== null) {
      const level = (heading[1] ?? "#").length;
      // Trailing hashes are decoration in ATX headings, not part of the title.
      const title = (heading[2] ?? "").replace(/\s*#+\s*$/, "");
      out.push({ type: "heading", attrs: { level }, content: inline(title) });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote !== null) {
      const body: string[] = [];
      while (i < lines.length) {
        const inner = QUOTE.exec(lines[i] ?? "");
        if (inner === null) break;
        body.push(inner[1] ?? "");
        i += 1;
      }
      // Recursing means a quoted heading or list is still one, which is what a
      // reader of the source would expect.
      out.push({ type: "blockquote", content: blocksOrEmptyParagraph(body.join("\n")) });
      continue;
    }

    const bullet = BULLET.exec(line);
    const ordered = ORDERED.exec(line);
    if (bullet !== null || ordered !== null) {
      const pattern = bullet !== null ? BULLET : ORDERED;
      const items: Node[] = [];
      while (i < lines.length) {
        const item = pattern.exec(lines[i] ?? "");
        if (item === null) break;
        items.push({ type: "listItem", content: [paragraph(item[1] ?? "")] });
        i += 1;
      }
      out.push({
        type: bullet !== null ? "bulletList" : "orderedList",
        ...(ordered !== null ? { attrs: { start: 1 } } : {}),
        content: items,
      });
      continue;
    }

    // Anything else is a paragraph, running until a blank line or a line that
    // starts a block of its own. Hard-wrapped prose joins with a space, which is
    // what a wrapped line means in a manuscript.
    const body: string[] = [];
    while (i < lines.length) {
      const next = lines[i] ?? "";
      if (BLANK.test(next) || startsBlock(next)) break;
      body.push(next.trim());
      i += 1;
    }
    out.push(paragraph(body.join(" ")));
  }

  return out;
}

function startsBlock(line: string): boolean {
  return (
    FENCE.test(line) ||
    RULE.test(line) ||
    HEADING.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line)
  );
}

function blocksOrEmptyParagraph(source: string): Node[] {
  const blocks = markdownBlocks(source);
  // Every container in the schema needs at least one child, and an empty one
  // throws inside ProseMirror rather than rendering as nothing.
  return blocks.length > 0 ? blocks : [{ type: "paragraph" }];
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Reads plain text, where the only structure available is the blank line.
 *
 * A file that uses blank lines between paragraphs is read that way, and lines
 * wrapped inside a paragraph are joined with a space. A file with no blank line
 * anywhere is one paragraph per line instead — that shape is a list, a poem or a
 * hard-wrapped export, and joining it into a single wall of text would be the
 * more destructive guess of the two.
 *
 * No Markdown is applied: an asterisk in a .txt file is an asterisk.
 */
export function documentFromPlainText(source: string): Node {
  const normalised = source.replace(/\r\n?/g, "\n");
  const paragraphs = /\n[ \t]*\n/.test(normalised)
    ? normalised.split(/\n[ \t]*\n+/).map((block) =>
        block.split("\n").map((line) => line.trim()).filter((line) => line !== "").join(" "),
      )
    : normalised.split("\n").map((line) => line.trim());

  const content = paragraphs
    .filter((block) => block !== "")
    .map((block) => ({ type: "paragraph", content: [{ type: "text", text: block }] }));

  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph" }] };
}

/** Reads Markdown into a document. */
export function documentFromMarkdown(source: string): Node {
  return { type: "doc", content: blocksOrEmptyParagraph(source) };
}

/** The extensions this reader accepts, lower-case and without the dot. */
export const IMPORT_EXTENSIONS = ["txt", "md", "markdown", "text"] as const;

export function importExtension(fileName: string): string | null {
  const dot = fileName.lastIndexOf(".");
  if (dot === -1 || dot === fileName.length - 1) return null;
  const ext = fileName.slice(dot + 1).toLowerCase();
  return (IMPORT_EXTENSIONS as readonly string[]).includes(ext) ? ext : null;
}

/** A presentable document title from a file name. */
export function titleFromFileName(fileName: string): string {
  const dot = fileName.lastIndexOf(".");
  // dot === 0 is a name that is nothing but an extension (".md"). It has no stem to
  // present, so it falls through to the default rather than titling the document ".md".
  const stem = dot > 0 ? fileName.slice(0, dot) : dot === 0 ? "" : fileName;
  const tidied = stem.replace(/[-_]+/g, " ").replace(/\s+/g, " ").trim();
  return tidied === "" ? "Imported document" : tidied;
}

/**
 * Reads a file's contents into a document, choosing the reader by extension.
 *
 * `.md` is read as Markdown; everything else this accepts is read as plain text,
 * because applying Markdown to a file that was never Markdown turns an author's
 * asterisks into emphasis they did not ask for.
 */
export function documentFromFile(fileName: string, source: string): Node {
  const ext = importExtension(fileName);
  return ext === "md" || ext === "markdown"
    ? documentFromMarkdown(source)
    : documentFromPlainText(source);
}
