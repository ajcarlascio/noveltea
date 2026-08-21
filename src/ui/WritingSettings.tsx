import { useState } from "react";
import { useSettings } from "@/app/settings/SettingsContext";
import { sessionKeyStore } from "@/features/lookup/keys";
import { NetworkFeatureToggle } from "./NetworkFeatureToggle";
import "./WritingSettings.css";

const keyStore = sessionKeyStore();

/**
 * Everything that changes how writing behaves, and everything that can leave the
 * device.
 *
 * The two are in one place on purpose: an author deciding what NovelTea does with
 * their words should see the local features and the networked ones side by side,
 * with the difference stated rather than implied by which screen they are on.
 */
export function WritingSettings() {
  const { settings, update } = useSettings();
  const [key, setKey] = useState("");
  const [keySaved, setKeySaved] = useState(false);

  return (
    <fieldset className="writing-settings">
      <legend className="writing-settings__legend">Writing</legend>

      <label className="writing-settings__row">
        <input
          type="checkbox"
          checked={settings.smartTypography}
          onChange={(event) =>
            update((current) => ({ ...current, smartTypography: event.target.checked }))
          }
        />
        <span>
          <span className="writing-settings__label">Smart punctuation</span>
          <span className="writing-settings__description">
            Turns straight quotes into curly ones, <code>--</code> into an en dash and
            three dots into an ellipsis, as you type. Leave it off if you write code or
            need a straight apostrophe.
          </span>
        </span>
      </label>

      <label className="writing-settings__row">
        <input
          type="checkbox"
          checked={settings.thesaurus}
          onChange={(event) =>
            update((current) => ({ ...current, thesaurus: event.target.checked }))
          }
        />
        <span>
          <span className="writing-settings__label">Offline thesaurus</span>
          <span className="writing-settings__description">
            Synonyms from a WordNet dictionary stored on this device. Nothing is sent
            anywhere, and it works with no connection.
          </span>
        </span>
      </label>

      <hr className="writing-settings__divide" />
      <p className="writing-settings__notice">
        The two below send text to services outside NovelTea. Both are off until you
        turn them on, neither is ever suggested while you write, and nothing calls them
        unless you ask for a lookup.
      </p>

      <NetworkFeatureToggle
        feature="datamuse"
        label="Datamuse word finder"
        description="Rhymes, near-matches and related words that a local dictionary cannot give you."
        whatIsSent="The single word or short phrase you look up. Never the surrounding sentence, never the document."
        recipient="datamuse.com, a third-party word API not run by NovelTea."
        notes={[
          "Only when you ask for a lookup. Nothing is sent while you type.",
          "Datamuse works without an account. A key only raises the daily request limit.",
        ]}
        confirmLabel="Send lookups to Datamuse"
      >
        <label className="writing-settings__key">
          <span>API key (optional)</span>
          <input
            type="password"
            value={key}
            autoComplete="off"
            onChange={(event) => {
              setKey(event.target.value);
              setKeySaved(false);
            }}
          />
          <button
            type="button"
            className="button"
            onClick={() => {
              void keyStore.set("datamuse", key).then(() => setKeySaved(true));
            }}
          >
            Save key
          </button>
        </label>
        <p className="writing-settings__description">
          {keySaved ? "Saved. " : ""}
          {keyStore.describe()}
        </p>
      </NetworkFeatureToggle>

      <NetworkFeatureToggle
        feature="assistant"
        label="AI assistance"
        description="Ask a language model about a passage. Never suggested, never automatic."
        whatIsSent="Only the passage you select and the question you type. Never the whole manuscript, and never anything in the background."
        recipient="The model provider you configure. NovelTea does not host a model and does not see your text."
        notes={[
          "Providers may retain what is sent. Check their policy before sending work you have not published.",
          "Requests may cost money on your account.",
          "Turning this on does not enable anything automatic — it adds a command you can choose to run.",
        ]}
        confirmLabel="Send selected passages to my provider"
      />
    </fieldset>
  );
}
