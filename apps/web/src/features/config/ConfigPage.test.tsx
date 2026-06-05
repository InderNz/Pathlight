import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigPage } from "./ConfigPage";

const jsonResponse = (body: unknown, status = 200) =>
  Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );

const noAiConfig = jsonResponse({ hasApiKey: false });

// Standard 5 initial mocks shared by most tests (unconfigured)
function mockInitial(fetchMock: ReturnType<typeof vi.fn>, configuredResponse: unknown) {
  fetchMock
    .mockReturnValueOnce(jsonResponse(configuredResponse))
    .mockReturnValueOnce(jsonResponse({ status: "not_connected", mockEnabled: false }))
    .mockReturnValueOnce(jsonResponse({ fetchedAt: null, jiraProjectKey: null, stories: [] }))
    .mockReturnValueOnce(
      jsonResponse({
        scannedAt: null,
        testDir: null,
        specFileCount: 0,
        testCaseCount: 0,
        folderGroups: {},
        topDescribeBlocks: [],
        excludedFolders: [],
      }),
    )
    .mockReturnValueOnce(
      jsonResponse({ derivedAt: null, mappedCount: 0, unmappedCount: 0, totalJourneys: 0 }),
    )
    .mockReturnValueOnce(noAiConfig); // 6th: /api/ai/config
}

