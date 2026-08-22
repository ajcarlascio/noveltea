import { useCallback, useEffect, useState } from "react";
import { useAuth } from "@/features/auth/AuthContext";
import { listConflicts, loadConflict, resolveConflict, type ConflictDetail, type ConflictSummary } from "./api";
import { MergeView } from "./MergeView";
import "./ConflictsPanel.css";

/**
 * The conflicts a project has, and the way out of them.
 *
 * Shown prominently and not behind a fold: a conflict means an author's words exist in
 * two places and one of them is not in their manuscript. That is worth interrupting
 * for, and it is the one thing in this app that genuinely needs a decision.
 *
 * Nothing here is possible without a server — conflicts only exist because two devices
 * synced — so the panel simply does not appear when signed out.
 */
export function ConflictsPanel({ projectId }: { projectId: string }) {
  const { authenticator } = useAuth();
  const [conflicts, setConflicts] = useState<ConflictSummary[]>([]);
  const [open, setOpen] = useState<ConflictDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async () => {
    if (!authenticator) return;
    try {
      setConflicts(await listConflicts(authenticator, projectId));
    } catch {
      // Not surfaced. An author who has not hit a conflict does not need to be told
      // the conflict list could not be fetched.
      setConflicts([]);
    }
  }, [authenticator, projectId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  if (!authenticator || (conflicts.length === 0 && open === null)) return null;

  const openPair = (copyId: string) => {
    if (!authenticator) return;
    setError(null);
    void loadConflict(authenticator, copyId).then(setOpen, (cause: unknown) => {
      setError(cause instanceof Error ? cause.message : String(cause));
    });
  };

  const resolve = (content: unknown) => {
    if (!authenticator || open === null) return;
    setBusy(true);
    setError(null);
    void resolveConflict(authenticator, open.copyId, content, open.originalVersion)
      .then(
        () => {
          setOpen(null);
          return refresh();
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          // Deliberately left open on a stale rejection so the author does not lose
          // the merge they just built by having the view close under them.
        },
      )
      .finally(() => setBusy(false));
  };

  if (open !== null) {
    return (
      <MergeView
        detail={open}
        busy={busy}
        error={error}
        onResolve={resolve}
        onCancel={() => {
          setOpen(null);
          setError(null);
        }}
      />
    );
  }

  return (
    <section className="conflicts" aria-label="Conflicts">
      <h2 className="conflicts__title">
        {conflicts.length === 1
          ? "One document needs your attention"
          : `${String(conflicts.length)} documents need your attention`}
      </h2>
      <p className="conflicts__lede">
        These were changed on two devices at once. Nothing was overwritten — both
        versions were kept, and you decide which words survive.
      </p>

      {error !== null && (
        <p className="conflicts__error" role="alert">
          {error}
        </p>
      )}

      <ul className="conflicts__list">
        {conflicts.map((conflict) => (
          <li key={conflict.copyId}>
            <span className="conflicts__name">{conflict.originalTitle}</span>
            <button type="button" className="button" onClick={() => openPair(conflict.copyId)}>
              Review
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
