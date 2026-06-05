// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

type LaunchRun = NonNullable<Parameters<typeof createApp>[0]["launchRun"]>;
type LaunchRunOptions = Parameters<LaunchRun>[0];
type RunningChild = ReturnType<LaunchRun>;

describe("US-P012 to US-P014 run execution", () => {
  let projectRoot: string;
  let targetProjectRoot: string;
  let bundledReporterPath: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-runs-"));
    targetProjectRoot = join(projectRoot, "application-under-test");
    await mkdir(join(targetProjectRoot, "config"), { recursive: true });
    await writeFile(join(targetProjectRoot, "config/playwright.qa.ts"), "export default {};");
    bundledReporterPath = join(
      projectRoot,
      "packages/playwright-reporter/dist/bundled-reporter.js",
    );
    await mkdir(dirname(bundledReporterPath), { recursive: true });
    await writeFile(bundledReporterPath, "export default class PathlightReporter {}");
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: targetProjectRoot,
        playwrightConfigPath: "config/playwright.qa.ts",
      }),
    );
    await writeFile(
      join(projectRoot, "pathlight-manifest.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        projectKey: "PL",
        lockedAt: "2026-05-27T00:00:00.000Z",
        lockedBy: "dev@example.com",
        businessRules: [],
        nodes: [
          { id: "E2E-001", tags: ["@smoke"], testFiles: ["e2e/review.spec.ts"] },
          { id: "E2E-002", tags: [], testFiles: [] },
          { id: "E2E-OLD", deprecated: true, tags: ["@smoke"], testFiles: [] },
        ],
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("starts a full run from a locked manifest and launches allowlisted Playwright", async () => {
    const originalReuseServer = process.env.PLAYWRIGHT_REUSE_SERVER;
    delete process.env.PLAYWRIGHT_REUSE_SERVER;
    let launchedEnv: NodeJS.ProcessEnv | undefined;
    const launch = vi.fn((options: LaunchRunOptions): RunningChild => {
      launchedEnv = options.env;
      return { kill: vi.fn(), on: vi.fn(), pid: 1234 };
    });
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });

    try {
      const response = await request(app).post("/api/runs").send({ runId: "run_20260527_001" });

      expect(response.status).toBe(201);
      expect(response.body).toEqual({
        runId: "run_20260527_001",
        intendedNodeIds: ["E2E-001", "E2E-002"],
      });
      expect(launch).toHaveBeenCalledWith(
        expect.objectContaining({
          command: "npx",
          args: [
            "playwright",
            "test",
            `--reporter=list,${bundledReporterPath}`,
            "--config",
            "config/playwright.qa.ts",
          ],
          cwd: targetProjectRoot,
          env: expect.objectContaining({
            PATHLIGHT_MANIFEST_NODE_IDS: JSON.stringify(["E2E-001", "E2E-002"]),
            PATHLIGHT_RUN_ID: "run_20260527_001",
            PATHLIGHT_SERVER_URL: "http://127.0.0.1:4242",
          }),
        }),
      );
      expect(launchedEnv?.PLAYWRIGHT_REUSE_SERVER).toBeUndefined();
      const summary = JSON.parse(
        await readFile(join(projectRoot, "reports/run_20260527_001/summary.json"), "utf8"),
      );
      expect(summary.intendedNodeIds).toEqual(["E2E-001", "E2E-002"]);
    } finally {
      if (originalReuseServer === undefined) {
        delete process.env.PLAYWRIGHT_REUSE_SERVER;
      } else {
        process.env.PLAYWRIGHT_REUSE_SERVER = originalReuseServer;
      }
    }
  });

  it("rejects a run until the target project location is configured", async () => {
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );

    const response = await request(createApp({ projectRoot, bundledReporterPath }))
      .post("/api/runs")
      .send({});

    expect(response.status).toBe(400);
    expect(response.body.error).toBe("Configure your project location before starting a run");
  });

  it("rejects a run when the configured project or Playwright configuration is unavailable", async () => {
    const unavailableDirectory = join(projectRoot, "removed-project");
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: unavailableDirectory,
        playwrightConfigPath: "playwright.config.ts",
      }),
    );

    const missingProject = await request(createApp({ projectRoot, bundledReporterPath }))
      .post("/api/runs")
      .send({});
    expect(missingProject.status).toBe(400);
    expect(missingProject.body.error).toBe("Configure your project location before starting a run");

    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "ZovKu", key: "ZOVK" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: targetProjectRoot,
      }),
    );
    const missingConfig = await request(createApp({ projectRoot, bundledReporterPath }))
      .post("/api/runs")
      .send({});
    expect(missingConfig.status).toBe(400);
    expect(missingConfig.body.error).toBe("playwright.config.ts not found");
  });

  it("filters tagged runs and rejects unlocked or concurrent runs", async () => {
    const launch = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: 1234 }));
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });
    const started = await request(app)
      .post("/api/runs")
      .send({ runId: "run_20260527_001", suiteTag: "@smoke" });
    expect(started.body.intendedNodeIds).toEqual(["E2E-001"]);

    const concurrent = await request(app).post("/api/runs").send({});
    expect(concurrent.status).toBe(409);
    expect(concurrent.body.activeRunId).toBe("run_20260527_001");

    const unlockedRoot = await mkdtemp(join(tmpdir(), "pathlight-unlocked-"));
    try {
      await writeFile(
        join(unlockedRoot, "pathlight-manifest.json"),
        JSON.stringify({ schemaVersion: "1.0", lockedAt: null, nodes: [] }),
      );
      const rejected = await request(
        createApp({ projectRoot: unlockedRoot, bundledReporterPath, launchRun: launch }),
      )
        .post("/api/runs")
        .send({});
      expect(rejected.status).toBe(400);
      expect(rejected.body.error).toBe("Lock the manifest before starting a run");
    } finally {
      await rm(unlockedRoot, { recursive: true, force: true });
    }
  });

  it("accepts nodeIds to set intendedNodeIds exactly, ignoring suiteTag", async () => {
    const launch = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: 1234 }));
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });

    const response = await request(app)
      .post("/api/runs")
      .send({ runId: "run_nodeid", nodeIds: ["E2E-001"] });

    expect(response.status).toBe(201);
    expect(response.body.intendedNodeIds).toEqual(["E2E-001"]);
    const summary = JSON.parse(
      await readFile(join(projectRoot, "reports/run_nodeid/summary.json"), "utf8"),
    );
    expect(summary.intendedNodeIds).toEqual(["E2E-001"]);
  });

  it("stops an active run, terminates the child and persists abandonment", async () => {
    const kill = vi.fn(() => true);
    const launch = vi.fn(() => ({ kill, on: vi.fn(), pid: 1234 }));
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });
    await request(app).post("/api/runs").send({ runId: "run_20260527_001" });

    const stopped = await request(app).delete("/api/runs/run_20260527_001");
    expect(stopped.status).toBe(202);
    expect(stopped.body).toEqual({ status: "stopping" });
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    const events = await readFile(
      join(projectRoot, "reports/run_20260527_001/events.jsonl"),
      "utf8",
    );
    expect(events).toContain('"type":"run.abandoned"');
    expect(events).toContain('"reason":"user_stopped"');
    const state = await request(app).get("/api/runs/run_20260527_001");
    expect(state.body.status).toBe("abandoned");
  });

  it("captures Playwright process output for run diagnostics", async () => {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const app = createApp({
      projectRoot,
      bundledReporterPath,
      launchRun: vi.fn(() => ({
        kill: vi.fn(),
        on: vi.fn(),
        stdout,
        stderr,
      })),
    });

    const response = await request(app).post("/api/runs").send({ runId: "run_output" });
    expect(response.status).toBe(201);

    stdout.emit("data", Buffer.from("running tests\n"));
    stderr.emit("data", Buffer.from("global setup failed\n"));

    await vi.waitFor(async () => {
      await expect(
        readFile(join(projectRoot, "reports/run_output/output.log"), "utf8"),
      ).resolves.toContain("global setup failed");
    });

    await expect((await request(app).get("/api/runs/run_output/output")).text).toContain(
      "global setup failed",
    );
  });

  it("reruns only failed nodes with an anchored, escaped grep expression", async () => {
    const launch = vi.fn(() => ({ kill: vi.fn(), on: vi.fn(), pid: 1234 }));
    const app = createApp({ projectRoot, bundledReporterPath, launchRun: launch });
    await request(app).post("/api/runs").send({ runId: "run_original" });
    await request(app)
      .post("/api/events")
      .send({
        eventId: "evt_0001",
        runId: "run_original",
        type: "test.failed",
        timestamp: "2026-05-27T00:00:00.000Z",
        payload: {
          testId: "E2E-001",
          attemptId: "attempt",
          duration: 1,
          error: "failure",
          errorType: "assertion_failure",
          retryCount: 0,
          workerId: "worker",
          isFinalAttempt: true,
        },
      });
    await request(app)
      .post("/api/events")
      .send({
        eventId: "evt_0002",
        runId: "run_original",
        type: "run.finished",
        timestamp: "2026-05-27T00:00:00.000Z",
        payload: {
          total: 1,
          passed: 0,
          failed: 1,
          skipped: 0,
          duration: 1,
          totalEventsSent: 2,
          droppedEventCount: 0,
          untaggedTestCount: 0,
          invalidTagCount: 0,
          unknownTagCount: 0,
        },
      });

    const rerun = await request(app)
      .post("/api/runs/run_original/rerun")
      .send({ failedOnly: true });

    expect(rerun.status).toBe(201);
    expect(rerun.body.intendedNodeIds).toEqual(["E2E-001"]);
    expect(launch).toHaveBeenLastCalledWith(
      expect.objectContaining({
        args: [
          "playwright",
          "test",
          `--reporter=list,${bundledReporterPath}`,
          "--config",
          "config/playwright.qa.ts",
          "--grep",
          "\\[(E2E-001)\\]",
        ],
        cwd: targetProjectRoot,
      }),
    );
  });
});
