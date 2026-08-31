/**
 * The bridge to the desktop shell, when there is one.
 *
 * Tauri's own JavaScript packages are deliberately not a dependency. The webview injects
 * `__TAURI_INTERNALS__` before any of our code runs, and reading it directly keeps the
 * web build free of a package that means nothing in a browser tab — this bundle ships to
 * both, and only one of them has a host.
 */

interface TauriInternals {
  invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
}

function internals(): TauriInternals | null {
  if (typeof window === "undefined") return null;
  const found = (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__;
  return found !== null && typeof found === "object" ? found : null;
}

/** True when running inside the desktop shell rather than a browser tab. */
export function isHosted(): boolean {
  return typeof internals()?.invoke === "function";
}

/**
 * Calls a command on the host.
 *
 * Throws when there is no host, rather than resolving to undefined. A caller that has not
 * checked {@link isHosted} has a bug, and a silent undefined turns it into a bug that
 * only shows up in the browser build.
 */
export async function invokeHost(
  command: string,
  args?: Record<string, unknown>,
): Promise<unknown> {
  const bridge = internals();
  if (typeof bridge?.invoke !== "function") throw new Error("No desktop host to call.");
  return bridge.invoke(command, args);
}
