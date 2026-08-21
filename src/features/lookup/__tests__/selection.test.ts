import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { EDITOR_EXTENSIONS } from "@/features/editor/schema";
import { wordAtSelection } from "../selection";

let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function open(html: string): Editor {
  editor = new Editor({ extensions: EDITOR_EXTENSIONS, content: html });
  return editor;
}

describe("wordAtSelection", () => {
  it("returns nothing without an editor", () => {
    expect(wordAtSelection(null)).toBe("");
  });

  it("takes the word the cursor sits at the end of", () => {
    // The commonest position while writing, and the one an unclamped read of the
    // surrounding text throws on, because it looks past the end of the document.
    const e = open("<p>She was furious</p>");
    e.commands.focus("end");
    expect(wordAtSelection(e)).toBe("furious");
  });

  it("takes the word the cursor sits at the start of", () => {
    const e = open("<p>furious indeed</p>");
    e.commands.focus("start");
    expect(wordAtSelection(e)).toBe("furious");
  });

  /** In a single-paragraph document a text offset is one less than the position. */
  const insideWord = (e: Editor, word: string, chars = 1) =>
    e.state.doc.textContent.indexOf(word) + 1 + chars;

  it("takes the word the cursor is inside", () => {
    const e = open("<p>She was furious today</p>");
    e.commands.setTextSelection(insideWord(e, "furious", 3));
    expect(wordAtSelection(e)).toBe("furious");
  });

  it("prefers an explicit selection over the word under the cursor", () => {
    const e = open("<p>She was furious today</p>");
    e.commands.setTextSelection({ from: 1, to: 8 });
    expect(wordAtSelection(e)).toBe("She was");
  });

  it("keeps an apostrophe and a hyphen inside the word", () => {
    const e = open("<p>a well-lit room</p>");
    e.commands.setTextSelection(insideWord(e, "well-lit", 4));
    expect(wordAtSelection(e)).toBe("well-lit");
  });

  it("returns nothing in an empty document", () => {
    const e = open("<p></p>");
    e.commands.focus("end");
    expect(wordAtSelection(e)).toBe("");
  });

  it("works far from the start, where the window is clamped at the other end", () => {
    const e = open(`<p>${"filler ".repeat(30)}lighthouse</p>`);
    e.commands.focus("end");
    expect(wordAtSelection(e)).toBe("lighthouse");
  });
});
