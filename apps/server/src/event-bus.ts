import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Request, Response } from "express";
import { z } from "zod";
import { publishReport, type ReportManifest, type ReportRunState } from "./report.js";

const REPORTER_TYPES = new Set([
  "run.started",
  "test.started",
  "step.started",
  "step.finished",
  "test.passed",
  "test.failed",
  "test.skipped",
  "artifact.created",
  "run.finished",
]);

interface ReporterEvent {
  eventId: string;
  runId: string;
  type: string;
  timestamp: string;
  payload?: Record<string, unknown>;
}

interface StoredEvent extends ReporterEvent {
  seq: number;
  receivedAt: string;
}

type RunState = ReportRunState;

const finiteNumber = z.number().finite();
const testScope = { testId: z.string(), attemptId: z.string() };
const payloadSchemas: Record<string, z.ZodType> = {
  "run.started": z.object({
    totalTests: finiteNumber,
    suiteTag: z.string().nullable(),
    runType: z.enum(["full", "partial"]),
  }),
  "test.started": z.object({
    ...testScope,
    workerId: z.string(),
    attempt: finiteNumber,
    testFile: z.string(),
    testTitle: z.string(),
    testCaseHash: z.string(),
  }),
  "step.started": z.object({
    ...testScope,
    stepTitle: z.string(),
    stepIndex: finiteNumber,
    source: z.enum(["explicit", "auto"]),
  }),
  "step.finished": z.object({
    ...testScope,
    stepTitle: z.string(),
    stepIndex: finiteNumber,
    source: z.enum(["explicit", "auto"]),
  }),
  "test.passed": z.object({
    ...testScope,
    duration: finiteNumber,
    retryCount: finiteNumber,
    workerId: z.string(),
  }),
  "test.failed": z.object({
    ...testScope,
    duration: finiteNumber,
    error: z.string(),
    errorType: z.enum([
      "assertion_failure",
      "timeout",
      "setup_failure",
      "teardown_failure",
      "infra_failure",
      "test_skipped",
      "blocked",
      "run_abandoned",
      "unknown",
    ]),
    retryCount: finiteNumber,
    workerId: z.string(),
    isFinalAttempt: z.boolean(),
  }),
  "test.skipped": z.object({ ...testScope, reason: z.string().optional() }),
  "artifact.created": z.object({
    ...testScope,
    artifactType: z.enum(["screenshot", "trace"]),
    path: z.string().refine((path) => !path.includes("..")),
    attachmentIndex: finiteNumber,
  }),
  "run.finished": z.object({
    total: finiteNumber,
    passed: finiteNumber,
    failed: finiteNumber,
    skipped: finiteNumber,
    duration: finiteNumber,
    totalEventsSent: finiteNumber,
    droppedEventCount: finiteNumber,
    untaggedTestCount: finiteNumber,
    invalidTagCount: finiteNumber,
    unknownTagCount: finiteNumber,
  }),
};

function validPayload(type: string, payload: unknown) {
  return payloadSchemas[type]?.safeParse(payload).success === true;
}

function redactError(error: string) {
  return error
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}

export interface RunMetadata {
  environment?: string;
  branch?: string;
  pr?: string;
  commit?: string;
}

function blankState(
  runId: string,
  intendedNodeIds: string[],
  metadata: RunMetadata = {},
): RunState {
  return {
    runId,
    status: "running",
    ...metadata,
    testResults: {},
    nodeTestResults: {},
    intendedNodeIds,
    reportReady: false,
    reportPath: null,
    unknownTestIdCount: 0,
    unknownTagCount: 0,
    untaggedTestCount: 0,
    invalidTagCount: 0,
    duplicateEventCount: 0,
    invalidPayloadCount: 0,
    droppedEventCount: 0,
  };
}

export class EventBus {
  private activeRunId: string | null;
  private currentSeq = 1;
  private readonly eventIds = new Set<string>();
  private readonly buffer: StoredEvent[] = [];
  private readonly clients = new Set<Response>();
  private readonly nodeIds: Set<string>;
  private readonly manifest: ReportManifest;
  private state: RunState | null;

