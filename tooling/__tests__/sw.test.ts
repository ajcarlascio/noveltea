import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";
import { expect, test } from "vitest";

// The worker is a classic script, so run it in a sandbox and call its router directly.
const sandbox: Record<string, unknown> = { self: { addEventListener() {} }, URL };
vm.runInNewContext(
  readFileSync(join(process.cwd(), "tooling/sw.js"), "utf8")
    .replace("__VERSION__", "t")
    .replace("__PRECACHE__", "[]"),
  sandbox,
);
const route = sandbox["route"] as (
  m: string,
  mode: string,
  url: string,
  origin: string,
  hasRange?: boolean,
) => string;
const isShell = sandbox["isShell"] as (contentType: string | null) => boolean;
const staleCaches = sandbox["staleCaches"] as (keys: string[], current: string) => string[];
const origin = "https://app.example";

test("only same-origin GETs outside the API are handled", () => {
  expect(route("GET", "navigate", `${origin}/projects/1`, origin)).toBe("navigation");
  expect(route("GET", "cors", `${origin}/assets/index-abc.js`, origin)).toBe("static");
  expect(route("GET", "cors", `${origin}/api/v1/sync`, origin)).toBe("ignore");
  expect(route("GET", "navigate", `${origin}/api/anything`, origin)).toBe("ignore");
  expect(route("GET", "cors", `${origin}/health/ready`, origin)).toBe("ignore");
  expect(route("POST", "cors", `${origin}/assets/x.js`, origin)).toBe("ignore");
  expect(route("GET", "cors", "https://other.example/x.js", origin)).toBe("ignore");
});

test("range requests go to the network", () => {
  expect(route("GET", "cors", `${origin}/thesaurus/wordnet.json`, origin, true)).toBe("ignore");
});

test("only html responses may become the cached shell", () => {
  expect(isShell("text/html; charset=utf-8")).toBe(true);
  expect(isShell("TEXT/HTML")).toBe(true);
  expect(isShell("application/manifest+json")).toBe(false);
  expect(isShell("image/png")).toBe(false);
  expect(isShell(null)).toBe(false);
});

test("activate keeps this build and the one before it", () => {
  const keys = ["noveltea-shell-a", "noveltea-shell-b", "noveltea-shell-c", "other"];
  expect(staleCaches(keys, "noveltea-shell-c")).toEqual(["noveltea-shell-a"]);
  expect(staleCaches(["noveltea-shell-c"], "noveltea-shell-c")).toEqual([]);
  expect(staleCaches(["noveltea-shell-b", "noveltea-shell-c"], "noveltea-shell-c")).toEqual([]);
});
