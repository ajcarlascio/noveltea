import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createScheduler } from "../scheduler";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(startOnline = true, startMayRun = true) {
  let online = startOnline;
  let mayRun = startMayRun;
  const listeners: (() => void)[] = [];
  const run = vi.fn<() => Promise<unknown>>().mockResolvedValue(undefined);
  const onError = vi.fn();

  const scheduler = createScheduler({
    run: () => run(),
    onError,
    settleMs: 15 * 60 * 1000,
    online: () => online,
    subscribe: (listener) => {
      listeners.push(listener);
      return () => listeners.splice(listeners.indexOf(listener), 1);
    },
    mayRun: () => mayRun,
  });

  return {
    scheduler,
    run,
    onError,
    // An arrow property, not a method: destructured off the object it would carry no
    // `this`, which the lint rule is right to object to.
    setOnline: (next: boolean) => {
      online = next;
      for (const listener of [...listeners]) listener();
    },
    setMayRun: (next: boolean) => {
      mayRun = next;
    },
  };
}

describe("the settle window", () => {
  it("waits fifteen minutes before syncing", async () => {
    const { run } = setup(true);

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("starts over when the connection drops", async () => {
    const { run, setOnline } = setup(true);

    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    setOnline(false);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    // A train, a tunnel, a phone hunting for signal: a sync started on every flicker
    // would fail halfway, every time.
    expect(run).not.toHaveBeenCalled();

    setOnline(true);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("does not start a window while offline", async () => {
    const { run } = setup(false);
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });

  it("does not stack windows when connectivity flaps", async () => {
    const { run, setOnline } = setup(true);
    for (let i = 0; i < 5; i += 1) {
      setOnline(false);
      setOnline(true);
    }
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    // Five windows would mean five syncs.
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("sync now", () => {
  it("runs immediately, whatever the timer was doing", async () => {
    const { scheduler, run } = setup(true);
    await scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("cancels the pending window rather than syncing twice", async () => {
    const { scheduler, run } = setup(true);
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
    await scheduler.syncNow();
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("works even while offline, because the author asked", async () => {
    // They may know something the browser does not — a VPN just came up, or
    // navigator.onLine is simply wrong, which it often is.
    const { scheduler, run } = setup(false);
    await scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("overlap", () => {
  it("does not start a second run while one is in flight", async () => {
    let release: (() => void) | undefined;
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));

    const online = true;
    const scheduler = createScheduler({
      run: () => run(),
      settleMs: 1000,
      online: () => online,
      subscribe: () => () => {},
    });
    void online;

    const first = scheduler.syncNow();
    const second = scheduler.syncNow();
    // A second sync mid-push would send the same queue entries twice.
    expect(run).toHaveBeenCalledTimes(1);
    expect(scheduler.running()).toBe(true);

    release?.();
    await Promise.all([first, second]);
    expect(scheduler.running()).toBe(false);
  });
});

describe("failure", () => {
  it("reports the error instead of throwing it", async () => {
    const onError = vi.fn();
    const scheduler = createScheduler({
      run: () => Promise.reject(new Error("offline")),
      onError,
      settleMs: 1000,
      online: () => true,
      subscribe: () => () => {},
    });

    // A failed sync is an ordinary outcome of being on a train; nothing above should
    // have to catch it.
    await expect(scheduler.syncNow()).resolves.toBeUndefined();
    expect(onError).toHaveBeenCalledWith(expect.any(Error));
  });

  it("can still sync after a failure", async () => {
    const run = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    const scheduler = createScheduler({
      run: () => run(),
      onError: () => undefined,
      settleMs: 1000,
      online: () => true,
      subscribe: () => () => {},
    });

    await scheduler.syncNow();
    await scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(2);
  });
});

describe("stopping", () => {
  it("cancels a pending window and unsubscribes", async () => {
    const { scheduler, run } = setup(true);
    scheduler.stop();
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });
});

describe("holding a sync back", () => {
  it("does not fire when the connection is one the author asked to avoid", async () => {
    const { run } = setup(true, false);
    await vi.advanceTimersByTimeAsync(15 * 60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });

  it("ASKS AT FIRE TIME, NOT WHEN THE WINDOW OPENED", async () => {
    // The window is fifteen minutes long. A phone that finds wifi inside it should
    // sync at the end of the window it already served, not start a new one.
    const { run, setMayRun } = setup(true, false);
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    setMayRun(true);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("stops firing when the connection becomes one to avoid mid-window", async () => {
    const { run, setMayRun } = setup(true, true);
    await vi.advanceTimersByTimeAsync(14 * 60 * 1000);
    setMayRun(false);
    await vi.advanceTimersByTimeAsync(60 * 1000);
    expect(run).not.toHaveBeenCalled();
  });

  it("SYNC NOW OVERRIDES IT", async () => {
    // Pressing the button is the consent. Refusing here would be the app overruling
    // an explicit instruction about the author's own data.
    const { scheduler, run } = setup(true, false);
    await scheduler.syncNow();
    expect(run).toHaveBeenCalledTimes(1);
  });
});