  constructor(
    private readonly projectRoot: string,
    activeRunId?: string,
  ) {
    this.activeRunId = activeRunId ?? null;
    let manifest: ReportManifest = { nodes: [] };
    try {
      manifest = JSON.parse(
        readFileSync(join(projectRoot, "pathlight-manifest.json"), "utf8"),
      ) as ReportManifest;
    } catch {
      // Event validation returns unknown IDs when a manifest is not available.
    }
    this.manifest = manifest;
    this.nodeIds = new Set(manifest.nodes.map((node) => node.id));
    this.state = this.activeRunId ? blankState(this.activeRunId, [...this.nodeIds]) : null;
    if (!activeRunId) {
      this.recoverActiveRun();
    }
  }

  get activeId() {
    return this.state?.status === "running" ? this.activeRunId : null;
  }

  getState(runId: string) {
    return this.state?.runId === runId ? this.state : null;
  }

  isRunning() {
    return this.state?.status === "running";
  }

  startRun(
    runId: string,
    intendedNodeIds: string[],
    blockedNodeIds: string[] = [],
    metadata: RunMetadata = {},
  ) {
    this.activeRunId = runId;
    this.currentSeq = 1;
    this.eventIds.clear();
    this.buffer.length = 0;
    this.nodeIds.clear();
    intendedNodeIds.forEach((nodeId) => this.nodeIds.add(nodeId));
    this.state = blankState(runId, intendedNodeIds, metadata);
    for (const nodeId of blockedNodeIds) {
      this.state.testResults[nodeId] = { status: "blocked" };
      this.state.nodeTestResults[nodeId] = ["blocked"];
    }
    this.updateRunIndex("running");
  }

  abandon(reason: "user_stopped" | "crash" | "timeout") {
    if (!this.activeRunId || !this.state || this.state.status !== "running") {
      return;
    }
    const completedTests = Object.values(this.state.testResults).filter((result) =>
      ["passed", "failed", "skipped", "blocked"].includes(result.status),
    ).length;
    const stored: StoredEvent = {
      eventId: `srv_${String(this.currentSeq).padStart(4, "0")}`,
      runId: this.activeRunId,
      type: "run.abandoned",
      timestamp: new Date().toISOString(),
      receivedAt: new Date().toISOString(),
      seq: this.currentSeq++,
      payload: { reason, completedTests },
    };
    this.store(stored);
    this.state.status = "abandoned";
    for (const nodeId of this.state.intendedNodeIds) {
      if (!this.state.testResults[nodeId]) {
        this.state.testResults[nodeId] = { status: "abandoned" };
        this.state.nodeTestResults[nodeId] = ["abandoned"];
      }
    }
    this.updateRunIndex("abandoned");
  }

  receive(input: unknown) {
    if (!input || typeof input !== "object") {
      return { status: 400, body: { error: "Invalid event." } };
    }
    const event = input as Partial<ReporterEvent>;
    if (
      typeof event.eventId !== "string" ||
      typeof event.runId !== "string" ||
      typeof event.type !== "string" ||
      typeof event.timestamp !== "string"
    ) {
      return { status: 400, body: { error: "Missing required event fields." } };
    }
    if (!REPORTER_TYPES.has(event.type)) {
      return { status: 400, body: { error: "Invalid event type." } };
    }
    if (!this.activeRunId || event.runId !== this.activeRunId || !this.state) {
      return { status: 400, body: { error: "Event runId does not match active run." } };
    }
    if (this.eventIds.has(event.eventId)) {
      this.state.duplicateEventCount += 1;
      return { status: 202, body: { received: false, reason: "duplicate" } };
    }
    const payload = event.payload as Record<string, unknown> | undefined;
    if (payload && typeof payload.testId === "string" && !this.nodeIds.has(payload.testId)) {
      this.state.unknownTestIdCount += 1;
      return { status: 202, body: { received: false, reason: "unknown testId" } };
    }
    if (!validPayload(event.type, event.payload)) {
      this.state.invalidPayloadCount += 1;
      return { status: 202, body: { received: false, reason: "invalid payload" } };
    }
    const storedPayload = { ...payload };
    if (typeof storedPayload.error === "string") {
      storedPayload.error = redactError(storedPayload.error);
    }
    const stored: StoredEvent = {
      eventId: event.eventId,
      runId: event.runId,
      type: event.type,
      timestamp: event.timestamp,
      payload: storedPayload,
      seq: this.currentSeq++,
      receivedAt: new Date().toISOString(),
    };
    this.store(stored);
    this.apply(stored, true);
    return { status: 202, body: { received: true } };
  }

