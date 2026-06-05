// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function setupProject(
  projectRoot: string,
  opts: {
    manifest?: object;
    runSummary?: object;
  } = {},
) {
  await mkdir(join(projectRoot, ".pathlight", "auth"), { recursive: true });
  await mkdir(join(projectRoot, "runs"), { recursive: true });
  await mkdir(join(projectRoot, "reports", "run-1"), { recursive: true });

  await writeFile(
    join(projectRoot, "pathlight.config.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      project: { name: "T", key: "T" },
      server: { host: "127.0.0.1", port: 4242 },
    }),
  );

  const manifest = opts.manifest ?? {
    schemaVersion: "1.0",
    projectKey: "T",
    lockedAt: "2024-01-01T00:00:00.000Z",
    lockedBy: "test",
    nodes: [{ id: "E2E-001", label: "Login" }],
    businessRules: [],
  };
  await writeFile(join(projectRoot, "pathlight-manifest.json"), JSON.stringify(manifest));

  const summary = opts.runSummary ?? {
    runId: "run-1",
    status: "finished",
    verdict: "PASSED",
    intendedNodeIds: ["E2E-001"],
    testResults: { "E2E-001": { status: "passed" } },
  };
  await writeFile(join(projectRoot, "reports", "run-1", "summary.json"), JSON.stringify(summary));
  await writeFile(
    join(projectRoot, "runs", "index.json"),
    JSON.stringify({ latest: "run-1", runs: [{ runId: "run-1", status: "finished" }] }),
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// a) Duplicate bug prevention
// ─────────────────────────────────────────────────────────────────────────────

describe("4.4a — duplicate bug prevention", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-bugs-"));
    await setupProject(projectRoot);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("creates a bug and stores the key", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: "PROJ-42" }),
      text: async () => "",
    });
    const app = createApp({
      projectRoot,
      jira: { fetch: mockFetch },
    });

    await writeFile(
      join(projectRoot, ".pathlight", "auth", "jira-token.json"),
      JSON.stringify({ access_token: "tok", cloudId: "cloud-1" }),
    );

    const res = await request(app).post("/api/bugs/create").send({ journeyId: "E2E-001" });

    expect(res.status).toBe(200);
    expect(res.body.bugKey).toBe("PROJ-42");
    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it("does not create a second bug when one already exists", async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ key: "PROJ-99" }),
      text: async () => "",
    });
    await writeFile(
      join(projectRoot, ".pathlight", "auth", "jira-token.json"),
      JSON.stringify({ access_token: "tok", cloudId: "cloud-1" }),
    );
    // Pre-seed the open bug key on the manifest node (single source of truth).
    await writeFile(
      join(projectRoot, "pathlight-manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        projectKey: "T",
        lockedAt: "2024-01-01T00:00:00.000Z",
        lockedBy: "test",
        nodes: [{ id: "E2E-001", label: "Login", openBugKey: "PROJ-42" }],
        businessRules: [],
      }),
    );

    const app = createApp({ projectRoot, jira: { fetch: mockFetch } });

    // autoCreateBugIfNeeded should return without calling JIRA
    const res = await request(app).post("/api/bugs/auto-create").send({ journeyId: "E2E-001" });

    expect(res.status).toBe(200);
    expect(res.body.bugKey).toBe("PROJ-42");
    expect(mockFetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// b) Webhook failure handling
// ─────────────────────────────────────────────────────────────────────────────

describe("4.4b — webhook failure handling", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-webhook-"));
    await setupProject(projectRoot);
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("logs a warning but does not throw when webhook returns 500", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({}),
    });

    const app = createApp({ projectRoot, jira: { fetch: mockFetch as typeof fetch } });

    // Patch global fetch for the webhook call
    const originalFetch = global.fetch;
    global.fetch = mockFetch as typeof fetch;
    const res = await request(app)
      .post("/api/alerts/run-complete")
      .send({ webhookUrl: "https://hooks.example.com/test", platform: "slack" });
    global.fetch = originalFetch;

    expect(res.status).toBe(200);
    expect(res.body.sent).toBe(false);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("non-2xx"));
    warnSpy.mockRestore();
  });

  it("rejects non-https webhook URLs", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app)
      .post("/api/alerts/test")
      .send({ webhookUrl: "http://example.com/hook", platform: "slack" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/https/i);
  });

  it("rejects localhost webhook URLs", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app)
      .post("/api/alerts/test")
      .send({ webhookUrl: "https://localhost/hook", platform: "slack" });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/localhost/i);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// c) AI provider fallback / BYPASS stubs
// ─────────────────────────────────────────────────────────────────────────────

describe("4.4c — AI provider BYPASS stub shapes", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-ai-"));
    await setupProject(projectRoot);
    process.env.BYPASS_EXTERNAL_AI = "true";
  });

  afterEach(async () => {
    delete process.env.BYPASS_EXTERNAL_AI;
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("evidence summarise returns a non-empty string stub", async () => {
    const app = createApp({ projectRoot, callClaude: async () => "stub" });
    const res = await request(app)
      .post("/api/evidence/E2E-001/summarise")
      .send({
        attemptId: "a1",
        steps: ["Step 1"],
        error: "timeout",
        journeyLabel: "Login",
        branchType: "happy",
      });
    expect(res.status).toBe(200);
    expect(typeof res.body.summary).toBe("string");
    expect(res.body.summary.length).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// e) History pagination
// ─────────────────────────────────────────────────────────────────────────────

describe("4.4e — history pagination", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-hist-"));
    await mkdir(join(projectRoot, "runs"), { recursive: true });
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "T", key: "T" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );

    // Create 25 fake runs
    const runs = Array.from({ length: 25 }, (_, i) => ({
      runId: `run-${i + 1}`,
      status: "finished",
      verdict: "PASSED",
    }));
    await writeFile(
      join(projectRoot, "runs", "index.json"),
      JSON.stringify({ latest: "run-25", runs }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("returns 20 runs on page 1 with hasMore=true", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).get("/api/history?page=1&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(20);
    expect(res.body.total).toBe(25);
    expect(res.body.hasMore).toBe(true);
    expect(res.body.page).toBe(1);
  });

  it("returns 5 runs on page 2 with hasMore=false", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).get("/api/history?page=2&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.runs).toHaveLength(5);
    expect(res.body.total).toBe(25);
    expect(res.body.hasMore).toBe(false);
    expect(res.body.page).toBe(2);
  });
});
