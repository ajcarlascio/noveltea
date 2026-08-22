import { useEffect, useState } from "react";

/**
 * How long the device-only notice stays on a phone.
 *
 * Long enough to read twice; short enough that it is not permanently occupying the
 * top of a screen that has very little of it. On anything larger the notice costs no
 * room worth reclaiming, so it stays.
 */
export const NOTICE_LIFETIME_MS = 15_000;

/** Below this the notice is competing with the manuscript for the screen. */
const SMALL_SCREEN = "(max-width: 48rem)";

/**
 * `matchMedia` is missing in some embedded webviews and in bare jsdom. Treating that
 * as "not a small screen" keeps the notice, which is the safer way to be wrong: an
 * author who never learns their work is device-only has more to lose than one who
 * reads the sentence twice.
 */
function isSmallScreen(): boolean {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") return false;
  try {
    return window.matchMedia(SMALL_SCREEN).matches;
  } catch {
    return false;
  }
}

/**
 * True while a notice should be shown.
 *
 * The timer starts when this mounts, which is when the window opens, reloads, or the
 * project is opened — deliberately not when the notice's *content* changes, so it
 * cannot restart itself and sit there for ever.
 */
export function useTransientNotice(lifetimeMs = NOTICE_LIFETIME_MS): boolean {
  const [visible, setVisible] = useState(true);

  useEffect(() => {
    if (!isSmallScreen()) return;
    const timer = setTimeout(() => setVisible(false), lifetimeMs);
    return () => clearTimeout(timer);
  }, [lifetimeMs]);

  return visible;
}
