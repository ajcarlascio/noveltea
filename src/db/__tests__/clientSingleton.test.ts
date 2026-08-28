import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * One writer, enforced rather than hoped for.
 *
 * "The database has exactly one writer" is the rule the whole local store rests on. It
 * used to be a convention: `DatabaseProvider` built its client in a `useState`
 * initializer, and React's StrictMode double-invokes those — so development ran two
 * workers, each with its own in-memory copy of the database, each flushing that whole
 * copy over the same file. The desktop shell has a single-instance guard for exactly
 * this hazard between processes; this is the same hazard inside one.
 */
describe("createDatabaseClient", () => {
  const spawned: unknown[] = [];

  beforeEach(() => {
    vi.resetModules();
    spawned.length = 0;
    // A worker that does nothing. Constructing a real one needs a bundler.
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          spawned.push(this);
        }
        postMessage() {}
        addEventListener() {}
        removeEventListener() {}
        terminate() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  it("HANDS BACK THE SAME CLIENT RATHER THAN A SECOND WORKER", async () => {
    const { createDatabaseClient } = await import("@/db/client");
    const first = createDatabaseClient();
    const second = createDatabaseClient();

    expect(second).toBe(first);
    expect(spawned).toHaveLength(1);
  });

  it("replaces a client that has been closed", async () => {
    // StrictMode's simulated unmount closes it between the two mounts. Returning the
    // closed one would leave the app holding a database it can no longer read.
    const { createDatabaseClient } = await import("@/db/client");
    const first = createDatabaseClient();
    first.close();

    const second = createDatabaseClient();
    expect(second).not.toBe(first);
    expect(second.closed).toBe(false);
    expect(spawned).toHaveLength(2);
  });
});
