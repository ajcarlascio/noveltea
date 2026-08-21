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
  const [client] = useState(create);
  const [status, setStatus] = useState<DbStatus>(() => client.status);

  useEffect(() => {
    // Subscribing happens after the constructor ran, so a "ready" that arrived in
    // between would be missed. Re-reading the current status closes that window.
    setStatus(client.status);
    return client.subscribe(setStatus);
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
