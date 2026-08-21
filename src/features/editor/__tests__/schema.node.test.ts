// @vitest-environment node
import { readFileSync } from "node:fs";
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { EDITOR_EXTENSIONS, EMPTY_DOCUMENT } from "../schema";

/**
 * The editor's schema against the server's compile package.
 *
 * These are two halves of one contract: this editor produces ProseMirror JSON and
 * `packages/compile` serialises it to txt, md and html. A node or mark compile has
 * never met is dropped to plain text with a warning — the words survive, the
 * formatting does not, and nobody finds out until an author opens their manuscript.
 *
 * Read from the submodule's source rather than imported, so this needs no second
 * workspace and no ProseMirror copy on the client's dependency tree.
 */
const compileSource = (file: string) =>
  readFileSync(`vendor/noveltea-server/packages/compile/src/${file}`, "utf8");

function knownMarks(): Set<string> {
  const block = /export const MARK_ALIASES[^=]*= \{([\s\S]*?)\};/.exec(compileSource("text.ts"));
  if (!block?.[1]) throw new Error("MARK_ALIASES not found — has compile/src/text.ts moved?");
  return new Set([...block[1].matchAll(/^\s*([A-Za-z]+)\s*:/gm)].map((m) => m[1]!));
}

function knownNodes(): Set<string> {
  // compile handles these by name across its serialisers.
  const sources = ["text.ts", "html.ts", "markdown.ts", "plain.ts"]
    .map((file) => {
      try {
        return compileSource(file);
      } catch {
        return "";
      }
    })
    .join("\n");
  const names = new Set<string>();
  for (const match of sources.matchAll(
    /"(doc|paragraph|text|heading|blockquote|bulletList|orderedList|listItem|codeBlock|horizontalRule|hardBreak)"/g,
  )) {
    names.add(match[1]!);
  }
  return names;
}

const schema = getSchema(EDITOR_EXTENSIONS);

describe("the compile contract", () => {
  it("reads a real alias table from the server package", () => {
    // Guards the assertions below: a regex that silently matched nothing would make
    // every one of them pass against an empty set.
    const marks = knownMarks();
    expect(marks.size).toBeGreaterThan(5);
    expect(marks).toContain("bold");
    expect(knownNodes().size).toBeGreaterThan(8);
  });

  it("produces no mark compile cannot serialise", () => {
    const marks = knownMarks();
    const unknown = Object.keys(schema.marks).filter((name) => !marks.has(name));
    expect(unknown, `marks compile would drop: ${unknown.join(", ")}`).toEqual([]);
  });

  it("produces no node compile cannot serialise", () => {
    const nodes = knownNodes();
    const unknown = Object.keys(schema.nodes).filter((name) => !nodes.has(name));
    expect(unknown, `nodes compile would drop: ${unknown.join(", ")}`).toEqual([]);
  });

  it("offers the formatting a manuscript actually uses", () => {
    // The inverse direction: a schema that shipped nothing would satisfy the two
    // tests above perfectly.
    for (const mark of ["bold", "italic", "strike", "code", "link", "underline"]) {
      expect(Object.keys(schema.marks), `missing mark: ${mark}`).toContain(mark);
    }
    for (const node of ["paragraph", "heading", "blockquote", "bulletList", "orderedList"]) {
      expect(Object.keys(schema.nodes), `missing node: ${node}`).toContain(node);
    }
  });
});

describe("the empty document", () => {
  it("is valid against the schema", () => {
    // An invalid starting document throws inside ProseMirror on first render, which
    // looks like the editor being broken rather than one constant being wrong.
    expect(() => schema.nodeFromJSON(EMPTY_DOCUMENT)).not.toThrow();
  });
});
