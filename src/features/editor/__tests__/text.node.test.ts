// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  describePages,
  documentText,
  manuscriptPages,
  summarise,
  wordCount,
  WORDS_PER_MANUSCRIPT_PAGE,
} from "../text";

const doc = (...content: unknown[]) => ({ type: "doc", content: content as never });
const para = (...text: string[]) => ({
  type: "paragraph",
  content: text.map((t) => ({ type: "text", text: t })),
});

describe("documentText", () => {
  it("returns nothing for an empty or absent document", () => {
    expect(documentText(null)).toBe("");
    expect(documentText(undefined)).toBe("");
    expect(documentText(doc())).toBe("");
    expect(documentText(doc({ type: "paragraph" }))).toBe("");
  });

  it("separates blocks so their words do not run together", () => {
    // Without a break "…end of chapter" and "Chapter Two…" become "chapterChapter",
    // which then matches neither search term.
    const text = documentText(doc(para("end of chapter"), para("Chapter Two")));
    expect(text).toBe("end of chapter\n\nChapter Two");
    expect(text).not.toContain("chapterChapter");
  });

  it("keeps marked text, because a mark is not a word boundary", () => {
    const text = documentText(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "she was " },
          { type: "text", text: "furious", marks: [{ type: "em" }] },
          { type: "text", text: " about it" },
        ],
      }),
    );
    expect(text).toBe("she was furious about it");
  });

  it("breaks on a hard break", () => {
    const text = documentText(
      doc({
        type: "paragraph",
        content: [
          { type: "text", text: "first line" },
          { type: "hardBreak" },
          { type: "text", text: "second line" },
        ],
      }),
    );
    expect(text).toBe("first line\nsecond line");
  });

  it("walks nested structures", () => {
    const text = documentText(
      doc({
        type: "bulletList",
        content: [
          { type: "listItem", content: [para("one")] },
          { type: "listItem", content: [para("two")] },
        ],
      }),
    );
    expect(text.split("\n").filter(Boolean)).toEqual(["one", "two"]);
  });

  it("collapses runs of blank lines but keeps a paragraph break", () => {
    const text = documentText(doc(para("a"), { type: "paragraph" }, { type: "paragraph" }, para("b")));
    expect(text).toBe("a\n\nb");
  });

  it("ignores a node type it has never met rather than losing its text", () => {
    // Unknown nodes come from a newer client syncing down. Their words still count.
    const text = documentText(
      doc({ type: "sceneBreak", content: [{ type: "text", text: "* * *" }] }),
    );
    expect(text).toBe("* * *");
  });
});

describe("wordCount", () => {
  it("counts nothing in nothing", () => {
    expect(wordCount("")).toBe(0);
    expect(wordCount("   ")).toBe(0);
    expect(wordCount("\n\n")).toBe(0);
  });

  it("counts words, not spaces", () => {
    expect(wordCount("one")).toBe(1);
    expect(wordCount("one two three")).toBe(3);
    expect(wordCount("  one   two  ")).toBe(2);
    expect(wordCount("one\ntwo\nthree")).toBe(3);
  });

  it("treats a hyphenated compound as one word", () => {
    // Authors count it that way, and so does every program they compare against.
    expect(wordCount("a well-lit room")).toBe(3);
  });

  it("matches the compiler's whitespace word boundaries", () => {
    // Word and Scrivener both break on an em dash. Matching them means tidying
    // punctuation does not appear to change how much an author wrote that day.
    expect(wordCount("she stopped—then turned")).toBe(3);
    expect(wordCount("she stopped — then turned")).toBe(5);
    expect(wordCount("1914–1918 was long")).toBe(3);
  });

  it("still treats a hyphen as joining", () => {
    expect(wordCount("a well-lit room")).toBe(3);
    expect(wordCount("mother-in-law")).toBe(1);
  });

  it("counts non-Latin text", () => {
    expect(wordCount("привет мир")).toBe(2);
  });
});

describe("summarise", () => {
  it("returns the text and its count together", () => {
    expect(summarise(doc(para("one two"), para("three")))).toEqual({
      searchText: "one two\n\nthree",
      words: 3,
    });
  });

  it("is empty for an empty document", () => {
    expect(summarise(null)).toEqual({ searchText: "", words: 0 });
  });
});

describe("manuscript pages", () => {
  it("counts at the publishing convention, not at what fits on screen", () => {
    // 250 words a page: 12pt, double-spaced, one-inch margins. Two writers' page
    // counts have to be comparable, so this cannot depend on display settings — an
    // author reading in 19pt has not written a longer book.
    expect(WORDS_PER_MANUSCRIPT_PAGE).toBe(250);
    expect(manuscriptPages(250)).toBe(1);
    expect(manuscriptPages(500)).toBe(2);
  });

  it("rounds up, because a page with two words on it is still a page", () => {
    expect(manuscriptPages(1)).toBe(1);
    expect(manuscriptPages(251)).toBe(2);
  });

  it("calls nothing zero pages", () => {
    expect(manuscriptPages(0)).toBe(0);
    expect(describePages(0)).toBe("0 pages");
  });

  it("refuses to produce a page count from nonsense", () => {
    expect(manuscriptPages(Number.NaN)).toBe(0);
    expect(manuscriptPages(-40)).toBe(0);
  });

  it("says one page in the singular", () => {
    expect(describePages(1)).toBe("1 page");
    expect(describePages(600)).toBe("3 pages");
  });
});
