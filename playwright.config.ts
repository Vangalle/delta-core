import { defineConfig } from "@playwright/test";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
const cached = `${homedir()}/Library/Caches/ms-playwright/chromium_headless_shell-1248/chrome-headless-shell-mac-arm64/chrome-headless-shell`;
const executablePath =
  process.env.PLAYWRIGHT_EXECUTABLE_PATH ??
  (existsSync(cached) ? cached : undefined);
export default defineConfig({
  testDir: "./tests",
  testMatch: "**/*.spec.ts",
  workers: 1,
  timeout: 30000,
  use: {
    baseURL: "http://127.0.0.1:47832",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    launchOptions: { executablePath },
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "cargo build -p delta-host && npm run build && node tests/serve.mjs",
    url: "http://127.0.0.1:47832",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
