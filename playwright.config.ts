import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

const PORT = 3311;
const DATABASE_URL = `file:${path.join(process.cwd(), "prisma", "e2e.db")}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,

  /**
   * SQLite is single-writer (specs/01 §12.1). Parallel workers hitting one
   * database file produce SQLITE_BUSY errors that surface as intermittent,
   * plausible-looking pricing bugs. If this suite ever gets slow enough to
   * matter, the fix is WAL mode plus a busy timeout — NOT more workers.
   */
  workers: 1,

  reporter: [["list"]],
  timeout: 30_000,

  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },

  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],

  webServer: {
    // Database preparation is the first link, not globalSetup: Playwright
    // launches webServer BEFORE globalSetup, so a globalSetup that seeds the
    // database races the server that reads it.
    command: `node e2e/prepare-db.mjs && npx next build && npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/products`,
    reuseExistingServer: false,
    timeout: 300_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      DATABASE_URL,
      NODE_ENV: "production",
      ADMIN_API_KEY: "e2e-admin-key",
      UPLOAD_DIR: path.join(process.cwd(), "e2e-uploads"),
      MAX_UPLOAD_BYTES: "5242880",
      STORE_CURRENCY: "USD",
      TAX_RATE_BPS: "800",
      TAX_ON_SHIPPING: "false",
      SHIPPING_FLAT_CENTS: "599",
      FREE_SHIPPING_THRESHOLD_CENTS: "5000",
    },
  },
});
