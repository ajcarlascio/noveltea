// @vitest-environment node
import { getSchema } from "@tiptap/core";
import { describe, expect, it } from "vitest";
import { EDITOR_EXTENSIONS } from "@/features/editor/schema";
import { documentText, wordCount } from "@/features/editor/text";
import {
  documentFromFile,
  documentFromMarkdown,
  documentFromPlainText,
  importExtension,
  isSafeHref,
  titleFromFileName,
  type Node,
} from "../markdown";

/**
 * The import reader, checked against the schema it has to satisfy.
 *
 * The assertion that matters most here is not any single construct: it is that
 * everything this produces survives `schema.nodeFromJSON`. The schema is a contract
 * with the server, and a document that does not satisfy it throws inside ProseMirror
 * on first render — which looks to an author like the import destroyed their file.
 */
const schema = getSchema(EDITOR_EXTENSIONS);

/** Fails loudly with the reason, rather than asserting a boolean that says nothing. */
function expectValid(doc: Node): void {
  expect(() => schema.nodeFromJSON(doc)).not.toThrow();
}

const types = (doc: Node): string[] => (doc.content ?? []).map((node) => node.type);

describe("plain text", () => {
  it("reads blank-line-separated blocks as paragraphs and joins wrapped lines", () => {
    const doc = documentFromPlainText(
      "The lighthouse stood\nagainst the weather.\n\nNobody had lit it in years.",
    );
    expect(types(doc)).toEqual(["paragraph", "paragraph"]);
    expect(documentText(doc)).toContain("The lighthouse stood against the weather.");
    expectValid(doc);
  });

  it("gives every line its own paragraph when the file has no blank line at all", () => {
    // A file shaped like this is a list, a poem or a hard-wrapped export. Joining it
    // into one paragraph is the more destructive of the two guesses.
    const doc = documentFromPlainText("First line\nSecond line\nThird line");
    expect(types(doc)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expectValid(doc);
  });

  it("leaves Markdown punctuation alone, because a .txt asterisk is an asterisk", () => {
    const doc = documentFromPlainText("she said *nothing* at all");
    expect(documentText(doc)).toBe("she said *nothing* at all");
    expect(doc.content?.[0]?.content?.[0]?.marks).toBeUndefined();
    expectValid(doc);
  });

  it("produces a valid document from an empty file rather than an empty doc", () => {
    // A doc with no content throws inside ProseMirror; an empty paragraph does not.
    const doc = documentFromPlainText("");
    expect(types(doc)).toEqual(["paragraph"]);
    expectValid(doc);
  });
});

describe("markdown blocks", () => {
  it("reads every block construct it claims to", () => {
    const doc = documentFromMarkdown(
      [
        "# Chapter One",
        "",
        "Prose in a paragraph.",
        "",
        "> A quoted line.",
        "",
        "- first",
        "- second",
        "",
        "1. one",
        "2. two",
        "",
        "```",
        "code stays code",
        "```",
        "",
        "---",
      ].join("\n"),
    );
    expect(types(doc)).toEqual([
      "heading",
      "paragraph",
      "blockquote",
      "bulletList",
      "orderedList",
      "codeBlock",
      "horizontalRule",
    ]);
    expect(doc.content?.[0]?.attrs?.level).toBe(1);
    expectValid(doc);
  });

  it("keeps a fenced block literal, marks and all", () => {
    const doc = documentFromMarkdown("```\n**not bold** and # not a heading\n```");
    expect(doc.content?.[0]?.type).toBe("codeBlock");
    expect(doc.content?.[0]?.content?.[0]?.text).toBe("**not bold** and # not a heading");
    expectValid(doc);
  });

  it("closes an unterminated fence at the end of the file instead of losing the text", () => {
    const doc = documentFromMarkdown("```\nthe author never closed this\n");
    expect(documentText(doc)).toContain("the author never closed this");
    expectValid(doc);
  });

  it("recurses into a blockquote, so a quoted list is still a list", () => {
    const doc = documentFromMarkdown("> - one\n> - two");
    expect(doc.content?.[0]?.type).toBe("blockquote");
    expect(doc.content?.[0]?.content?.[0]?.type).toBe("bulletList");
    expectValid(doc);
  });

  it("does not read a rule as a list item, or a list item as a rule", () => {
    expect(types(documentFromMarkdown("---"))).toEqual(["horizontalRule"]);
    expect(types(documentFromMarkdown("- item"))).toEqual(["bulletList"]);
    expect(types(documentFromMarkdown("***"))).toEqual(["horizontalRule"]);
  });

  it("ends a paragraph at a line that starts a block, without a blank line between", () => {
    const doc = documentFromMarkdown("Prose here.\n# A heading immediately after");
    expect(types(doc)).toEqual(["paragraph", "heading"]);
    expectValid(doc);
  });

  it("drops the decorative trailing hashes from a heading", () => {
    const doc = documentFromMarkdown("## Chapter Two ##");
    expect(documentText(doc)).toBe("Chapter Two");
  });
});

describe("markdown inline", () => {
  const marksOn = (doc: Node, index = 0): string[][] =>
    (doc.content?.[index]?.content ?? []).map((node) =>
      (node.marks ?? []).map((mark) => mark.type),
    );

  it("reads bold, italic, strikethrough and code", () => {
    const doc = documentFromMarkdown("a **b** c *d* e ~~f~~ g `h`");
    const flat = marksOn(doc).flat();
    expect(flat).toContain("bold");
    expect(flat).toContain("italic");
    expect(flat).toContain("strike");
    expect(flat).toContain("code");
    expect(documentText(doc)).toBe("a b c d e f g h");
    expectValid(doc);
  });

  it("reads a code span literally rather than looking inside it", () => {
    // Emphasis inside backticks is the author showing the syntax, not using it.
    const doc = documentFromMarkdown("use `**stars**` for bold");
    const bolded = (doc.content?.[0]?.content ?? []).filter((node) =>
      (node.marks ?? []).some((mark) => mark.type === "bold"),
    );
    expect(bolded).toEqual([]);
    expect(documentText(doc)).toBe("use **stars** for bold");
  });

  it("nests marks rather than letting the outer one win", () => {
    const doc = documentFromMarkdown("**bold with *italic* inside**");
    const both = (doc.content?.[0]?.content ?? []).find((node) => node.text === "italic");
    expect((both?.marks ?? []).map((mark) => mark.type).sort()).toEqual(["bold", "italic"]);
    expectValid(doc);
  });

  it("carries a safe link across and keeps its text", () => {
    const doc = documentFromMarkdown("see [the notes](https://example.com/notes)");
    const linked = (doc.content?.[0]?.content ?? []).find((node) =>
      (node.marks ?? []).some((mark) => mark.type === "link"),
    );
    expect(linked?.text).toBe("the notes");
    expect(linked?.marks?.[0]?.attrs?.href).toBe("https://example.com/notes");
    expectValid(doc);
  });

  it("keeps the words but drops the href when a link's scheme is not allowed", () => {
    for (const href of ["javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,x"]) {
      const doc = documentFromMarkdown(`click [here](${href})`);
      const marks = (doc.content?.[0]?.content ?? []).flatMap((node) =>
        (node.marks ?? []).map((mark) => mark.type),
      );
      expect(marks, `${href} must not become a link`).not.toContain("link");
      expect(documentText(doc)).toBe("click here");
    }
  });
});

describe("isSafeHref", () => {
  it("allows what the editor allows", () => {
    expect(isSafeHref("https://example.com")).toBe(true);
    expect(isSafeHref("http://example.com")).toBe(true);
    expect(isSafeHref("mailto:someone@example.com")).toBe(true);
    // Relative references are how a manuscript points at its own parts.
    expect(isSafeHref("#scene-two")).toBe(true);
    expect(isSafeHref("../chapter-one")).toBe(true);
  });

  it("refuses a scheme that can execute, including one hidden behind whitespace", () => {
    expect(isSafeHref("javascript:alert(1)")).toBe(false);
    expect(isSafeHref("  javascript:alert(1)")).toBe(false);
    expect(isSafeHref("java\tscript:alert(1)")).toBe(false);
    expect(isSafeHref("java script:alert(1)")).toBe(false);
    expect(isSafeHref("data:text/html,<script>")).toBe(false);
    expect(isSafeHref("")).toBe(false);
  });
});

describe("choosing a reader", () => {
  it("accepts the extensions it offers and refuses the rest", () => {
    expect(importExtension("chapter.md")).toBe("md");
    expect(importExtension("chapter.TXT")).toBe("txt");
    expect(importExtension("chapter.docx")).toBeNull();
    expect(importExtension("chapter")).toBeNull();
  });

  it("reads .md as Markdown and .txt as text, on the same source", () => {
    const source = "# Not a heading in a text file";
    expect(documentFromFile("a.md", source).content?.[0]?.type).toBe("heading");
    expect(documentFromFile("a.txt", source).content?.[0]?.type).toBe("paragraph");
  });

  it("makes a presentable title from a file name", () => {
    expect(titleFromFileName("chapter-one-draft.md")).toBe("chapter one draft");
    expect(titleFromFileName("Chapter_Two.txt")).toBe("Chapter Two");
    expect(titleFromFileName(".md")).toBe("Imported document");
  });
});

describe("what the rest of the app does with the result", () => {
  it("counts the words an author would count", () => {
    const doc = documentFromMarkdown("# Chapter One\n\nThe lighthouse stood alone.");
    // Two in the heading, four in the sentence. The heading is text in the manuscript
    // so it counts; the hashes are markup and are not.
    expect(wordCount(documentText(doc))).toBe(6);
  });

  it("produces a document every construct of which the schema accepts", () => {
    // The whole surface at once, because the schema is the contract that matters and
    // one unaccepted node is an editor that will not open.
    const doc = documentFromMarkdown(
      [
        "# H1", "## H2", "### H3", "#### H4", "##### H5", "###### H6",
        "", "Paragraph with **bold**, *italic*, ~~strike~~, `code` and [a link](https://x.test).",
        "", "> quoted", "", "- a", "- b", "", "1. a", "2. b", "", "```", "code", "```", "", "___",
      ].join("\n"),
    );
    expectValid(doc);
  });
});
