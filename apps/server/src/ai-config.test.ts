// @vitest-environment node
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import request from "supertest";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "./app.js";

describe("US-V5-001 AI provider config", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await mkdtemp(join(tmpdir(), "pathlight-ai-config-"));
    await writeFile(
      join(projectRoot, "pathlight.config.json"),
      JSON.stringify({
        schemaVersion: "1.0",
        project: { name: "Test", key: "TEST" },
        server: { host: "127.0.0.1", port: 4242 },
      }),
    );
  });

  afterEach(async () => {
    await rm(projectRoot, { recursive: true, force: true });
  });

  it("GET /api/ai/config returns empty config when nothing saved", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).get("/api/ai/config");
    expect(res.status).toBe(200);
    expect(res.body.hasApiKey).toBe(false);
  });

  it("PUT /api/ai/config saves provider and model to config, key to credentials file", async () => {
    const app = createApp({ projectRoot });

    const res = await request(app).put("/api/ai/config").send({
      provider: "openai",
      model: "gpt-4o",
      apiKey: "sk-test-key",
    });
    expect(res.status).toBe(200);
    expect(res.body.saved).toBe(true);

    const config = JSON.parse(await readFile(join(projectRoot, "pathlight.config.json"), "utf8"));
    expect(config.aiProvider).toEqual({ provider: "openai", model: "gpt-4o" });

    const credsPath = join(projectRoot, ".pathlight", "auth", "ai-credentials.json");
    const creds = JSON.parse(await readFile(credsPath, "utf8"));
    expect(creds.apiKey).toBe("sk-test-key");
  });

  it("PUT /api/ai/config rejects unknown providers", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).put("/api/ai/config").send({ provider: "unknown" });
    expect(res.status).toBe(400);
  });

  it("GET /api/ai/config returns hasApiKey=true after credentials saved", async () => {
    const app = createApp({ projectRoot });
    await request(app).put("/api/ai/config").send({ provider: "claude", apiKey: "sk-ant-key" });

    const res = await request(app).get("/api/ai/config");
    expect(res.body.hasApiKey).toBe(true);
    expect(res.body.provider).toBe("claude");
  });

  it("POST /api/ai/test-connection returns bypassed response when BYPASS_EXTERNAL_AI=true", async () => {
    const original = process.env.BYPASS_EXTERNAL_AI;
    process.env.BYPASS_EXTERNAL_AI = "true";
    try {
      const app = createApp({ projectRoot });
      const res = await request(app).post("/api/ai/test-connection").send({ provider: "claude" });
      expect(res.status).toBe(200);
      expect(res.body.connected).toBe(true);
      expect(res.body.model).toContain("bypassed");
    } finally {
      if (original === undefined) delete process.env.BYPASS_EXTERNAL_AI;
      else process.env.BYPASS_EXTERNAL_AI = original;
    }
  });

  it("POST /api/ai/test-connection returns 502 for bad ollama URL", async () => {
    const app = createApp({ projectRoot });
    const res = await request(app).post("/api/ai/test-connection").send({
      provider: "ollama",
      ollamaUrl: "http://127.0.0.1:19999",
      model: "llama3",
    });
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/Ollama not running/);
  });

  it("PUT /api/ai/config saves ollama URL without apiKey", async () => {
    const app = createApp({ projectRoot });
    const authDir = join(projectRoot, ".pathlight", "auth");
    await mkdir(authDir, { recursive: true });

    const res = await request(app).put("/api/ai/config").send({
      provider: "ollama",
      ollamaUrl: "http://localhost:11434",
      model: "llama3",
    });
    expect(res.status).toBe(200);

    const config = JSON.parse(await readFile(join(projectRoot, "pathlight.config.json"), "utf8"));
    expect(config.aiProvider.ollamaUrl).toBe("http://localhost:11434");
  });
});
