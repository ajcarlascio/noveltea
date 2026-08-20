import { createContext, useContext } from "react";
import type { ResolvedTheme, ThemeChoice } from "./theme";

export interface ThemeContextValue {
  /** What the reader picked, including "system". */
  choice: ThemeChoice;
  /** What is actually on screen. Never "system". */
  resolved: ResolvedTheme;
  setChoice: (choice: ThemeChoice) => void;
}

export const ThemeContext = createContext<ThemeContextValue | null>(null);

export function useTheme(): ThemeContextValue {
  const value = useContext(ThemeContext);
  if (value === null) {
    throw new Error("useTheme must be used within <ThemeProvider>");
  }
  return value;
}
