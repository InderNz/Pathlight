// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";
import { computeVerdict, type ReportRunState } from "./report.js";

const runId = "run-report";
const timestamp = "2026-05-27T00:00:00.000Z";

const manifest = {
  schemaVersion: "1.0",
  projectKey: "PL",
  lockedAt: timestamp,
  lockedBy: "dev@example.com",
  businessRules: [
    { id: "BR-H", label: "High assurance", severity: "high" },
    { id: "BR-L", label: "Low assurance", severity: "low" },
    { id: "BR-D", label: "Draft only", severity: "critical", draft: true },
  ],
  nodes: [
    {
      id: "E2E-001",
      stage: "S2",
      module: "Review",
      label: "Submit",
      businessRuleIds: ["BR-H", "BR-D"],
    },
    {
      id: "E2E-002",
      stage: "S3",
      module: "Decision",
      label: "Approve",
      businessRuleIds: ["BR-L"],
    },
  ],
};

function event(eventId: string, type: string, payload: unknown) {
  return { eventId, runId, type, timestamp, payload };
}

function finished(overrides: Record<string, number> = {}) {
  return {
    total: 2,
    passed: 2,
    failed: 0,
    skipped: 0,
    duration: 200,
    totalEventsSent: 4,
    droppedEventCount: 0,
    untaggedTestCount: 0,
    invalidTagCount: 0,
    unknownTagCount: 0,
    ...overrides,
  };
}

describe("US-P020 and US-P022 dashboard publisher and run health", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-report-"));
    await writeFile(join(projectRoot, "pathlight-manifest.json"), JSON.stringify(manifest));
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("publishes the dashboard, summary, report event and run index on completion", async () => {
    const app = createApp({ projectRoot, activeRunId: runId });
    await request(app)
      .post("/api/events")
      .send(event("evt_0001", "run.started", { totalTests: 2, suiteTag: null, runType: "full" }));
    for (const [id, testId] of [
      ["evt_0002", "E2E-001"],
      ["evt_0003", "E2E-002"],
    ]) {
      await request(app)
        .post("/api/events")
        .send(
          event(id, "test.passed", {
            testId,
            attemptId: `${testId}-attempt`,
            duration: 10,
            retryCount: 0,
            workerId: "worker",
          }),
        );
    }
    await writeFile(
      join(projectRoot, `reports/${runId}/output.log`),
      "[stderr] global setup failed\n",
      "utf8",
    );
    const complete = await request(app)
      .post("/api/events")
      .send(event("evt_0004", "run.finished", finished()));

    expect(complete.body).toEqual({ received: true });
    const state = (await request(app).get(`/api/runs/${runId}`)).body;
    expect(state).toMatchObject({
      status: "finished",
      reportReady: true,
      reportPath: `reports/${runId}/report.html`,
      nodeTestResults: { "E2E-001": ["passed"], "E2E-002": ["passed"] },
    });
    const summary = JSON.parse(
      await readFile(join(projectRoot, `reports/${runId}/summary.json`), "utf8"),
    );
    expect(summary.verdict).toBe("PASSED");
    const report = await readFile(join(projectRoot, `reports/${runId}/report.html`), "utf8");
    for (const section of [
      "Release confidence",
      "Summary metrics",
      "Fishbone snapshot",
      "Module breakdown",
      "Failed branches",
      "Business rule coverage",
      "Untested paths",
      "Run health",
      "Playwright output",
      "Run metadata",
    ]) {
      expect(report).toContain(section);
    }
    expect(report).toContain("global setup failed");
    expect(report).toContain("<svg");
    expect(report).toContain("Review: 1 passed");
    expect(report).toContain("BR-H");
    expect(report).toContain("PASS");
    expect(report).toContain("No untested paths.");
    expect((await request(app).get(`/reports/${runId}/report.html`)).text).toContain("PASSED");
    const events = await readFile(join(projectRoot, `reports/${runId}/events.jsonl`), "utf8");
    expect(events).not.toContain("report.ready");
    const index = JSON.parse(await readFile(join(projectRoot, "runs/index.json"), "utf8"));
    expect(index).toMatchObject({ latest: runId, runs: [{ runId, status: "finished" }] });
  });

  it("shows title matching guidance and delivery verification warning in report health", async () => {
    const app = createApp({ projectRoot, activeRunId: runId });
    await request(app)
      .post("/api/events")
      .send(event("evt_0001", "run.started", { totalTests: 2, suiteTag: null, runType: "full" }));
    await request(app)
      .post("/api/events")
      .send(
        event("evt_unknown", "test.passed", {
          testId: "UNKNOWN",
          attemptId: "unknown",
          duration: 10,
          retryCount: 0,
          workerId: "worker",
        }),
      );
    await request(app)
      .post("/api/events")
      .send(
        event(
          "evt_0002",
          "run.finished",
          finished({
            totalEventsSent: 5,
            untaggedTestCount: 2,
          }),
        ),
      );

    const report = await readFile(join(projectRoot, `reports/${runId}/report.html`), "utf8");
    expect(report).toContain("WARNING: server-side event drop detected");
    expect(report).toContain(
      "2 tests have no bracketed journey ID such as [E2E-005] and were excluded from tracking",
    );
    expect((await request(app).get(`/api/runs/${runId}`)).body.unknownTestIdCount).toBe(1);
  });
});

describe("US-P021 release confidence verdict", () => {
  const state = (overrides: Partial<ReportRunState>): ReportRunState => ({
    runId,
    status: "finished",
    intendedNodeIds: ["E2E-001", "E2E-002"],
    testResults: {
      "E2E-001": { status: "passed" },
      "E2E-002": { status: "passed" },
    },
    nodeTestResults: {
      "E2E-001": ["passed"],
      "E2E-002": ["passed"],
    },
    reportReady: false,
    reportPath: null,
    unknownTestIdCount: 0,
    unknownTagCount: 0,
    untaggedTestCount: 0,
    invalidTagCount: 0,
    duplicateEventCount: 0,
    invalidPayloadCount: 0,
    droppedEventCount: 0,
    ...overrides,
  });

  it("passes only when every intended node has passing raw results", () => {
    expect(computeVerdict(manifest, state({}))).toBe("PASSED");
    expect(
      computeVerdict(
        manifest,
        state({ nodeTestResults: { "E2E-001": ["passed", "blocked"], "E2E-002": ["passed"] } }),
      ),
    ).toBe("FAILED");
  });

  it("fails abandoned runs and warns for low severity or general coverage gaps", () => {
    expect(computeVerdict(manifest, state({ status: "abandoned" }))).toBe("FAILED");
    expect(
      computeVerdict(
        manifest,
        state({ nodeTestResults: { "E2E-001": ["passed"], "E2E-002": ["skipped"] } }),
      ),
    ).toBe("WARNING");
  });
});
