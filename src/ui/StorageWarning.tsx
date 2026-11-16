import { useDatabase } from "@/app/db/DatabaseContext";
import "./StorageWarning.css";

/**
 * Says so, loudly, when the replica is not being persisted.
 *
 * An in-memory database loses every word on reload. That is the one condition a
 * writing app must never let an author discover for themselves, so it is stated
 * in the interface rather than logged to a console nobody has open.
 */
export function StorageWarning() {
  const { status } = useDatabase();

  if (status.state === "failed") {
    return (
      <p className="storage-warning storage-warning--danger" role="alert">
        <strong>The local database could not be opened.</strong> Nothing you write will be
        saved. {status.error.message}
      </p>
    );
  }

  if (status.state === "ready" && status.storage === "memory") {
    // Browsers only offer persistent storage to pages served over HTTPS (or from
    // localhost). On a self-hosted address reached over plain http that is the whole
    // cause, and blaming private browsing sends the author looking in the wrong place.
    if (typeof window !== "undefined" && !window.isSecureContext) {
      return (
        <p className="storage-warning" role="alert">
          <strong>This browser is not storing your work.</strong> This address is served
          over plain http, and browsers only keep a local database for pages on https.
          Anything you write will be lost when you close this tab. Put the server behind
          https, or use the desktop app.
        </p>
      );
    }
    return (
      <p className="storage-warning" role="alert">
        <strong>This browser is not storing your work.</strong> Persistent storage is
        unavailable, so anything you write will be lost when you close this tab. The usual
        cause is a private window.
      </p>
    );
  }

  return null;
}
