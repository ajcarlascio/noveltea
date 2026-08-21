import { chromium, devices } from "@playwright/test";
import { spawn } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * Writes a set of screenshots to ./screenshots for review.
 *
 * Not a test — nothing here asserts. It exists so a change to the interface can be
 * looked at rather than described, across the shells the app has to work in.
 */
const PORT = 4174;
const BASE = process.env.NOVELTEA_PREVIEW_URL ?? `http://127.0.0.1:${PORT}`;

/** Starts `vite preview` unless something is already answering, and returns a stopper. */
async function ensurePreview() {
  if (await reachable()) return () => {};

  // Its own process group, killed as a group: `npx` spawns vite as a grandchild, so
  // killing the child alone leaves the server running and the port held.
  const child = spawn(
    process.execPath,
    ["node_modules/vite/bin/vite.js", "preview", "--port", String(PORT), "--strictPort"],
    { stdio: "ignore", detached: true },
  );

  const stop = () => {
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      child.kill("SIGTERM");
    }
  };
  // Also stop it if this script dies partway through.
  process.on("exit", stop);

  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (await reachable()) return stop;
    await sleep(250);
  }
  stop();
  throw new Error(`vite preview did not come up on ${BASE}`);
}

async function reachable() {
  try {
    await fetch(BASE, { signal: AbortSignal.timeout(500) });
    return true;
  } catch {
    return false;
  }
}
const OUT = new URL("../screenshots/", import.meta.url).pathname;

const targets = [
  { name: "phone", device: devices["iPhone 13"] },
  { name: "tablet", device: devices["iPad Mini"] },
  { name: "desktop", device: { viewport: { width: 1280, height: 800 } } },
];

const routes = [
  { name: "projects", path: "/projects" },
  { name: "settings", path: "/settings" },
  {
    name: "binder",
    path: "/projects",
    /** The binder needs something in it, so build a small one through the interface. */
    async prepare(page) {
      await page.getByRole("button", { name: "New project" }).click();
      await page.getByRole("link", { name: "Untitled project" }).first().click();
      await page.getByRole("heading", { name: "Binder" }).waitFor();

      // Each step waits for the tree to catch up. A click does not settle the
      // reload that follows it, and without waiting the capture is a frame behind.
      const rows = page.getByRole("treeitem");
      const settled = async (count) => {
        for (let i = 0; i < 100 && (await rows.count()) !== count; i += 1) {
          await page.waitForTimeout(50);
        }
      };

      await page.getByRole("button", { name: "New folder" }).click();
      await settled(1);
      await rows.first().click();
      await page.getByRole("button", { name: "New document" }).click();
      await settled(2);
      await page.getByRole("button", { name: "New document" }).click();
      await settled(3);
      await rows.first().click();
      await page.getByRole("button", { name: "New folder" }).click();
      await settled(4);
    },
  },
];

const stopPreview = await ensurePreview();

await rm(OUT, { recursive: true, force: true });
await mkdir(OUT, { recursive: true });

const browser = await chromium.launch();
let count = 0;
for (const { name, device } of targets) {
  for (const theme of ["light", "dark"]) {
    const context = await browser.newContext({ ...device, colorScheme: theme });
    const page = await context.newPage();
    for (const route of routes) {
      await page.goto(`${BASE}${route.path}`, { waitUntil: "networkidle" });
      await page
        .locator("html[data-db-status='ready']")
        .waitFor({ timeout: 30_000 })
        .catch(() => {});
      if (route.prepare) await route.prepare(page);
      await page.screenshot({ path: `${OUT}${name}-${theme}-${route.name}.png` });
      count += 1;
    }
    await context.close();
  }
}
await browser.close();
stopPreview();
console.log(`${count} screenshots written to ${OUT}`);
