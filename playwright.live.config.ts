import { defineConfig } from "@playwright/test";
import standard from "./playwright.config.ts";
export default defineConfig({
  testDir: "./tests/live",
  testMatch: "pi.spec.ts",
  workers: 1,
  timeout: 240000,
  outputDir: "./test-results/live",
  use: {
    ...standard.use,
    baseURL: "http://127.0.0.1:47834",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      "cargo build -p delta-host && npm run build && node tests/live/serve.mjs",
    url: "http://127.0.0.1:47834",
    reuseExistingServer: false,
    timeout: 120000,
  },
});
