import { spawnSync } from "node:child_process";

/**
 * Brings up the real stack (deploy/fullstack.compose.yml), runs the full-stack
 * Playwright spec against it, and always tears it down with its volumes — a fresh
 * database per run matters, because the login endpoint locks out after repeated failures.
 *
 * Set NOVELTEA_FULLSTACK_KEEP=1 to leave the stack running afterwards.
 */
const compose = ["compose", "-p", "nt-fullstack-test", "-f", "deploy/fullstack.compose.yml"];
const run = (cmd, args) => spawnSync(cmd, args, { stdio: "inherit" }).status ?? 1;

let status = run("docker", [...compose, "up", "--build", "--wait", "--wait-timeout", "600", "-d"]);
if (status === 0) status = run("npx", ["playwright", "test", "-c", "playwright.fullstack.config.ts"]);
if (status !== 0) run("docker", [...compose, "logs", "--no-color", "--tail", "200"]);
if (process.env.NOVELTEA_FULLSTACK_KEEP !== "1") run("docker", [...compose, "down", "-v"]);
process.exit(status);
