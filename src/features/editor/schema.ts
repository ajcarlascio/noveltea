import StarterKit from "@tiptap/starter-kit";
import type { Extensions } from "@tiptap/react";

/**
 * The document schema, declared once.
 *
 * This is a **contract with the server**, not an editor preference. `packages/compile`
 * serialises the same ProseMirror JSON to txt, md and html, and it recognises a fixed
 * set of node and mark names. Anything this editor can produce that compile has not
 * met is dropped to plain text on export with a warning — the author's words survive,
 * their formatting does not. `schema.node.test.ts` checks the two agree.
 */
export const EDITOR_EXTENSIONS: Extensions = [
  StarterKit.configure({
    // History is per-document; 100 steps is more than an author undoes in a sitting
    // and bounds what a long session holds in memory.
    undoRedo: { depth: 100 },
    link: {
      openOnClick: false,
      // Hrefs are allowlisted rather than escaped: there is nothing in
      // `javascript:alert(1)` to escape. The same rule the server applies on export.
      protocols: ["http", "https", "mailto"],
      autolink: true,
    },
  }),
];

/** An empty document, matching the schema's own default. */
export const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };
