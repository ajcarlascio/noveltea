import type { Editor } from "@tiptap/react";
import type { CommentAnchor } from "@/data/comments";

/**
 * The selection, as an anchor.
 *
 * Null when nothing is selected, which makes the comment an unanchored note on the
 * document — never orphaned, because it was never pointing anywhere in particular.
 * The offsets are recorded for completeness; what decides orphaning later is the text.
 */
export function anchorFrom(editor: Editor | null): CommentAnchor | null {
  if (!editor) return null;
  const { from, to } = editor.state.selection;
  if (from === to) return null;
  const quotedText = editor.state.doc.textBetween(from, to, "\n\n", " ").trim();
  if (quotedText.length === 0) return null;
  return { from, to, quotedText };
}
