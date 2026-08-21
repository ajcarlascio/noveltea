import { runInNewContext } from "node:vm";
import indexHtml from "../../index.html?raw";

/**
 * Runs the inline theme script from index.html against fakes.
 *
 * The script cannot be imported — it exists to run before any module does, which
 * is the whole reason it is inline. Asserting on its *source text* would break on
 * any rewrite while proving nothing about what it does, so it is extracted and
 * executed instead.
 */
export interface PrePaintResult {
  /** What the script stamped on <html>, if anything. */
  theme: string | null;
  threw: unknown;
}

function scriptSource(): string {
  const match = /<script>([\s\S]*?)<\/script>/.exec(indexHtml);
  if (!match?.[1]) {
    throw new Error("index.html no longer contains an inline pre-paint script");
  }
  return match[1];
}

export function runPrePaintScript(storage: {
  getItem: (key: string) => string | null;
}): PrePaintResult {
  let theme: string | null = null;
  const documentElement = {
    setAttribute: (name: string, value: string) => {
      if (name === "data-theme") theme = value;
    },
  };

  let threw: unknown = null;
  try {
    runInNewContext(scriptSource(), {
      localStorage: storage,
      document: { documentElement },
    });
  } catch (error) {
    threw = error;
  }
  return { theme, threw };
}
