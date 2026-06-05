// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { runGate, type GateOptions } from "./index.js";

const BASE: GateOptions = {
  serverUrl: "http://127.0.0.1:4242",
  noCriticalFailures: false,
  noHighestFailures: true,
};

function mockFetch(latestRun: unknown, manifest?: unknown) {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockImplementation((url: string) => {
      if (url.includes("/api/runs/latest")) {
        return Promise.resolve({
          ok: true,
          json: async () => latestRun,
        });
      }
      if (url.includes("/api/manifest")) {
        return Promise.resolve({
          ok: manifest !== undefined,
          json: async () => manifest ?? {},
        });
      }
      return Promise.resolve({ ok: false, json: async () => ({}) });
    }),
  );
}

describe("US-V6-002 pathlight gate command", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("passes when all journeys pass", async () => {
    mockFetch(
      {
        runId: "run_001",
        status: "finished",
        intendedNodeIds: ["E2E-001", "E2E-002"],
        testResults: { "E2E-001": { status: "passed" }, "E2E-002": { status: "passed" } },
      },
      {
        nodes: [
          { id: "E2E-001", priority: "Highest" },
          { id: "E2E-002", priority: "High" },
        ],
      },
    );
    const result = await runGate(BASE);
    expect(result.passed).toBe(true);
    expect(result.reasons).toHaveLength(0);
    expect(result.passRate).toBe(100);
  });

  it("fails when a Highest priority journey fails (default gate)", async () => {
    mockFetch(
      {
        runId: "run_001",
        status: "finished",
        intendedNodeIds: ["E2E-001", "E2E-002"],
        testResults: { "E2E-001": { status: "failed" }, "E2E-002": { status: "passed" } },
      },
      {
        nodes: [
          { id: "E2E-001", priority: "Highest" },
          { id: "E2E-002", priority: "High" },
        ],
      },
    );
    const result = await runGate(BASE);
    expect(result.passed).toBe(false);
    expect(result.highestFailures).toContain("E2E-001");
    expect(result.reasons[0]).toMatch(/Highest priority/);
  });

  it("fails when pass rate is below --min-pass-rate", async () => {
    mockFetch({
      runId: "run_001",
      status: "finished",
      intendedNodeIds: ["E2E-001", "E2E-002", "E2E-003"],
      testResults: {
        "E2E-001": { status: "passed" },
        "E2E-002": { status: "failed" },
        "E2E-003": { status: "failed" },
      },
    });
    const result = await runGate({ ...BASE, minPassRate: 80, noHighestFailures: false });
    expect(result.passed).toBe(false);
    expect(result.passRate).toBeCloseTo(33.3, 0);
    expect(result.reasons[0]).toMatch(/Pass rate/);
  });

  it("fails on critical business rule failures with --no-critical-failures", async () => {
    mockFetch(
      {
        runId: "run_001",
        status: "finished",
        intendedNodeIds: ["E2E-001"],
        testResults: { "E2E-001": { status: "failed" } },
      },
      {
        nodes: [{ id: "E2E-001", priority: "Medium", businessRuleIds: ["BR-CRIT"] }],
        businessRules: [{ id: "BR-CRIT", severity: "critical" }],
      },
    );
    const result = await runGate({
      ...BASE,
      noCriticalFailures: true,
      noHighestFailures: false,
    });
    expect(result.passed).toBe(false);
    expect(result.criticalRuleFailures).toContain("BR-CRIT");
  });

  it("throws when server is not running", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("ECONNREFUSED")));
    await expect(runGate(BASE)).rejects.toThrow(/server not running/);
  });

  it("throws when no completed runs exist", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: "No runs found." }) }),
    );
    await expect(runGate(BASE)).rejects.toThrow(/No completed runs/);
  });

  it("fails when an intended journey covering a critical rule is untested (FIX 1.5)", async () => {
    mockFetch(
      {
        runId: "run_001",
        status: "finished",
        intendedNodeIds: ["E2E-001", "E2E-002"],
        testResults: {
          "E2E-001": { status: "passed" },
          "E2E-002": { status: "untested" },
        },
      },
      {
        nodes: [
          { id: "E2E-001", businessRuleIds: [] },
          { id: "E2E-002", businessRuleIds: ["BR-CRIT"] },
        ],
        businessRules: [{ id: "BR-CRIT", severity: "critical" }],
      },
    );
    const result = await runGate({ ...BASE, noHighestFailures: false });
    expect(result.passed).toBe(false);
    expect(result.reasons.some((r) => r.includes("untested"))).toBe(true);
  });
});
