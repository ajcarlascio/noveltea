import { useCallback, useMemo, useState, type ReactNode } from "react";
import { SettingsContext, type SettingsContextValue } from "./SettingsContext";
import { mayUseNetwork, readSettings, writeSettings, type NetworkFeature, type Settings } from "./settings";

function safeStorage(): Storage | undefined {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
}

export function SettingsProvider({
  children,
  initial,
}: {
  children: ReactNode;
  /** Injectable for tests; production reads storage. */
  initial?: Settings;
}) {
  const [settings, setSettings] = useState<Settings>(() => initial ?? readSettings(safeStorage()));

  const update = useCallback((change: (current: Settings) => Settings) => {
    setSettings((current) => {
      const next = change(current);
      writeSettings(safeStorage(), next);
      return next;
    });
  }, []);

  const mayUse = useCallback(
    (feature: NetworkFeature) => mayUseNetwork(settings, feature),
    [settings],
  );

  const value = useMemo<SettingsContextValue>(
    () => ({ settings, update, mayUse }),
    [settings, update, mayUse],
  );

  return <SettingsContext.Provider value={value}>{children}</SettingsContext.Provider>;
}
