import { EditorContent, useEditor } from "@tiptap/react";
import { useEffect, useRef, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { useSettings } from "@/app/settings/SettingsContext";
import { loadDocument, saveDocument, type StoredDocument } from "@/data/documents";
import { editorExtensions } from "./schema";
import { describePages, summarise } from "./text";
import { CommentsPanel } from "@/features/comments/CommentsPanel";
import { HistoryPanel } from "@/features/history/HistoryPanel";
import { LookupPanel } from "@/features/lookup/LookupPanel";
import { useAutosave, type SaveState } from "./useAutosave";
import "./DocumentEditor.css";

/**
 * How long between automatic captures of one document.
 *
 * Every autosave would bury the named versions an author actually made, and the bound
 * is 25 per document. Every session start plus a capture every ten minutes of work is
 * roughly a morning's history, which is the span someone reaches back over.
 */
const AUTO_SNAPSHOT_INTERVAL_MS = 10 * 60 * 1000;

const LABELS: Record<SaveState, string> = {
  clean: "Saved",
  pending: "Unsaved changes",
  saving: "Saving…",
  error: "Not saved",
};

export function DocumentEditor({ projectId, documentId }: { projectId: string; documentId: string }) {
  const { db } = useDatabase();
  const { settings } = useSettings();
  const [loaded, setLoaded] = useState<StoredDocument | null>(null);
  const [missing, setMissing] = useState(false);
  const [state, setState] = useState<SaveState>("clean");
  const [error, setError] = useState<string | null>(null);
  const [words, setWords] = useState(0);

  // Zero, not the mount time, so the first save of a session captures. What that
  // snapshot holds is the document as it was *before* this session's edits, which is
  // the state someone reaching for history actually wants back.
  const lastAutoSnapshot = useRef(0);

  // What the editor's text is based on. `base` is the version its next save claims to
  // have seen; `seen` is the last row read back, so a change can be told apart: the same
  // text under a new version is this device's own push being accepted, different text is
  // another device's.
  const base = useRef(0);
  const seen = useRef<{ version: number; text: string } | null>(null);
  const stateRef = useRef<SaveState>("clean");

  const autosave = useAutosave(
    async (payload) => {
      const { searchText, words: count } = summarise(payload as never);
      const due = Date.now() - lastAutoSnapshot.current >= AUTO_SNAPSHOT_INTERVAL_MS;
      if (due) lastAutoSnapshot.current = Date.now();
      // The capture rides along inside the save's own transaction, so it sees the
      // content being replaced and costs no extra round trip to the worker.
      await saveDocument(db, projectId, documentId, payload, searchText, count, due, base.current);
    },
    (next, message) => {
      stateRef.current = next;
      setState(next);
      setError(next === "error" ? (message ?? "Unknown error") : null);
    },
  );

  const editor = useEditor(
    {
      extensions: editorExtensions({ smartTypography: settings.smartTypography }),
      content: loaded?.content ?? "",
      editable: loaded !== null,
      onUpdate: ({ editor: instance }) => {
        const json = instance.getJSON();
        setWords(summarise(json).words);
        autosave.schedule(json);
      },
      editorProps: {
        attributes: {
          class: "editor__surface",
          // contenteditable alone does not confer a role: HTML-AAM maps a bare
          // <div contenteditable> to `generic`, so a screen reader never announces
          // the manuscript as somewhere you can type. The role has to be stated.
          role: "textbox",
          "aria-multiline": "true",
          "aria-label": "Manuscript",
        },
      },
    },
    // Rebuilt when the typography setting changes, because extensions are fixed at
    // construction. Flushing first is handled by the same effect that guards a
    // document switch.
    [loaded?.id, settings.smartTypography],
  );

  // Flush the previous document before the next one replaces it. Without this the
  // last few seconds of writing go nowhere and nothing reports it.
  const flushRef = useRef(autosave.flush);
  flushRef.current = autosave.flush;
  useEffect(
    () => () => {
      void flushRef.current();
    },
    [documentId],
  );

  // And flush when the page is going away. React unmounting is not involved in a
  // reload, a closed tab, or a phone backgrounding the browser — the document simply
  // stops existing, taking anything still inside the debounce with it.
  //
  // visibilitychange rather than beforeunload: it is the only one mobile browsers
  // fire reliably, and it arrives early enough for a local write to finish.
  useEffect(() => {
    const flushIfHidden = () => {
      if (document.visibilityState === "hidden") void flushRef.current();
    };
    document.addEventListener("visibilitychange", flushIfHidden);
    window.addEventListener("pagehide", flushIfHidden);
    return () => {
      document.removeEventListener("visibilitychange", flushIfHidden);
      window.removeEventListener("pagehide", flushIfHidden);
    };
  }, []);

  useEffect(() => {
    let current = true;
    // A different document has its own history and its own interval. Carrying the
    // previous one's timer over means opening several in a row captures none of them.
    lastAutoSnapshot.current = 0;
    void loadDocument(db, projectId, documentId).then(
      (row) => {
        if (!current) return;
        setLoaded(row);
        setMissing(row === null);
        setWords(row?.wordCount ?? 0);
        setState("clean");
        stateRef.current = "clean";
        base.current = row?.version ?? 0;
        seen.current = row === null ? null : { version: row.version, text: JSON.stringify(row.content) };
      },
      (cause: unknown) => {
        if (!current) return;
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
    return () => {
      current = false;
    };
  }, [db, projectId, documentId]);

  // Sync writes straight to the replica, and the editor holds its own copy of the text.
  // Without this a pulled edit sits in the database while the old words stay on screen,
  // and the next keystroke saves them over it.
  useEffect(() => {
    if (editor === null || loaded?.id !== documentId) return;
    let current = true;
    const unsubscribe = db.subscribeToChanges(() => {
      void loadDocument(db, projectId, documentId).then((row) => {
        if (!current || row === null || editor.isDestroyed) return;
        const text = JSON.stringify(row.content);
        const before = seen.current;
        seen.current = { version: row.version, text };

        if (before !== null && text === before.text) {
          // Our own push accepted: the text is unchanged and the version moved. Followed
          // only if the editor was on the version that was replaced, so a save made
          // while another device's edit was waiting keeps its old base and conflicts.
          if (base.current === before.version) base.current = row.version;
          return;
        }
        // Different text, and the author has something unsaved or mid-write. Their words
        // are not replaced: the next save goes out against `base`, the server calls it a
        // conflict, and it keeps them in a copy.
        if (stateRef.current !== "clean") return;

        base.current = row.version;
        const { from, to } = editor.state.selection;
        // Not an edit: no autosave, and not an undo step that would return to the old text.
        editor.chain().setMeta("addToHistory", false).setContent(row.content, { emitUpdate: false }).run();
        editor.commands.setTextSelection({ from, to });
        setWords(row.wordCount);
      });
    });
    return () => {
      current = false;
      unsubscribe();
    };
  }, [db, projectId, documentId, editor, loaded?.id]);

  if (missing) {
    return (
      <p className="editor__missing" role="status">
        That document is no longer in this binder.
      </p>
    );
  }

  return (
    <section className="editor" aria-label="Editor">
      <header className="editor__bar">
        <h2 className="editor__title">{loaded?.title ?? ""}</h2>
        <span className="editor__words">{words === 1 ? "1 word" : `${words} words`}</span>
        {/* Standard manuscript pages, which is what "how long is it" means to a
            novelist. Not pages of this screen, which change with the window. */}
        <span className="editor__pages" title="Standard manuscript pages, at 250 words a page">
          {describePages(words)}
        </span>
        <span className="editor__state" data-state={state} role="status">
          {LABELS[state]}
        </span>
      </header>

      {error !== null && (
        <p className="editor__error" role="alert">
          {error}
        </p>
      )}

      <EditorContent editor={editor} className="editor__scroll" />

      {/* One bounded region for everything under the prose. Left to grow on their own
          the panels push the manuscript out of its own pane — and, at a small enough
          height, out from under the page footer entirely. */}
      <div className="editor__panels">
      <CommentsPanel projectId={projectId} documentId={documentId} editor={editor} />
      <HistoryPanel
        projectId={projectId}
        documentId={documentId}
        // Restoring writes the document row, and the editor holds its own copy of the
        // content. Without this the old draft is in the database and the new one is
        // still on screen, and the next keystroke saves the words the author just
        // asked to replace.
        onRestored={(content) => {
          editor?.commands.setContent(content, { emitUpdate: false });
          setWords(summarise(content).words);
        }}
      />
      <LookupPanel editor={editor} />
      </div>
    </section>
  );
}
