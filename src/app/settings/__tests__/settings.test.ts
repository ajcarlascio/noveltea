import { describe, expect, it } from "vitest";
import {
  DEFAULT_SETTINGS,
  grantConsent,
  mayUseNetwork,
  NETWORK_FEATURES,
  parseSettings,
  readSettings,
  revokeConsent,
  SETTINGS_STORAGE_KEY,
  writeSettings,
  type Settings,
} from "../settings";

function fakeStorage(initial: Record<string, string> = {}) {
  const map = new Map(Object.entries(initial));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    snapshot: () => Object.fromEntries(map),
  };
}

const stored = (value: unknown) => fakeStorage({ [SETTINGS_STORAGE_KEY]: JSON.stringify(value) });

describe("defaults", () => {
  it("has every network feature off and unconsented", () => {
    // The whole point of the feature: nothing leaves the device until asked.
    for (const feature of NETWORK_FEATURES) {
      expect(DEFAULT_SETTINGS[feature].enabled).toBe(false);
      expect(DEFAULT_SETTINGS.consent[feature].grantedAt).toBeNull();
      expect(mayUseNetwork(DEFAULT_SETTINGS, feature)).toBe(false);
    }
  });

  it("has the local features on, because they cost nothing to anyone", () => {
    expect(DEFAULT_SETTINGS.smartTypography).toBe(true);
    expect(DEFAULT_SETTINGS.thesaurus).toBe(true);
  });
});

describe("mayUseNetwork, as the last line of defence", () => {
  it("refuses a state where enabled is true but consent is absent", () => {
    // Built by hand rather than through parseSettings, which already forces this
    // state out. That is the point: mayUseNetwork is what every request asks, and it
    // must not depend on having been given a value that went through the parser. A
    // future code path that flips `enabled` without recording consent stops here.
    const inconsistent: Settings = {
      ...DEFAULT_SETTINGS,
      datamuse: { enabled: true },
      consent: { datamuse: { grantedAt: null }, assistant: { grantedAt: null } },
    };
    expect(mayUseNetwork(inconsistent, "datamuse")).toBe(false);
  });

  it("refuses a state where consent exists but the feature is off", () => {
    const consentedButOff: Settings = {
      ...DEFAULT_SETTINGS,
      datamuse: { enabled: false },
      consent: {
        datamuse: { grantedAt: "2026-08-21T10:00:00.000Z" },
        assistant: { grantedAt: null },
      },
    };
    expect(mayUseNetwork(consentedButOff, "datamuse")).toBe(false);
  });

  it("permits only the pair of both", () => {
    const allowed: Settings = {
      ...DEFAULT_SETTINGS,
      datamuse: { enabled: true },
      consent: {
        datamuse: { grantedAt: "2026-08-21T10:00:00.000Z" },
        assistant: { grantedAt: null },
      },
    };
    expect(mayUseNetwork(allowed, "datamuse")).toBe(true);
    expect(mayUseNetwork(allowed, "assistant")).toBe(false);
  });
});

describe("parsing untrusted storage", () => {
  it("falls back for absent, unparseable and wrongly typed values", () => {
    expect(parseSettings(null)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings("nonsense")).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings(42)).toEqual(DEFAULT_SETTINGS);
    expect(parseSettings({ smartTypography: "yes" }).smartTypography).toBe(true);
  });

  it("refuses to enable a network feature with no consent recorded", () => {
    // Hand-edited storage, or a value written by a build that predates the consent
    // flow. Either way the feature must not come up quietly enabled.
    const parsed = parseSettings({
      datamuse: { enabled: true },
      assistant: { enabled: true },
    });
    expect(parsed.datamuse.enabled).toBe(false);
    expect(parsed.assistant.enabled).toBe(false);
    expect(mayUseNetwork(parsed, "datamuse")).toBe(false);
  });

  it("refuses a consent timestamp that is not a date", () => {
    // Failing closed: the cost of asking again is a dialog; the cost of getting this
    // wrong is sending someone's manuscript somewhere they never agreed to.
    const parsed = parseSettings({
      datamuse: { enabled: true },
      consent: { datamuse: { grantedAt: "whenever" } },
    });
    expect(parsed.consent.datamuse.grantedAt).toBeNull();
    expect(parsed.datamuse.enabled).toBe(false);
  });

  it("keeps a feature that was properly consented to", () => {
    const parsed = parseSettings({
      datamuse: { enabled: true },
      consent: { datamuse: { grantedAt: "2026-08-21T10:00:00.000Z" } },
    });
    expect(mayUseNetwork(parsed, "datamuse")).toBe(true);
    // ...and only that one.
    expect(mayUseNetwork(parsed, "assistant")).toBe(false);
  });

  it("reads through storage, and survives storage that throws", () => {
    expect(readSettings(stored({ smartTypography: false })).smartTypography).toBe(false);
    expect(
      readSettings({
        getItem: () => {
          throw new Error("blocked");
        },
      }),
    ).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(undefined)).toEqual(DEFAULT_SETTINGS);
  });

  it("survives storage holding invalid JSON", () => {
    expect(readSettings(fakeStorage({ [SETTINGS_STORAGE_KEY]: "{not json" }))).toEqual(
      DEFAULT_SETTINGS,
    );
  });
});

describe("granting and withdrawing", () => {
  it("records the moment and enables in one step", () => {
    const at = new Date("2026-08-21T12:00:00.000Z");
    const next = grantConsent(DEFAULT_SETTINGS, "datamuse", at);

    expect(next.consent.datamuse.grantedAt).toBe(at.toISOString());
    expect(next.datamuse.enabled).toBe(true);
    expect(mayUseNetwork(next, "datamuse")).toBe(true);
  });

  it("touches only the feature named", () => {
    const next = grantConsent(DEFAULT_SETTINGS, "datamuse");
    expect(mayUseNetwork(next, "assistant")).toBe(false);
    expect(next.consent.assistant.grantedAt).toBeNull();
  });

  it("does not mutate what it was given", () => {
    // The provider holds settings in React state; mutating in place would leave the
    // UI showing a value that never triggered a render.
    const before = JSON.stringify(DEFAULT_SETTINGS);
    grantConsent(DEFAULT_SETTINGS, "datamuse");
    revokeConsent(DEFAULT_SETTINGS, "datamuse");
    expect(JSON.stringify(DEFAULT_SETTINGS)).toBe(before);
  });

  it("forgets the consent when withdrawn, so the next attempt asks again", () => {
    const granted = grantConsent(DEFAULT_SETTINGS, "datamuse");
    const revoked = revokeConsent(granted, "datamuse");

    expect(revoked.datamuse.enabled).toBe(false);
    // Keeping the timestamp would let a later toggle re-enable it without asking,
    // which is not what someone who turned it off meant.
    expect(revoked.consent.datamuse.grantedAt).toBeNull();
  });
});

describe("round-tripping", () => {
  it("writes settings a later read recovers exactly", () => {
    const storage = fakeStorage();
    const settings = grantConsent({ ...DEFAULT_SETTINGS, smartTypography: false }, "assistant");
    writeSettings(storage, settings);
    expect(readSettings(storage)).toEqual(settings);
  });

  it("does not throw when storage is unavailable", () => {
    expect(() => writeSettings(undefined, DEFAULT_SETTINGS)).not.toThrow();
    expect(() =>
      writeSettings(
        {
          setItem: () => {
            throw new Error("full");
          },
        },
        DEFAULT_SETTINGS,
      ),
    ).not.toThrow();
  });
});
