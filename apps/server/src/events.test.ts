// @vitest-environment node
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

const runId = "run-001";
const timestamp = "2026-05-27T00:00:00.000Z";

function event(eventId: string, type: string, payload: unknown) {
  return { eventId, runId, type, timestamp, payload };
}

describe("US-P007 and US-P008 event bus and stream", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-events-"));
    await writeFile(
      join(projectRoot, "pathlight-manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        projectKey: "PL",
        lockedAt: timestamp,
        lockedBy: "dev@example.com",
        businessRules: [],
        nodes: [
          { id: "E2E-001", stage: "S2", label: "Submit", branchType: "happy", tags: [] },
          { id: "E2E-002", stage: "S2", label: "Reject", branchType: "unhappy", tags: [] },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("persists valid events, redacts failure errors and updates node state", async () => {
    const app = createApp({ projectRoot, activeRunId: runId });
    const started = await request(app)
      .post("/api/events")
      .send(
        event("evt_0001", "test.started", {
          testId: "E2E-001",
          attemptId: "attempt-1",
          workerId: "worker-1",
          attempt: 0,
          testFile: "e2e/review.spec.ts",
          testTitle: "submits @pathlight:E2E-001",
          testCaseHash: "12ab34cd",
        }),
      );
    const failed = await request(app)
      .post("/api/events")
      .send(
        event("evt_0002", "test.failed", {
          testId: "E2E-001",
          attemptId: "attempt-1",
          duration: 50,
          error: "Authorization: Bearer secret-token",
          errorType: "assertion_failure",
          retryCount: 0,
          workerId: "worker-1",
          isFinalAttempt: true,
        }),
      );

    expect(started.status).toBe(202);
    expect(started.body).toEqual({ received: true });
    expect(failed.status).toBe(202);
    const lines = (await readFile(join(projectRoot, "reports/run-001/events.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines.map((line) => line.seq)).toEqual([1, 2]);
    expect(lines[1].payload.error).not.toContain("secret-token");
    const state = await request(app).get(`/api/runs/${runId}`);
    expect(state.body.testResults["E2E-001"].status).toBe("failed");
  });

  it("returns required rejection responses and exposes health counters", async () => {
    const app = createApp({ projectRoot, activeRunId: runId });
    expect((await request(app).post("/api/events").send({})).status).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/events")
          .send(event("evt_wrong", "bad.type", {}))
      ).status,
    ).toBe(400);
    expect(
      (
        await request(app)
          .post("/api/events")
          .send({ ...event("evt_other", "run.started", {}), runId: "other-run" })
      ).status,
    ).toBe(400);

    const accepted = event("evt_0001", "run.started", {
      totalTests: 2,
      suiteTag: null,
      runType: "full",
    });
    expect((await request(app).post("/api/events").send(accepted)).body.received).toBe(true);
    expect((await request(app).post("/api/events").send(accepted)).body).toEqual({
      received: false,
      reason: "duplicate",
    });
    expect(
      (
        await request(app)
          .post("/api/events")
          .send(
            event("evt_unknown", "test.passed", {
              testId: "UNKNOWN",
              attemptId: "attempt",
              duration: 10,
              retryCount: 0,
              workerId: "w",
            }),
          )
      ).body,
    ).toEqual({ received: false, reason: "unknown testId" });
    expect(
      (
        await request(app)
          .post("/api/events")
          .send(event("evt_invalid", "test.passed", { testId: "E2E-001" }))
      ).body,
    ).toEqual({ received: false, reason: "invalid payload" });
    expect(
      (
        await request(app)
          .post("/api/events")
          .send(
            event("evt_invalid_type", "test.failed", {
              testId: "E2E-001",
              attemptId: "attempt",
              duration: 10,
              error: "failure",
              errorType: "made_up",
              retryCount: 0,
              workerId: "w",
              isFinalAttempt: true,
            }),
          )
      ).body,
    ).toEqual({ received: false, reason: "invalid payload" });

    const state = await request(app).get(`/api/runs/${runId}`);
    expect(state.body).toMatchObject({
      duplicateEventCount: 1,
      unknownTestIdCount: 1,
      invalidPayloadCount: 2,
    });
    expect((await request(app).get("/api/health")).body).toMatchObject({
      status: "ok",
      activeRunId: runId,
    });
  });

  it("streams persisted events using SSE replay after Last-Event-ID", async () => {
    const app = createApp({ projectRoot, activeRunId: runId });
    await request(app)
      .post("/api/events")
      .send(
        event("evt_0001", "run.started", {
          totalTests: 2,
          suiteTag: null,
          runType: "full",
        }),
      );
    await request(app)
      .post("/api/events")
      .send(
        event("evt_0002", "test.skipped", {
          testId: "E2E-002",
          attemptId: "attempt-2",
          reason: "not applicable",
        }),
      );

    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Unable to bind test server.");
    }
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
        headers: { "Last-Event-ID": "1" },
        signal: controller.signal,
      });
      expect(response.headers.get("content-type")).toContain("text/event-stream");
      const reader = response.body!.getReader();
      const chunk = new TextDecoder().decode((await reader.read()).value);
      expect(chunk).toContain("id: 2");
      expect(chunk).toContain('"type":"test.skipped"');
    } finally {
      controller.abort();
      server.close();
    }
  });
});
