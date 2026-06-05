import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { expect, test } from "@playwright/test";

const configPath = resolve(".tmp/e2e-project/pathlight.config.json");
const targetProjectRoot = resolve(".tmp/e2e-target-project");

test.describe.serial("US-P001 project configuration page", () => {
  test("validates identity fields and saves a new configuration", async ({ page }) => {
    await page.goto("/config");

    await expect(page.getByRole("heading", { name: "Project configuration" })).toBeVisible();

    // Navigate to Project section and check its headings
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Project Identity" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Project Location" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Logo" })).toBeVisible();

    // Check Integrations section heading
    await page.getByRole("button", { name: "Integrations", exact: true }).click();
    await expect(page.getByRole("heading", { name: "JIRA Connection" })).toBeVisible();

    // Check Advanced section heading
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Server Settings" })).toBeVisible();

    // Return to Project section for form interactions
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.getByText("Project Name is required.")).toBeVisible();
    await expect(page.getByText("Project Key is required.")).toBeVisible();
    await expect(page.getByText("Project root is required.")).toBeVisible();

    await page.getByLabel("Project Name").fill("Pathlight Demo");
    await page.getByLabel("Project root").fill(targetProjectRoot);
    await page.getByLabel("Project root").blur();
    await expect(page.getByLabel("Playwright config path")).toHaveValue("playwright.config.ts");
    await page.getByRole("button", { name: "Verify connection" }).click();
    await expect(page.getByText(/Playwright .* found/)).toBeVisible();
    await page.getByLabel("Project Key").fill("PL DEMO");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(
      page.getByText(
        "Project Key must contain only uppercase letters and numbers, up to 10 characters.",
      ),
    ).toBeVisible();

    await page.getByLabel("Project Key").fill("PLDEMO");
    await page.getByRole("button", { name: "Save configuration" }).click();
    await expect(page.getByText("Configuration saved")).toBeVisible();
    await expect(page.getByText(configPath)).toBeVisible();
    await expect(page.getByText("Fishbone")).toHaveAttribute("aria-disabled", "true");

    await expect
      .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
      .toMatchObject({
        project: { name: "Pathlight Demo", key: "PLDEMO" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: targetProjectRoot,
        playwrightConfigPath: "playwright.config.ts",
      });
  });

  test("loads current values and confirms before overwriting", async ({ page }) => {
    await page.goto("/config");
    // Configured + no manifest → default is Journeys; navigate to Project
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await expect(page.getByLabel("Project Name")).toHaveValue("Pathlight Demo");
    await expect(page.getByLabel("Project root")).toHaveValue(targetProjectRoot);
    await page.getByLabel("Project Name").fill("Pathlight Production");

    page.on("dialog", (dialog) => dialog.accept());
    await page.getByRole("button", { name: "Save configuration" }).click();

    await expect(page.getByRole("status")).toContainText("Configuration saved");
    await expect(page.getByText(configPath)).toBeVisible();
    await expect
      .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
      .toMatchObject({ project: { name: "Pathlight Production", key: "PLDEMO" } });
  });
});

test.describe.serial("US-P002 logo and US-P003 JIRA configuration", () => {
  test("uploads a project logo and renders its preview", async ({ page }) => {
    await page.goto("/config");
    // Configured + no manifest → default is Journeys; navigate to Project for logo
    await page.getByRole("button", { name: "Project", exact: true }).click();
    await page.getByLabel("Upload project logo").setInputFiles({
      name: "project-logo.png",
      mimeType: "image/png",
      buffer: Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
        "base64",
      ),
    });

    await expect(page.getByText("Logo uploaded")).toBeVisible();
    await expect(page.getByAltText("Project logo")).toBeVisible();
    await expect
      .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
      .toMatchObject({ logoPath: ".pathlight/logo.png" });
  });

  test("persists the JIRA mock toggle for local execution", async ({ page }) => {
    await page.goto("/config");
    // Navigate to Integrations to check JIRA status
    await page.getByRole("button", { name: "Integrations", exact: true }).click();
    await expect(page.getByText("Not connected")).toBeVisible();
    // Mock toggle is in Advanced section
    await page.getByRole("button", { name: "Advanced", exact: true }).click();
    await page.getByLabel("Use JIRA mock").check();
    await expect(page.getByLabel("Use JIRA mock")).toBeChecked();
    await expect
      .poll(async () => JSON.parse(await readFile(configPath, "utf8")))
      .toMatchObject({ PATHLIGHT_JIRA_MOCK: true });
  });
});

