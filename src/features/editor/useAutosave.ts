import { useCallback, useEffect, useRef } from "react";

export type SaveState = "clean" | "pending" | "saving" | "error";

export interface Autosave {
  /** Record a change. Saves after the quiet period, or sooner if flushed. */
  schedule: (payload: unknown) => void;
  /** Write anything outstanding now. Safe to call when there is nothing. */
  flush: () => Promise<void>;
}

/**
 * Debounced writes to the local replica.
 *
 * Offline-first: a save is a local transaction, so it is fast and cannot fail for
 * network reasons. It is still debounced because a typing session produces hundreds
 * of changes a minute and each one would rewrite the whole document body.
 *
 * The part that matters is `flush`. Anything outstanding must be written before the
 * editor unmounts or moves to another document, or the last few seconds of writing
 * are lost — silently, because nothing failed.
 */
export function useAutosave(
  save: (payload: unknown) => Promise<void>,
  onState: (state: SaveState, error?: string) => void,
  quietMs = 700,
): Autosave {
  const pending = useRef<{ payload: unknown } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inFlight = useRef<Promise<void> | null>(null);

  // Kept in refs so a re-render with a new closure does not strand a scheduled save
  // pointing at the previous document.
  const saveRef = useRef(save);
  const stateRef = useRef(onState);
  saveRef.current = save;
  stateRef.current = onState;

  const write = useCallback(async () => {
    const next = pending.current;
    if (!next) return;
    pending.current = null;
    stateRef.current("saving");
    try {
      await saveRef.current(next.payload);
      // Only clean if nothing arrived while the write was in flight.
      stateRef.current(pending.current === null ? "clean" : "pending");
    } catch (cause) {
      // Put it back: a failed save must not discard the author's words.
      pending.current = next;
      stateRef.current("error", cause instanceof Error ? cause.message : String(cause));
    }
  }, []);

  const flush = useCallback(async () => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    // Wait for a write already running, then write whatever arrived after it.
    await inFlight.current;
    inFlight.current = write();
    await inFlight.current;
  }, [write]);

  const schedule = useCallback(
    (payload: unknown) => {
      pending.current = { payload };
      stateRef.current("pending");
      if (timer.current !== null) clearTimeout(timer.current);
      timer.current = setTimeout(() => {
        timer.current = null;
        inFlight.current = write();
      }, quietMs);
    },
    [write, quietMs],
  );

  useEffect(
    () => () => {
      // Unmounting is the commonest way to lose the last edit: navigating away, or
      // the route swapping one document for another.
      if (timer.current !== null) clearTimeout(timer.current);
      void write();
    },
    [write],
  );

  return { schedule, flush };
}
