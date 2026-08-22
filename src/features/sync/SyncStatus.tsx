import { Link } from "react-router-dom";
import { useTransientNotice } from "./useTransientNotice";
import { describeWhen, useSync } from "./useSync";
import "./SyncStatus.css";

/**
 * Sync as ambient status, never as a modal.
 *
 * An author is told what is happening and is never stopped by it: the work is already
 * safe locally, so a failed sync is information, not an emergency. Nothing here blocks
 * writing, and nothing demands a decision.
 */
export function SyncStatus({ projectId }: { projectId: string }) {
  const { lastSyncedAt, pending, lastError, running, conflicts, possible, syncNow } =
    useSync(projectId);
  // Hooks run before the early return, or this one would be skipped whenever an
  // account exists and React would see a different hook order between renders.
  const noticeVisible = useTransientNotice();

  if (!possible) {
    // On a phone this stands down after a few seconds. It is worth saying and not
    // worth keeping: the state it describes is the ordinary one, nothing is at risk
    // that signing in later would not fix, and the screen is needed for writing.
    if (!noticeVisible) return null;
    return (
      <p className="sync sync--muted">
        This project is on this device only. <Link to="/signin">Sign in</Link> to keep it on a
        server as well.
      </p>
    );
  }

  return (
    <div className="sync">
      <span className="sync__line">
        <span className="sync__when">
          {running ? "Syncing…" : `Last synced ${describeWhen(lastSyncedAt)}`}
        </span>
        {pending > 0 && (
          <span className="sync__pending">
            {pending === 1 ? "1 change waiting" : `${String(pending)} changes waiting`}
          </span>
        )}
        <button type="button" className="button" onClick={syncNow} disabled={running}>
          Sync now
        </button>
      </span>

      {lastError !== null && (
        <p className="sync__error" role="status">
          {/* status, not alert: an author on a train does not need an interruption. */}
          Last attempt did not finish: {lastError}
        </p>
      )}

      {conflicts.length > 0 && (
        <p className="sync__conflicts" role="status">
          {conflicts.length === 1 ? "1 change" : `${String(conflicts.length)} changes`} could not be
          applied. Where your text was at risk it was kept as a conflict copy in the binder,
          so nothing was overwritten.
        </p>
      )}
    </div>
  );
}
