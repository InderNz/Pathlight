// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("US-P002 logo upload", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-logo-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Pathlight", key: "PL" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("stores an accepted PNG and records its relative path in config", async () => {
    const png = Buffer.from("89504e470d0a1a0a", "hex");
    const app = createApp({ projectRoot });
    const response = await request(app)
      .post("/api/logo")
      .attach("logo", png, { filename: "brand.png", contentType: "image/png" });

    expect(response.status).toBe(200);
    expect(response.body.logoPath).toBe(".pathlight/logo.png");
    await expect(readFile(join(projectRoot, ".pathlight/logo.png"))).resolves.toEqual(png);
    const config = JSON.parse(await readFile(join(projectRoot, "pathlight.config.json"), "utf8"));
    expect(config.logoPath).toBe(".pathlight/logo.png");
    const servedLogo = await request(app).get("/api/logo");
    expect(servedLogo.status).toBe(200);
    expect(servedLogo.body).toEqual(png);
  });

  it("rejects invalid logo types and files larger than 2MB", async () => {
    const invalid = await request(createApp({ projectRoot }))
      .post("/api/logo")
      .attach("logo", Buffer.from("plain"), {
        filename: "logo.svg",
        contentType: "image/svg+xml",
      });
    expect(invalid.status).toBe(400);
    expect(invalid.body.error).toBe("Only PNG and JPG logos are accepted.");

    const oversized = await request(createApp({ projectRoot }))
      .post("/api/logo")
      .attach("logo", Buffer.alloc(2 * 1024 * 1024 + 1), {
        filename: "huge.jpg",
        contentType: "image/jpeg",
      });
    expect(oversized.status).toBe(400);
    expect(oversized.body.error).toContain("Logo must be under 2MB.");
  });

  it("replaces a prior logo with a different accepted extension", async () => {
    await mkdir(join(projectRoot, ".pathlight"), { recursive: true });
    await writeFile(join(projectRoot, ".pathlight/logo.png"), "old");
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Pathlight", key: "PL" },
        server: { host: "127.0.0.1", port: 4242 },
        logoPath: ".pathlight/logo.png",
      }),
    );

    const response = await request(createApp({ projectRoot }))
      .post("/api/logo")
      .attach("logo", Buffer.from("new"), {
        filename: "brand.jpg",
        contentType: "image/jpeg",
      });

    expect(response.body.logoPath).toBe(".pathlight/logo.jpg");
    await expect(stat(join(projectRoot, ".pathlight/logo.png"))).rejects.toThrow();
  });

  it("falls back cleanly when the configured logo has been deleted", async () => {
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Pathlight", key: "PL" },
        server: { host: "127.0.0.1", port: 4242 },
        logoPath: ".pathlight/logo.png",
      }),
    );

    const response = await request(createApp({ projectRoot })).get("/api/logo");
    expect(response.status).toBe(404);
  });
});
