import { THEME_CHOICES, type ThemeChoice } from "@/app/theme/theme";
import { useTheme } from "@/app/theme/ThemeContext";
import "./ThemeToggle.css";

const LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle() {
  const { choice, setChoice } = useTheme();

  return (
    <fieldset className="theme-toggle">
      <legend className="theme-toggle__legend">Appearance</legend>
      {THEME_CHOICES.map((option) => (
        <label key={option} className="theme-toggle__option">
          <input
            type="radio"
            name="theme"
            value={option}
            checked={choice === option}
            onChange={() => setChoice(option)}
          />
          <span>{LABELS[option]}</span>
        </label>
      ))}
    </fieldset>
  );
}
