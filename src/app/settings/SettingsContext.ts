import { createContext, useContext } from "react";
import type { NetworkFeature, Settings } from "./settings";

export interface SettingsContextValue {
  settings: Settings;
  update: (change: (current: Settings) => Settings) => void;
  /** True only when the feature is enabled *and* consent is recorded. */
  mayUse: (feature: NetworkFeature) => boolean;
}

export const SettingsContext = createContext<SettingsContextValue | null>(null);

export function useSettings(): SettingsContextValue {
  const value = useContext(SettingsContext);
  if (value === null) throw new Error("useSettings must be used within <SettingsProvider>");
  return value;
}
