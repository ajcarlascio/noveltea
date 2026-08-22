import { EditorContent, useEditor } from "@tiptap/react";
import { useState } from "react";
import { editorExtensions } from "@/features/editor/schema";
import type { ConflictDetail } from "./api";
import "./MergeView.css";

/**
 * Two versions of one document, side by side, and a decision.
 *
 * The server never merges prose and never will, so this is where a conflict actually
 * gets resolved. It deliberately does not attempt a three-way merge: an automatic
 * merge of a novel produces sentences nobody wrote, and the whole design exists to
 * avoid exactly that. What it offers is both texts, a starting point, and an editor.
 *
 * Both versions are rendered with the same extensions the editor uses, so what an
 * author compares is what they would get — not an approximation in a preview.
 */
export function MergeView({
  detail,
  busy,
  error,
  onResolve,
  onCancel,
}: {
  detail: ConflictDetail;
  busy: boolean;
  error: string | null;
  onResolve: (content: unknown) => void;
  onCancel: () => void;
}) {
  const [source, setSource] = useState<"original" | "copy" | null>(null);

  const original = useEditor({
    extensions: editorExtensions({ smartTypography: false }),
    content: detail.originalContent ?? "",
    editable: false,
    editorProps: { attributes: { class: "merge__surface", role: "document", "aria-label": "This device's version" } },
  });

  const copy = useEditor({
    extensions: editorExtensions({ smartTypography: false }),
    content: detail.copyContent ?? "",
    editable: false,
    editorProps: { attributes: { class: "merge__surface", role: "document", "aria-label": "The conflicting version" } },
  });

  const result = useEditor(
    {
      extensions: editorExtensions({ smartTypography: true }),
      content:
        source === null ? "" : (source === "original" ? detail.originalContent : detail.copyContent) ?? "",
      editorProps: {
        attributes: { class: "merge__surface", role: "textbox", "aria-multiline": "true", "aria-label": "Merged version" },
      },
    },
    [source],
  );

  return (
    <section className="merge" aria-label="Resolve a conflict">
      <header className="merge__bar">
        <h2 className="merge__title">{detail.originalTitle}</h2>
        <p className="merge__lede">
          Two devices changed this document. Nothing was overwritten — both versions are
          here, and the one you build below replaces the document. The other is kept in
          the trash.
        </p>
      </header>

      <div className="merge__panes">
        <article className="merge__pane">
          <h3 className="merge__pane-title">
            On the server <span className="merge__version">version {detail.originalVersion}</span>
          </h3>
          <EditorContent editor={original} className="merge__scroll" />
          <button type="button" className="button" onClick={() => setSource("original")}>
            Start from this
          </button>
        </article>

        <article className="merge__pane">
          <h3 className="merge__pane-title">
            The conflicting copy{" "}
            <span className="merge__version">forked at version {detail.forkedFromVersion}</span>
          </h3>
          <EditorContent editor={copy} className="merge__scroll" />
          <button type="button" className="button" onClick={() => setSource("copy")}>
            Start from this
          </button>
        </article>
      </div>

      <div className="merge__result">
        <h3 className="merge__pane-title">The version to keep</h3>
        {source === null ? (
          <p className="merge__hint">
            Choose one above to start from, then edit it here. Nothing is written until
            you resolve.
          </p>
        ) : (
          <EditorContent editor={result} className="merge__scroll" />
        )}
      </div>

      {error !== null && (
        <p className="merge__error" role="alert">
          {error}
        </p>
      )}

      <div className="merge__actions">
        <button type="button" className="button" onClick={onCancel}>
          Leave it for now
        </button>
        <button
          type="button"
          className="button button--confirm"
          disabled={source === null || busy || result === null}
          onClick={() => result !== null && onResolve(result.getJSON())}
        >
          {busy ? "Resolving…" : "Resolve"}
        </button>
      </div>
    </section>
  );
}
