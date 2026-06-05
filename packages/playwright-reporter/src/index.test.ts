import { describe, expect, it, vi } from "vitest";
import PathlightReporter from "./index.js";

const suite = (tests: Array<Record<string, unknown>>) => ({
  allTests: () => tests,
});

function testCase(title: string) {
  return {
    title,
    location: { file: "e2e/review.spec.ts" },
    titlePath: () => [title],
  };
}

describe("US-P009 to US-P011 Pathlight Playwright reporter", () => {
  it("emits run lifecycle events with delivery accounting", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const reporter = new PathlightReporter({
      runId: "run-001",
      serverUrl: "http://127.0.0.1:4242",
      manifestNodeIds: ["E2E-001"],
      fetch: vi.fn(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 202 });
      }) as typeof fetch,
    });

    await reporter.onBegin({ grep: null } as never, suite([testCase("[E2E-001] sends")]) as never);
    await reporter.onEnd({ status: "passed", duration: 24 } as never);

    expect(sent.map((item) => item.type)).toEqual(["run.started", "run.finished"]);
    expect(sent[0].payload).toMatchObject({ totalTests: 1, suiteTag: null, runType: "full" });
    expect(sent[1].payload).toMatchObject({ totalEventsSent: 2, droppedEventCount: 0 });
  });

  it("posts run.started before run.finished even when manifest loading is slow", async () => {
    const sent: Array<Record<string, unknown>> = [];
    let releaseManifest!: () => void;
    const manifestReady = new Promise<void>((resolve) => {
      releaseManifest = resolve;
    });
    const reporter = new PathlightReporter({
      runId: "run-001",
      serverUrl: "http://127.0.0.1:4242",
      fetch: vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/manifest")) {
          await manifestReady;
          return new Response(JSON.stringify({ nodes: [{ id: "E2E-001" }] }), { status: 200 });
        }
        sent.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 202 });
      }) as typeof fetch,
    });

    const begin = reporter.onBegin(
      { grep: null } as never,
      suite([testCase("[E2E-001] sends")]) as never,
    );
    await reporter.onEnd({ status: "passed", duration: 24 } as never);
    releaseManifest();
    await begin;

    expect(sent.map((item) => item.type)).toEqual(["run.started", "run.finished"]);
    expect(sent[0].payload).toMatchObject({ totalTests: 1 });
    expect(sent[1].payload).toMatchObject({ total: 1 });
  });

  it("does not emit events without PATHLIGHT_RUN_ID and never throws on network failures", async () => {
    const warn = vi.fn();
    const missingFetch = vi.fn<typeof fetch>();
    const missing = new PathlightReporter({
      serverUrl: "http://127.0.0.1:4242",
      manifestNodeIds: ["E2E-001"],
      fetch: missingFetch,
      stderr: warn,
    });
    await expect(
      missing.onBegin({ grep: null } as never, suite([testCase("[E2E-001] sends")]) as never),
    ).resolves.toBeUndefined();
    expect(missingFetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalled();

    const unavailable = new PathlightReporter({
      runId: "run-001",
      serverUrl: "http://127.0.0.1:4242",
      manifestNodeIds: ["E2E-001"],
      fetch: vi.fn().mockRejectedValue(new Error("offline")) as typeof fetch,
      stderr: warn,
    });
    await expect(
      unavailable.onBegin({ grep: null } as never, suite([testCase("[E2E-001] sends")]) as never),
    ).resolves.toBeUndefined();
    await expect(
      unavailable.onEnd({ status: "failed", duration: 10 } as never),
    ).resolves.toBeUndefined();
  });

  it("uses approved semantic mapping as fallback when test title has no bracket ID", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const untaggedTest = testCase("SMS gateway times out");
    const reporter = new PathlightReporter({
      runId: "run-001",
      serverUrl: "http://127.0.0.1:4242",
      manifestNodeIds: ["E2E-007"],
      fetch: vi.fn(async (url, init) => {
        if (String(url).endsWith("/api/mapping")) {
          return new Response(
            JSON.stringify({
              mappings: [
                {
                  journeyId: "E2E-007",
                  matchedTests: [{ testTitle: "SMS gateway times out", approved: true }],
                },
              ],
            }),
            { status: 200 },
          );
        }
        if (init) sent.push(JSON.parse(String(init.body)));
        return new Response("", { status: 202 });
      }) as typeof fetch,
    });

    await reporter.onBegin({ grep: null } as never, suite([untaggedTest]) as never);
    await new Promise((r) => setTimeout(r, 20)); // let loadSemanticMapping complete
    const result = { workerIndex: 0, retry: 0, status: "passed", duration: 10 };
    await reporter.onTestBegin(untaggedTest as never, result as never);
    await reporter.onTestEnd(untaggedTest as never, result as never);
    await reporter.onEnd({ status: "passed", duration: 10 } as never);

    const testStarted = sent.find((item) => item.type === "test.started");
    expect(testStarted?.payload).toMatchObject({ testId: "E2E-007" });
    const finished = sent.find((item) => item.type === "run.finished");
    expect((finished?.payload as { untaggedTestCount: number }).untaggedTestCount).toBe(0);
  });

  it("matches the first bracketed journey ID and reports unmatched title health counts", async () => {
    const sent: Array<Record<string, unknown>> = [];
    const valid = testCase("[E2E-001] submits [E2E-999]");
    const untagged = testCase("Admin can view waitlist");
    const unknown = testCase("[E2E-999] absent");
    const reporter = new PathlightReporter({
      runId: "run-001",
      serverUrl: "http://127.0.0.1:4242",
      manifestNodeIds: ["E2E-001"],
      fetch: vi.fn(async (_url, init) => {
        sent.push(JSON.parse(String(init?.body)));
        return new Response("", { status: 202 });
      }) as typeof fetch,
    });
    await reporter.onBegin({ grep: /smoke/ } as never, suite([valid, untagged, unknown]) as never);
    const result = { workerIndex: 2, retry: 0, status: "passed", duration: 50 };
    await reporter.onTestBegin(valid as never, result as never);
    await reporter.onTestBegin(untagged as never, result as never);
    await reporter.onTestBegin(unknown as never, result as never);
    const explicitStep = {
      title: "enter phone",
      category: "test.step",
    };
    const autoStep = {
      title: "click button",
      category: "pw:api",
    };
    await reporter.onStepBegin(valid as never, result as never, explicitStep as never);
    await reporter.onStepEnd(valid as never, result as never, explicitStep as never);
    await reporter.onStepBegin(valid as never, result as never, autoStep as never);
    await reporter.onStepEnd(valid as never, result as never, autoStep as never);
    await reporter.onTestEnd(valid as never, result as never);
    await reporter.onEnd({ status: "passed", duration: 50 } as never);

    expect(sent[0].payload).toMatchObject({ suiteTag: "/smoke/", runType: "partial" });
    const testStarted = sent.find((item) => item.type === "test.started");
    expect(testStarted?.payload).toMatchObject({ testId: "E2E-001", workerId: "2", attempt: 0 });
    expect(String((testStarted?.payload as { attemptId: string }).attemptId)).toMatch(
      /^E2E-001_[a-f0-9]{8}_run-001_att_0$/,
    );
    expect(sent.filter((item) => item.type === "step.started")[0].payload).toMatchObject({
      source: "explicit",
      stepIndex: 0,
    });
    expect(sent.filter((item) => item.type === "step.finished")[0].payload).toMatchObject({
      source: "explicit",
      stepIndex: 0,
    });
    expect(sent.filter((item) => item.type === "step.finished")[1].payload).toMatchObject({
      source: "auto",
      stepIndex: 1,
    });
    expect(sent.find((item) => item.type === "run.finished")?.payload).toMatchObject({
      untaggedTestCount: 1,
      invalidTagCount: 0,
      unknownTagCount: 1,
    });
  });
});
