import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import { createApp } from "./app.js";
import { generateToken } from "./local-auth.js";

const serverDirectory = fileURLToPath(new URL("..", import.meta.url));
const workspaceDirectory = resolve(serverDirectory, "../..");
const webDirectory = resolve(workspaceDirectory, "apps/web");
const bundledReporterPath = resolve(
  workspaceDirectory,
  "packages/playwright-reporter/dist/bundled-reporter.js",
);
const projectRoot = process.env.PATHLIGHT_PROJECT_ROOT
  ? resolve(process.env.PATHLIGHT_PROJECT_ROOT)
  : workspaceDirectory;
const host = process.env.PATHLIGHT_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT) || 4242;
const localToken = generateToken();
const app = createApp({
  projectRoot,
  bundledReporterPath,
  localToken,
  jira: {
    clientId: process.env.JIRA_CLIENT_ID,
    redirectUri: process.env.JIRA_REDIRECT_URI ?? `http://${host}:${port}/api/jira/callback`,
  },
});

if (process.env.NODE_ENV === "production") {
  const express = await import("express");
  app.use(express.default.static(resolve(webDirectory, "dist")));
  app.get("*splat", (_request, response) => {
    response.sendFile(resolve(webDirectory, "dist/index.html"));
  });
} else {
  // In Vite 6 middleware mode the HMR WebSocket always binds a port (hmr:false
  // is not honoured). VITE_HMR_PORT lets a second server (e.g. the E2E server)
  // use a different port so it doesn't conflict with the dev server on 24678.
  const hmrPort = process.env.VITE_HMR_PORT ? Number(process.env.VITE_HMR_PORT) : undefined;
  const vite = await createViteServer({
    root: webDirectory,
    server: {
      middlewareMode: true,
      hmr: hmrPort !== undefined ? { port: hmrPort } : true,
    },
    appType: "spa",
  });
  app.use(vite.middlewares);
}

app.listen(port, host, () => {
  console.log(`[pathlight] Configuration server ready at http://${host}:${port}/config`);
});
