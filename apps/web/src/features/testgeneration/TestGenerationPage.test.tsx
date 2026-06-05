import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { TestGenerationPage } from "./TestGenerationPage";

const response = (body: unknown, status = 200) =>
  Promise.resolve(new Response(JSON.stringify(body), { status }));

const MOCK_TEST_META = {
  journeyId: "E2E-007",
  journeyLabel: "SMS gateway times out",
  status: "pending",
  filePath: "/tests/e2e/generated/E2E-007.spec.ts",
  qualityChecks: { hasJourneyId: true, hasExpect: true, passed: true },
  styleScore: "High",
  generatedAt: "2026-05-29T10:00:00.000Z",
  approvedAt: null,
};

const MOCK_TEST_FULL = {
  ...MOCK_TEST_META,
  content:
    "import { test, expect } from '@playwright/test';\n\ntest('[E2E-007] SMS gateway times out', async ({ page }) => {\n  expect(page).toBeTruthy();\n});\n",
};

describe("US-V4-001 to US-V4-005 TestGenerationPage", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal("fetch", fetchMock);
    // Reset to list view
    window.history.replaceState({}, "", "/test-generation");
  });

  it("shows empty state and batch form when no tests generated yet", async () => {
    fetchMock.mockReturnValueOnce(response({ tests: [] }));
    render(<TestGenerationPage />);
    expect(await screen.findByText(/No generated tests yet/)).toBeVisible();
    expect(screen.getByText("Batch generate")).toBeVisible();
  });

  it("shows list of pending generated tests with Review links", async () => {
    fetchMock.mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }));
    render(<TestGenerationPage />);
    expect(await screen.findByText("Pending review (1)")).toBeVisible();
    expect(screen.getByText("SMS gateway times out")).toBeVisible();
    expect(screen.getByRole("link", { name: "Review" })).toHaveAttribute(
      "href",
      "/test-generation?journeyId=E2E-007",
    );
  });

  it("shows generate form when journeyId param provided and test not yet generated", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    fetchMock
      .mockReturnValueOnce(response({ tests: [] }))
      .mockReturnValueOnce(response({ error: "Not found" }, 404));
    render(<TestGenerationPage />);
    expect(await screen.findByText("Generate Playwright test")).toBeVisible();
    expect(screen.getByRole("button", { name: "Generate test" })).toBeVisible();
  });

  it("calls generate endpoint and shows review UI after successful generation", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response({ tests: [] }))
      .mockReturnValueOnce(response({ error: "Not found" }, 404))
      .mockReturnValueOnce(
        response(
          { journeyId: "E2E-007", qualityChecks: MOCK_TEST_FULL.qualityChecks, styleScore: "High" },
          201,
        ),
      )
      .mockReturnValueOnce(response(MOCK_TEST_FULL));

    render(<TestGenerationPage />);
    await screen.findByRole("button", { name: "Generate test" });
    await user.click(screen.getByRole("button", { name: "Generate test" }));

    expect(await screen.findByRole("button", { name: "Approve and save" })).toBeVisible();
    expect(screen.getByLabelText("Generated test code")).toBeVisible();
    expect(screen.getByText(/\[E2E-007\] SMS gateway times out/)).toBeVisible();
  });

  it("shows quality badge and style score in review view", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    fetchMock
      .mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }))
      .mockReturnValueOnce(response(MOCK_TEST_FULL));
    render(<TestGenerationPage />);
    expect(await screen.findByText("Quality: Pass")).toBeVisible();
    expect(screen.getByText("Style: High")).toBeVisible();
  });

  it("disables Approve until test run passes", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    fetchMock
      .mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }))
      .mockReturnValueOnce(response(MOCK_TEST_FULL));
    render(<TestGenerationPage />);
    const approveBtn = await screen.findByRole("button", { name: "Approve and save" });
    expect(approveBtn).toBeDisabled();
  });

  it("enables Approve after test run passes", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }))
      .mockReturnValueOnce(response(MOCK_TEST_FULL))
      .mockReturnValueOnce(response({ passed: true, output: "1 passed" }));
    render(<TestGenerationPage />);
    await screen.findByRole("button", { name: "Approve and save" });
    await user.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText("Test passed")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve and save" })).not.toBeDisabled();
  });

  it("shows failed run output when test fails", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }))
      .mockReturnValueOnce(response(MOCK_TEST_FULL))
      .mockReturnValueOnce(response({ passed: false, output: "selector not found" }));
    render(<TestGenerationPage />);
    await screen.findByRole("button", { name: "Run test" });
    await user.click(screen.getByRole("button", { name: "Run test" }));
    expect(await screen.findByText("Test failed")).toBeVisible();
    expect(screen.getByText("selector not found")).toBeVisible();
    expect(screen.getByRole("button", { name: "Approve and save" })).toBeDisabled();
  });

  it("starts batch generation and shows progress", async () => {
    fetchMock
      .mockReturnValueOnce(response({ tests: [] }))
      .mockReturnValueOnce(response({ batchId: "batch-1", total: 2 }, 202))
      .mockReturnValueOnce(
        response({ id: "batch-1", status: "running", completed: 1, total: 2, results: [] }),
      );

    render(<TestGenerationPage />);
    await screen.findByText("Batch generate");

    const textarea = screen.getByPlaceholderText("E2E-007, E2E-008, E2E-009…");
    fireEvent.change(textarea, { target: { value: "E2E-007, E2E-008" } });
    expect(screen.getByRole("button", { name: "Generate all (2)" })).toBeVisible();

    await userEvent.setup().click(screen.getByRole("button", { name: "Generate all (2)" }));
    await waitFor(() => expect(screen.getByText(/Generating/)).toBeVisible());
  });

  it("shows discard removes test from list", async () => {
    window.history.replaceState({}, "", "/test-generation?journeyId=E2E-007");
    const user = userEvent.setup();
    vi.stubGlobal("history", { ...window.history, pushState: vi.fn() });
    fetchMock
      .mockReturnValueOnce(response({ tests: [MOCK_TEST_META] }))
      .mockReturnValueOnce(response(MOCK_TEST_FULL))
      .mockReturnValueOnce(response({ ok: true }));
    render(<TestGenerationPage />);
    await screen.findByRole("button", { name: "Discard" });
    await user.click(screen.getByRole("button", { name: "Discard" }));
    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/api/generation/E2E-007",
        expect.objectContaining({ method: "DELETE" }),
      ),
    );
  });
});
