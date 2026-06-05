// @vitest-environment node
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ManifestFile } from "@pathlight/manifest-schema";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";
import { computeRisk } from "./services/RiskService.js";

// ─────────────────────────────────────────────────────────────────────────────
// 4.1 Risk: an untested journey covering a critical rule must BLOCK, not GO.
// ─────────────────────────────────────────────────────────────────────────────

describe("4.1 risk recommendation for untested critical journeys", () => {
  const manifest = {
    schemaVersion: "1.0",
    projectKey: "T",
    lockedAt: "2024-01-01T00:00:00.000Z",
    lockedBy: "test",
    businessRules: [
      { id: "BR-CRIT", label: "Consent", severity: "critical" },
      { id: "BR-HIGH", label: "Notify", severity: "high" },
    ],
    nodes: [
      { id: "E2E-001", priority: "Medium", businessRuleIds: ["BR-CRIT"] },
      { id: "E2E-002", priority: "Medium", businessRuleIds: ["BR-HIGH"] },
    ],
  } as unknown as ManifestFile;

  it("BLOCKS when a critical-rule journey has no test result", () => {
    const result = computeRisk(manifest, {}, ["E2E-001"]);
    expect(result.recommendation).toBe("BLOCKED");
    expect(result.statement).toMatch(/no automated verification/i);
  });

  it("HOLDS when only a high-rule journey is untested", () => {
    const result = computeRisk(manifest, { "E2E-001": { status: "passed" } }, [
      "E2E-001",
      "E2E-002",
    ]);
    expect(result.recommendation).toBe("HOLD");
  });

  it("GOes when every in-scope journey passed", () => {
    const result = computeRisk(
      manifest,
      { "E2E-001": { status: "passed" }, "E2E-002": { status: "passed" } },
      ["E2E-001", "E2E-002"],
    );
    expect(result.recommendation).toBe("GO");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Bug creation (4.3–4.6) — shared project scaffolding
// ─────────────────────────────────────────────────────────────────────────────

const FAILURE_EVENTS = [
  {
    type: "step.started",
    payload: { testId: "E2E-001", attemptId: "a1", stepTitle: "Open form", source: "explicit" },
  },
  {
    type: "step.started",
    payload: { testId: "E2E-001", attemptId: "a1", stepTitle: "locator.click", source: "auto" },
  },
  {
    type: "artifact.created",
    payload: { testId: "E2E-001", attemptId: "a1", artifactType: "screenshot", path: "shot.png" },
  },
  {
    type: "test.failed",
    payload: {
      testId: "E2E-001",
      attemptId: "a1",
      error: "boom",
      errorType: "timeout",
      duration: 1234,
      retryCount: 1,
      isFinalAttempt: true,
    },
  },
];

const NODE = {
  id: "E2E-001",
  label: "Owner requests review",
  priority: "Highest",
  branchType: "happy",
  storyId: "US-002",
  businessRuleIds: ["BR-1"],
  tags: [] as string[],
};

async function scaffold(
  projectRoot: string,
  opts: { tags?: string[]; failedRuns?: number; openDebtStoryKey?: string } = {},
) {
  await mkdir(join(projectRoot, ".pathlight", "auth"), { recursive: true });
  await mkdir(join(projectRoot, "reports", "run-1"), { recursive: true });
  await mkdir(join(projectRoot, "runs"), { recursive: true });
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
      businessRules: [{ id: "BR-1", label: "Consent", severity: "critical" }],
      nodes: [{ ...NODE, tags: opts.tags ?? [], openDebtStoryKey: opts.openDebtStoryKey }],
    }),
  );
  await writeFile(
    join(projectRoot, ".pathlight", "auth", "jira-token.json"),
    JSON.stringify({ access_token: "tok", cloudId: "cloud-1" }),
  );
  // Failure evidence for the latest run (incl. a screenshot artifact on disk).
  await writeFile(
    join(projectRoot, "reports", "run-1", "events.jsonl"),
    FAILURE_EVENTS.map((e) => JSON.stringify(e)).join("\n") + "\n",
  );
  await writeFile(join(projectRoot, "shot.png"), "png-bytes");

  const failedRuns = opts.failedRuns ?? 1;
  const runs = Array.from({ length: failedRuns }, (_, i) => ({
    runId: i === 0 ? "run-1" : `run-${i + 1}`,
    status: "finished",
  }));
  await writeFile(
    join(projectRoot, "runs", "index.json"),
    JSON.stringify({ latest: "run-1", runs }),
  );
  for (const run of runs) {
    await mkdir(join(projectRoot, "reports", run.runId), { recursive: true });
    await writeFile(
      join(projectRoot, "reports", run.runId, "summary.json"),
      JSON.stringify({ runId: run.runId, testResults: { "E2E-001": { status: "failed" } } }),
    );
  }
}

function okJiraMock(issueKey = "PROJ-1") {
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

function issueBody(mock: ReturnType<typeof vi.fn>) {
  const call = mock.mock.calls.find(
    ([url, init]) =>
      String(url).endsWith("/rest/api/3/issue") &&
      (init as RequestInit | undefined)?.method === "POST",
  );
  return call ? JSON.parse(String((call[1] as RequestInit).body)) : undefined;
}

describe("4.3/4.4 JIRA bug payload", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-g4-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("4.3 manual bug includes failing step, error, duration, retry count and run id", async () => {
    await scaffold(projectRoot);
    const mock = okJiraMock("PROJ-7");
    const app = createApp({ projectRoot, jira: { fetch: mock } });

    const res = await request(app)
      .post("/api/bugs/create")
      .send({ journeyId: "E2E-001", attemptId: "a1" });

    expect(res.status).toBe(200);
    expect(res.body.bugKey).toBe("PROJ-7");
    const body = issueBody(mock);
    const text = body.fields.description.content[0].content[0].text as string;
    expect(text).toContain("Failing step: Open form");
    expect(text).toContain("Error: boom");
    expect(text).toContain("Duration: 1234 ms");
    expect(text).toContain("Retry count: 1");
    expect(text).toContain("Run: run-1");
    expect(body.fields.labels).toEqual(["pathlight", "automated-failure", "E2E-001"]);
  });

  it("4.4 auto bug has an identical payload plus the pathlight-auto label", async () => {
    await scaffold(projectRoot, { failedRuns: 2 });
    const mock = okJiraMock("PROJ-8");
    const app = createApp({ projectRoot, jira: { fetch: mock } });

    const res = await request(app).post("/api/bugs/auto-create").send({ journeyId: "E2E-001" });

    expect(res.status).toBe(200);
    expect(res.body.bugKey).toBe("PROJ-8");
    const body = issueBody(mock);
    const text = body.fields.description.content[0].content[0].text as string;
    expect(text).toContain("Failing step: Open form");
    expect(text).toContain("Error: boom");
    expect(body.fields.labels).toEqual([
      "pathlight",
      "automated-failure",
      "E2E-001",
      "pathlight-auto",
    ]);
  });

  it("4.5 auto bug is skipped when the journey is tagged @no-auto-bug", async () => {
    await scaffold(projectRoot, { failedRuns: 2, tags: ["@no-auto-bug"] });
    const mock = okJiraMock();
    const app = createApp({ projectRoot, jira: { fetch: mock } });

    const res = await request(app).post("/api/bugs/auto-create").send({ journeyId: "E2E-001" });

    expect(res.status).toBe(200);
    expect(res.body.bugKey).toBeNull();
    expect(issueBody(mock)).toBeUndefined(); // no issue was created
  });
});

describe("4.6 test-debt export duplicate prevention", () => {
  let projectRoot: string;
  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-g4-debt-"));
  });
  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("skips a journey that already has an open debt story", async () => {
    await scaffold(projectRoot, { openDebtStoryKey: "DEBT-1" });
    const mock = okJiraMock();
    const app = createApp({ projectRoot, jira: { fetch: mock } });

    const res = await request(app).post("/api/bugs/export-debt").send({});

    expect(res.status).toBe(200);
    expect(res.body.created).toBe(0);
    expect(res.body.skipped).toBe(1);
    // The status was checked, but no new Story was created.
    expect(issueBody(mock)).toBeUndefined();
    expect(res.body.results[0]).toMatchObject({ skipped: true, key: "DEBT-1" });
  });
});
