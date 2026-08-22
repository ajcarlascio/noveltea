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
  /**
   * Whether an automatic sync may run right now.
   *
   * Read at fire time rather than at construction: the setting can be changed and the
   * connection can move from wifi to cellular during the settle window, and the answer
   * that matters is the one at the moment bytes would be sent.
   */
  mayRun?: () => boolean;
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
  mayRun = () => true,
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
      // Checked here and not before the timer is set, because the window is fifteen
      // minutes long and a phone can find wifi inside it.
      if (mayRun()) void fire();
    }, settleMs);
  };

  const unsubscribe = subscribe(onConnectivityChange);
  // Start the window if the app opens already online.
  onConnectivityChange();

  return {
    syncNow: async () => {
      // Bypasses the settle window and the metered check both. Someone who pressed the
      // button is watching, and asking for it is the consent — refusing here would be
      // the app overruling an explicit instruction about the author's own data.
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
