import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FishbonePage } from "./FishbonePage";

const manifest = {
  schemaVersion: "1.0",
  projectKey: "PL",
  lockedAt: "2026-05-27T00:00:00.000Z",
  lockedBy: "dev@example.com",
  businessRules: [{ id: "BR-H", label: "Consent required", severity: "high" }],
  nodes: [
    {
      id: "E2E-001",
      stage: "S2",
      stageName: "Core SMS Review Flow",
      priority: "P0",
      priorityRank: 99,
      label: "Owner submits request",
      risk: "critical",
      tags: [],
      businessRuleIds: ["BR-H"],
    },
    {
      id: "E2E-002",
      stage: "S2",
      stageName: "Core SMS Review Flow",
      priority: "High",
      priorityRank: 1,
      label: "Reviewer rejects",
      risk: "high",
      tags: [],
    },
    {
      id: "E2E-003",
      stage: "S3",
      stageName: "Review Decision",
      priority: "Medium",
      priorityRank: 3,
      label: "Notify owner",
      risk: "medium",
      tags: [],
    },
  ],
};

const response = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));
const textResponse = (body: string, status = 200) =>
  Promise.resolve(new Response(body, { status }));

class StubEventSource {
  static last: StubEventSource;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  close = vi.fn();

  constructor(public readonly url: string) {
    StubEventSource.last = this;
  }

  emit(data: unknown) {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent<string>);
  }
}

