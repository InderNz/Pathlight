// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createApp } from "./app.js";

describe("US-P001 configuration API", () => {
  let projectRoot: string;
  let targetProjectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-config-"));
    targetProjectRoot = join(projectRoot, "application-under-test");
    await mkdir(targetProjectRoot);
    await writeFile(join(targetProjectRoot, "playwright.config.ts"), "export default {};");
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("writes a new project configuration to the project root", async () => {
    const response = await request(createApp({ projectRoot })).put("/api/config").send({
      projectName: "Pathlight Demo",
      projectKey: "PLDEMO",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
    });

    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      saved: true,
      configPath: join(projectRoot, "pathlight.config.json"),
      config: {
        schemaVersion: "1.0",
        project: { name: "Pathlight Demo", key: "PLDEMO" },
        server: { host: "127.0.0.1", port: 4242 },
        projectRoot: targetProjectRoot,
        playwrightConfigPath: "playwright.config.ts",
      },
    });
    await expect(readFile(join(projectRoot, "pathlight.config.json"), "utf8")).resolves.toContain(
      '"key": "PLDEMO"',
    );
  });

  it.each([
    [{ projectName: "", projectKey: "PLDEMO" }, "Project Name is required."],
    [{ projectName: "Demo", projectKey: "" }, "Project Key is required."],
    [
      { projectName: "Demo", projectKey: "not valid" },
      "Project Key must contain only uppercase letters and numbers, up to 10 characters.",
    ],
  ])("rejects invalid project identity values", async (payload, error) => {
    const response = await request(createApp({ projectRoot })).put("/api/config").send(payload);

    expect(response.status).toBe(400);
    expect(response.body.errors).toContain(error);
  });

  it("loads existing configuration for editing", async () => {
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Existing Project", key: "EXIST" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );

    const response = await request(createApp({ projectRoot })).get("/api/config");

    expect(response.status).toBe(200);
    expect(response.body.configured).toBe(true);
    expect(response.body.config.project).toEqual({
      name: "Existing Project",
      key: "EXIST",
    });
  });

  it("persists the target project root and relative Playwright configuration path", async () => {
    const response = await request(createApp({ projectRoot })).put("/api/config").send({
      projectName: "ZovKu",
      projectKey: "ZOVK",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
    });

    expect(response.status).toBe(200);
    expect(response.body.config.projectRoot).toBe(targetProjectRoot);
    expect(response.body.config.playwrightConfigPath).toBe("playwright.config.ts");
    const stored = JSON.parse(await readFile(join(projectRoot, "pathlight.config.json"), "utf8"));
    expect(stored).toMatchObject({
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
    });
  });

  it("rejects a missing project directory and missing Playwright configuration file", async () => {
    const missingDirectory = await request(createApp({ projectRoot }))
      .put("/api/config")
      .send({
        projectName: "ZovKu",
        projectKey: "ZOVK",
        projectRoot: join(projectRoot, "missing"),
        playwrightConfigPath: "playwright.config.ts",
      });
    expect(missingDirectory.status).toBe(400);
    expect(missingDirectory.body.errors).toContain(
      "Directory not found. Check the path and try again.",
    );

    const response = await request(createApp({ projectRoot })).put("/api/config").send({
      projectName: "ZovKu",
      projectKey: "ZOVK",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "missing.config.ts",
    });

    expect(response.status).toBe(400);
    expect(response.body.errors).toContain(
      "playwright.config.ts not found. Check your playwrightConfigPath.",
    );
  });

  it("validates the project directory on blur and verifies Playwright plus config from that directory", async () => {
    const verifyPlaywright = vi.fn(() => "Version 1.54.0");
    const app = createApp({ projectRoot, verifyPlaywright });

    const location = await request(app)
      .post("/api/config/validate-project-root")
      .send({ projectRoot: targetProjectRoot });
    expect(location.status).toBe(200);
    expect(location.body).toEqual({ valid: true });

    const verified = await request(app)
      .post("/api/config/verify-playwright")
      .send({ projectRoot: targetProjectRoot, playwrightConfigPath: "playwright.config.ts" });
    expect(verified.status).toBe(200);
    expect(verified.body).toEqual({ message: "Playwright 1.54.0 found" });
    expect(verifyPlaywright).toHaveBeenCalledWith(targetProjectRoot);

    const missingConfig = await request(app)
      .post("/api/config/verify-playwright")
      .send({ projectRoot: targetProjectRoot, playwrightConfigPath: "missing.config.ts" });
    expect(missingConfig.status).toBe(400);
    expect(missingConfig.body.error).toBe(
      "playwright.config.ts not found. Check your playwrightConfigPath.",
    );
    expect(verifyPlaywright).toHaveBeenCalledTimes(1);
  });

  it("requires confirmation before overwriting an existing configuration", async () => {
    const app = createApp({ projectRoot });
    await request(app).put("/api/config").send({
      projectName: "Original",
      projectKey: "ORIG",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
    });

    const refused = await request(app).put("/api/config").send({
      projectName: "Replacement",
      projectKey: "NEW",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
    });
    expect(refused.status).toBe(409);
    expect(refused.body.error).toBe("CONFIRM_OVERWRITE_REQUIRED");

    const confirmed = await request(app).put("/api/config").send({
      projectName: "Replacement",
      projectKey: "NEW",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
      confirmOverwrite: true,
    });
    expect(confirmed.status).toBe(200);
    expect(confirmed.body.config.project.name).toBe("Replacement");
  });

  it("includes the path and filesystem reason when the config cannot be written", async () => {
    const fileInsteadOfRoot = join(projectRoot, "not-a-directory");
    await writeFile(fileInsteadOfRoot, "occupied");

    const response = await request(createApp({ projectRoot: fileInsteadOfRoot }))
      .put("/api/config")
      .send({
        projectName: "Demo",
        projectKey: "DEMO",
        projectRoot: targetProjectRoot,
        playwrightConfigPath: "playwright.config.ts",
      });

    expect(response.status).toBe(500);
    expect(response.body.error).toContain(join(fileInsteadOfRoot, "pathlight.config.json"));
    expect(response.body.error).toContain("ENOTDIR");
  });

  it("preserves setup fields owned by later configuration stories when identity is edited", async () => {
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Existing Project", key: "EXIST" },
        server: { host: "127.0.0.1", port: 4242 },
        logoPath: ".pathlight/logo.png",
        PATHLIGHT_JIRA_MOCK: true,
      }),
    );

    const response = await request(createApp({ projectRoot })).put("/api/config").send({
      projectName: "Edited Project",
      projectKey: "EDITED",
      projectRoot: targetProjectRoot,
      playwrightConfigPath: "playwright.config.ts",
      confirmOverwrite: true,
    });

    expect(response.body.config.logoPath).toBe(".pathlight/logo.png");
    expect(response.body.config.PATHLIGHT_JIRA_MOCK).toBe(true);
  });
});
