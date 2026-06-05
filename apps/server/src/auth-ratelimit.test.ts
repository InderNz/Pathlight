// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const MANIFEST = {
  schemaVersion: "1.0",
  projectKey: "PL",
  lockedAt: null,
  lockedBy: null,
  businessRules: [],
  nodes: [],
};

describe("Local auth middleware", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-auth-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Test", key: "TST" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot,
      }),
    );
    await writeFile(join(projectRoot, "pathlight-manifest.json"), JSON.stringify(MANIFEST));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns 401 on mutating endpoints without the token", async () => {
    const app = createApp({ projectRoot, localToken: "secret-token" });
    const res = await request(app).post("/api/manifest/validate").send({ nodes: [] });
    expect(res.status).toBe(401);
  });

  it("returns 401 with a wrong token", async () => {
    const app = createApp({ projectRoot, localToken: "correct-token" });
    const res = await request(app)
      .post("/api/manifest/validate")
      .set("x-pathlight-token", "wrong-token")
      .send({ nodes: [] });
    expect(res.status).toBe(401);
  });

  it("passes through with the correct token", async () => {
    const app = createApp({ projectRoot, localToken: "secret-token" });
    const res = await request(app)
      .post("/api/manifest/validate")
      .set("x-pathlight-token", "secret-token")
      .send({ schemaVersion: "1.0", projectKey: "PL", nodes: [] });
    expect(res.status).not.toBe(401);
  });

  it("allows GET requests without a token when auth is enabled", async () => {
    const app = createApp({ projectRoot, localToken: "secret-token" });
    const res = await request(app).get("/api/health");
    expect(res.status).toBe(200);
  });

  it("exposes the token at GET /api/local-token", async () => {
    const app = createApp({ projectRoot, localToken: "my-test-token" });
    const res = await request(app).get("/api/local-token");
    expect(res.status).toBe(200);
    expect(res.body.token).toBe("my-test-token");
  });

  it("returns 404 at GET /api/local-token when auth is not configured", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).get("/api/local-token");
    expect(res.status).toBe(404);
  });

  it("does not apply auth when localToken is not set (existing tests keep working)", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app)
      .post("/api/manifest/validate")
      .send({ schemaVersion: "1.0", projectKey: "PL", nodes: [] });
    expect(res.status).not.toBe(401);
  });
});

describe("Rate limiting", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-rl-"));
    await mkdir(join(projectRoot, "tests/e2e"), { recursive: true });
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Test", key: "TST" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot,
        testDir: "tests/e2e",
      }),
    );
    await writeFile(join(projectRoot, "pathlight-manifest.json"), JSON.stringify(MANIFEST));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns 429 from JIRA fetch after limit is reached", async () => {
    // RATE_LIMIT_JIRA defaults to 20; use window env override isn't practical in unit tests.
    // Instead test directly by overriding the env to min=1 — but env changes in process are global.
    // Simpler: confirm the endpoint returns 429 when overriding the window via a tiny custom limiter.
    // We test this through a fresh app with env RATE_LIMIT_JIRA=1
    const originalEnv = process.env.RATE_LIMIT_JIRA;
    process.env.RATE_LIMIT_JIRA = "1";
    try {
      const app = createApp({ projectRoot });
      // First call consumes the 1 slot
      await request(app).post("/api/jira/fetch-stories").send({ jiraProjectKey: "TST" });
      // Second call should be rate-limited
      const res = await request(app)
        .post("/api/jira/fetch-stories")
        .send({ jiraProjectKey: "TST" });
      expect(res.status).toBe(429);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.RATE_LIMIT_JIRA;
      } else {
        process.env.RATE_LIMIT_JIRA = originalEnv;
      }
    }
  });

  it("returns 429 from run start after limit is reached", async () => {
    const originalEnv = process.env.RATE_LIMIT_RUNS;
    process.env.RATE_LIMIT_RUNS = "1";
    try {
      const app = createApp({ projectRoot });
      await request(app).post("/api/runs").send({});
      const res = await request(app).post("/api/runs").send({});
      expect(res.status).toBe(429);
    } finally {
      if (originalEnv === undefined) {
        delete process.env.RATE_LIMIT_RUNS;
      } else {
        process.env.RATE_LIMIT_RUNS = originalEnv;
      }
    }
  });
});
