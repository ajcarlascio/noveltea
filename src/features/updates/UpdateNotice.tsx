import { useEffect, useState } from "react";
import { checkForUpdate, installUpdate, type AvailableUpdate } from "@/platform/updates";

/**
 * A line offering the new version, when there is one.
 *
 * Deliberately not a dialog. An update is the least urgent thing this app has to say,
 * and interrupting someone mid-paragraph to tell them about a version number is how a
 * writing tool loses a sentence. It sits in the header, it can be dismissed, and in a
 * browser tab it never appears at all.
 *
 * The check runs once, on mount. Polling would mean an app left open overnight makes
 * requests to GitHub all night to learn something that changes a few times a year.
 */
export function UpdateNotice() {
  const [update, setUpdate] = useState<AvailableUpdate | null>(null);
  const [installing, setInstalling] = useState(false);
  const [failed, setFailed] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    let live = true;
    // A failed check resolves to null, so there is no rejection path to handle: being
    // unable to reach the update server is not something an author needs told.
    void checkForUpdate().then((found) => {
      if (live) setUpdate(found);
    });
    return () => {
      live = false;
    };
  }, []);

  if (update === null || dismissed) return null;

  async function install() {
    setInstalling(true);
    setFailed(null);
    try {
      await installUpdate();
      // Not reached on success: the host restarts the app.
    } catch (error) {
      setInstalling(false);
      setFailed(error instanceof Error ? error.message : "The update could not be installed.");
    }
  }

  return (
    <p className="shell__banner shell__banner--notice" role="status">
      <span>
        {failed ?? `NovelTea ${update.version} is available.`}
        {failed === null && update.notes !== null && (
          <span className="shell__banner-notes"> {update.notes}</span>
        )}
      </span>
      <button
        type="button"
        className="button button--confirm"
        onClick={() => void install()}
        disabled={installing}
      >
        {installing ? "Installing…" : failed === null ? "Install and restart" : "Try again"}
      </button>
      <button type="button" className="button" onClick={() => setDismissed(true)}>
        Not now
      </button>
    </p>
  );
}
