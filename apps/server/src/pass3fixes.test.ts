// @vitest-environment node
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

// ─────────────────────────────────────────────────────────────────────────────
// FIX 1 — history pagination must not be capped at 50 runs
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 1 history pagination beyond 50 runs", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-fix1-"));
    await mkdir(join(projectRoot, "runs"), { recursive: true });
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "T", key: "T" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
    const runs = Array.from({ length: 60 }, (_, i) => ({
      runId: `run-${i + 1}`,
      status: "finished",
      verdict: "PASSED",
    }));
    await writeFile(
      join(projectRoot, "runs", "index.json"),
      JSON.stringify({ latest: "run-60", runs }),
    );
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("reports the full total and serves page 3 (runs 41–60)", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).get("/api/history?page=3&limit=20");
    expect(res.status).toBe(200);
    expect(res.body.total).toBe(60);
    expect(res.body.runs).toHaveLength(20);
    expect(res.body.hasMore).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 2 / FIX 4 — JIRA linking uses linkedStories[0] (fallback storyId)
// ─────────────────────────────────────────────────────────────────────────────

async function scaffoldJira(projectRoot: string, nodeOverrides: Record<string, unknown>) {
  await mkdir(join(projectRoot, ".pathlight", "auth"), { recursive: true });
  await writeFile(
    join(projectRoot, "pathlight.config.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      project: { name: "T", key: "T" },
      server: { host: "127.0.0.1", port: 4242 },
    }),
  );
  await writeFile(
    join(projectRoot, "pathlight-manifest.json"),
    JSON.stringify({
      schemaVersion: "1.0",
      projectKey: "T",
      lockedAt: "2024-01-01T00:00:00.000Z",
      lockedBy: "test",
      businessRules: [{ id: "BR-1", label: "Consent required", severity: "critical" }],
      nodes: [
        {
          id: "E2E-001",
          label: "Owner requests review",
          priority: "Highest",
          branchType: "happy",
          stageName: "Core Flow",
          businessRuleIds: ["BR-1"],
          tags: [],
          linkedStories: [],
          ...nodeOverrides,
        },
      ],
    }),
  );
  await writeFile(
    join(projectRoot, ".pathlight", "auth", "jira-token.json"),
    JSON.stringify({ access_token: "tok", cloudId: "cloud-1" }),
  );
}

function jiraMock(issueKey = "PROJ-1") {
  return vi.fn().mockImplementation((url: string) => {
    if (String(url).includes("?fields=status")) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ fields: { status: { name: "To Do" } } }),
        text: async () => "",
      });
    }
    return Promise.resolve({
      ok: true,
      json: async () => ({ key: issueKey }),
      text: async () => "",
    });
  });
}

