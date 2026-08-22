import type { Editor } from "@tiptap/react";
import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  addComment,
  deleteComment,
  listComments,
  resolveComment,
  type CommentThread,
} from "@/data/comments";
import { anchorFrom } from "./anchor";
import "./CommentsPanel.css";

/**
 * Margin comments on the open document.
 *
 * Read from the local replica, so the panel opens with no network and a note written
 * on a plane is in the manuscript the moment it is typed.
 *
 * **Orphaned threads stay visible.** When the words a note quoted are gone, it is
 * shown with its quotation and marked, rather than moved to a guess or hidden. An
 * editor's remark attached to the wrong sentence is worse than one that admits it
 * lost its place.
 */
export function CommentsPanel({
  projectId,
  documentId,
  editor,
}: {
  projectId: string;
  documentId: string;
  editor: Editor | null;
}) {
  const { db } = useDatabase();
  const [threads, setThreads] = useState<CommentThread[]>([]);
  const [draft, setDraft] = useState("");
  const [replyTo, setReplyTo] = useState<string | null>(null);
  const [replyDraft, setReplyDraft] = useState("");
  const [showResolved, setShowResolved] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setThreads(await listComments(db, projectId, documentId));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [db, projectId, documentId]);

  useEffect(() => {
    void refresh();
    // Editing the manuscript can orphan a thread, and that is decided from the
    // document's text. Without listening, the panel would keep saying a quotation is
    // still there after the author has just deleted it.
    return db.subscribeToChanges(() => void refresh());
  }, [db, refresh]);

  const act = (work: Promise<unknown>) => {
    setError(null);
    void work.then(
      () => refresh(),
      (cause: unknown) => {
        setError(cause instanceof Error ? cause.message : String(cause));
      },
    );
  };

  const open = threads.filter((thread) => !thread.comment.resolved);
  const resolved = threads.filter((thread) => thread.comment.resolved);
  const shown = showResolved ? threads : open;

  return (
    <details className="comments">
      <summary className="comments__summary">
        Comments{open.length > 0 ? ` (${String(open.length)})` : ""}
      </summary>

      <div className="comments__compose">
        <label className="comments__field">
          <span className="comments__label">New comment</span>
          <textarea
            value={draft}
            rows={2}
            placeholder="on the selected passage, or on the document"
            onChange={(event) => setDraft(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          disabled={draft.trim().length === 0}
          onClick={() => {
            act(addComment(db, projectId, documentId, draft, anchorFrom(editor)));
            setDraft("");
          }}
        >
          Comment
        </button>
      </div>

      {error !== null && (
        <p className="comments__error" role="alert">
          {error}
        </p>
      )}

      {resolved.length > 0 && (
        <label className="comments__toggle">
          <input
            type="checkbox"
            checked={showResolved}
            onChange={(event) => setShowResolved(event.target.checked)}
          />
          Show resolved
        </label>
      )}

      {shown.length === 0 ? (
        <p className="comments__empty">
          Nothing to look at. Select a passage and write a note, and it will point at
          those words rather than at a position that moves.
        </p>
      ) : (
        <ul className="comments__list">
          {shown.map(({ comment, replies }) => (
            <li key={comment.id} className="comments__thread" data-resolved={comment.resolved}>
              {comment.anchor !== null && (
                <blockquote className="comments__quote" data-orphaned={comment.orphaned}>
                  {comment.anchor.quotedText}
                </blockquote>
              )}
              {comment.orphaned && (
                <p className="comments__orphaned">
                  {/* Named plainly. "Orphaned" is jargon; what an author needs to know
                      is that the words changed and the note was kept anyway. */}
                  The text this was about has changed. The note was kept.
                </p>
              )}

              <p className="comments__body">{comment.body}</p>

              {replies.map((reply) => (
                <p key={reply.id} className="comments__reply">
                  {reply.body}
                </p>
              ))}

              <div className="comments__actions">
                <button
                  type="button"
                  className="button"
                  onClick={() =>
                    act(resolveComment(db, projectId, comment.id, !comment.resolved))
                  }
                >
                  {comment.resolved ? "Reopen" : "Resolve"}
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => setReplyTo(replyTo === comment.id ? null : comment.id)}
                >
                  Reply
                </button>
                <button
                  type="button"
                  className="button"
                  onClick={() => act(deleteComment(db, projectId, comment.id))}
                  aria-label={`Delete "${comment.body.slice(0, 40)}"`}
                >
                  Delete
                </button>
              </div>

              {replyTo === comment.id && (
                <div className="comments__compose">
                  <label className="comments__field">
                    <span className="comments__label">Reply</span>
                    <textarea
                      value={replyDraft}
                      rows={2}
                      onChange={(event) => setReplyDraft(event.target.value)}
                    />
                  </label>
                  <button
                    type="button"
                    className="button"
                    disabled={replyDraft.trim().length === 0}
                    onClick={() => {
                      act(addComment(db, projectId, documentId, replyDraft, null, comment.id));
                      setReplyDraft("");
                      setReplyTo(null);
                    }}
                  >
                    Send
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </details>
  );
}