test.describe.serial("US-P004 to US-P006 journey manifest workflow", () => {
  const journeyCsv =
    "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description\n" +
    "E2E-001,Owner requests review,Highest,1,S2,Core SMS Review Flow,happy,@smoke,US-002,Submit request\n" +
    "E2E-002,Reviewer rejects,High,2,S3,Review Decision,unhappy,@critical,US-003,Reject request\n";

  test("downloads the CSV template from the journey panel", async ({ page }) => {
    await page.goto("/config");
    // Configured + no manifest → default is Journeys section
    const download = page.waitForEvent("download");
    await page.getByRole("link", { name: "Download template" }).click();
    const saved = await download;
    expect(saved.suggestedFilename()).toBe("pathlight-journeys-template.csv");
    const templatePath = await saved.path();
    expect(templatePath).not.toBeNull();
    const template = await readFile(templatePath!, "utf8");
    expect(template).toContain(
      "id,summary,priority,priorityRank,stage,stageName,branchType,labels,linkedStories,description",
    );
  });

  test("validates, imports and locks journeys from a CSV file", async ({ page }) => {
    await page.goto("/config");
    // Configured + no manifest → default is Journeys section
    await page.getByLabel("Upload journey CSV").setInputFiles({
      name: "journeys.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(journeyCsv),
    });
    await expect(page.getByText("2 journeys validated")).toBeVisible();
    await expect(page.getByText("S2: 1")).toBeVisible();
    await page.getByRole("button", { name: "Import journeys" }).click();
    await expect(
      page.getByText("2 journeys imported across 2 stages. Manifest ready to lock."),
    ).toBeVisible();
    await page.getByRole("button", { name: "Lock manifest" }).click();
    await expect(page.getByText(/^Locked at /)).toBeVisible();
    await expect(page.getByRole("link", { name: "Fishbone" })).toHaveAttribute("href", "/");

    await expect
      .poll(async () =>
        JSON.parse(await readFile(resolve(".tmp/e2e-project/pathlight-manifest.json"), "utf8")),
      )
      .toMatchObject({
        projectKey: "PLDEMO",
        lockedBy: expect.any(String),
        nodes: [{ id: "E2E-001", priorityRank: 1, risk: "critical" }, { id: "E2E-002" }],
      });
  });
});

test.describe.serial("US-P013 and US-P015 to US-P019 fishbone renderer", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      class TestEventSource {
        onmessage: ((event: MessageEvent<string>) => void) | null = null;

        constructor() {
          (window as Window & { pathlightStream?: TestEventSource }).pathlightStream = this;
        }

        close() {}

        emit(event: unknown) {
          this.onmessage?.({ data: JSON.stringify(event) } as MessageEvent<string>);
        }
      }
      Object.defineProperty(window, "EventSource", { value: TestEventSource });
    });
  });

  test("renders the locked journey view with navigation and evidence details", async ({ page }) => {
    await page.goto("/");

    await expect(page.getByRole("heading", { name: "Journey confidence" })).toBeVisible();
    await expect(page.getByAltText("Project logo")).toBeVisible();
    await expect(page.getByRole("button", { name: "S2" })).toHaveAttribute("aria-current", "true");
    await expect(page.getByLabel("Highest fishbone")).toBeVisible();

    // Branches only render once a journey has a non-pending status (by design — see
    // FishbonePage rendering and unit tests). Surface E2E-001 via the live stream.
    await page.evaluate(() => {
      const stream = (window as Window & { pathlightStream?: { emit: (event: unknown) => void } })
        .pathlightStream;
      stream?.emit({ type: "test.started", payload: { testId: "E2E-001" } });
    });

    // Click the branch's node dot; the SVG <g> centroid sits over empty SVG
    // background, so click the circle child, which bubbles to the branch onClick.
    await page.locator('[data-testid="status-E2E-001"] circle').click();
    await expect(page.getByRole("heading", { name: "E2E-001" })).toBeVisible();
    await expect(page.getByText("Branch: happy")).toBeVisible();
  });

  test("applies live events and publishes the report link", async ({ page }) => {
    await page.route("**/api/runs", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({
          contentType: "application/json",
          status: 201,
          body: JSON.stringify({ runId: "run-browser", intendedNodeIds: ["E2E-001", "E2E-002"] }),
        });
        return;
      }
      await route.continue();
    });
    await page.route("**/reports/run-browser/report.html", async (route) => {
      await route.fulfill({
        contentType: "text/html",
        body: "<!doctype html><title>Pathlight report</title><h1>Release confidence: PASSED</h1>",
      });
    });
    await page.goto("/");
    await page.getByRole("button", { name: "Start run" }).click();
    await expect(page.getByRole("button", { name: "Stop run" })).toBeVisible();

    await page.evaluate(() => {
      const stream = (window as Window & { pathlightStream?: { emit: (event: unknown) => void } })
        .pathlightStream;
      stream?.emit({ type: "test.started", payload: { testId: "E2E-001" } });
      stream?.emit({
        type: "step.started",
        payload: { testId: "E2E-001", stepTitle: "Open form", source: "explicit" },
      });
      stream?.emit({ type: "test.passed", payload: { testId: "E2E-001" } });
      stream?.emit({
        type: "report.ready",
        payload: { runId: "run-browser", reportPath: "reports/run-browser/report.html" },
      });
    });

    await expect(page.locator(".counter.passed")).toHaveText("Pass 1");
    await expect(page.getByText("Passed E2E-001 - Owner requests review")).toBeVisible();
    await expect(page.getByRole("link", { name: "View report" })).toHaveAttribute(
      "href",
      "/reports/run-browser/report.html",
    );
    await page.getByRole("link", { name: "View report" }).click();
    await expect(page.getByRole("heading", { name: "Release confidence: PASSED" })).toBeVisible();
  });
});
