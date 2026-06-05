// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

describe("US-P003 JIRA OAuth connection", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-jira-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Pathlight", key: "PL" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("starts PKCE OAuth by storing verifier/state and returning Atlassian authorization URL", async () => {
    const response = await request(
      createApp({
        projectRoot,
        jira: { clientId: "jira-client", redirectUri: "http://127.0.0.1:4242/api/jira/callback" },
      }),
    ).post("/api/jira/connect");

    expect(response.status).toBe(200);
    const authorizationUrl = new URL(response.body.authorizationUrl);
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(
      "https://auth.atlassian.com/authorize",
    );
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("client_id")).toBe("jira-client");
    const stateFile = JSON.parse(
      await readFile(join(projectRoot, ".pathlight/auth/oauth-state.json"), "utf8"),
    );
    expect(stateFile.state).toBe(authorizationUrl.searchParams.get("state"));
    expect(stateFile.codeVerifier).toEqual(expect.any(String));
  });

  it("exchanges a valid callback, discovers cloudId, and stores chmod 600 credentials", async () => {
    const jiraFetch = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            access_token: "access",
            refresh_token: "refresh",
            expires_in: 3600,
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(new Response(JSON.stringify([{ id: "cloud-123" }]), { status: 200 }));
    const app = createApp({
      projectRoot,
      jira: {
        clientId: "jira-client",
        redirectUri: "http://127.0.0.1:4242/api/jira/callback",
        fetch: jiraFetch,
      },
    });
    const connect = await request(app).post("/api/jira/connect");
    const state = new URL(connect.body.authorizationUrl).searchParams.get("state")!;

    const callback = await request(app).get(`/api/jira/callback?code=grant&state=${state}`);

    expect(callback.status).toBe(302);
    expect(callback.headers.location).toBe("/config?jira=connected");
    const tokenPath = join(projectRoot, ".pathlight/auth/jira-token.json");
    const token = JSON.parse(await readFile(tokenPath, "utf8"));
    expect(token.cloudId).toBe("cloud-123");
    expect(token.access_token).toBe("access");
    expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
  });

  it("rejects CSRF mismatch and supports disconnecting an existing connection", async () => {
    const app = createApp({
      projectRoot,
      jira: { clientId: "jira-client", redirectUri: "http://127.0.0.1:4242/api/jira/callback" },
    });
    await request(app).post("/api/jira/connect");

    const mismatch = await request(app).get("/api/jira/callback?code=grant&state=wrong");
    expect(mismatch.status).toBe(302);
    expect(mismatch.headers.location).toBe("/config?jira=csrf");
    await expect(
      readFile(join(projectRoot, ".pathlight/auth/jira-token.json"), "utf8"),
    ).rejects.toThrow();

    await writeFile(join(projectRoot, ".pathlight/auth/jira-token.json"), "{}");
    const disconnected = await request(app).delete("/api/jira/connection");
    expect(disconnected.status).toBe(200);
    const status = await request(app).get("/api/jira/status");
    expect(status.body.status).toBe("not_connected");
  });

  it("stores the JIRA mock toggle in configuration and identifies expired tokens", async () => {
    const app = createApp({ projectRoot });
    const mock = await request(app).put("/api/jira/mock").send({ enabled: true });
    expect(mock.status).toBe(200);
    const config = JSON.parse(await readFile(join(projectRoot, "pathlight.config.json"), "utf8"));
    expect(config.PATHLIGHT_JIRA_MOCK).toBe(true);

    await mkdir(join(projectRoot, ".pathlight/auth"), { recursive: true });
    await writeFile(
      join(projectRoot, ".pathlight/auth/jira-token.json"),
      JSON.stringify({ cloudId: "expired-cloud", expiresAt: "2000-01-01T00:00:00.000Z" }),
    );
    const status = await request(app).get("/api/jira/status");
    expect(status.body).toEqual({
      status: "expired",
      cloudId: "expired-cloud",
      message: "JIRA connection expired — reconnect",
      mockEnabled: true,
    });
  });
});
