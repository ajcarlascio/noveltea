import { afterEach, describe, expect, it, vi } from "vitest";
import { checkForUpdate, hostVersion, installUpdate } from "@/platform/updates";

/**
 * The update check. Every assertion here is about the same rule: a failed check is not
 * an event in an author's day. The app works with no network at all, so an unreachable
 * update server is the ordinary case, and treating it as an error would put a banner in
 * front of someone whose only problem is being on a train.
 */

function withHost(invoke: (command: string) => Promise<unknown>) {
  vi.stubGlobal("window", { __TAURI_INTERNALS__: { invoke } });
}

afterEach(() => vi.unstubAllGlobals());

describe("checkForUpdate", () => {
  it("offers nothing in a browser tab, without calling anything", async () => {
    const invoke = vi.fn();
    vi.stubGlobal("window", {});
    await expect(checkForUpdate()).resolves.toBeNull();
    expect(invoke).not.toHaveBeenCalled();
  });

  it("reports the version and notes the host found", async () => {
    withHost(() => Promise.resolve({ version: "0.3.0", notes: "Adds the outliner." }));
    await expect(checkForUpdate()).resolves.toEqual({
      version: "0.3.0",
      notes: "Adds the outliner.",
    });
  });

  it("treats a release with no notes as a release with no notes", async () => {
    // An empty body is what GitHub sends for a release nobody wrote notes for, and it
    // must not render as an empty line beside the version.
    withHost(() => Promise.resolve({ version: "0.3.0", notes: "" }));
    await expect(checkForUpdate()).resolves.toEqual({ version: "0.3.0", notes: null });
  });

  it("offers nothing when the host says there is nothing", async () => {
    withHost(() => Promise.resolve(null));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("is silent when the check itself fails", async () => {
    // Offline, DNS gone, a 404 from a release nobody published yet. The author is
    // writing; none of this is theirs to deal with.
    withHost(() => Promise.reject(new Error("error sending request")));
    await expect(checkForUpdate()).resolves.toBeNull();
  });

  it("refuses a version-less answer rather than offering a nameless update", async () => {
    // A banner reading "NovelTea undefined is available" is worse than no banner.
    for (const nonsense of [{}, { version: "" }, { version: 3 }, "0.3.0", 42]) {
      withHost(() => Promise.resolve(nonsense));
      await expect(checkForUpdate()).resolves.toBeNull();
    }
  });
});

describe("installUpdate", () => {
  it("reports its failure, unlike the check", async () => {
    // The author pressed a button and is waiting. Silence here would leave them
    // watching a spinner that never resolves.
    withHost(() => Promise.reject(new Error("the update could not be installed: disk full")));
    await expect(installUpdate()).rejects.toThrow(/disk full/);
  });

  it("refuses in a browser tab, where there is nothing to install", async () => {
    vi.stubGlobal("window", {});
    await expect(installUpdate()).rejects.toThrow(/desktop app/);
  });
});

describe("hostVersion", () => {
  it("is null in a browser tab", async () => {
    vi.stubGlobal("window", {});
    await expect(hostVersion()).resolves.toBeNull();
  });

  it("is what the host reports", async () => {
    withHost(() => Promise.resolve("0.2.0"));
    await expect(hostVersion()).resolves.toBe("0.2.0");
  });
});
