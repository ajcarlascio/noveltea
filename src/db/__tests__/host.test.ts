import { afterEach, describe, expect, it, vi } from "vitest";
import { isHosted, loadDatabase, saveDatabase } from "@/db/host";

/**
 * The bridge to the desktop host. Everything here is about degrading rather than
 * failing: a browser tab has no host at all, and a host that cannot read its own file
 * must not stop an author writing.
 */

function withHost(invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>) {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
}

afterEach(() => vi.unstubAllGlobals());

describe("isHosted", () => {
  it("is false in a browser tab", () => {
    vi.stubGlobal("window", {});
    expect(isHosted()).toBe(false);
  });

  it("is false when the bridge is there but unusable", () => {
    vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke: "not a function" } });
    expect(isHosted()).toBe(false);
  });

  it("is true inside the desktop shell", () => {
    withHost(() => Promise.resolve(null));
    expect(isHosted()).toBe(true);
  });
});

describe("loadDatabase", () => {
  it("returns null the first time, when there is no file yet", async () => {
    withHost(() => Promise.resolve(null));
    await expect(loadDatabase()).resolves.toBeNull();
  });

  it("accepts the array Tauri's IPC actually delivers", async () => {
    // Bytes cross the bridge as JSON, so they arrive as a plain array of numbers.
    withHost(() => Promise.resolve([1, 2, 3]));
    await expect(loadDatabase()).resolves.toEqual(Uint8Array.from([1, 2, 3]));
  });

  it("THROWS WHEN THE FILE CANNOT BE READ, RATHER THAN CLAIMING THERE ISN'T ONE", async () => {
    // This test used to assert the opposite, on the grounds that an author is better
    // off with an empty app than no app, and that sync would pull their work back.
    //
    // That was wrong, and expensively so. `null` means "no file yet", so the worker
    // opens an empty database, migrates it, and flushes — and the host writes that
    // empty file atomically over the author's book. It is a valid SQLite file, so the
    // magic-number guard passes and nothing notices. Meanwhile the app is built to work
    // with no server at all, so "sync will pull it back" is not available to most
    // people who would hit this.
    //
    // The host already tells the two apart: read_database answers Ok(None) only for
    // NotFound. Everything else is a real failure and has to stay one.
    withHost(() => Promise.reject(new Error("permission denied")));
    await expect(loadDatabase()).rejects.toThrow(/permission denied/);
  });

  it("throws rather than guessing when the bridge answers with nonsense", async () => {
    // Also not a first run. Guessing "empty" here writes the guess over the file.
    for (const nonsense of [42, "a database", { bytes: [1, 2] }]) {
      withHost(() => Promise.resolve(nonsense));
      await expect(loadDatabase()).rejects.toThrow(/not a database/);
    }
  });
});

describe("saveDatabase", () => {
  it("sends the bytes as an array, which is what the host can decode", async () => {
    const calls: { command: string; args: Record<string, unknown> | undefined }[] = [];
    withHost((command, args) => {
      calls.push({ command, args });
      return Promise.resolve(null);
    });

    await saveDatabase(Uint8Array.from([7, 8, 9]));
    expect(calls[0]?.command).toBe("db_save");
    // A Uint8Array would arrive on the Rust side as an object with numeric keys.
    expect(calls[0]?.args).toEqual({ bytes: [7, 8, 9] });
  });

  it("reports a failure rather than swallowing it", async () => {
    withHost(() => Promise.reject(new Error("disk full")));
    await expect(saveDatabase(Uint8Array.from([1]))).rejects.toThrow(/disk full/);
  });

  it("refuses when there is no host to save to", async () => {
    vi.stubGlobal("window", {});
    await expect(saveDatabase(Uint8Array.from([1]))).rejects.toThrow(/no desktop host/i);
  });
});
