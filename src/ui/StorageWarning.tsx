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
    return (
      <p className="storage-warning" role="alert">
        <strong>This browser is not storing your work.</strong> Persistent storage is
        unavailable, so anything you write will be lost when you close this tab. Private
        browsing is the usual cause.
      </p>
    );
  }

  return null;
}
