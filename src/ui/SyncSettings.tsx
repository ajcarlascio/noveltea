import { useEffect, useState } from "react";
import { useSettings } from "@/app/settings/SettingsContext";
import { meteringOf, subscribeToConnection, type Metering } from "@/features/sync/connection";
import "./WritingSettings.css";

/**
 * What sync is allowed to cost.
 *
 * Its own fieldset rather than a row in "Writing", and deliberately not one of the
 * consent toggles: syncing sends an author's work to their own server, which is what
 * they installed this for. The question here is about their data plan, not about who
 * sees their words.
 */
export function SyncSettings() {
  const { settings, update } = useSettings();
  const [metering, setMetering] = useState<Metering>(() =>
    typeof navigator === "undefined" ? "unknown" : meteringOf(navigator),
  );

  useEffect(() => {
    if (typeof navigator === "undefined") return;
    const read = () => setMetering(meteringOf(navigator));
    read();
    return subscribeToConnection(navigator, read);
  }, []);

  return (
    <fieldset className="writing-settings">
      <legend className="writing-settings__legend">Sync</legend>

      <label className="writing-settings__row">
        <input
          type="checkbox"
          checked={settings.syncOnWifiOnly}
          onChange={(event) =>
            update((current) => ({ ...current, syncOnWifiOnly: event.target.checked }))
          }
        />
        <span>
          <span className="writing-settings__label">Hold automatic syncs for Wi-Fi</span>
          <span className="writing-settings__description">
            Your writing is saved on this device the moment you type it, so holding a
            sync never risks losing anything — it only delays the copy on your server.
            “Sync now” always sends immediately, whatever this is set to.
          </span>
        </span>
      </label>

      {/*
        Said plainly rather than hidden. Only some browsers will name the connection —
        Safari and Firefox expose nothing at all — and a setting that silently does
        nothing is worse than one that explains when it can.
      */}
      <p className="writing-settings__description" data-metering={metering}>
        {metering === "unknown"
          ? "This browser will not say what kind of connection you are on, so automatic syncs run as usual here. On a phone app, where the connection can be read properly, this setting takes effect."
          : metering === "metered"
            ? "This connection looks like mobile data."
            : "This connection looks unmetered."}
      </p>
    </fieldset>
  );
}
