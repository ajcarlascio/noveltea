/**
 * Checking for a new version of the desktop app.
 *
 * Only the desktop shell can update itself — a browser tab gets the new version by
 * reloading, and a self-hoster's tab gets it when they pull a new image. So every
 * function here answers "nothing to do" in a browser rather than throwing, and callers
 * do not have to guard.
 *
 * The signature check happens on the host, against the public key compiled into the
 * binary. Nothing on this side is trusted with deciding whether an update is genuine.
 */

import { invokeHost, isHosted } from "./host";

export interface AvailableUpdate {
  /** The version being offered. */
  version: string;
  /** Release notes, when the release carried any. */
  notes: string | null;
}

function readUpdate(value: unknown): AvailableUpdate | null {
  if (value === null || typeof value !== "object") return null;
  const { version, notes } = value as { version?: unknown; notes?: unknown };
  if (typeof version !== "string" || version === "") return null;
  return { version, notes: typeof notes === "string" && notes !== "" ? notes : null };
}

/**
 * The newer version on offer, or null.
 *
 * Never throws and never reports a reason. Being offline is the normal state of this
 * app, not an error, and an author who cannot reach an update server has lost nothing —
 * every word they have is on the machine in front of them. The host logs the reason.
 */
export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!isHosted()) return null;
  try {
    return readUpdate(await invokeHost("update_check"));
  } catch {
    return null;
  }
}

/**
 * Installs the update and restarts.
 *
 * This one **does** throw, because the author asked for it and is waiting. The promise
 * only settles on failure: a success replaces the running binary and restarts the app.
 */
export async function installUpdate(): Promise<void> {
  if (!isHosted()) throw new Error("Updates are installed by the desktop app only.");
  await invokeHost("update_install");
}

/** The version this build reports, or null in a browser. */
export async function hostVersion(): Promise<string | null> {
  if (!isHosted()) return null;
  try {
    const version = await invokeHost("app_version");
    return typeof version === "string" ? version : null;
  } catch {
    return null;
  }
}