function linkCall(mock: ReturnType<typeof vi.fn>) {
  const call = mock.mock.calls.find(([url]) => String(url).endsWith("/rest/api/3/issueLink"));
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

function debtBody(mock: ReturnType<typeof vi.fn>) {
  const call = mock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/rest/api/3/issue") &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

describe("FIX 2 bug linking prefers linkedStories[]", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-fix2-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("links the bug to linkedStories[0] when storyId is absent", async () => {
    await scaffoldJira(projectRoot, { linkedStories: ["US-100"] });
    const mock = jiraMock("BUG-1");
    const app = createApp({ projectRoot, jira: { fetch: mock } });
    const res = await request(app).post("/api/bugs/create").send({ journeyId: "E2E-001" });
    expect(res.status).toBe(200);
    const link = linkCall(mock);
    expect(link.outwardIssue.key).toBe("US-100");
    expect(link.inwardIssue.key).toBe("BUG-1");
  });

  it("falls back to storyId when linkedStories is empty", async () => {
    await scaffoldJira(projectRoot, { linkedStories: [], storyId: "US-200" });
    const mock = jiraMock("BUG-2");
    const app = createApp({ projectRoot, jira: { fetch: mock } });
    await request(app).post("/api/bugs/create").send({ journeyId: "E2E-001" });
    expect(linkCall(mock).outwardIssue.key).toBe("US-200");
  });
});

describe("FIX 4 test-debt story payload", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-fix4-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("includes priority, business rules and a source-story link", async () => {
    await scaffoldJira(projectRoot, { linkedStories: ["US-100"] });
    const mock = jiraMock("DEBT-9");
    const app = createApp({ projectRoot, jira: { fetch: mock } });
    const res = await request(app).post("/api/bugs/export-debt").send({});
    expect(res.status).toBe(200);
    expect(res.body.created).toBe(1);
    const body = debtBody(mock);
    expect(body.fields.priority.name).toBe("Critical"); // Highest → Critical
    const text = body.fields.description.content[0].content[0].text as string;
    expect(text).toContain("Priority: Highest");
    expect(text).toContain("Business rules covered:");
    expect(text).toContain("- BR-1: Consent required [critical]");
    expect(linkCall(mock).outwardIssue.key).toBe("US-100");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// FIX 5 — branch / pr / commit persisted in run metadata
// ─────────────────────────────────────────────────────────────────────────────

describe("FIX 5 run provenance metadata", () => {
  let projectRoot: string;
  let bundledReporterPath: string;
  const launch = () => Object.assign(new EventEmitter(), { kill: vi.fn(), pid: 1 }) as never;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-fix5-"));
    const target = join(projectRoot, "app-under-test");
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "playwright.config.ts"), "export default {};");
    bundledReporterPath = join(projectRoot, "reporter.js");
    await writeFile(bundledReporterPath, "export default class R {}");
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "T", key: "T" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: target,
        playwrightConfigPath: "playwright.config.ts",
      }),
    );
    await writeFile(
      join(projectRoot, "pathlight-manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        projectKey: "T",
        lockedAt: "2024-01-01T00:00:00.000Z",
        lockedBy: "test",
        businessRules: [],
        nodes: [{ id: "E2E-001", tags: [], testFiles: [] }],
      }),
    );
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("persists explicit branch/pr/commit/environment and returns them from GET", async () => {
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });
    const res = await request(app).post("/api/runs").send({
      runId: "run_meta_1",
      branch: "feat/x",
      pr: "42",
      commit: "abc123",
      environment: "staging",
    });
    expect(res.status).toBe(201);

    const summary = JSON.parse(
      await readFile(join(projectRoot, "reports/run_meta_1/summary.json"), "utf8"),
    );
    expect(summary).toMatchObject({
      branch: "feat/x",
      pr: "42",
      commit: "abc123",
      environment: "staging",
    });

    const get = await request(app).get("/api/runs/run_meta_1");
    expect(get.body).toMatchObject({ branch: "feat/x", pr: "42", commit: "abc123" });
  });

  it("falls back to CI env vars and never stores empty strings", async () => {
    const prevBranch = process.env.GITHUB_REF_NAME;
    const prevSha = process.env.GITHUB_SHA;
    process.env.GITHUB_REF_NAME = "ci-branch";
    process.env.GITHUB_SHA = "deadbeef";
    try {
      const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });
      await request(app).post("/api/runs").send({ runId: "run_meta_2", branch: "   " });
      const summary = JSON.parse(
        await readFile(join(projectRoot, "reports/run_meta_2/summary.json"), "utf8"),
      );
      expect(summary.branch).toBe("ci-branch"); // blank body → CI fallback
      expect(summary.commit).toBe("deadbeef");
      expect("pr" in summary).toBe(false); // no value anywhere → omitted
    } finally {
      if (prevBranch === undefined) delete process.env.GITHUB_REF_NAME;
      else process.env.GITHUB_REF_NAME = prevBranch;
      if (prevSha === undefined) delete process.env.GITHUB_SHA;
      else process.env.GITHUB_SHA = prevSha;
    }
  });
});
