import { useCallback, useEffect, useRef, useState } from "react";
import { useDatabase } from "@/app/db/DatabaseContext";
import { useAuth } from "@/features/auth/AuthContext";
import { useSettings } from "@/app/settings/SettingsContext";
import { mayAutoSync, meteringOf, subscribeToConnection, type Metering } from "./connection";
import { syncProject, type SyncOutcome } from "./engine";
import { createScheduler } from "./scheduler";

export interface SyncStatus {
  /** Null when this project has never synced. */
  lastSyncedAt: string | null;
  /** Local edits not yet accepted by a server. */
  pending: number;
  lastError: string | null;
  running: boolean;
  conflicts: SyncOutcome["conflicts"];
  /** Feed rows the server sent that this client could not parse and had to skip. */
  dropped: number;
  /** False when there is no account, so nothing can sync at all. */
  possible: boolean;
  /** What the platform will say about the connection, which is often nothing. */
  metering: Metering;
  /** True when the wifi-only setting is holding automatic syncs back right now. */
  heldForWifi: boolean;
  syncNow: () => void;
}

export function useSync(projectId: string): SyncStatus {
  const { db } = useDatabase();
  const { authenticator } = useAuth();
  const { settings } = useSettings();
  const [metering, setMetering] = useState<Metering>(() =>
    typeof navigator === "undefined" ? "unknown" : meteringOf(navigator),
  );

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const read = () => setMetering(meteringOf(navigator));
    read();
    return subscribeToConnection(navigator, read);
  }, []);
  const [status, setStatus] = useState({ lastSyncedAt: null as string | null, pending: 0, lastError: null as string | null });
  const [running, setRunning] = useState(false);
  const [conflicts, setConflicts] = useState<SyncOutcome["conflicts"]>([]);
  const [dropped, setDropped] = useState(0);

  const refresh = useCallback(async () => {
    const state = await db.command("syncState", { projectId });
    setStatus({
      lastSyncedAt: state.lastSyncedAt,
      pending: state.pending,
      lastError: state.lastError,
    });
  }, [db, projectId]);

  useEffect(() => {
    void refresh();
    // The count changes whenever anything is written locally, not only when a sync
    // runs, so it follows the database rather than waiting to be told.
    return db.subscribeToChanges(() => void refresh());
  }, [db, refresh]);

  // Held in a ref so the scheduler is built once per project rather than on every
  // status change — rebuilding it would restart the settle window each time.
  const runRef = useRef<() => Promise<unknown>>(() => Promise.resolve());
  runRef.current = async () => {
    if (!authenticator) return;
    setRunning(true);
    try {
      const outcome = await syncProject({ db, auth: authenticator }, projectId);
      setConflicts(outcome.conflicts);
      setDropped(outcome.dropped);
    } finally {
      setRunning(false);
      await refresh();
    }
  };

  // Read through a ref so changing the setting does not tear down the scheduler and
  // restart a fifteen-minute settle window that was most of the way through.
  const mayRunRef = useRef(true);
  mayRunRef.current = mayAutoSync(settings.syncOnWifiOnly, metering);

  const schedulerRef = useRef<ReturnType<typeof createScheduler> | null>(null);
  useEffect(() => {
    const scheduler = createScheduler({
      run: () => runRef.current(),
      // Already recorded against the project and shown by `lastError`; rethrowing
      // here would only produce an unhandled rejection.
      onError: () => undefined,
      mayRun: () => mayRunRef.current,
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.stop();
      schedulerRef.current = null;
    };
  }, [projectId]);

  const syncNow = useCallback(() => {
    void schedulerRef.current?.syncNow();
  }, []);

  return {
    ...status,
    running,
    conflicts,
    dropped,
    possible: authenticator !== null,
    metering,
    heldForWifi: settings.syncOnWifiOnly && !mayAutoSync(settings.syncOnWifiOnly, metering),
    syncNow,
  };
}

/** "4 minutes ago", for a timestamp an author glances at. */
export function describeWhen(iso: string | null, now = new Date()): string {
  if (iso === null) return "never";
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "never";

  const seconds = Math.max(0, Math.round((now.getTime() - then) / 1000));
  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${String(minutes)} minute${minutes === 1 ? "" : "s"} ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${String(hours)} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${String(days)} day${days === 1 ? "" : "s"} ago`;
}
