import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig } from "vite";

export default defineConfig({
  root: resolve("apps/web"),
  plugins: [react()],
  build: {
    outDir: "dist",
  },
  test: {
    root: resolve("."),
    environment: "jsdom",
    include: ["apps/**/*.test.{ts,tsx}", "packages/**/*.test.ts"],
    exclude: [
      "e2e/**",
      "**/node_modules/**",
      "**/dist/**",
      "pathlight-app/**",
      "pathlight-spike/**",
    ],
    setupFiles: ["./apps/web/src/test/setup.ts"],
  },
});
