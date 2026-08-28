import { describe, expect, it } from "vitest";
import { contentSecurityPolicy } from "../csp-plugin";

/**
 * The desktop build's policy has to name Tauri's IPC scheme, and the web build's must
 * not — a browser build carrying scheme names it will never use only widens the policy.
 *
 * Which build it is used to come from an environment variable set as `NOVELTEA_TAURI=1
 * vite`. That is Unix shell syntax, so on Windows the variable name was read as a
 * command and the build stopped before Vite ran: the desktop app could not be built
 * there at all, by CI or by a person. It is Vite's `--mode` now, which is an argument
 * and travels the same way everywhere. This is here so that cannot regress silently
 * again — the previous failure was invisible on the machine most development happens on.
 */

function policyFor(mode: string): string {
  const plugin = contentSecurityPolicy();
  // The hooks are plain methods on the returned object, so they can be driven directly
  // without standing up a Vite build.
  (plugin.configResolved as unknown as (config: { mode: string }) => void)({ mode });

  // Through `unknown`: the declared hook type is a union covering several shapes, and
  // this plugin only ever uses the plain-function one.
  const transform = plugin.transformIndexHtml as unknown as (html: string) => {
    tags: { attrs?: Record<string, string> }[];
  };
  const result = transform("<html><head></head><body></body></html>");
  const meta = result.tags.find((tag) => tag.attrs?.["http-equiv"] === "Content-Security-Policy");
  return meta?.attrs?.content ?? "";
}

describe("the injected Content-Security-Policy", () => {
  it("NAMES TAURI'S IPC ONLY IN THE DESKTOP BUILD", () => {
    // Without these the desktop app's `invoke` is blocked before it leaves the webview,
    // and both sides fail quietly: the host never hears a request, and the page catches
    // an error it cannot tell apart from a missing file.
    expect(policyFor("tauri")).toContain("ipc: http://ipc.localhost");
  });

  it("leaves them out of a browser build", () => {
    const web = policyFor("production");
    expect(web).toContain("connect-src");
    expect(web).not.toContain("ipc:");
  });

  it("keeps what sqlite-wasm needs in both", () => {
    // 'wasm-unsafe-eval' is the most likely well-meaning tightening, and removing it
    // takes the database with it.
    for (const mode of ["tauri", "production"]) {
      expect(policyFor(mode)).toContain("'wasm-unsafe-eval'");
    }
  });
});
