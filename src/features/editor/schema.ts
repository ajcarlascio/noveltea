import Typography from "@tiptap/extension-typography";
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
export interface SchemaOptions {
  /**
   * Curly quotes, en and em dashes, ellipses, as you type.
   *
   * Optional because it is wrong for some writing: code samples, dialect that needs
   * a straight apostrophe, and anyone typesetting deliberately. It adds no node or
   * mark — it only rewrites text — so turning it on or off does not change what
   * compile has to understand.
   */
  smartTypography: boolean;
}

export function editorExtensions({ smartTypography }: SchemaOptions): Extensions {
  return smartTypography ? [...BASE_EXTENSIONS, Typography] : BASE_EXTENSIONS;
}

const BASE_EXTENSIONS: Extensions = [
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

/** The full set, used where the options do not matter — schema checks, tests. */
export const EDITOR_EXTENSIONS: Extensions = editorExtensions({ smartTypography: true });

/** An empty document, matching the schema's own default. */
export const EMPTY_DOCUMENT = { type: "doc", content: [{ type: "paragraph" }] };
