import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "@/app/theme/ThemeProvider";
import { THEME_CHOICES } from "@/app/theme/theme";
import { ThemeToggle } from "../ThemeToggle";

beforeEach(() => {
  vi.stubGlobal(
    "matchMedia",
    vi.fn().mockReturnValue({
      matches: false,
      addEventListener: () => {},
      removeEventListener: () => {},
    }),
  );
});

function renderToggle() {
  return render(
    <ThemeProvider>
      <ThemeToggle />
    </ThemeProvider>,
  );
}

describe("ThemeToggle", () => {
  it("offers every theme choice the model defines", () => {
    // Adding a choice to THEME_CHOICES without a control here would leave it
    // unreachable; this fails rather than quietly shipping a dead option.
    renderToggle();
    expect(screen.getAllByRole("radio")).toHaveLength(THEME_CHOICES.length);
  });

  it("shows the active choice as checked", () => {
    renderToggle();
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
  });

  it("applies a chosen theme to the document", async () => {
    renderToggle();
    await userEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("is reachable and operable by keyboard", async () => {
    renderToggle();
    await userEvent.tab();
    // Focus lands on the checked radio, and arrow keys move within the group.
    expect(screen.getByRole("radio", { name: "System" })).toHaveFocus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
  });
});
