/**
 * Which server an author signs in to.
 *
 * NovelTea is self-hosted, so there is no default instance and never will be. The
 * address is something the author types, remembers, and switches between — a laptop
 * against a home server, a phone against the same one over a tunnel — so it is a
 * first-class piece of state rather than a build-time constant.
 */

export const SERVERS_STORAGE_KEY = "noveltea.servers";

export interface KnownServer {
  /** Normalised origin, e.g. "https://write.example.com". No trailing slash. */
  url: string;
  /** What the author last signed in as here, to prefill the form. Never a password. */
  lastEmail: string | null;
  lastUsedAt: string;
}

export class InvalidServerUrl extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidServerUrl";
  }
}

/**
 * Normalises what someone typed into an origin, or explains why it cannot be one.
 *
 * Deliberately forgiving about the things people actually type — a bare host, a
 * trailing slash, a stray path — and unforgiving about scheme, because a `file:` or
 * `javascript:` "server" is not a typo to be helpfully corrected.
 */
export function normaliseServerUrl(input: string): string {
  const trimmed = input.trim();
  if (trimmed.length === 0) throw new InvalidServerUrl("Enter your server's address.");

  // A bare host is what most people type. Assume https, which is the answer they
  // want anywhere except a machine on their desk.
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;

  let parsed: URL;
  try {
    parsed = new URL(withScheme);
  } catch {
    throw new InvalidServerUrl(`"${trimmed}" is not a web address.`);
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new InvalidServerUrl("A server address has to start with https:// or http://.");
  }
  if (parsed.hostname.length === 0) {
    throw new InvalidServerUrl(`"${trimmed}" is missing a host name.`);
  }
  // Credentials in the URL would end up in the servers list, in logs, and in every
  // request. If someone pastes one, say so rather than quietly stripping it.
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new InvalidServerUrl("Leave the username and password out of the address.");
  }

  return parsed.origin;
}

/** True for an address whose traffic would cross a network unencrypted. */
export function isInsecure(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:") return false;
  // A server on this machine never leaves it, so plain HTTP there is not a warning
  // worth crying wolf over — it is how everyone runs a dev server.
  return !["localhost", "127.0.0.1", "[::1]", "::1"].includes(parsed.hostname);
}

function isKnownServer(value: unknown): value is KnownServer {
  if (value === null || typeof value !== "object") return false;
  const row = value as Record<string, unknown>;
  if (typeof row.url !== "string") return false;
  try {
    // A stored address that no longer parses is dropped rather than offered.
    return normaliseServerUrl(row.url) === row.url;
  } catch {
    return false;
  }
}

export function parseServers(raw: unknown): KnownServer[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(isKnownServer).map((row) => ({
    url: row.url,
    lastEmail: typeof row.lastEmail === "string" ? row.lastEmail : null,
    lastUsedAt: typeof row.lastUsedAt === "string" ? row.lastUsedAt : new Date(0).toISOString(),
  }));
}

/** Most recently used first, which is the order a dropdown should offer them in. */
export function rememberServer(
  servers: readonly KnownServer[],
  url: string,
  lastEmail: string | null,
  now = new Date(),
): KnownServer[] {
  const entry: KnownServer = { url, lastEmail, lastUsedAt: now.toISOString() };
  return [entry, ...servers.filter((server) => server.url !== url)];
}

export function forgetServer(servers: readonly KnownServer[], url: string): KnownServer[] {
  return servers.filter((server) => server.url !== url);
}

export function readServers(storage: Pick<Storage, "getItem"> | undefined): KnownServer[] {
  if (!storage) return [];
  try {
    const raw = storage.getItem(SERVERS_STORAGE_KEY);
    return parseServers(raw === null ? null : JSON.parse(raw));
  } catch {
    return [];
  }
}

export function writeServers(
  storage: Pick<Storage, "setItem"> | undefined,
  servers: readonly KnownServer[],
): void {
  if (!storage) return;
  try {
    storage.setItem(SERVERS_STORAGE_KEY, JSON.stringify(servers));
  } catch {
    // Not remembered; the author types it again next time.
  }
}
