/**
 * Settings that are not the theme or the reading font.
 *
 * Those two are separate single-purpose keys because a script in <head> has to read
 * them before any module loads, to avoid a flash of the wrong colours or a reflow
 * when the metrics change. Everything here is read after the app is running, so it
 * lives in one validated object instead of accumulating keys.
 *
 * Every field is validated on read. The value comes from local storage, which is
 * editable by hand and survives across versions of the app, so it is untrusted
 * input like any other.
 */

export const SETTINGS_STORAGE_KEY = "noveltea.settings";

/**
 * Anything that sends an author's words off their device.
 *
 * Kept as a named union rather than booleans scattered through the object, because
 * consent is granted per destination and the interface has to be able to say which
 * one it is asking about.
 */
export const NETWORK_FEATURES = ["datamuse", "assistant"] as const;
export type NetworkFeature = (typeof NETWORK_FEATURES)[number];

export interface Consent {
  /** ISO-8601 UTC. Absent means never granted. */
  grantedAt: string | null;
}

export interface Settings {
  /** Smart quotes, dashes and ellipses as you type. */
  smartTypography: boolean;
  /** Offline thesaurus. Local, so it needs no consent. */
  thesaurus: boolean;
  datamuse: {
    enabled: boolean;
  };
  assistant: {
    enabled: boolean;
    /** Which provider the author configured, for display only. */
    provider: string | null;
  };
  consent: Record<NetworkFeature, Consent>;
}

export const DEFAULT_SETTINGS: Settings = {
  // On by default: novelists expect curly quotes, and the toggle is for the minority
  // writing code or dialect who need them left alone.
  smartTypography: true,
  thesaurus: true,
  // Everything that leaves the device is off until asked for, explicitly, twice.
  datamuse: { enabled: false },
  assistant: { enabled: false, provider: null },
  consent: { datamuse: { grantedAt: null }, assistant: { grantedAt: null } },
};

function bool(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  // A timestamp that does not parse is treated as no consent. Failing closed is the
  // only safe direction: the cost of asking again is a dialog, the cost of getting it
  // wrong is sending someone's manuscript somewhere they never agreed to.
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** Parses whatever is in storage into a complete, valid Settings. */
export function parseSettings(raw: unknown): Settings {
  if (raw === null || typeof raw !== "object") return structuredCloneSettings(DEFAULT_SETTINGS);
  const source = raw as Record<string, unknown>;
  const datamuse = (source.datamuse ?? {}) as Record<string, unknown>;
  const assistant = (source.assistant ?? {}) as Record<string, unknown>;
  const consent = (source.consent ?? {}) as Record<string, unknown>;

  const consentFor = (feature: NetworkFeature): Consent => {
    const entry = (consent[feature] ?? {}) as Record<string, unknown>;
    return { grantedAt: isoOrNull(entry.grantedAt) };
  };

  const settings: Settings = {
    smartTypography: bool(source.smartTypography, DEFAULT_SETTINGS.smartTypography),
    thesaurus: bool(source.thesaurus, DEFAULT_SETTINGS.thesaurus),
    datamuse: { enabled: bool(datamuse.enabled, false) },
    assistant: {
      enabled: bool(assistant.enabled, false),
      provider: typeof assistant.provider === "string" ? assistant.provider : null,
    },
    consent: { datamuse: consentFor("datamuse"), assistant: consentFor("assistant") },
  };

  // The invariant that matters: a network feature cannot be on without consent
  // recorded for it. Storage edited by hand, or written by a build that predates the
  // consent flow, must not leave a feature quietly enabled.
  for (const feature of NETWORK_FEATURES) {
    if (settings.consent[feature].grantedAt === null) {
      settings[feature].enabled = false;
    }
  }
  return settings;
}

function structuredCloneSettings(settings: Settings): Settings {
  return {
    ...settings,
    datamuse: { ...settings.datamuse },
    assistant: { ...settings.assistant },
    consent: {
      datamuse: { ...settings.consent.datamuse },
      assistant: { ...settings.consent.assistant },
    },
  };
}

export function readSettings(storage: Pick<Storage, "getItem"> | undefined): Settings {
  if (!storage) return structuredCloneSettings(DEFAULT_SETTINGS);
  try {
    const raw = storage.getItem(SETTINGS_STORAGE_KEY);
    return parseSettings(raw === null ? null : JSON.parse(raw));
  } catch {
    // Unparseable or blocked. Defaults, which have every network feature off.
    return structuredCloneSettings(DEFAULT_SETTINGS);
  }
}

export function writeSettings(
  storage: Pick<Storage, "setItem"> | undefined,
  settings: Settings,
): void {
  if (!storage) return;
  try {
    storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  } catch {
    // Honoured for this session; not persisted.
  }
}

/** Records consent and turns the feature on, in one step so they cannot diverge. */
export function grantConsent(settings: Settings, feature: NetworkFeature, now = new Date()): Settings {
  const next = structuredCloneSettings(settings);
  next.consent[feature] = { grantedAt: now.toISOString() };
  next[feature].enabled = true;
  return next;
}

/**
 * Turns the feature off and forgets the consent.
 *
 * Withdrawing means the next attempt asks again. Keeping the timestamp would let a
 * later toggle re-enable it silently, which is not what someone who turned it off
 * meant.
 */
export function revokeConsent(settings: Settings, feature: NetworkFeature): Settings {
  const next = structuredCloneSettings(settings);
  next.consent[feature] = { grantedAt: null };
  next[feature].enabled = false;
  return next;
}

/** The single question the rest of the app asks before any request leaves. */
export function mayUseNetwork(settings: Settings, feature: NetworkFeature): boolean {
  return settings[feature].enabled && settings.consent[feature].grantedAt !== null;
}
