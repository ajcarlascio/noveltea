import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@sqlite.org/sqlite-wasm", () => ({
  default: () => Promise.resolve({
    oo1: { DB: class {} },
    installOpfsSAHPoolVfs: () => Promise.reject(new Error("access handle busy")),
  }),
}));

/**
 * Failing to get the OPFS pool means two different things. Behind a lock another tab
 * holds, the memory fallback is a trap to refuse; in a private window it is the
 * supported degraded mode. Telling them apart is the whole job of the lock.
 */
describe("opening when the OPFS pool cannot be installed", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  async function open() {
    const { openDatabase } = await import("@/db/open");
    const opened = openDatabase();
    await vi.advanceTimersByTimeAsync(3000);
    return opened;
  }

  it("reports contention when another tab holds the replica lock, and stops queueing", async () => {
    let signal: AbortSignal | undefined;
    vi.stubGlobal("navigator", {
      locks: {
        request: (_name: string, options: { signal: AbortSignal }) => {
          signal = options.signal;
          return new Promise(() => undefined);
        },
      },
    });
    await expect(open()).resolves.toMatchObject({ storage: "contended" });
    expect(signal?.aborted).toBe(true);
  });

  it("stays plain memory when this worker has the lock", async () => {
    vi.stubGlobal("navigator", {
      locks: { request: (_n: string, _o: unknown, cb: () => unknown) => Promise.resolve(cb()) },
    });
    await expect(open()).resolves.toMatchObject({ storage: "memory" });
  });

  it("stays plain memory where there are no Web Locks at all", async () => {
    vi.stubGlobal("navigator", {});
    await expect(open()).resolves.toMatchObject({ storage: "memory" });
  });
});
