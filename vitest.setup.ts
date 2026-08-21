import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom keeps <html> between tests in a file. The theme provider writes to it, so
// without this a test inherits whatever the previous one stamped.
//
// Guarded because the database tests run in the node environment against real
// SQLite, where there is no document to clean up.
afterEach(() => {
  if (typeof document === "undefined") return;
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  window.localStorage.clear();
});