  stream(request: Request, response: Response) {
    response.status(200);
    response.set({
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    });
    response.flushHeaders();
    const lastEventId = Number(request.header("Last-Event-ID"));
    if (Number.isFinite(lastEventId) && lastEventId > 0) {
      const replay = this.replayAfter(lastEventId);
      for (const event of replay) {
        response.write(this.format(event));
      }
    } else if (this.state) {
      response.write(`data: ${JSON.stringify({ type: "run.state", payload: this.state })}\n\n`);
    }
    this.clients.add(response);
    const heartbeat = setInterval(() => response.write(": heartbeat\n\n"), 15_000);
    heartbeat.unref();
    request.on("close", () => {
      clearInterval(heartbeat);
      this.clients.delete(response);
    });
  }

  private replayAfter(seq: number) {
    if (this.buffer.some((event) => event.seq === seq)) {
      return this.buffer.filter((event) => event.seq > seq);
    }
    const eventsPath = this.activeRunId
      ? join(this.projectRoot, "reports", this.activeRunId, "events.jsonl")
      : "";
    if (!eventsPath || !existsSync(eventsPath)) {
      return [];
    }
    return readFileSync(eventsPath, "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as StoredEvent)
      .filter((event) => event.seq > seq);
  }

  private format(event: StoredEvent) {
    return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
  }

  private store(event: StoredEvent) {
    const eventsPath = join(this.projectRoot, "reports", event.runId, "events.jsonl");
    mkdirSync(dirname(eventsPath), { recursive: true });
    appendFileSync(eventsPath, `${JSON.stringify(event)}\n`, "utf8");
    this.eventIds.add(event.eventId);
    this.buffer.push(event);
    if (this.buffer.length > 100) {
      this.buffer.shift();
    }
    const formatted = this.format(event);
    for (const client of this.clients) {
      client.write(formatted);
    }
  }

  private broadcastOnly(event: StoredEvent) {
    this.buffer.push(event);
    if (this.buffer.length > 100) {
      this.buffer.shift();
    }
    const formatted = this.format(event);
    for (const client of this.clients) {
      client.write(formatted);
    }
  }

  private recordFinalStatus(testId: string, status: "passed" | "failed" | "skipped") {
    if (!this.state) {
      return;
    }
    const raw = this.state.nodeTestResults[testId] ?? [];
    raw.push(status);
    this.state.nodeTestResults[testId] = raw;
    const aggregate = raw.includes("failed")
      ? "failed"
      : raw.includes("passed")
        ? "passed"
        : raw.every((result) => result === "blocked")
          ? "blocked"
          : raw.every((result) => result === "skipped")
            ? "skipped"
            : "untested";
    this.state.testResults[testId] = { status: aggregate };
  }

  private apply(event: StoredEvent, publish: boolean) {
    if (!this.state) {
      return;
    }
    const payload = event.payload as Record<string, unknown>;
    const testId = typeof payload.testId === "string" ? payload.testId : null;
    if (event.type === "test.started" && testId) {
      this.state.testResults[testId] = { status: "running" };
    } else if (event.type === "test.passed" && testId) {
      this.recordFinalStatus(testId, "passed");
    } else if (event.type === "test.failed" && testId && payload.isFinalAttempt === true) {
      this.recordFinalStatus(testId, "failed");
    } else if (event.type === "test.skipped" && testId) {
      this.recordFinalStatus(testId, "skipped");
    } else if (event.type === "run.finished") {
      this.state.status = "finished";
      this.state.droppedEventCount = Number(payload.droppedEventCount);
      this.state.untaggedTestCount = Number(payload.untaggedTestCount);
      this.state.invalidTagCount = Number(payload.invalidTagCount);
      this.state.unknownTagCount = Number(payload.unknownTagCount);
      if (publish) {
        try {
          const reportPath = publishReport(this.projectRoot, this.manifest, this.state, payload);
          this.state.reportReady = true;
          this.state.reportPath = reportPath;
          this.broadcastOnly({
            eventId: `srv_${String(this.currentSeq).padStart(4, "0")}`,
            runId: this.state.runId,
            type: "report.ready",
            timestamp: new Date().toISOString(),
            receivedAt: new Date().toISOString(),
            seq: this.currentSeq++,
            payload: { runId: this.state.runId, reportPath },
          });
        } catch (error) {
          console.error("[pathlight] Unable to publish report.", error);
        }
      }
    }
  }

  private updateRunIndex(status: RunState["status"]) {
    if (!this.activeRunId) {
      return;
    }
    const indexPath = join(this.projectRoot, "runs", "index.json");
    let index: { latest: string; runs: Array<Record<string, unknown>> } = {
      latest: this.activeRunId,
      runs: [],
    };
    try {
      index = JSON.parse(readFileSync(indexPath, "utf8")) as typeof index;
    } catch {
      // A first run creates the index.
    }
    const prior = index.runs.find((run) => run.runId === this.activeRunId);
    index.latest = this.activeRunId;
    index.runs = [
      { ...prior, runId: this.activeRunId, status },
      ...index.runs.filter((run) => run.runId !== this.activeRunId),
    ];
    mkdirSync(dirname(indexPath), { recursive: true });
    writeFileSync(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  }

  private recoverActiveRun() {
    let runId: string | undefined;
    try {
      const index = JSON.parse(
        readFileSync(join(this.projectRoot, "runs", "index.json"), "utf8"),
      ) as { latest?: string; runs?: Array<{ runId: string; status: string }> };
      const latest = index.runs?.find((run) => run.runId === index.latest);
      if (latest?.status === "running") {
        runId = latest.runId;
      }
    } catch {
      return;
    }
    if (!runId) {
      return;
    }
    this.activeRunId = runId;
    let intendedNodeIds = [...this.nodeIds];
    try {
      const summary = JSON.parse(
        readFileSync(join(this.projectRoot, "reports", runId, "summary.json"), "utf8"),
      ) as { intendedNodeIds?: string[] };
      intendedNodeIds = summary.intendedNodeIds ?? intendedNodeIds;
    } catch {
      // A missing initial summary falls back to all manifest nodes.
    }
    this.state = blankState(runId, intendedNodeIds);
    this.state.reportReady = existsSync(join(this.projectRoot, "reports", runId, "summary.json"));
    const eventsPath = join(this.projectRoot, "reports", runId, "events.jsonl");
    const events: StoredEvent[] = [];
    if (existsSync(eventsPath)) {
      const lines = readFileSync(eventsPath, "utf8").split("\n").filter(Boolean);
      for (const line of lines) {
        try {
          events.push(JSON.parse(line) as StoredEvent);
        } catch {
          console.warn(`[pathlight] Discarded corrupt event line while recovering ${runId}.`);
        }
      }
      writeFileSync(
        eventsPath,
        events.length > 0 ? `${events.map((event) => JSON.stringify(event)).join("\n")}\n` : "",
        "utf8",
      );
    }
    for (const event of events) {
      this.currentSeq = Math.max(this.currentSeq, event.seq + 1);
      this.eventIds.add(event.eventId);
      this.buffer.push(event);
      this.apply(event, false);
    }
    const terminal = events.some(({ type }) => type === "run.finished" || type === "run.abandoned");
    if (!terminal) {
      this.abandon("crash");
    }
  }
}
