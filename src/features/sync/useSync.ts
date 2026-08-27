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
  const [status, setStatus] = useState({
    lastSyncedAt: null as string | null,
    pending: 0,
    lastError: null as string | null,
    /**
     * Which project the three fields above describe, or null before the first read.
     *
     * Carried so "this project has never synced" can be told from "this project's state
     * has not been read yet" — and, when the route moves to another project, from the
     * previous project's answer. Getting that wrong would fire an immediate sync for an
     * established replica, which is the thing the settle window exists to prevent.
     */
    loadedFor: null as string | null,
  });
  const [running, setRunning] = useState(false);
  const [conflicts, setConflicts] = useState<SyncOutcome["conflicts"]>([]);
  const [dropped, setDropped] = useState(0);

  const refresh = useCallback(async () => {
    // A read that fails means the replica itself is in trouble — a dead worker, a closed
    // database — and DatabaseProvider already surfaces that state to the whole app. What
    // must not happen is this becoming an unhandled rejection: it is called from an effect
    // and from a change subscription, neither of which has anywhere to put one.
    const state = await db.command("syncState", { projectId }).catch(() => null);
    if (state === null) return;
    setStatus({
      lastSyncedAt: state.lastSyncedAt,
      pending: state.pending,
      lastError: state.lastError,
      loadedFor: projectId,
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

  /**
   * Nothing has ever been synced for this project, so there is no window to wait out.
   *
   * False until this project's own state has been read: the scheduler is built before
   * that read finishes, and a default of "yes" would make every app open an immediate
   * sync for every replica.
   */
  const neverSynced = status.loadedFor === projectId && status.lastSyncedAt === null;
  const firstSyncRef = useRef(false);

  const schedulerRef = useRef<ReturnType<typeof createScheduler> | null>(null);
  useEffect(() => {
    // Reset before the scheduler reads it: on a move to another project this still holds
    // the previous one's answer, and the scheduler decides once at construction.
    firstSyncRef.current = false;
    const scheduler = createScheduler({
      run: () => runRef.current(),
      // Already recorded against the project and shown by `lastError`; rethrowing
      // here would only produce an unhandled rejection.
      onError: () => undefined,
      mayRun: () => mayRunRef.current,
      firstSync: () => firstSyncRef.current,
    });
    schedulerRef.current = scheduler;
    return () => {
      scheduler.stop();
      schedulerRef.current = null;
    };
  }, [projectId]);

  useEffect(() => {
    firstSyncRef.current = neverSynced;
    // The scheduler decided before this was knowable, so tell it to decide again. Only
    // when the answer is yes: a no leaves whatever window is already running alone
    // rather than restarting one that is most of the way through.
    if (neverSynced) schedulerRef.current?.reconsider();
  }, [neverSynced, projectId]);

  const syncNow = useCallback(() => {
    void schedulerRef.current?.syncNow();
  }, []);

  return {
    // Listed rather than spread: loadedFor is bookkeeping for the decision above and has
    // no business in a caller's status object.
    lastSyncedAt: status.lastSyncedAt,
    pending: status.pending,
    lastError: status.lastError,
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
