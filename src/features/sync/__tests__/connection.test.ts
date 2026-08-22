import { describe, expect, it, vi } from "vitest";
import { mayAutoSync, meteringOf, subscribeToConnection } from "../connection";

/**
 * What the platform will say about a connection, and what is done when it says
 * nothing — which is most browsers, most of the time.
 */

const nav = (connection: unknown) => ({ connection });

describe("meteringOf", () => {
  it("reports unknown where the API does not exist", () => {
    // Safari and Firefox expose no `connection` at all.
    expect(meteringOf({})).toBe("unknown");
    expect(meteringOf(null)).toBe("unknown");
    expect(meteringOf("not a navigator")).toBe("unknown");
  });

  it("names a cellular bearer as metered", () => {
    expect(meteringOf(nav({ type: "cellular" }))).toBe("metered");
  });

  it("names wifi and ethernet as unmetered", () => {
    expect(meteringOf(nav({ type: "wifi" }))).toBe("unmetered");
    expect(meteringOf(nav({ type: "ethernet" }))).toBe("unmetered");
  });

  it("treats saveData as metered whatever the bearer is", () => {
    // The author telling the whole platform they are counting bytes is a clearer
    // signal than a `type` field that is missing on most engines.
    expect(meteringOf(nav({ saveData: true }))).toBe("metered");
    expect(meteringOf(nav({ saveData: true, type: "wifi" }))).toBe("metered");
  });

  it("does not read speed as cost", () => {
    // effectiveType describes how fast the link is. A slow connection is not a
    // charged one, and a fast one can still be a tethered phone.
    expect(meteringOf(nav({ effectiveType: "2g" }))).toBe("unknown");
    expect(meteringOf(nav({ effectiveType: "4g" }))).toBe("unknown");
  });

  it("passes through the API's own 'unknown'", () => {
    expect(meteringOf(nav({ type: "unknown" }))).toBe("unknown");
  });
});

describe("mayAutoSync", () => {
  it("runs everything when the setting is off", () => {
    expect(mayAutoSync(false, "metered")).toBe(true);
    expect(mayAutoSync(false, "unknown")).toBe(true);
  });

  it("holds a metered connection when the setting is on", () => {
    expect(mayAutoSync(true, "metered")).toBe(false);
  });

  it("STILL SYNCS WHEN THE CONNECTION CANNOT BE IDENTIFIED", () => {
    // The alternative is an author's work silently ceasing to reach their server on
    // every browser that does not implement the API, which is most of them. Guessing
    // with somebody else's manuscript is not a trade this makes.
    expect(mayAutoSync(true, "unknown")).toBe(true);
  });

  it("syncs on a connection known to be unmetered", () => {
    expect(mayAutoSync(true, "unmetered")).toBe(true);
  });
});

describe("subscribeToConnection", () => {
  it("listens for change and stops on unsubscribe", () => {
    const addEventListener = vi.fn();
    const removeEventListener = vi.fn();
    const stop = subscribeToConnection(nav({ addEventListener, removeEventListener }), () => undefined);

    expect(addEventListener).toHaveBeenCalledWith("change", expect.any(Function));
    stop();
    expect(removeEventListener).toHaveBeenCalledWith("change", expect.any(Function));
  });

  it("is a no-op where there is nothing to listen to", () => {
    expect(() => subscribeToConnection({}, () => undefined)()).not.toThrow();
  });

  it("survives an engine that throws on addEventListener", () => {
    const stop = subscribeToConnection(
      nav({
        addEventListener: () => {
          throw new Error("not supported");
        },
      }),
      () => undefined,
    );
    expect(() => stop()).not.toThrow();
  });
});
