import { resolve } from "node:path";
import { defineConfig } from "@playwright/test";

// Use a dedicated port so E2E never reuses a developer's dev server on 4242
// (which would point at the real project root instead of .tmp/e2e-project).
const PORT = process.env.E2E_PORT ?? "4343";
const BASE_URL = `http://127.0.0.1:${PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: BASE_URL,
    trace: "on-first-retry",
  },
  webServer: {
    command: `PORT=${PORT} VITE_HMR_PORT=24680 npm run dev`,
    url: `${BASE_URL}/config`,
    // Always start a fresh server bound to the dedicated E2E port and pointed
    // at .tmp/e2e-project, so each run begins from clean, unsaved state.
    reuseExistingServer: false,
    env: {
      PORT,
      PATHLIGHT_PROJECT_ROOT: resolve(".tmp/e2e-project"),
      // VITE_HMR_PORT is set inline in the command above for reliable
      // propagation through npm run dev's subshell chain.
    },
  },
  globalSetup: "./e2e/global-setup.ts",
});
