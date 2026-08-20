import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ThemeProvider } from "../ThemeProvider";
import { useTheme } from "../ThemeContext";
import { THEME_STORAGE_KEY } from "../theme";

/**
 * jsdom has no `matchMedia`, so every test installs one. The double also records
 * add/remove so the leak test can assert the provider cleans up after itself.
 */
function installMatchMedia({ dark = false } = {}) {
  const listeners = new Set<() => void>();
  const state = { dark, added: 0, removed: 0 };

  const query = {
    get matches() {
      return state.dark;
    },
    media: "(prefers-color-scheme: dark)",
    addEventListener: (_type: string, fn: () => void) => {
      listeners.add(fn);
      state.added += 1;
    },
    removeEventListener: (_type: string, fn: () => void) => {
      listeners.delete(fn);
      state.removed += 1;
    },
  };

  vi.stubGlobal("matchMedia", vi.fn().mockReturnValue(query));

  return {
    state,
    /** Simulate the OS switching appearance. */
    flipTo(next: boolean) {
      state.dark = next;
      act(() => {
        for (const fn of listeners) fn();
      });
    },
  };
}

function Probe() {
  const { choice, resolved, setChoice } = useTheme();
  return (
    <div>
      <output data-testid="choice">{choice}</output>
      <output data-testid="resolved">{resolved}</output>
      <button onClick={() => setChoice("dark")}>dark</button>
      <button onClick={() => setChoice("light")}>light</button>
      <button onClick={() => setChoice("system")}>system</button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <Probe />
    </ThemeProvider>,
  );
}

const root = () => document.documentElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ThemeProvider", () => {
  it("defaults to following the system when nothing is stored", () => {
    installMatchMedia({ dark: true });
    renderProbe();
    expect(screen.getByTestId("choice")).toHaveTextContent("system");
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    // "system" must leave the attribute off, or the CSS media query is bypassed.
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(root().style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("restores an explicit choice from storage", () => {
    installMatchMedia({ dark: false });
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(root().getAttribute("data-theme")).toBe("dark");
  });

  it("lets an explicit light choice win over a dark system preference", () => {
    installMatchMedia({ dark: true });
    window.localStorage.setItem(THEME_STORAGE_KEY, "light");
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    expect(root().getAttribute("data-theme")).toBe("light");
  });

  it("stamps and persists a new choice", async () => {
    installMatchMedia();
    renderProbe();
    await userEvent.click(screen.getByRole("button", { name: "dark" }));
    expect(root().getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  });

  it("clears the attribute and the stored key when returning to system", async () => {
    installMatchMedia();
    window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
    renderProbe();
    await userEvent.click(screen.getByRole("button", { name: "system" }));
    expect(root().hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBeNull();
  });

  it("follows the OS while on 'system'", () => {
    const media = installMatchMedia({ dark: false });
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
    media.flipTo(true);
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
    expect(root().style.getPropertyValue("color-scheme")).toBe("dark");
  });

  it("ignores the OS while a choice is explicit, then honours it again on return", async () => {
    const media = installMatchMedia({ dark: false });
    renderProbe();
    await userEvent.click(screen.getByRole("button", { name: "light" }));

    media.flipTo(true);
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");

    // Returning to "system" must land on the OS value already in effect, not on
    // the value that was current when the app booted.
    await userEvent.click(screen.getByRole("button", { name: "system" }));
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });

  it("unsubscribes from the media query on unmount", () => {
    const media = installMatchMedia();
    const { unmount } = renderProbe();
    expect(media.state.added).toBeGreaterThan(0);
    unmount();
    expect(media.state.removed).toBe(media.state.added);
  });

  it("renders when matchMedia is missing entirely", () => {
    vi.stubGlobal("matchMedia", undefined);
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("renders when matchMedia throws", () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => {
        throw new TypeError("not supported");
      }),
    );
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");
  });

  it("supports webviews that only expose the deprecated addListener", () => {
    const listeners = new Set<() => void>();
    const state = { dark: false };
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({
        get matches() {
          return state.dark;
        },
        addListener: (fn: () => void) => void listeners.add(fn),
        removeListener: (fn: () => void) => void listeners.delete(fn),
      }),
    );
    renderProbe();
    expect(screen.getByTestId("resolved")).toHaveTextContent("light");

    state.dark = true;
    act(() => {
      for (const fn of listeners) fn();
    });
    expect(screen.getByTestId("resolved")).toHaveTextContent("dark");
  });
});

describe("useTheme", () => {
  it("fails loudly outside a provider rather than returning undefined", () => {
    installMatchMedia();
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Probe />)).toThrow(/within <ThemeProvider>/);
    consoleError.mockRestore();
  });
});
