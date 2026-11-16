import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Plugin } from "vite";

/** Files from public/ that the bundle does not mention but a cold offline start wants. */
const PUBLIC_SHELL = ["/manifest.webmanifest", "/icons/icon-256.png", "/icons/icon-512.png"];

/**
 * Emits /sw.js from tooling/sw.js with the build's file list filled in.
 *
 * The list is what makes offline work after one visit: the database worker and
 * sqlite3.wasm are fetched lazily, so caching only what the page happened to request
 * could leave the first offline start without the database. Left out: source maps (only
 * a debugger asks), legacy .woff (every browser with OPFS takes the .woff2), and the 3.5 MB
 * thesaurus, which is cached the first time someone looks a word up.
 */
export function offlineShell(): Plugin {
  return {
    name: "noveltea:offline-shell",
    apply: "build",

    generateBundle(_, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !/\.(?:map|woff)$/.test(name))
        .map((name) => `/${name}`);
      const precache = [...files, ...PUBLIC_SHELL].sort();
      // The cache name follows the content, so a deploy that changes nothing keeps its
      // cache and any deploy that changes something replaces it.
      const version = createHash("sha256")
        .update(
          Object.values(bundle)
            .map((chunk) => (chunk.type === "chunk" ? chunk.code : chunk.source))
            .map((part) => createHash("sha256").update(part).digest("hex"))
            .sort()
            .join(),
        )
        .digest("hex")
        .slice(0, 12);

      const template = readFileSync(new URL("./sw.js", import.meta.url), "utf8");
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: template
          .replace("__VERSION__", version)
          .replace("__PRECACHE__", JSON.stringify(precache)),
      });
    },
  };
}
