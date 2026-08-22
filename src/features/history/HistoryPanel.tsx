import { useCallback, useEffect, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import {
  captureSnapshot,
  deleteSnapshot,
  listSnapshots,
  loadSnapshot,
  restoreSnapshot,
  type SnapshotSummary,
} from "@/data/snapshots";
import type { ProseMirrorNode } from "@/features/editor/text";
import "./HistoryPanel.css";

/**
 * A document's revision history.
 *
 * Every read is a local SQLite query, so this opens instantly and works with no
 * server. That matters because the moment an author wants an old draft back, they
 * usually want it now, and often because something has just gone wrong.
 *
 * Automatic captures are labelled as such and can be told apart from the ones an
 * author named. Both restore the same way; only the automatic ones are ever pruned.
 */
export function HistoryPanel({
  projectId,
  documentId,
  onRestored,
}: {
  projectId: string;
  documentId: string;
  /** Handed the content that is now in the document, so the editor can show it. */
  onRestored: (content: ProseMirrorNode) => void;
}) {
  const { db } = useDatabase();
  const [snapshots, setSnapshots] = useState<SnapshotSummary[]>([]);
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setSnapshots(await listSnapshots(db, projectId, documentId));
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [db, projectId, documentId]);

  useEffect(() => {
    void refresh();
    // The editor writes snapshots too, on its own schedule. Without listening, a
    // capture taken while this panel is open never appears in it.
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

  return (
    <details className="history">
      <summary className="history__summary">
        History{snapshots.length > 0 ? ` (${String(snapshots.length)})` : ""}
      </summary>

      <div className="history__capture">
        <label className="history__field">
          <span className="history__label">Save this version as</span>
          <input
            value={label}
            placeholder="a name you will recognise"
            onChange={(event) => setLabel(event.target.value)}
          />
        </label>
        <button
          type="button"
          className="button"
          onClick={() => {
            act(captureSnapshot(db, projectId, documentId, label));
            setLabel("");
          }}
        >
          Save a version
        </button>
      </div>

      {error !== null && (
        <p className="history__error" role="alert">
          {error}
        </p>
      )}

      {snapshots.length === 0 ? (
        <p className="history__empty">
          No versions yet. One is kept automatically as you write, and you can name one
          yourself at any point.
        </p>
      ) : (
        <ul className="history__list">
          {snapshots.map((snapshot) => (
            <li key={snapshot.id} className="history__item">
              <span className="history__name">
                {snapshot.label ?? "Autosaved"}
                {snapshot.automatic && (
                  <span className="history__auto" title="Kept automatically; only these are pruned">
                    auto
                  </span>
                )}
              </span>
              <span className="history__meta">
                {formatWhen(snapshot.createdAt)} · {snapshot.wordCount} words
              </span>
              {confirming === snapshot.id ? (
                <>
                  <button
                    type="button"
                    className="button button--confirm"
                    onClick={() => {
                      setConfirming(null);
                      act(
                        restoreSnapshot(db, projectId, snapshot.id).then(async () => {
                          const restored = await loadSnapshot(db, projectId, snapshot.id);
                          if (restored) onRestored(restored.content);
                        }),
                      );
                    }}
                  >
                    Replace the document
                  </button>
                  <button type="button" className="button" onClick={() => setConfirming(null)}>
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  {/* Restoring replaces everything on screen, so it asks first. The
                      current state is captured automatically either way, which is
                      what the confirmation says rather than a bare "are you sure". */}
                  <button
                    type="button"
                    className="button"
                    onClick={() => setConfirming(snapshot.id)}
                    aria-label={`Restore ${snapshot.label ?? "the autosaved version"}`}
                  >
                    Restore
                  </button>
                  <button
                    type="button"
                    className="button"
                    onClick={() => act(deleteSnapshot(db, projectId, snapshot.id))}
                    aria-label={`Forget ${snapshot.label ?? "the autosaved version"}`}
                  >
                    Forget
                  </button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}

      {confirming !== null && (
        <p className="history__note" role="status">
          The version on screen now is kept too, so this can be undone.
        </p>
      )}
    </details>
  );
}

/** Local time, since a snapshot is a moment in the author's own day. */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  if (Number.isNaN(when.getTime())) return iso;
  return when.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}
