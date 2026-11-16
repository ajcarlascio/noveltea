import { spawn, spawnSync } from "node:child_process";

/**
 * Brings up the real stack (deploy/fullstack.compose.yml), runs the full-stack
 * Playwright spec against it, and tears it down with its volumes on every exit path,
 * Ctrl-C and SIGTERM included — a fresh database per run matters, because the login
 * endpoint locks out after repeated failures. A `down -v` before `up` clears anything a
 * crashed earlier run left behind.
 *
 * Set NOVELTEA_FULLSTACK_KEEP=1 to leave the stack running afterwards (and to skip the
 * clean-slate teardown beforehand).
 */
const compose = ["compose", "-p", "nt-fullstack-test", "-f", "deploy/fullstack.compose.yml"];
const keep = process.env.NOVELTEA_FULLSTACK_KEEP === "1";
const sh = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1;
const down = () => {
  if (!keep) sh("docker", [...compose, "down", "-v"]);
};

let child = null;
let interrupted = null;
const run = (cmd, args) =>
  new Promise((resolve) => {
    if (interrupted) return resolve(1);
    child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code, signal) => resolve(code ?? (signal ? 1 : 1)));
  });

// The terminal sends Ctrl-C to the whole foreground group, so the child is already
// stopping; forward for the SIGTERM case, then let main() fall through to teardown.
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
  process.on(sig, () => {
    interrupted ??= sig;
    child?.kill(sig);
  });
}

down();
let status = await run("docker", [...compose, "up", "--build", "--wait", "--wait-timeout", "600", "-d"]);
if (status === 0) status = await run("npx", ["playwright", "test", "-c", "playwright.fullstack.config.ts"]);
if (status !== 0 && !interrupted) sh("docker", [...compose, "logs", "--no-color", "--tail", "200"]);
down();
process.exit(interrupted ? 130 : status);