describe("US-P013 and US-P015 to US-P019 fishbone renderer", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("EventSource", StubEventSource);
  });

  it("renders stage navigation and priority-sorted fishbones from the manifest", async () => {
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(response({ runId: "run-rerun", intendedNodeIds: ["E2E-001"] }, 201));
    const { container } = render(<FishbonePage />);

    expect(await screen.findByText("Core SMS Review Flow")).toBeVisible();
    expect(screen.getByRole("button", { name: "S2" })).toHaveAttribute("aria-current", "true");
    expect(screen.getByRole("button", { name: "S3" })).toBeVisible();
    expect(screen.getByText("2 journeys")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("button", { name: "Hide stages" }));
    expect(screen.queryByRole("navigation", { name: "Stages" })).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByRole("button", { name: "Show stages" }));
    const priorities = screen.getAllByTestId("priority-label").map((item) => item.textContent);
    expect(priorities).toEqual(["P0", "High"]);
    expect(container.querySelectorAll(".spine-origin")).toHaveLength(2);
    expect(screen.queryByRole("button", { name: "E2E-001: Owner submits request" })).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "S3" }));
    expect(container.querySelectorAll(".spine-origin")).toHaveLength(1);
    expect(screen.queryByText("Owner submits request")).not.toBeInTheDocument();
  });

  it("starts and stops a run, applying live branch states, counters and commentary", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(
        response({ runId: "run-001", intendedNodeIds: ["E2E-001", "E2E-002"] }, 201),
      )
      .mockReturnValueOnce(response({ status: "stopping" }, 202));
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    await user.click(screen.getByRole("button", { name: "Start run" }));
    expect(await screen.findByRole("button", { name: "Stop run" })).toBeVisible();
    expect(
      screen.queryByText("Run started - watching mapped journey IDs."),
    ).not.toBeInTheDocument();
    StubEventSource.last.emit({
      type: "test.started",
      payload: { testId: "E2E-001" },
    });
    expect(await screen.findByTestId("status-E2E-001")).toHaveAttribute("data-status", "running");
    expect(await screen.findByText("Started E2E-001 - Owner submits request")).toBeVisible();
    StubEventSource.last.emit({
      type: "step.started",
      payload: { testId: "E2E-001", stepTitle: "Open review form", source: "explicit" },
    });
    StubEventSource.last.emit({
      type: "step.started",
      payload: { testId: "E2E-001", stepTitle: "locator.click", source: "auto" },
    });
    expect(screen.queryByText("locator.click")).not.toBeInTheDocument();
    StubEventSource.last.emit({
      type: "test.passed",
      payload: { testId: "E2E-001" },
    });
    expect(await screen.findByText("Pass 1")).toBeVisible();
    expect(screen.getByText("Passed E2E-001 - Owner submits request")).toBeVisible();
    StubEventSource.last.emit({
      type: "test.failed",
      payload: { testId: "E2E-002", isFinalAttempt: true, errorType: "timeout" },
    });
    expect(await screen.findByText("Fail 1")).toBeVisible();
    expect(screen.getByText("Failed (timeout) E2E-002 - Reviewer rejects")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Stop run" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith("/api/runs/run-001", { method: "DELETE" }),
    );
  });

  it("turns a zero-event run into actionable commentary instead of lifecycle noise", async () => {
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(
        textResponse(
          "[stdout] Error: http://localhost:3001/api/v1/health is already used, make sure that nothing is running on the port/url or set reuseExistingServer:true in config.webServer.",
        ),
      );
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    act(() => {
      StubEventSource.last.emit({
        type: "run.finished",
        payload: { runId: "run-empty", total: 0, passed: 0, failed: 0 },
      });
      StubEventSource.last.emit({
        type: "report.ready",
        payload: { runId: "run-empty", reportPath: "reports/run-empty/report.html" },
      });
    });

    expect(
      screen.getByText(
        "Run run-empty finished, but no mapped Playwright tests reported back. Open the report and check Playwright output/test IDs.",
      ),
    ).toBeVisible();
    expect(
      await screen.findByText(
        "Playwright could not start the target app because http://localhost:3001/api/v1/health is already in use. Stop the app servers on those ports, then start the run again.",
      ),
    ).toBeVisible();
    expect(screen.queryByText("Report ready - open it from the top bar.")).not.toBeInTheDocument();
    expect(screen.getByRole("link", { name: "View report" })).toBeVisible();
  });

  it("explains when Playwright ran tests that did not contain journey IDs", async () => {
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(
        textResponse(
          "[stdout] Running 153 tests using 1 worker\n[stdout] ✓ tests/e2e/tests/landing/waitlist.spec.js › Landing page — waitlist form",
        ),
      );
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    act(() => {
      StubEventSource.last.emit({
        type: "run.finished",
        payload: { runId: "run-unmapped", total: 0, passed: 0, failed: 0 },
      });
    });

    expect(
      await screen.findByText(
        "Playwright ran 153 tests, but none matched Pathlight journey IDs. Add bracketed IDs like [E2E-001] to Playwright test titles, then rerun.",
      ),
    ).toBeVisible();
  });

  it("surfaces start-run configuration errors beside the run controls", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(
        response({ error: "Configure your project location before starting a run" }, 400),
      );
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    await user.click(screen.getByRole("button", { name: "Start run" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("Configure your project location before starting a run");
    expect(alert).toHaveTextContent("Open Config");
  });

  it("opens branch evidence and shows the report link once the server publishes it", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }))
      .mockReturnValueOnce(response({ bugKey: null, status: null })) // bug status on selectNode
      .mockReturnValueOnce(response({ config: {} }));
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");
    expect(screen.queryByText("Owner submits request")).not.toBeInTheDocument();
    act(() => {
      StubEventSource.last.emit({
        type: "test.started",
        payload: { testId: "E2E-001" },
      });
    });
    const branch = await screen.findByRole("button", { name: "E2E-001: Owner submits request" });
    await user.hover(branch);
    expect(await screen.findByRole("tooltip")).toHaveTextContent("Owner submits request");
    await user.click(screen.getByRole("button", { name: "Owner submits request" }));
    expect(screen.getByRole("heading", { name: "E2E-001" })).toBeVisible();
    expect(screen.getAllByText("Owner submits request").length).toBeGreaterThan(0);
    expect(screen.queryByRole("navigation", { name: "Stages" })).not.toBeInTheDocument();
    expect(screen.getByText("Consent required (high)")).toBeVisible();

    act(() => {
      StubEventSource.last.emit({
        type: "step.started",
        payload: { testId: "E2E-001", stepTitle: "Fill phone", source: "explicit" },
      });
      StubEventSource.last.emit({
        type: "test.failed",
        payload: {
          testId: "E2E-001",
          isFinalAttempt: true,
          errorType: "timeout",
          error: "Review button did not appear",
          retryCount: 1,
        },
      });
      StubEventSource.last.emit({
        type: "artifact.created",
        payload: { testId: "E2E-001", artifactType: "screenshot", path: "artifacts/failure.png" },
      });
    });
    expect(screen.getByText("Error type: timeout")).toBeVisible();
    expect(screen.getByText("Review button did not appear")).toBeVisible();
    expect(screen.getByText("Retry count: 1")).toBeVisible();
    expect(screen.getByText("Fill phone")).toBeVisible();
    expect(screen.getByText("Failed here")).toBeVisible();
    expect(screen.getByRole("link", { name: "screenshot" })).toHaveAttribute(
      "href",
      "artifacts/failure.png",
    );
    expect(screen.getByRole("button", { name: "Rerun branch" })).toBeVisible();

    StubEventSource.last.emit({
      type: "report.ready",
      payload: { runId: "run-001", reportPath: "reports/run-001/report.html" },
    });
    expect(await screen.findByRole("link", { name: "View report" })).toHaveAttribute(
      "href",
      "/reports/run-001/report.html",
    );
    await user.click(screen.getByRole("button", { name: "Rerun branch" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/runs/run-001/rerun",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("restores live state on reconnect, resets counters on a new run and follows the active stage", async () => {
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }));
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    act(() => {
      StubEventSource.last.emit({
        type: "run.state",
        payload: {
          runId: "run-old",
          status: "running",
          testResults: { "E2E-001": { status: "passed" }, "E2E-003": { status: "failed" } },
        },
      });
    });
    expect(screen.getByText("Pass 1")).toBeVisible();
    expect(screen.getByText("Fail 1")).toBeVisible();
    act(() => {
      StubEventSource.last.emit({
        type: "run.state",
        payload: {
          runId: "run-old",
          status: "finished",
          testResults: { "E2E-001": { status: "passed" }, "E2E-002": { status: "failed" } },
        },
      });
    });
    expect(screen.getByRole("img", { name: "P0 fishbone" })).toHaveClass("spine-passed");
    expect(screen.getByRole("img", { name: "High fishbone" })).toHaveClass("spine-failed");

    act(() => {
      StubEventSource.last.emit({ type: "run.started", payload: {} });
      StubEventSource.last.emit({ type: "test.started", payload: { testId: "E2E-003" } });
    });
    expect(screen.getByText("Pass 0")).toBeVisible();
    expect(screen.getByText("Fail 0")).toBeVisible();
    expect(screen.getByRole("button", { name: "S3" })).toHaveAttribute("aria-current", "true");
  });

  it("keeps at most 500 journey-level commentary lines and adds a final run summary", async () => {
    fetchMock
      .mockReturnValueOnce(response(manifest))
      .mockReturnValueOnce(response({ derivedAt: null, mappings: [], unmappedJourneys: [] }));
    render(<FishbonePage />);
    await screen.findByText("Core SMS Review Flow");

    act(() => {
      for (let index = 0; index < 501; index += 1) {
        StubEventSource.last.emit({
          type: "test.started",
          payload: { testId: "E2E-001" },
        });
      }
      StubEventSource.last.emit({
        type: "run.finished",
        payload: { runId: "run-001", passed: 2, failed: 1 },
      });
    });
    expect(screen.queryAllByText("Started E2E-001 - Owner submits request")).toHaveLength(499);
    expect(screen.getByText("Run run-001 complete - 2 passed, 1 failed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Resize commentary" })).toBeVisible();
  });
});
