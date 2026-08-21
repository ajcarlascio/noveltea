import { describe, expect, it } from "vitest";
// `?raw` rather than node:fs: these tests run in the jsdom environment, where
// import.meta.url is an http URL and file reads have no base path to resolve against.
import css from "../tokens.css?raw";
import indexHtml from "../../../index.html?raw";

/**
 * These tests read tokens.css as text rather than through jsdom on purpose: jsdom
 * does not evaluate `prefers-color-scheme`, so the only way to check the dark
 * palettes is to inspect the source. The bug class being guarded against is a
 * colour that exists in one theme and not the other — which renders as an
 * unresolved custom property (transparent text, invisible borders) for exactly
 * the half of readers on the other theme, and which nobody notices in review.
 */

/** Returns the body of the block introduced by `selector`, brace-balanced. */
function blockBody(selector: string): string {
  const start = css.indexOf(selector);
  if (start === -1) throw new Error(`selector not found in tokens.css: ${selector}`);
  const open = css.indexOf("{", start + selector.length - 1);
  if (open === -1) throw new Error(`no opening brace for: ${selector}`);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced braces after: ${selector}`);
}

/** Custom-property declarations in a block, as name -> value. */
function declarations(body: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const match of body.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/gi)) {
    const [, name, value] = match;
    if (name && value) found.set(name, value.trim());
  }
  return found;
}

const light = declarations(blockBody("\n:root {"));
const darkBySystem = declarations(blockBody(':root:not([data-theme="light"]) {'));
const darkByChoice = declarations(blockBody(':root[data-theme="dark"] {'));

/** Anything that renders as a colour: hex, rgb()/hsl(), and the shadows built from them. */
function isColourValued(value: string): boolean {
  return /#[0-9a-f]{3,8}\b/i.test(value) || /\b(?:rgba?|hsla?)\(/i.test(value);
}

describe("tokens.css", () => {
  it("defines a light palette on bare :root", () => {
    expect(light.size).toBeGreaterThan(20);
    expect(light.get("--surface-page")).toBeDefined();
  });

  it("keeps light mode off pure white so the page reads as paper", () => {
    // The user-facing requirement: light mode is grey/white paper, not a lit panel.
    expect(light.get("--surface-page")).not.toBe("#ffffff");
    expect(light.get("--surface-app")).not.toBe("#ffffff");
    // ...and the chrome must be darker than the page, or the "sheet on a desk"
    // separation collapses. Compare the summed channels of the two hexes.
    const luminance = (hex: string) => {
      const m = /^#([0-9a-f]{6})$/i.exec(hex);
      if (!m || !m[1]) throw new Error(`expected a 6-digit hex, got: ${hex}`);
      const n = Number.parseInt(m[1], 16);
      return ((n >> 16) & 0xff) + ((n >> 8) & 0xff) + (n & 0xff);
    };
    const page = light.get("--surface-page");
    const app = light.get("--surface-app");
    expect(page).toBeDefined();
    expect(app).toBeDefined();
    expect(luminance(page!)).toBeGreaterThan(luminance(app!));
  });

  it("uses a soft near-black in dark mode rather than pure black", () => {
    expect(darkByChoice.get("--surface-page")).not.toBe("#000000");
    expect(darkByChoice.get("--surface-app")).not.toBe("#000000");
  });

  it("redefines every colour-valued light token in both dark blocks", () => {
    const colourTokens = [...light.entries()]
      .filter(([, value]) => isColourValued(value))
      .map(([name]) => name);

    expect(colourTokens.length).toBeGreaterThan(15);

    const missingFromSystem = colourTokens.filter((name) => !darkBySystem.has(name));
    const missingFromChoice = colourTokens.filter((name) => !darkByChoice.has(name));

    expect(missingFromSystem).toEqual([]);
    expect(missingFromChoice).toEqual([]);
  });

  it("keeps the two dark blocks byte-identical", () => {
    // They are duplicated because CSS cannot share a declaration list across a
    // media query and an attribute selector. Editing one and not the other means
    // the OS-driven and the explicitly-chosen dark themes silently diverge.
    expect(Object.fromEntries(darkBySystem)).toEqual(Object.fromEntries(darkByChoice));
  });

  it("does not introduce tokens in dark that light never defined", () => {
    const strays = [...darkByChoice.keys()].filter((name) => !light.has(name));
    expect(strays).toEqual([]);
  });

  it("keeps the browser chrome colour in step with the app surface", () => {
    // index.html cannot read a custom property, so <meta name="theme-color"> repeats
    // the value. A stale copy paints the address bar or status bar a colour the app
    // stopped using, which looks like a rendering fault rather than a stale string.
    const metas = [...indexHtml.matchAll(/<meta name="theme-color" content="([^"]+)" media="\(prefers-color-scheme: (light|dark)\)"/g)];
    expect(metas).toHaveLength(2);

    const declared = new Map(metas.map((m) => [m[2], m[1]]));
    expect(declared.get("light")).toBe(light.get("--surface-app"));
    expect(declared.get("dark")).toBe(darkByChoice.get("--surface-app"));
  });

  it("guards the explicit light choice against the dark media query", () => {
    // Without :not([data-theme="light"]) a reader on a dark OS who chooses light
    // gets dark anyway, because the media query would still match.
    expect(css).toContain(':root:not([data-theme="light"])');
  });
});
