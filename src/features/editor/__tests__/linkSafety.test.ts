import { Editor } from "@tiptap/core";
import { afterEach, describe, expect, it } from "vitest";
import { EDITOR_EXTENSIONS } from "../schema";

/**
 * Link hrefs are allowlisted, not escaped.
 *
 * There is nothing in `javascript:alert(1)` to escape — escaping is the wrong tool
 * entirely. The editor permits http, https and mailto and refuses the rest, matching
 * the rule the server applies when it serialises a document for export. A link that
 * survives here but is stripped there is a formatting difference; one that survives
 * both is an execution vector in whatever renders the manuscript.
 *
 * Driven through a real editor rather than by inspecting configuration, because what
 * matters is whether the mark is applied, not what an options object claims.
 */
let editor: Editor | null = null;

afterEach(() => {
  editor?.destroy();
  editor = null;
});

function withLink(href: string): string | null {
  // Destroyed before being replaced. ProseMirror's DOMObserver keeps a timer, and an
  // editor left running past the end of a test fires it after the environment is torn
  // down — "document is not defined", from a test that already reported a pass.
  editor?.destroy();
  editor = new Editor({ extensions: EDITOR_EXTENSIONS, content: "<p>a link</p>" });
  editor.commands.selectAll();
  editor.commands.setLink({ href });

  // getJSON is loosely typed; narrow it here rather than reaching through `any`.
  interface JsonMark {
    type?: string;
    attrs?: Record<string, unknown>;
  }
  interface JsonNode {
    marks?: JsonMark[];
    content?: JsonNode[];
  }

  const json = editor.getJSON() as JsonNode;
  const marks = json.content?.[0]?.content?.[0]?.marks ?? [];
  const applied = marks.find((mark) => mark.type === "link")?.attrs?.href;
  return typeof applied === "string" ? applied : null;
}

describe("permitted protocols", () => {
  it.each(["https://example.com/x", "http://example.com", "mailto:author@example.com"])(
    "keeps %s",
    (href) => {
      expect(withLink(href)).toBe(href);
    },
  );

  it("keeps a relative reference", () => {
    // Relative links are how a manuscript points at its own parts.
    expect(withLink("/chapters/one")).toBe("/chapters/one");
  });
});

describe("refused protocols", () => {
  const CONTROL_CHAR = String.fromCharCode(9); // tab, stripped by browsers before resolving

  it.each([
    "javascript:alert(1)",
    "JaVaScRiPt:alert(1)",
    "  javascript:alert(1)",
    "data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==",
    "vbscript:msgbox(1)",
    "file:///etc/passwd",
  ])("refuses %s", (href) => {
    // Fails closed: no mark rather than a sanitised one, so nothing downstream has to
    // decide what a half-trusted href means.
    expect(withLink(href)).toBeNull();
  });

  it("is not fooled by whitespace inside the scheme", () => {
    // A browser strips these before resolving, so "java<TAB>script:" executes.
    expect(withLink("java script:alert(1)")).toBeNull();
    expect(withLink(`java${CONTROL_CHAR}script:alert(1)`)).toBeNull();
  });
});
