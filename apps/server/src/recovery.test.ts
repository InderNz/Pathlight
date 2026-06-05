// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

const runId = "run-recovery";
const timestamp = "2026-05-27T00:00:00.000Z";

describe("US-P023 server restart and crash recovery", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-recovery-"));
    await writeFile(
      join(projectRoot, "pathlight-manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        projectKey: "PL",
        lockedAt: timestamp,
        nodes: [{ id: "E2E-001" }, { id: "E2E-002" }],
      }),
    );
    await mkdir(join(projectRoot, "reports", runId), { recursive: true });
    await mkdir(join(projectRoot, "runs"), { recursive: true });
    await writeFile(
      join(projectRoot, "runs/index.json"),
      JSON.stringify({ latest: runId, runs: [{ runId, status: "running" }] }),
    );
    await writeFile(
      join(projectRoot, "reports", runId, "summary.json"),
      JSON.stringify({ runId, intendedNodeIds: ["E2E-001", "E2E-002"] }),
    );
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("replays persisted state, discards a corrupt final line and abandons an interrupted run", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(
      join(projectRoot, "reports", runId, "events.jsonl"),
      [
        JSON.stringify({
          seq: 1,
          eventId: "evt_0001",
          runId,
          type: "run.started",
          timestamp,
          receivedAt: timestamp,
          payload: { totalTests: 2, suiteTag: null, runType: "full" },
        }),
        JSON.stringify({
          seq: 2,
          eventId: "evt_0002",
          runId,
          type: "test.passed",
          timestamp,
          receivedAt: timestamp,
          payload: {
            testId: "E2E-001",
            attemptId: "attempt",
            duration: 10,
            retryCount: 0,
            workerId: "worker",
          },
        }),
        '{"seq":3',
      ].join("\n"),
    );

    const app = createApp({ projectRoot });
    const state = (await request(app).get(`/api/runs/${runId}`)).body;
    expect(state).toMatchObject({
      status: "abandoned",
      reportReady: true,
      testResults: { "E2E-001": { status: "passed" }, "E2E-002": { status: "abandoned" } },
      nodeTestResults: { "E2E-001": ["passed"], "E2E-002": ["abandoned"] },
    });
    expect(console.warn).toHaveBeenCalled();
    const events = await readFile(join(projectRoot, "reports", runId, "events.jsonl"), "utf8");
    expect(events).toContain('"seq":3');
    expect(events).toContain('"type":"run.abandoned"');
    expect(
      JSON.parse(await readFile(join(projectRoot, "runs/index.json"), "utf8")).runs[0].status,
    ).toBe("abandoned");

    const server = app.listen(0);
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Unable to bind server.");
    const controller = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/stream`, {
        headers: { "Last-Event-ID": "2" },
        signal: controller.signal,
      });
      const chunk = new TextDecoder().decode((await response.body!.getReader().read()).value);
      expect(chunk).toContain("id: 3");
      expect(chunk).toContain("run.abandoned");
    } finally {
      controller.abort();
      server.close();
    }
  });

  it("resets an active run cleanly when its event log is wholly corrupt", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await writeFile(join(projectRoot, "reports", runId, "events.jsonl"), "not-json\n");

    const state = (await request(createApp({ projectRoot })).get(`/api/runs/${runId}`)).body;

    expect(state.status).toBe("abandoned");
    expect(state.intendedNodeIds).toEqual(["E2E-001", "E2E-002"]);
  });
});
