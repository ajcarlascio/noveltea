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

  it("STARTS EMPTY RATHER THAN NOT AT ALL WHEN THE FILE CANNOT BE READ", async () => {
    // Refusing to start would leave an author with no app. Starting empty leaves them
    // with one, and the sync engine pulls their work back from the server. Which of
    // those is worse is not a close call.
    withHost(() => Promise.reject(new Error("permission denied")));
    await expect(loadDatabase()).resolves.toBeNull();
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
