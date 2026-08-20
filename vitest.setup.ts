import "@testing-library/jest-dom/vitest";
import { afterEach } from "vitest";

// jsdom keeps <html> between tests in a file. The theme provider writes to it,
// so without this a test inherits whatever the previous one stamped.
afterEach(() => {
  document.documentElement.removeAttribute("data-theme");
  document.documentElement.style.removeProperty("color-scheme");
  window.localStorage.clear();
});
