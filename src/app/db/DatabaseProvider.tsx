import { useEffect, useMemo, useState, type ReactNode } from "react";
import { DatabaseClient, createDatabaseClient, type DbStatus } from "@/db/client";
import { DatabaseContext, type DatabaseContextValue } from "./DatabaseContext";

/**
 * Opens the local replica once and hands it to the app.
 *
 * Children render immediately rather than behind a gate. The replica is local, so
 * it resolves in milliseconds, and the worker queues anything that arrives before
 * it is open — a full-screen spinner would be showing the author a wait that is
 * not happening.
 */
export function DatabaseProvider({
  children,
  create = createDatabaseClient,
}: {
  children: ReactNode;
  /** Injectable so tests never spawn a real worker. */
  create?: () => DatabaseClient;
}) {
  const [client, setClient] = useState(create);
  const [status, setStatus] = useState<DbStatus>(() => client.status);

  useEffect(() => {
    // React's StrictMode mounts, unmounts and mounts again in development, and the
    // cleanup below closes the client on that simulated unmount — but `useState` does
    // not run again on the second mount, so without this the provider spends the rest
    // of the session holding a client it closed itself, and every read fails with
    // "Database closed." A real unmount and remount lands here for the same reason.
    if (client.closed) {
      // Called, not passed. React treats a function handed to a setter as an updater
      // and invokes it — twice under StrictMode — so `setClient(create)` would build a
      // client it then threw away, and a thrown-away client owns a live worker.
      setClient(create());
      return;
    }

    // Subscribing happens after the constructor ran, so a "ready" that arrived in
    // between would be missed. Re-reading the current status closes that window.
    setStatus(client.status);
    return client.subscribe(setStatus);
    // `create` is deliberately not a dependency: callers pass an inline factory, so it
    // changes every render, and depending on it would re-subscribe every render. It is
    // only read when the client is already closed, which is a transition, not a render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client]);

  // Mirrored onto <html> so the state of the replica is inspectable without a
  // debugger — by an operator helping an author, and by the end-to-end tests,
  // which need to tell a persisted database from a fresh one without the app
  // exposing a handle that would also be there in production.
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.dbStatus = status.state;
    if (status.state === "ready") {
      root.dataset.dbStorage = status.storage;
      root.dataset.dbApplied = String(status.appliedVersions.length);
      root.dataset.dbSchema = String(status.schemaVersion);
    }
  }, [status]);

  useEffect(() => () => client.close(), [client]);

  const value = useMemo<DatabaseContextValue>(() => ({ db: client, status }), [client, status]);

  return <DatabaseContext.Provider value={value}>{children}</DatabaseContext.Provider>;
}
