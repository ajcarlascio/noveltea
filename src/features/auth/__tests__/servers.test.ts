import { describe, expect, it } from "vitest";
import {
  forgetServer,
  InvalidServerUrl,
  isInsecure,
  normaliseServerUrl,
  parseServers,
  readServers,
  rememberServer,
  SERVERS_STORAGE_KEY,
  writeServers,
  type KnownServer,
} from "../servers";

describe("normalising what someone typed", () => {
  it("assumes https for a bare host, which is what they meant", () => {
    expect(normaliseServerUrl("write.example.com")).toBe("https://write.example.com");
  });

  it("keeps an explicit scheme", () => {
    expect(normaliseServerUrl("http://localhost:8080")).toBe("http://localhost:8080");
  });

  it("drops a path, a query and a trailing slash", () => {
    // People paste the address bar. The origin is the part that matters.
    expect(normaliseServerUrl("https://write.example.com/")).toBe("https://write.example.com");
    expect(normaliseServerUrl("https://write.example.com/projects?x=1")).toBe(
      "https://write.example.com",
    );
  });

  it("keeps a non-default port", () => {
    expect(normaliseServerUrl("https://write.example.com:8443")).toBe(
      "https://write.example.com:8443",
    );
  });

  it("tolerates surrounding whitespace", () => {
    expect(normaliseServerUrl("  write.example.com  ")).toBe("https://write.example.com");
  });

  it("refuses a scheme that is not the web", () => {
    // Not a typo to be helpfully corrected.
    for (const bad of ["javascript:alert(1)", "file:///etc/passwd", "ftp://example.com"]) {
      expect(() => normaliseServerUrl(bad)).toThrow(InvalidServerUrl);
    }
  });

  it("refuses credentials in the address", () => {
    // They would end up in the servers list, in logs, and on every request.
    expect(() => normaliseServerUrl("https://me:secret@example.com")).toThrow(/username/i);
  });

  it("refuses nothing at all", () => {
    expect(() => normaliseServerUrl("")).toThrow(InvalidServerUrl);
    expect(() => normaliseServerUrl("   ")).toThrow(InvalidServerUrl);
  });
});

describe("warning about plain HTTP", () => {
  it("warns for a remote host", () => {
    expect(isInsecure("http://write.example.com")).toBe(true);
  });

  it("does not warn for a server on this machine", () => {
    // Every development server is plain HTTP on localhost; crying wolf there trains
    // people to ignore the warning that matters.
    expect(isInsecure("http://localhost:8080")).toBe(false);
    expect(isInsecure("http://127.0.0.1:8080")).toBe(false);
  });

  it("does not warn for https", () => {
    expect(isInsecure("https://write.example.com")).toBe(false);
  });
});

describe("the remembered list", () => {
  const at = (iso: string) => new Date(iso);

  it("puts the most recent first, which is the order to offer them in", () => {
    let servers: KnownServer[] = [];
    servers = rememberServer(servers, "https://a.example", "me@a", at("2026-01-01T00:00:00Z"));
    servers = rememberServer(servers, "https://b.example", "me@b", at("2026-01-02T00:00:00Z"));
    expect(servers.map((s) => s.url)).toEqual(["https://b.example", "https://a.example"]);
  });

  it("moves a repeat visit to the front rather than duplicating it", () => {
    let servers: KnownServer[] = [];
    servers = rememberServer(servers, "https://a.example", "me@a");
    servers = rememberServer(servers, "https://b.example", "me@b");
    servers = rememberServer(servers, "https://a.example", "me@a");
    expect(servers.map((s) => s.url)).toEqual(["https://a.example", "https://b.example"]);
  });

  it("remembers the email but never a password", () => {
    const [entry] = rememberServer([], "https://a.example", "me@a");
    expect(entry).toMatchObject({ lastEmail: "me@a" });
    expect(JSON.stringify(entry)).not.toMatch(/password/i);
  });

  it("forgets one on request", () => {
    const servers = rememberServer(rememberServer([], "https://a.example", null), "https://b.example", null);
    expect(forgetServer(servers, "https://b.example").map((s) => s.url)).toEqual([
      "https://a.example",
    ]);
  });
});

describe("reading a list written by someone else", () => {
  it("drops entries that are not servers", () => {
    const parsed = parseServers([
      { url: "https://good.example", lastEmail: null, lastUsedAt: "2026-01-01T00:00:00Z" },
      { url: "javascript:alert(1)" },
      { nope: true },
      "https://bare-string.example",
      null,
    ]);
    // Local storage is hand-editable, and a "server" the app would then post
    // credentials to is not a value to take on trust.
    expect(parsed.map((s) => s.url)).toEqual(["https://good.example"]);
  });

  it("drops an entry that is not already normalised", () => {
    // Otherwise a trailing slash makes the same server look like two.
    expect(parseServers([{ url: "https://good.example/" }])).toEqual([]);
  });

  it("returns nothing for anything that is not a list", () => {
    for (const raw of [null, {}, "x", 3]) expect(parseServers(raw)).toEqual([]);
  });

  it("round-trips through storage and survives a broken value", () => {
    const map = new Map<string, string>();
    const storage = {
      getItem: (k: string) => map.get(k) ?? null,
      setItem: (k: string, v: string) => void map.set(k, v),
    };
    const servers = rememberServer([], "https://a.example", "me@a");
    writeServers(storage, servers);
    expect(readServers(storage)).toEqual(servers);

    map.set(SERVERS_STORAGE_KEY, "{not json");
    expect(readServers(storage)).toEqual([]);
    expect(readServers(undefined)).toEqual([]);
  });
});
