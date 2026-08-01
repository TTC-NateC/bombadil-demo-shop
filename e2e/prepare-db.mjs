/**
 * Builds the throwaway e2e database. specs/01 §12.1.
 *
 * This runs as the first link of playwright.config.ts's webServer command, NOT
 * from globalSetup: Playwright launches webServer *before* globalSetup, so a
 * globalSetup that creates the database races the server that needs it.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";

const url = process.env.DATABASE_URL;
if (!url?.startsWith("file:")) {
  throw new Error(`Expected a file: DATABASE_URL for the e2e run, got ${url}`);
}

const file = url.slice("file:".length);
rmSync(file, { force: true });
console.log(`[e2e] fresh database at ${file}`);

const run = (args) =>
  execFileSync("npx", args, {
    stdio: "inherit",
    shell: process.platform === "win32",
    env: process.env,
  });

run(["prisma", "db", "push", "--skip-generate", "--accept-data-loss"]);
run(["prisma", "db", "seed"]);
