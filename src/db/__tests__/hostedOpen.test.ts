import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * What happens when the desktop host cannot read the database file.
 *
 * The failure this guards against is the worst one this codebase can produce: an
 * unreadable file reported as "no file yet" makes the worker open an *empty* database,
 * migrate it and flush — and that flush is written over the author's book. An empty
 * SQLite file passes every guard downstream, including the host's magic-number check,
 * so nothing anywhere reports it. The book is simply gone, before a key is pressed.
 *
 * So the assertion is about what does *not* happen: the worker is never opened.
 */
describe("opening under a desktop host", () => {
  const posted: unknown[] = [];

  beforeEach(() => {
    vi.resetModules();
    posted.length = 0;
    vi.stubGlobal(
      "Worker",
      class {
        postMessage(message: unknown) {
          posted.push(message);
        }
        addEventListener() {}
        removeEventListener() {}
        terminate() {}
      },
    );
  });

  afterEach(() => vi.unstubAllGlobals());

  /** A host whose `db_load` behaves as given; everything else resolves. */
  function withHost(load: () => Promise<unknown>) {
    vi.stubGlobal("window", {
      __TAURI_INTERNALS__: {
        invoke: (command: string) => (command === "db_load" ? load() : Promise.resolve(null)),
      },
    });
  }

  async function spawn() {
    const { createDatabaseClient } = await import("@/db/client");
    const client = createDatabaseClient();
    // The load is a promise chain kicked off in the constructor; let it settle.
    await new Promise((resolve) => setTimeout(resolve, 0));
    return client;
  }

  it("NEVER OPENS THE WORKER WHEN THE FILE COULD NOT BE READ", async () => {
    withHost(() => Promise.reject(new Error("permission denied")));
    const client = await spawn();

    // The whole fix. One "open" message here is one empty database written over a book.
    expect(posted).toEqual([]);
    expect(client.status.state).toBe("failed");
  });

  it("says the work is still there, because it is", async () => {
    // The file was not readable; it was not lost. Telling an author their projects
    // could not be read is recoverable — telling them nothing, and silently starting
    // empty, teaches them their book is gone.
    withHost(() => Promise.reject(new Error("permission denied")));
    const client = await spawn();

    const status = client.status;
    if (status.state !== "failed") throw new Error(`expected failed, got ${status.state}`);
    expect(status.error.message).toMatch(/on this machine/i);
    expect(status.error.message).toMatch(/permission denied/);
  });

  it("opens normally on a first run, when there really is no file", async () => {
    // The case the old behaviour was conflated with, and the one that must keep working:
    // a machine that has never run NovelTea has no file, and that is not a failure.
    withHost(() => Promise.resolve(null));
    const client = await spawn();

    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "open", initial: null, hosted: true });
    expect(client.status.state).toBe("opening");
  });

  it("hands the stored bytes to the worker when the file reads back", async () => {
    withHost(() => Promise.resolve([1, 2, 3]));
    await spawn();

    expect(posted).toHaveLength(1);
    const message = posted[0] as { kind: string; initial: ArrayBuffer; hosted: boolean };
    expect(message.kind).toBe("open");
    expect(message.hosted).toBe(true);
    expect(new Uint8Array(message.initial)).toEqual(Uint8Array.from([1, 2, 3]));
  });
});
