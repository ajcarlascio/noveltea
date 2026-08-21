import type { Editor } from "@tiptap/react";

/** The word under the cursor, or the selection if there is one. */
export function wordAtSelection(editor: Editor | null): string {
  if (!editor) return "";
  const { from, to, empty } = editor.state.selection;
  if (!empty) return editor.state.doc.textBetween(from, to, " ").trim();

  // Both ends clamped to the document. ProseMirror throws on a position outside the
  // fragment, and the cursor is at the end of the document more often than anywhere
  // else while writing — so the unclamped version fails in the commonest case.
  const size = editor.state.doc.content.size;
  const start = Math.max(0, from - 40);
  const end = Math.min(size, from + 40);
  const text = editor.state.doc.textBetween(start, end, " ");
  const offset = from - start;
  const before = /[\p{L}\p{M}'-]*$/u.exec(text.slice(0, offset))?.[0] ?? "";
  const after = /^[\p{L}\p{M}'-]*/u.exec(text.slice(offset))?.[0] ?? "";
  return `${before}${after}`.trim();
}

