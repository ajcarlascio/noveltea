import { useEffect, useRef } from "react";
import { REPLICA_LOCK } from "@/db/protocol";
import "./StorageWarning.css";

/**
 * Stands in for the whole app when another tab owns the local replica.
 *
 * Only one tab can hold the OPFS database, and a second would otherwise write into
 * memory that vanishes on close. So it gets nothing to write into, and reloads by
 * itself the moment the other tab lets go.
 */
export function AnotherTab() {
  const reloadRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    reloadRef.current?.focus();
    const abort = new AbortController();
    void navigator.locks
      ?.request(REPLICA_LOCK, { signal: abort.signal }, () => window.location.reload())
      .catch(() => undefined); // Aborted on unmount.
    return () => abort.abort();
  }, []);

  return (
    <main className="another-tab">
      <div role="alert">
        <h1>NovelTea is already open in another tab or window</h1>
        <p>Use that one, or close it and reload here.</p>
      </div>
      <button ref={reloadRef} type="button" onClick={() => window.location.reload()}>
        Reload
      </button>
    </main>
  );
}