describe("US-P001 project configuration page", () => {
  const fetchMock = vi.fn<typeof fetch>();

  beforeEach(() => {
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    window.history.replaceState({}, "", "/config");
  });

  it("shows all required configuration sections and identity fields", async () => {
    const user = userEvent.setup();
    mockInitial(fetchMock, {
      configured: false,
      config: null,
      configPath: "/tmp/pathlight.config.json",
    });

    render(<ConfigPage />);

    expect(await screen.findByRole("heading", { name: "Project configuration" })).toBeVisible();

    // Project section
    await user.click(screen.getByRole("button", { name: "Project" }));
    expect(screen.getByRole("heading", { name: "Project Identity" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Project Location" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "Logo" })).toBeVisible();
    expect(screen.getByLabelText("Project Name")).toBeVisible();
    expect(screen.getByLabelText("Project Key")).toBeVisible();
    expect(screen.getByLabelText("Project root")).toBeVisible();
    expect(screen.getByLabelText("Playwright config path")).toHaveValue("playwright.config.ts");

    // Integrations section
    await user.click(screen.getByRole("button", { name: "Integrations" }));
    expect(screen.getByRole("heading", { name: "JIRA Connection" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "AI Provider" })).toBeVisible();

    // Advanced section
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    expect(screen.getByRole("heading", { name: "Server Settings" })).toBeVisible();
  });

  it("blocks save and displays inline validation for missing or malformed identity fields", async () => {
    const user = userEvent.setup();
    mockInitial(fetchMock, {
      configured: false,
      config: null,
      configPath: "/tmp/pathlight.config.json",
    });
    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });

    await user.click(screen.getByRole("button", { name: "Project" }));
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(screen.getByText("Project Name is required.")).toBeVisible();
    expect(screen.getByText("Project Key is required.")).toBeVisible();
    expect(screen.getByText("Project root is required.")).toBeVisible();

    await user.type(screen.getByLabelText("Project Name"), "Demo");
    await user.type(screen.getByLabelText("Project Key"), "not valid");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));
    expect(
      screen.getByText(
        "Project Key must contain only uppercase letters and numbers, up to 10 characters.",
      ),
    ).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("loads current config and confirms an overwrite before saving", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockInitial(fetchMock, {
      configured: true,
      configPath: "/project/pathlight.config.json",
      config: {
        project: { name: "Original", key: "ORIG" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: "/repos/zovku",
        playwrightConfigPath: "tests/playwright.qa.ts",
      },
    });
    fetchMock
      .mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)) // /api/manifest
      .mockReturnValueOnce(jsonResponse({ error: "CONFIRM_OVERWRITE_REQUIRED" }, 409))
      .mockReturnValueOnce(
        jsonResponse({
          saved: true,
          configPath: "/project/pathlight.config.json",
          config: {
            project: { name: "Replacement", key: "ORIG" },
            server: { host: "127.0.0.1", port: 4242 },
            projectRoot: "/repos/zovku",
            playwrightConfigPath: "tests/playwright.qa.ts",
          },
        }),
      );

    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });
    await user.click(screen.getByRole("button", { name: "Project" }));
    const projectName = await screen.findByLabelText("Project Name");
    expect(projectName).toHaveValue("Original");
    expect(screen.getByLabelText("Project root")).toHaveValue("/repos/zovku");
    expect(screen.getByLabelText("Playwright config path")).toHaveValue("tests/playwright.qa.ts");
    await user.clear(projectName);
    await user.type(projectName, "Replacement");
    await user.click(screen.getByRole("button", { name: "Save configuration" }));

    expect(confirm).toHaveBeenCalled();
    await waitFor(() =>
      expect(screen.getByRole("status")).toHaveTextContent("Configuration saved"),
    );
    expect(screen.getByText("/project/pathlight.config.json")).toBeVisible();
    expect(screen.getByText("Fishbone")).toHaveAttribute("aria-disabled", "true");
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/config",
      expect.objectContaining({
        body: JSON.stringify({
          projectName: "Replacement",
          projectKey: "ORIG",
          projectRoot: "/repos/zovku",
          playwrightConfigPath: "tests/playwright.qa.ts",
          confirmOverwrite: true,
        }),
      }),
    );
  });

  it("validates a project root on blur and verifies its Playwright installation", async () => {
    const user = userEvent.setup();
    mockInitial(fetchMock, {
      configured: false,
      config: null,
      configPath: "/tmp/pathlight.config.json",
    });
    fetchMock
      .mockReturnValueOnce(
        jsonResponse({ error: "Directory not found. Check the path and try again." }, 400),
      )
      .mockReturnValueOnce(jsonResponse({ valid: true }))
      .mockReturnValueOnce(jsonResponse({ message: "Playwright 1.54.0 found" }));

    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });
    await user.click(screen.getByRole("button", { name: "Project" }));
    const projectRoot = await screen.findByLabelText("Project root");
    await user.type(projectRoot, "/repos/missing");
    await user.tab();
    expect(
      await screen.findByText("Directory not found. Check the path and try again."),
    ).toBeVisible();

    await user.clear(projectRoot);
    await user.type(projectRoot, "/repos/zovku");
    await user.tab();
    await user.click(screen.getByRole("button", { name: "Verify connection" }));
    expect(await screen.findByText("Playwright 1.54.0 found")).toBeVisible();
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/config/verify-playwright",
      expect.objectContaining({
        body: JSON.stringify({
          projectRoot: "/repos/zovku",
          playwrightConfigPath: "playwright.config.ts",
        }),
      }),
    );
  });

  it("uploads an accepted logo and surfaces validation errors for rejected logos", async () => {
    const user = userEvent.setup({ applyAccept: false });
    mockInitial(fetchMock, {
      configured: true,
      configPath: "/project/pathlight.config.json",
      config: {
        project: { name: "Original", key: "ORIG" },
        server: { host: "127.0.0.1", port: 4242 },
      },
    });
    fetchMock
      .mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)) // /api/manifest
      .mockReturnValueOnce(jsonResponse({ logoPath: ".pathlight/logo.png" }))
      .mockReturnValueOnce(jsonResponse({ error: "Only PNG and JPG logos are accepted." }, 400));

    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });
    await user.click(screen.getByRole("button", { name: "Project" }));
    const input = await screen.findByLabelText("Upload project logo");
    await user.upload(input, new File(["logo"], "logo.png", { type: "image/png" }));
    expect(await screen.findByAltText("Project logo")).toHaveAttribute("src", "/api/logo");

    await user.upload(input, new File(["svg"], "logo.svg", { type: "image/svg+xml" }));
    expect(await screen.findByText("Only PNG and JPG logos are accepted.")).toBeVisible();
  });

  it("shows JIRA status, toggles mock mode, and disconnects", async () => {
    const user = userEvent.setup();
    fetchMock
      .mockReturnValueOnce(
        jsonResponse({
          configured: true,
          configPath: "/project/pathlight.config.json",
          config: {
            project: { name: "Original", key: "ORIG" },
            server: { host: "127.0.0.1", port: 4242 },
          },
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({ status: "connected", cloudId: "cloud-123", mockEnabled: false }),
      )
      .mockReturnValueOnce(jsonResponse({ fetchedAt: null, jiraProjectKey: null, stories: [] }))
      .mockReturnValueOnce(
        jsonResponse({
          scannedAt: null,
          testDir: null,
          specFileCount: 0,
          testCaseCount: 0,
          folderGroups: {},
          topDescribeBlocks: [],
          excludedFolders: [],
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({ derivedAt: null, mappedCount: 0, unmappedCount: 0, totalJourneys: 0 }),
      )
      .mockReturnValueOnce(noAiConfig) // 6th: /api/ai/config
      .mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)) // /api/manifest
      .mockReturnValueOnce(jsonResponse({ mockEnabled: true }))
      .mockReturnValueOnce(jsonResponse({ status: "not_connected" }));

    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });

    // JIRA status is in Integrations section
    await user.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByText("Connected · cloud-123")).toBeVisible();

    // Mock toggle is in Advanced section
    await user.click(screen.getByRole("button", { name: "Advanced" }));
    await user.click(screen.getByLabelText("Use JIRA mock"));
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/jira/mock",
      expect.objectContaining({ body: JSON.stringify({ enabled: true }) }),
    );

    // Disconnect is in Integrations section
    await user.click(screen.getByRole("button", { name: "Integrations" }));
    await user.click(screen.getByRole("button", { name: "Disconnect" }));
    expect(await screen.findByText("Not connected")).toBeVisible();
  });

  it("surfaces expired JIRA credentials with a reconnect action", async () => {
    fetchMock
      .mockReturnValueOnce(
        jsonResponse({
          configured: true,
          configPath: "/project/pathlight.config.json",
          config: {
            project: { name: "Original", key: "ORIG" },
            server: { host: "127.0.0.1", port: 4242 },
          },
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({
          status: "expired",
          cloudId: "cloud-123",
          message: "JIRA connection expired — reconnect",
          mockEnabled: false,
        }),
      )
      .mockReturnValueOnce(jsonResponse({ fetchedAt: null, jiraProjectKey: null, stories: [] }))
      .mockReturnValueOnce(
        jsonResponse({
          scannedAt: null,
          testDir: null,
          specFileCount: 0,
          testCaseCount: 0,
          folderGroups: {},
          topDescribeBlocks: [],
          excludedFolders: [],
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({ derivedAt: null, mappedCount: 0, unmappedCount: 0, totalJourneys: 0 }),
      )
      .mockReturnValueOnce(noAiConfig) // 6th: /api/ai/config
      .mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)); // /api/manifest

    render(<ConfigPage />);
    await screen.findByRole("heading", { name: "Project configuration" });
    await userEvent.click(screen.getByRole("button", { name: "Integrations" }));
    expect(await screen.findByText("JIRA connection expired — reconnect")).toBeVisible();
    expect(screen.getByRole("button", { name: "Reconnect" })).toBeVisible();
  });

  it("shows retryable OAuth callback errors without storing a connection", async () => {
    window.history.replaceState({}, "", "/config?jira=csrf");
    mockInitial(fetchMock, {
      configured: false,
      config: null,
      configPath: "/tmp/pathlight.config.json",
    });

    render(<ConfigPage />);

    // jira URL param auto-navigates to Integrations section
    expect(
      await screen.findByText(
        "JIRA connection could not be completed because the security check failed. Try again.",
      ),
    ).toBeVisible();
    expect(screen.getByRole("button", { name: "Connect JIRA" })).toBeVisible();
  });

  it("offers the journey CSV template after project configuration", async () => {
    mockInitial(fetchMock, {
      configured: true,
      configPath: "/project/pathlight.config.json",
      config: {
        project: { name: "Original", key: "ORIG" },
        server: { host: "127.0.0.1", port: 4242 },
      },
    });
    fetchMock.mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)); // /api/manifest

    render(<ConfigPage />);

    // Configured + no manifest → default is Journeys section
    expect(await screen.findByRole("link", { name: "Download template" })).toHaveAttribute(
      "href",
      "/api/journeys/template",
    );
  });

  it("validates, imports and locks journey CSV from the configuration page", async () => {
    const user = userEvent.setup();
    const csv = new File(
      [
        "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description\n" +
          "E2E-001,Request,Highest,1,S2,Core,happy,@smoke,US-2,Submit\n",
      ],
      "journeys.csv",
      { type: "text/csv" },
    );
    mockInitial(fetchMock, {
      configured: true,
      configPath: "/project/pathlight.config.json",
      config: {
        project: { name: "Original", key: "ORIG" },
        server: { host: "127.0.0.1", port: 4242 },
      },
    });
    fetchMock
      .mockReturnValueOnce(jsonResponse({ error: "Not found" }, 404)) // /api/manifest
      .mockReturnValueOnce(
        jsonResponse({
          valid: true,
          journeyCount: 1,
          stages: { S2: 1 },
          priorities: { Highest: 1 },
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({
          message: "1 journeys imported across 1 stage. Manifest ready to lock.",
          manifest: { schemaVersion: "1.0", projectKey: "ORIG", nodes: [] },
        }),
      )
      .mockReturnValueOnce(
        jsonResponse({ lockedAt: "2026-05-27T01:02:03.000Z", lockedBy: "dev@example.com" }),
      );

    render(<ConfigPage />);
    // Configured + no manifest → default is Journeys section
    await user.upload(await screen.findByLabelText("Upload journey CSV"), csv);
    expect(await screen.findByText("1 journeys validated")).toBeVisible();
    expect(screen.getByText("S2: 1")).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Import journeys" }));
    expect(
      await screen.findByText("1 journeys imported across 1 stage. Manifest ready to lock."),
    ).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Lock manifest" }));
    expect(await screen.findByText("Locked at 2026-05-27T01:02:03.000Z")).toBeVisible();
  });

  it("lists CSV validation failures and requires confirmation before unlocking", async () => {
    const user = userEvent.setup();
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    mockInitial(fetchMock, {
      configured: true,
      configPath: "/project/pathlight.config.json",
      config: {
        project: { name: "Original", key: "ORIG" },
        server: { host: "127.0.0.1", port: 4242 },
      },
    });
    fetchMock
      .mockReturnValueOnce(
        jsonResponse({
          schemaVersion: "1.0",
          projectKey: "ORIG",
          lockedAt: "2026-05-27T00:00:00.000Z",
          lockedBy: "dev@example.com",
          nodes: [],
        }),
      ) // /api/manifest
      .mockReturnValueOnce(jsonResponse({ unlocked: true }))
      .mockReturnValueOnce(
        jsonResponse(
          { valid: false, errors: ["Required column 'priority' not found in header row."] },
          422,
        ),
      );

    render(<ConfigPage />);
    // Locked manifest + JIRA not connected → default is Integrations; navigate to Journeys
    await screen.findByRole("heading", { name: "Project configuration" });
    await user.click(screen.getByRole("button", { name: "Journeys" }));
    expect(await screen.findByText("Locked at 2026-05-27T00:00:00.000Z")).toBeVisible();
    expect(screen.getByRole("link", { name: "Fishbone" })).toHaveAttribute("href", "/");
    await user.click(screen.getByRole("button", { name: "Unlock and re-import" }));
    expect(confirm).toHaveBeenCalled();
    const input = screen.getByLabelText("Upload journey CSV");
    await user.upload(input, new File(["bad"], "bad.csv", { type: "text/csv" }));
    expect(
      await screen.findByText("Required column 'priority' not found in header row."),
    ).toBeVisible();
  });
});
