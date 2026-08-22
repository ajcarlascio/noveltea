/**
 * When a sync happens.
 *
 * The rule comes from the server's design notes: regaining a connection starts a
 * fifteen-minute timer, and the sync fires only if the connection holds for the whole
 * window. Dropping resets it. A manual "sync now" always overrides.
 *
 * The reason for the delay is that a flapping connection — a train, a tunnel, a phone
 * hunting for a signal — would otherwise start a sync every time the interface
 * flickered online, and each one would fail halfway. Waiting until the connection has
 * proved itself costs an author nothing: their work is already safe locally.
 */

export interface SchedulerOptions {
  /** Called when a sync should run. Rejections are reported, never thrown. */
  run: () => Promise<unknown>;
  onError?: (error: unknown) => void;
  /** How long a connection must hold. Fifteen minutes by default. */
  settleMs?: number;
  /** Injectable so tests do not have to reach for globals. */
  online?: () => boolean;
  subscribe?: (listener: () => void) => () => void;
}

export interface Scheduler {
  /** Runs now, whatever the timer was doing. */
  syncNow: () => Promise<void>;
  /** True while a run is in flight. */
  running: () => boolean;
  stop: () => void;
}

function defaultSubscribe(listener: () => void): () => void {
  if (typeof window === "undefined") return () => {};
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

export function createScheduler({
  run,
  onError,
  settleMs = 15 * 60 * 1000,
  online = () => (typeof navigator === "undefined" ? true : navigator.onLine),
  subscribe = defaultSubscribe,
}: SchedulerOptions): Scheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let stopped = false;

  const clear = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const fire = async () => {
    if (stopped) return;
    // One at a time. A second sync while the first is mid-push would send the same
    // queue entries twice.
    if (inFlight !== null) return inFlight;
    inFlight = (async () => {
      try {
        await run();
      } catch (error) {
        // Reported, never thrown: a failed sync is an ordinary outcome of being on a
        // train, and nothing above should have to catch it.
        onError?.(error);
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  };

  const onConnectivityChange = () => {
    clear();
    if (stopped || !online()) return;
    timer = setTimeout(() => {
      timer = null;
      void fire();
    }, settleMs);
  };

  const unsubscribe = subscribe(onConnectivityChange);
  // Start the window if the app opens already online.
  onConnectivityChange();

  return {
    syncNow: async () => {
      // Deliberately bypasses the settle window. Someone who asked for it is watching.
      clear();
      await fire();
    },
    running: () => inFlight !== null,
    stop: () => {
      stopped = true;
      clear();
      unsubscribe();
    },
  };
}
