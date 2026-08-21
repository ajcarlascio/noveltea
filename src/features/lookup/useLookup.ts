import { useCallback, useMemo, useState } from "react";
import { useSettings } from "@/app/settings/SettingsContext";
import { datamuseLookup } from "./datamuse";
import { sessionKeyStore } from "./keys";
import { offlineThesaurus } from "./thesaurus";
import type { LookupKind, LookupResult } from "./types";

const keys = sessionKeyStore();

export interface LookupState {
  result: LookupResult | null;
  error: string | null;
  busy: boolean;
  /** Which kinds can be asked for right now, given the settings. */
  kinds: LookupKind[];
  look: (word: string, kind: LookupKind) => void;
  clear: () => void;
}

/**
 * Word lookup for the editor.
 *
 * Both providers are constructed unconditionally; what varies is whether they report
 * themselves available. Constructing the networked one lazily would put the consent
 * check in two places, and the second copy is the one that goes wrong.
 */
export function useLookup(): LookupState {
  const { settings, mayUse } = useSettings();
  const [result, setResult] = useState<LookupResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const providers = useMemo(
    () => ({
      offline: offlineThesaurus({ enabled: () => settings.thesaurus }),
      datamuse: datamuseLookup({ consented: () => mayUse("datamuse"), keys }),
    }),
    [settings.thesaurus, mayUse],
  );

  const kinds = useMemo<LookupKind[]>(() => {
    const available: LookupKind[] = [];
    if (settings.thesaurus) available.push("synonym");
    if (mayUse("datamuse")) {
      for (const kind of ["synonym", "related", "rhyme"] as const) {
        if (!available.includes(kind)) available.push(kind);
      }
    }
    return available;
  }, [settings.thesaurus, mayUse]);

  const look = useCallback(
    (word: string, kind: LookupKind) => {
      // Local first, always. A synonym that can be answered on this device is never
      // a reason to tell a third party what the author is writing.
      const provider =
        kind === "synonym" && providers.offline.available()
          ? providers.offline
          : providers.datamuse.available()
            ? providers.datamuse
            : null;

      if (!provider) {
        setError("No word lookup is turned on. You can enable one in Settings.");
        setResult(null);
        return;
      }

      setBusy(true);
      setError(null);
      provider.look(word, kind).then(
        (next) => {
          setResult(next);
          setBusy(false);
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setResult(null);
          setBusy(false);
        },
      );
    },
    [providers],
  );

  const clear = useCallback(() => {
    setResult(null);
    setError(null);
  }, []);

  return { result, error, busy, kinds, look, clear };
}
