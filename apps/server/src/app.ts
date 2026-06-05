import { createHash, randomBytes } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
// execFileSync is used only in setup/configuration paths (lockingIdentity, verifyPlaywright),
// never in request handlers. These are acceptable sync calls outside the hot path.
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  access,
  appendFile,
  chmod,
  mkdir,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import express from "express";
import multer from "multer";
import { createAIProvider } from "@pathlight/ai-provider";
import {
  generateManifest,
  JOURNEY_ID_RE,
  JOURNEY_TEMPLATE,
  type DraftManifest,
  type DraftNode,
  type ManifestFile,
  type ManifestNode,
  summarizeJourneys,
  validateJourneyCsv,
  validateManifest,
} from "@pathlight/manifest-schema";
import { EventBus } from "./event-bus.js";
import { createLocalAuthMiddleware } from "./local-auth.js";
import { checkTestQuality } from "./quality-checks.js";
import { RateLimiter } from "./rate-limit.js";
import { redactOutput } from "./redact.js";
import { log } from "./logger.js";
import { computeRisk } from "./services/RiskService.js";
import { buildComplianceHtml } from "./services/ComplianceService.js";
import {
  readRunHistory as readRunHistorySvc,
  computeHealthScores as computeHealthScoresSvc,
  detectRegressions as detectRegressionsSvc,
} from "./services/HistoryService.js";

const JIRA_PROJECT_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

function isBlockedWebhookHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, ""); // strip IPv6 brackets
  // Loopback and link-local names
  if (h === "localhost" || h === "::1" || h.endsWith(".local")) return true;
  // Literal private/reserved IPv4 ranges
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (ipv4) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 0) return true; // 0.0.0.0/8 reserved
  }
  // IPv6 private/link-local: fc00::/7 (fc/fd) and fe80::/10 (fe8/fe9/fea/feb)
  if (/^f[cd]/.test(h) || /^fe[89ab]/.test(h)) return true;
  return false;
}

function validateWebhookUrl(
  raw: unknown,
): { ok: true; url: string } | { ok: false; error: string } {
  if (typeof raw !== "string" || !raw) return { ok: false, error: "webhookUrl is required." };
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, error: "webhookUrl is not a valid URL." };
  }
  if (parsed.protocol !== "https:") return { ok: false, error: "webhookUrl must use HTTPS." };
  if (isBlockedWebhookHost(parsed.hostname)) {
    return {
      ok: false,
      error: "webhookUrl cannot target localhost or a private/internal address (SSRF protection).",
    };
  }
  return { ok: true, url: raw };
}

async function writeFileAtomic(filePath: string, content: string): Promise<void> {
  const tmp = filePath + ".tmp";
  await writeFile(tmp, content, "utf8");
  await rename(tmp, filePath);
}

const CONFIG_FILENAME = "pathlight.config.json";
const PROJECT_KEY_PATTERN = /^[A-Z0-9]{1,10}$/;
const HISTORY_PAGE_LIMIT = 20;
const BUG_STATUS_CACHE_MS = 5 * 60_000;
const SELF_BASE_URL = `http://${process.env.PATHLIGHT_HOST ?? "127.0.0.1"}:${process.env.PORT ?? 4242}`;

export interface PathlightConfig {
  schemaVersion: "1.0";
  project: {
    name: string;
    key: string;
  };
  server: {
    host: "127.0.0.1";
    port: 4242;
  };
  projectRoot?: string;
  playwrightConfigPath?: string;
  testDir?: string;
  logoPath?: string;
  PATHLIGHT_JIRA_MOCK?: boolean;
  aiProvider?: {
    provider: "claude" | "openai" | "gemini" | "ollama";
    model?: string;
    ollamaUrl?: string;
  };
}

interface AiCredentials {
  provider: string;
  apiKey?: string;
}

interface JiraOptions {
  clientId?: string;
  redirectUri?: string;
  fetch?: typeof fetch;
}

interface CreateAppOptions {
  projectRoot: string;
  jira?: JiraOptions;
  identity?: string;
  activeRunId?: string;
  launchRun?: (options: LaunchRunOptions) => RunningChild;
  bundledReporterPath?: string;
  verifyPlaywright?: (projectRoot: string) => string;
  callClaude?: (params: { system: string; userContent: string }) => Promise<string>;
  localToken?: string;
}

interface LaunchRunOptions {
  command: "npx";
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

interface RunningChild {
  pid?: number;
  killed?: boolean;
  kill(signal?: NodeJS.Signals): boolean;
  on?(event: "close", listener: () => void): unknown;
  stdout?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
  stderr?: { on(event: "data", listener: (chunk: Buffer | string) => void): unknown };
}

function configPath(projectRoot: string) {
  return join(projectRoot, CONFIG_FILENAME);
}

function captureRunOutput(childProcess: RunningChild, reportDirectory: string) {
  const outputPath = join(reportDirectory, "output.log");
  const append = (prefix: "stdout" | "stderr", chunk: Buffer | string) => {
    // Fire-and-forget: run output is diagnostic only; a write failure must not interrupt the test run.
    void appendFile(outputPath, `[${prefix}] ${redactOutput(chunk.toString())}`, "utf8").catch(
      () => undefined,
    );
  };
  childProcess.stdout?.on("data", (chunk) => append("stdout", chunk));
  childProcess.stderr?.on("data", (chunk) => append("stderr", chunk));
}

function validateProjectIdentity(projectName: unknown, projectKey: unknown) {
  const errors: string[] = [];
  const name = typeof projectName === "string" ? projectName.trim() : "";
  const key = typeof projectKey === "string" ? projectKey.trim() : "";

  if (!name) {
    errors.push("Project Name is required.");
  }
  if (!key) {
    errors.push("Project Key is required.");
  } else if (!PROJECT_KEY_PATTERN.test(key)) {
    errors.push(
      "Project Key must contain only uppercase letters and numbers, up to 10 characters.",
    );
  }

  return { errors, name, key };
}

async function hasConfig(path: string) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readConfig(path: string) {
  return JSON.parse(await readFile(path, "utf8")) as PathlightConfig;
}

async function writeConfig(path: string, config: PathlightConfig) {
  await writeFileAtomic(path, `${JSON.stringify(config, null, 2)}\n`);
}

function base64Url(bytes: Buffer) {
  return bytes.toString("base64url");
}

function lockingIdentity(projectRoot: string, configuredIdentity?: string) {
  if (configuredIdentity) {
    return configuredIdentity;
  }
  try {
    return (
      execFileSync("git", ["config", "user.email"], {
        cwd: projectRoot,
        encoding: "utf8",
      }).trim() ||
      process.env.USER ||
      "unknown"
    );
  } catch {
    return process.env.USER || "unknown";
  }
}

function generatedRunId(projectRoot: string) {
  const day = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  let sequence = 1;
  while (
    existsSync(join(projectRoot, "reports", `run_${day}_${String(sequence).padStart(3, "0")}`))
  ) {
    sequence += 1;
  }
  return `run_${day}_${String(sequence).padStart(3, "0")}`;
}

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function directoryExists(directory: string) {
  try {
    return (await stat(directory)).isDirectory();
  } catch {
    return false;
  }
}

async function fileExists(file: string) {
  try {
    return (await stat(file)).isFile();
  } catch {
    return false;
  }
}

export function createApp({
  projectRoot,
  jira = {},
  identity,
  activeRunId,
  launchRun,
  bundledReporterPath = resolve("packages/playwright-reporter/dist/bundled-reporter.js"),
  verifyPlaywright = (targetProjectRoot) =>
    execFileSync("npx", ["playwright", "--version"], {
      cwd: targetProjectRoot,
      encoding: "utf8",
    }),
  callClaude: callClaudeOverride,
  localToken,
}: CreateAppOptions) {
  const app = express();
  const eventBus = new EventBus(projectRoot, activeRunId);
  let child: RunningChild | undefined;
  const path = configPath(projectRoot);
  const manifestPath = join(projectRoot, "pathlight-manifest.json");
  const storiesPath = join(projectRoot, "pathlight-stories.json");
  const draftManifestPath = join(projectRoot, "pathlight-draft-manifest.json");
  const testScanPath = join(projectRoot, "pathlight-test-scan.json");
  const testMappingPath = join(projectRoot, "pathlight-test-mapping.json");
  const generatedTestsPath = join(projectRoot, "pathlight-generated-tests.json");
  const pathlightDirectory = join(projectRoot, ".pathlight");
  const authDirectory = join(pathlightDirectory, "auth");
  const oauthStatePath = join(authDirectory, "oauth-state.json");
  const jiraTokenPath = join(authDirectory, "jira-token.json");
  const aiCredentialsPath = join(authDirectory, "ai-credentials.json");
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });
  const execFileAsync = promisify(execFile);

  const claudeRl = new RateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_CLAUDE ?? 10),
  });
  const jiraRl = new RateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_JIRA ?? 20),
  });
  const runsRl = new RateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: Number(process.env.RATE_LIMIT_RUNS ?? 5),
  });

  // Real AI implementation (or test override). Does NOT handle bypass — that is callClaudeImpl's job.
  const callClaudeCore: (params: { system: string; userContent: string }) => Promise<string> =
    callClaudeOverride ??
    (async ({ system, userContent }: { system: string; userContent: string }) => {
      let savedConfig: PathlightConfig["aiProvider"] | undefined;
      let savedApiKey: string | undefined;
      try {
        savedConfig = (await readConfig(path)).aiProvider;
      } catch {
        // Config not available — fall back to env-based Claude.
      }
      if (savedConfig) {
        try {
          const creds = JSON.parse(await readFile(aiCredentialsPath, "utf8")) as AiCredentials;
          savedApiKey = creds.apiKey;
        } catch {
          // Credentials file may not exist yet.
        }
        // Each provider falls back to its own env var — never cross-pollinate keys.
        const envApiKey =
          savedConfig.provider === "openai"
            ? process.env.OPENAI_API_KEY
            : savedConfig.provider === "gemini"
              ? process.env.GOOGLE_API_KEY
              : savedConfig.provider === "claude"
                ? process.env.ANTHROPIC_API_KEY
                : undefined;
        const provider = createAIProvider({
          provider: savedConfig.provider,
          apiKey: savedApiKey ?? envApiKey,
          model: savedConfig.model,
          ollamaUrl: savedConfig.ollamaUrl ?? process.env.OLLAMA_URL,
        });
        return provider.complete({ system, userContent });
      }
      // Legacy fallback: ANTHROPIC_API_KEY with no saved provider config → use Claude.
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
      return createAIProvider({ provider: "claude", apiKey }).complete({ system, userContent });
    });

  // Wrapper that short-circuits with a task-specific stub when BYPASS_EXTERNAL_AI=true.
  const callClaudeImpl = (params: {
    system: string;
    userContent: string;
    bypass?: string;
  }): Promise<string> => {
    if (process.env.BYPASS_EXTERNAL_AI === "true") {
      return Promise.resolve(params.bypass ?? '{"stub":true}');
    }
    return callClaudeCore({ system: params.system, userContent: params.userContent });
  };

  app.use(express.json());

  if (localToken) {
    const authMiddleware = createLocalAuthMiddleware(localToken);
    app.use((req, res, next) => {
      if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") {
        next();
        return;
      }
      if (req.path === "/api/events") {
        next();
        return;
      }
      authMiddleware(req, res, next);
    });
  }

  app.get("/api/local-token", (request, response) => {
    if (!localToken) {
      response.status(404).json({ error: "Local auth not configured." });
      return;
    }
    // Refuse to serve the token when the server is bound to a non-loopback address.
    // A non-loopback binding indicates hosted/multi-user mode where the local-auth
    // token must never be exposed over the network.
    const binding = process.env.PATHLIGHT_HOST ?? "127.0.0.1";
    if (!["127.0.0.1", "localhost", "::1"].includes(binding)) {
      response.status(404).json({ error: "Local auth not available in hosted mode." });
      return;
    }
    // Reject cross-origin requests so a malicious web page can't harvest the token.
    const origin = request.headers.origin;
    if (origin) {
      const allowed = SELF_BASE_URL;
      if (origin !== allowed) {
        response.status(403).json({ error: "Forbidden" });
        return;
      }
    }
    response.json({ token: localToken });
  });

  app.get("/api/config", async (_request, response) => {
    if (!(await hasConfig(path))) {
      response.json({ configured: false, config: null, configPath: path });
      return;
    }

    try {
      const config = await readConfig(path);
      response.json({ configured: true, config, configPath: path });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({
        error: `Unable to read configuration at ${path}: ${reason}`,
      });
    }
  });

  async function projectLocationErrors(
    targetProjectRoot: unknown,
    configPathValue: unknown,
    requireConfig: boolean,
  ) {
    const errors: string[] = [];
    const target = typeof targetProjectRoot === "string" ? targetProjectRoot.trim() : "";
    const playwrightConfigPath =
      typeof configPathValue === "string" && configPathValue.trim()
        ? configPathValue.trim()
        : "playwright.config.ts";
    if (!target) {
      errors.push("Project root is required.");
    } else if (!isAbsolute(target)) {
      errors.push("Project root must be an absolute path.");
    } else if (!(await directoryExists(target))) {
      errors.push("Directory not found. Check the path and try again.");
    }
    if (isAbsolute(playwrightConfigPath)) {
      errors.push("Playwright config path must be relative to Project root.");
    } else if (
      target &&
      isAbsolute(target) &&
      relative(target, resolve(target, playwrightConfigPath)).startsWith("..")
    ) {
      errors.push("Playwright config path must be inside the project root.");
    } else if (
      requireConfig &&
      errors.length === 0 &&
      !(await fileExists(join(target, playwrightConfigPath)))
    ) {
      errors.push("playwright.config.ts not found. Check your playwrightConfigPath.");
    }
    return { errors, target, playwrightConfigPath };
  }

  app.post("/api/config/validate-project-root", async (request, response) => {
    const { errors } = await projectLocationErrors(request.body.projectRoot, undefined, false);
    if (errors.length > 0) {
      response.status(400).json({ error: errors[0] });
      return;
    }
    response.json({ valid: true });
  });

  app.post("/api/config/verify-playwright", async (request, response) => {
    const { errors, target } = await projectLocationErrors(
      request.body.projectRoot,
      request.body.playwrightConfigPath,
      true,
    );
    if (errors.length > 0) {
      response.status(400).json({ error: errors[0] });
      return;
    }
    try {
      const version = verifyPlaywright(target).match(/Version\s+([^\s]+)/)?.[1] ?? "installed";
      response.json({ message: `Playwright ${version} found` });
    } catch {
      response.status(400).json({
        error:
          "Playwright was not found in this project. Install it with npm install -D @playwright/test.",
      });
    }
  });

  app.put("/api/config", async (request, response) => {
    const { errors, name, key } = validateProjectIdentity(
      request.body.projectName,
      request.body.projectKey,
    );
    const location = await projectLocationErrors(
      request.body.projectRoot,
      request.body.playwrightConfigPath,
      true,
    );
    const validationErrors = [...errors, ...location.errors];
    if (validationErrors.length > 0) {
      response.status(400).json({ errors: validationErrors });
      return;
    }

    if ((await hasConfig(path)) && request.body.confirmOverwrite !== true) {
      response.status(409).json({ error: "CONFIRM_OVERWRITE_REQUIRED" });
      return;
    }

    const existingConfig = (await hasConfig(path)) ? await readConfig(path) : null;
    const config: PathlightConfig = {
      ...existingConfig,
      schemaVersion: "1.0",
      project: { name, key },
      server: { host: "127.0.0.1", port: 4242 },
      projectRoot: location.target,
      playwrightConfigPath: location.playwrightConfigPath,
    };

    try {
      await writeConfig(path, config);
      response.json({ saved: true, configPath: path, config });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({
        error: `Unable to write configuration at ${path}: ${reason}`,
      });
    }
  });

  app.get("/api/logo", async (_request, response) => {
    try {
      const config = await readConfig(path);
      if (!config.logoPath) {
        response.sendStatus(404);
        return;
      }
      const logoPath = join(projectRoot, config.logoPath);
      await access(logoPath);
      response.sendFile(logoPath, { dotfiles: "allow" });
    } catch {
      response.sendStatus(404);
    }
  });

  app.post("/api/logo", upload.single("logo"), async (request, response) => {
    const file = request.file;
    if (!file || !["image/png", "image/jpeg"].includes(file.mimetype)) {
      response.status(400).json({ error: "Only PNG and JPG logos are accepted." });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      const size = (file.size / (1024 * 1024)).toFixed(2);
      response.status(400).json({ error: `Logo must be under 2MB. This file is ${size}MB.` });
      return;
    }

    const extension = file.mimetype === "image/png" ? "png" : "jpg";
    const relativeLogoPath = `.pathlight/logo.${extension}`;
    try {
      const config = await readConfig(path);
      await mkdir(pathlightDirectory, { recursive: true });
      await rm(join(pathlightDirectory, "logo.png"), { force: true });
      await rm(join(pathlightDirectory, "logo.jpg"), { force: true });
      await writeFile(join(projectRoot, relativeLogoPath), file.buffer);
      config.logoPath = relativeLogoPath;
      await writeConfig(path, config);
      response.json({ logoPath: relativeLogoPath });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: `Unable to store logo: ${reason}` });
    }
  });

  app.get("/api/jira/status", async (_request, response) => {
    let mockEnabled = false;
    try {
      mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
    } catch {
      // Config errors are surfaced on the configuration endpoint.
    }
    try {
      const token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as {
        cloudId: string;
        expiresAt?: string;
      };
      if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
        response.json({
          status: "expired",
          cloudId: token.cloudId,
          message: "JIRA connection expired — reconnect",
          mockEnabled,
        });
        return;
      }
      response.json({ status: "connected", cloudId: token.cloudId, mockEnabled });
    } catch {
      response.json({ status: "not_connected", mockEnabled });
    }
  });

  app.put("/api/jira/mock", async (request, response) => {
    try {
      const config = await readConfig(path);
      config.PATHLIGHT_JIRA_MOCK = request.body.enabled === true;
      await writeConfig(path, config);
      response.json({ mockEnabled: config.PATHLIGHT_JIRA_MOCK });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: `Unable to update JIRA mock setting: ${reason}` });
    }
  });

  app.post("/api/jira/connect", async (_request, response) => {
    if (!jira.clientId || !jira.redirectUri) {
      response.status(503).json({ error: "JIRA OAuth is not configured." });
      return;
    }
    const codeVerifier = base64Url(randomBytes(32));
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    const state = base64Url(randomBytes(32));
    await mkdir(authDirectory, { recursive: true });
    await writeFile(oauthStatePath, JSON.stringify({ codeVerifier, state }), "utf8");
    const authorizationUrl = new URL("https://auth.atlassian.com/authorize");
    authorizationUrl.searchParams.set("audience", "api.atlassian.com");
    authorizationUrl.searchParams.set("client_id", jira.clientId);
    authorizationUrl.searchParams.set("scope", "read:jira-work read:jira-user");
    authorizationUrl.searchParams.set("redirect_uri", jira.redirectUri);
    authorizationUrl.searchParams.set("state", state);
    authorizationUrl.searchParams.set("response_type", "code");
    authorizationUrl.searchParams.set("prompt", "consent");
    authorizationUrl.searchParams.set("code_challenge", codeChallenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
    response.json({ authorizationUrl: authorizationUrl.toString() });
  });

  app.get("/api/jira/callback", async (request, response) => {
    if (typeof request.query.error === "string") {
      response.redirect("/config?jira=denied");
      return;
    }
    try {
      const storedState = JSON.parse(await readFile(oauthStatePath, "utf8")) as {
        codeVerifier: string;
        state: string;
      };
      if (request.query.state !== storedState.state) {
        await rm(oauthStatePath, { force: true });
        response.redirect("/config?jira=csrf");
        return;
      }
      if (!jira.clientId || !jira.redirectUri || typeof request.query.code !== "string") {
        response.redirect("/config?jira=error");
        return;
      }
      const jiraFetch = jira.fetch ?? fetch;
      const tokenResponse = await jiraFetch("https://auth.atlassian.com/oauth/token", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          grant_type: "authorization_code",
          client_id: jira.clientId,
          code: request.query.code,
          redirect_uri: jira.redirectUri,
          code_verifier: storedState.codeVerifier,
        }),
      });
      if (!tokenResponse.ok) {
        throw new Error("Token exchange failed.");
      }
      const token = (await tokenResponse.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };
      const resourcesResponse = await jiraFetch(
        "https://api.atlassian.com/oauth/token/accessible-resources",
        { headers: { Authorization: `Bearer ${token.access_token}` } },
      );
      if (!resourcesResponse.ok) {
        throw new Error("Cloud discovery failed.");
      }
      const resources = (await resourcesResponse.json()) as Array<{ id: string }>;
      const cloudId = resources[0]?.id;
      if (!cloudId) {
        throw new Error("No accessible JIRA resource found.");
      }
      await writeFile(
        jiraTokenPath,
        JSON.stringify({
          ...token,
          cloudId,
          expiresAt: new Date(Date.now() + token.expires_in * 1000).toISOString(),
        }),
        { mode: 0o600 },
      );
      await chmod(jiraTokenPath, 0o600);
      await rm(oauthStatePath, { force: true });
      response.redirect("/config?jira=connected");
    } catch {
      response.redirect("/config?jira=error");
    }
  });

  app.delete("/api/jira/connection", async (_request, response) => {
    await unlink(jiraTokenPath).catch(() => undefined);
    response.json({ status: "not_connected" });
  });

  function extractAdfText(node: unknown): string {
    if (!node || typeof node !== "object") return "";
    const obj = node as Record<string, unknown>;
    if (obj.type === "text" && typeof obj.text === "string") return obj.text;
    if (Array.isArray(obj.content)) {
      return obj.content.map(extractAdfText).join(" ").replace(/\s+/g, " ").trim();
    }
    return "";
  }

  const MOCK_JIRA_STORIES = [
    {
      key: "ZOV-12",
      summary: "Business can request a review from a customer via SMS",
      description:
        "As a business owner, I can send a review request SMS to a customer after service so that I can collect their feedback.\nAcceptance criteria:\n- SMS is sent to the customer's mobile number\n- Message contains the business name and a unique review link\n- Business receives confirmation the SMS was queued",
      status: "Done",
      epic: "Core SMS Review Flow",
      epicKey: "ZOV-1",
      excluded: false,
    },
    {
      key: "ZOV-13",
      summary: "Customer can submit a star rating and text review via the review link",
      description:
        "As a customer, I can open the review link and submit a rating so that my feedback is recorded.\nAcceptance criteria:\n- Review page loads without authentication\n- Customer selects 1-5 stars\n- Optional text comment up to 500 characters\n- Submission confirmation shown\n- Review stored and visible to business",
      status: "Done",
      epic: "Core SMS Review Flow",
      epicKey: "ZOV-1",
      excluded: false,
    },
    {
      key: "ZOV-14",
      summary: "Customer can opt out of future review requests",
      description:
        "As a customer, I can opt out of receiving further review request SMS so that I am not contacted again.\nAcceptance criteria:\n- Opt-out link present in every review request SMS\n- Opt-out is confirmed on-screen\n- Business cannot send further requests to opted-out number\n- Opt-out persists across business accounts",
      status: "Done",
      epic: "Core SMS Review Flow",
      epicKey: "ZOV-1",
      excluded: false,
    },
    {
      key: "ZOV-20",
      summary: "Business can view analytics dashboard showing review metrics",
      description:
        "As a business owner, I can view a dashboard of my review performance so that I can track customer satisfaction trends.\nAcceptance criteria:\n- Dashboard shows: total reviews, average rating, response rate, rating distribution\n- Data filterable by date range (7d, 30d, 90d, custom)\n- Metrics update within 5 minutes of new review submission",
      status: "Done",
      epic: "Analytics",
      epicKey: "ZOV-5",
      excluded: false,
    },
    {
      key: "ZOV-21",
      summary: "Business can view list of all received reviews with filter and search",
      description:
        "As a business owner, I can browse all reviews submitted so that I can read individual customer feedback.\nAcceptance criteria:\n- Review list shows: date, customer (masked), star rating, comment\n- Filterable by star rating and date range\n- Searchable by comment text\n- Paginated at 25 per page",
      status: "In Progress",
      epic: "Analytics",
      epicKey: "ZOV-5",
      excluded: false,
    },
    {
      key: "ZOV-30",
      summary: "Business owner can register and create an account",
      description:
        "As a new user, I can create a Zovku account so that I can start sending review requests.\nAcceptance criteria:\n- Registration form collects: business name, email, password, mobile number\n- Email verification required before first login\n- Password must be 8+ characters with at least one number\n- Duplicate email is rejected with clear message",
      status: "Done",
      epic: "Auth & Onboarding",
      epicKey: "ZOV-3",
      excluded: false,
    },
  ];

  app.get("/api/jira/stories", async (_request, response) => {
    try {
      const cached = JSON.parse(await readFile(storiesPath, "utf8")) as {
        fetchedAt: string;
        jiraProjectKey: string;
        stories: unknown[];
      };
      response.json(cached);
    } catch {
      response.json({ fetchedAt: null, jiraProjectKey: null, stories: [] });
    }
  });

  app.post("/api/jira/fetch-stories", async (request, response) => {
    if (!jiraRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    const jiraProjectKey =
      typeof request.body.jiraProjectKey === "string" ? request.body.jiraProjectKey.trim() : "";
    if (!jiraProjectKey) {
      response.status(400).json({ error: "jiraProjectKey is required." });
      return;
    }
    if (!JIRA_PROJECT_KEY_RE.test(jiraProjectKey)) {
      response.status(400).json({
        error:
          "jiraProjectKey must be 2-10 uppercase letters/numbers starting with a letter (e.g. PROJ).",
      });
      return;
    }

    let mockEnabled = false;
    try {
      mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
    } catch {
      // Config errors are surfaced on the configuration endpoint.
    }

    if (mockEnabled) {
      const cache = {
        fetchedAt: new Date().toISOString(),
        jiraProjectKey,
        stories: MOCK_JIRA_STORIES,
      };
      await writeFile(storiesPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
      response.json({ storyCount: MOCK_JIRA_STORIES.length, fetchedAt: cache.fetchedAt });
      return;
    }

    let token: { access_token: string; cloudId: string; expiresAt?: string };
    try {
      token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as typeof token;
      if (token.expiresAt && Date.parse(token.expiresAt) <= Date.now()) {
        response.status(401).json({ error: "JIRA connection expired — reconnect first." });
        return;
      }
    } catch {
      response.status(401).json({ error: "JIRA not connected. Connect JIRA first." });
      return;
    }

    const jiraFetch = jira.fetch ?? fetch;
    const baseJiraUrl =
      `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/search` +
      `?jql=${encodeURIComponent(`project = ${jiraProjectKey} AND issuetype = Story ORDER BY created DESC`)}` +
      `&fields=key,summary,description,status,priority,parent,customfield_10014` +
      `&maxResults=50`;

    type JiraIssue = {
      key: string;
      fields: {
        summary: string;
        description: unknown;
        status: { name: string };
        parent?: { key: string; fields?: { summary: string } };
        customfield_10014?: string;
      };
    };
    let allIssues: JiraIssue[] = [];
    let startAt = 0;
    let total = Infinity;
    while (allIssues.length < total) {
      const pageResponse = await jiraFetch(`${baseJiraUrl}&startAt=${startAt}`, {
        headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
      });
      if (!pageResponse.ok) {
        const body = await pageResponse.text();
        response
          .status(502)
          .json({ error: `JIRA API error ${pageResponse.status}: ${body.slice(0, 200)}` });
        return;
      }
      const page = (await pageResponse.json()) as { total: number; issues: JiraIssue[] };
      total = page.total;
      if (page.issues.length === 0) break;
      allIssues = allIssues.concat(page.issues);
      startAt += page.issues.length;
    }

    const stories = allIssues.map((issue) => ({
      key: issue.key,
      summary: issue.fields.summary,
      description:
        typeof issue.fields.description === "string"
          ? issue.fields.description
          : extractAdfText(issue.fields.description),
      status: issue.fields.status.name,
      epic: issue.fields.parent?.fields?.summary ?? issue.fields.customfield_10014 ?? null,
      epicKey: issue.fields.parent?.key ?? null,
      excluded: false,
    }));

    const cache = { fetchedAt: new Date().toISOString(), jiraProjectKey, stories };
    await writeFile(storiesPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    response.json({ storyCount: stories.length, fetchedAt: cache.fetchedAt });
  });

  app.patch("/api/jira/stories/:key", async (request, response) => {
    let cache: {
      fetchedAt: string;
      jiraProjectKey: string;
      stories: Array<{ key: string; excluded: boolean }>;
    };
    try {
      cache = JSON.parse(await readFile(storiesPath, "utf8")) as typeof cache;
    } catch {
      response.status(404).json({ error: "No stories cached. Fetch stories first." });
      return;
    }
    const story = cache.stories.find((s) => s.key === request.params.key);
    if (!story) {
      response.status(404).json({ error: "Story not found." });
      return;
    }
    if (typeof request.body.excluded === "boolean") {
      story.excluded = request.body.excluded;
    }
    await writeFile(storiesPath, `${JSON.stringify(cache, null, 2)}\n`, "utf8");
    response.json({ key: story.key, excluded: story.excluded });
  });

  app.get("/api/journeys/template", (_request, response) => {
    response.attachment("pathlight-journeys-template.csv").type("text/csv").send(JOURNEY_TEMPLATE);
  });

  function uploadError(file: Express.Multer.File | undefined) {
    return !file || !file.originalname.toLowerCase().endsWith(".csv")
      ? ["Only .csv files are accepted."]
      : null;
  }

  app.post("/api/journeys/validate", upload.single("journeys"), (request, response) => {
    const fileErrors = uploadError(request.file);
    if (fileErrors) {
      response.status(400).json({ valid: false, error: fileErrors[0], errors: fileErrors });
      return;
    }
    const result = validateJourneyCsv(request.file!.buffer.toString("utf8"));
    if (!result.valid) {
      response.status(422).json({ valid: false, errors: result.errors });
      return;
    }
    response.json({ valid: true, ...summarizeJourneys(result.rows) });
  });

  app.post("/api/journeys/import", upload.single("journeys"), async (request, response) => {
    const fileErrors = uploadError(request.file);
    if (fileErrors) {
      response.status(400).json({ valid: false, error: fileErrors[0], errors: fileErrors });
      return;
    }
    try {
      if (await hasConfig(manifestPath)) {
        const existingManifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
        if (existingManifest.lockedAt) {
          response.status(409).json({ error: "Unlock the manifest before importing journeys." });
          return;
        }
      }
      const result = validateJourneyCsv(request.file!.buffer.toString("utf8"));
      if (!result.valid) {
        response.status(422).json({ valid: false, errors: result.errors });
        return;
      }
      const config = await readConfig(path);
      const manifest = generateManifest(config.project.key, result.rows);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
      const summary = summarizeJourneys(result.rows);
      response.json({
        manifest,
        ...summary,
        message: `${summary.journeyCount} journeys imported across ${Object.keys(summary.stages).length} ${Object.keys(summary.stages).length === 1 ? "stage" : "stages"}. Manifest ready to lock.`,
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: `Unable to import journeys: ${reason}` });
    }
  });

  app.post("/api/journeys/derive", async (_request, response) => {
    if (!claudeRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response
        .status(503)
        .json({ error: "ANTHROPIC_API_KEY is not set. Add it to your .env file." });
      return;
    }

    let storiesCache: {
      stories: Array<{
        key: string;
        summary: string;
        description: string | null;
        status: string;
        epic: string | null;
        excluded: boolean;
      }>;
    };
    try {
      storiesCache = JSON.parse(await readFile(storiesPath, "utf8")) as typeof storiesCache;
    } catch {
      response.status(400).json({ error: "No stories cached. Fetch stories from JIRA first." });
      return;
    }

    const included = storiesCache.stories.filter((s) => !s.excluded);
    if (included.length === 0) {
      response
        .status(400)
        .json({ error: "All stories are excluded. Include at least one story before deriving." });
      return;
    }

    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      response.status(400).json({ error: "Pathlight not configured." });
      return;
    }

    const storiesText = included
      .map(
        (s, i) =>
          `${i + 1}. Key: ${s.key}\n   Summary: ${s.summary}\n   Epic: ${s.epic ?? "Unknown"}\n   Status: ${s.status}\n   Description: ${s.description?.slice(0, 600) ?? "(none)"}`,
      )
      .join("\n\n");

    const systemPrompt = `You are a QA architect. Given JIRA user stories, derive testable end-to-end user journeys.

Rules:
- Every journey has exactly one branchType: happy, unhappy, edge, boundary, or system
- At least one happy path journey per story
- Unhappy paths from negative acceptance criteria only
- Edge cases from boundary conditions in acceptance criteria
- Maximum 5 journeys per story — pick the most impactful
- Journey labels are plain English (no jargon: no API, endpoint, database, null, 422, HTTP)
- stage is a short key like S1, S2, S3 derived from the epic group
- stageName is the human-readable stage label derived from the epic group
- module is the feature area name (e.g. "Review Flow", "Auth", "Analytics")
- IDs are sequential E2E-NNN starting at E2E-001
- flagged: true only when story has no acceptance criteria and journey is derived from summary only
- businessRules: compliance or constraint rules implied by the acceptance criteria

Respond with ONLY a JSON object in this exact structure, no commentary:
{
  "journeys": [
    {
      "id": "E2E-001",
      "label": "...",
      "branchType": "happy",
      "stage": "S1",
      "stageName": "...",
      "module": "...",
      "sourceStoryKey": "PROJ-123",
      "flagged": false
    }
  ],
  "businessRules": [
    {
      "label": "...",
      "severity": "low|medium|high|critical",
      "description": "...",
      "jurisdiction": "...",
      "sourceRef": "PROJ-123",
      "appliesToJourneyIds": ["E2E-001", "E2E-007"]
    }
  ]
}`;

    let derived: {
      journeys: Array<{
        id: string;
        label: string;
        branchType: string;
        stage: string;
        stageName: string;
        module: string;
        sourceStoryKey: string;
        flagged: boolean;
      }>;
      businessRules: Array<{
        label: string;
        severity: string;
        description: string;
        jurisdiction?: string;
        sourceRef?: string;
        appliesToJourneyIds?: string[];
      }>;
    };

    try {
      const text = await callClaudeImpl({
        system: systemPrompt,
        userContent: `Project: ${config.project.name}\n\nStories:\n\n${storiesText}`,
        bypass: '{"journeys":[],"businessRules":[]}',
      });
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        throw new Error("Claude response did not contain a JSON object.");
      }
      derived = JSON.parse(jsonMatch[0]) as typeof derived;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(502).json({ error: `Claude derivation failed: ${reason}` });
      return;
    }

    const BRANCH_TYPES_SET = new Set(["happy", "unhappy", "edge", "boundary", "system"]);
    const draftNodes: DraftNode[] = derived.journeys
      .filter((j) => j.id && j.label && BRANCH_TYPES_SET.has(j.branchType))
      .map((j) => ({
        schemaVersion: "1.0" as const,
        id: j.id,
        projectKey: config.project.key,
        stage: j.stage,
        stageName: j.stageName,
        module: j.module,
        priority: "Medium",
        priorityRank: 1,
        storyTitle: j.label,
        storyHash: createHash("sha256")
          .update(j.id + j.label)
          .digest("hex"),
        branchType: j.branchType as DraftNode["branchType"],
        label: j.label,
        risk: "medium" as const,
        businessRuleIds: [],
        testFiles: [],
        tags: [],
        linkedStories: j.sourceStoryKey ? [j.sourceStoryKey] : [],
        draftState: "draft" as const,
        sourceStoryKey: j.sourceStoryKey,
        flagged: j.flagged,
      }));

    const draftManifest: DraftManifest = {
      schemaVersion: "1.0",
      projectKey: config.project.key,
      createdAt: new Date().toISOString(),
      nodes: draftNodes,
      suggestedBusinessRules: derived.businessRules.map((r) => ({
        label: r.label,
        severity: (["low", "medium", "high", "critical"].includes(r.severity)
          ? r.severity
          : "medium") as DraftManifest["suggestedBusinessRules"][number]["severity"],
        description: r.description,
        jurisdiction: r.jurisdiction,
        sourceRef: r.sourceRef,
        appliesToJourneyIds: Array.isArray(r.appliesToJourneyIds)
          ? r.appliesToJourneyIds.filter((id): id is string => typeof id === "string")
          : [],
      })),
    };

    await writeFile(draftManifestPath, `${JSON.stringify(draftManifest, null, 2)}\n`, "utf8");
    response.json({ journeyCount: draftNodes.length, createdAt: draftManifest.createdAt });
  });

  app.get("/api/manifest", async (_request, response) => {
    try {
      response.json(JSON.parse(await readFile(manifestPath, "utf8")));
    } catch {
      response.sendStatus(404);
    }
  });

  app.post("/api/manifest/validate", (request, response) => {
    const errors = validateManifest(request.body);
    response
      .status(errors.length === 0 ? 200 : 422)
      .json(errors.length === 0 ? { valid: true } : { valid: false, errors });
  });

  app.post("/api/manifest/lock", async (request, response) => {
    const manifest = request.body.manifest as ManifestFile | undefined;
    const errors = validateManifest(manifest);
    if (errors.length > 0) {
      response.status(422).json({ valid: false, errors });
      return;
    }
    try {
      if (await hasConfig(manifestPath)) {
        const stored = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
        if (stored.lockedAt && stored.lockedAt !== request.body.currentLockedAt) {
          response.status(409).json({
            error: "MANIFEST_LOCK_CONFLICT",
            currentLockedAt: stored.lockedAt,
          });
          return;
        }
      }
      const lockedAt = new Date().toISOString();
      const lockedBy = lockingIdentity(projectRoot, identity);
      const locked = { ...manifest!, lockedAt, lockedBy };
      await writeFile(manifestPath, `${JSON.stringify(locked, null, 2)}\n`, "utf8");
      response.json({ lockedAt, lockedBy });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: `Unable to lock manifest: ${reason}` });
    }
  });

  app.post("/api/manifest/unlock", async (request, response) => {
    if (request.body.confirm !== true) {
      response.status(400).json({ error: "UNLOCK_CONFIRMATION_REQUIRED" });
      return;
    }
    try {
      const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
      const unlocked = { ...manifest, lockedAt: null, lockedBy: null };
      await writeFile(manifestPath, `${JSON.stringify(unlocked, null, 2)}\n`, "utf8");
      response.json({ locked: false, manifest: unlocked });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(500).json({ error: `Unable to unlock manifest: ${reason}` });
    }
  });

  app.get("/api/manifest/draft", async (_request, response) => {
    try {
      response.json(JSON.parse(await readFile(draftManifestPath, "utf8")));
    } catch {
      response.sendStatus(404);
    }
  });

  app.patch("/api/manifest/draft/journeys/:id", async (request, response) => {
    let draft: DraftManifest;
    try {
      draft = JSON.parse(await readFile(draftManifestPath, "utf8")) as DraftManifest;
    } catch {
      response.status(404).json({ error: "No draft manifest found." });
      return;
    }
    const node = draft.nodes.find((n) => n.id === request.params.id);
    if (!node) {
      response.status(404).json({ error: "Journey not found in draft." });
      return;
    }
    if (request.body.draftState === "approved" || request.body.draftState === "rejected") {
      node.draftState = request.body.draftState as DraftNode["draftState"];
    }
    if (typeof request.body.label === "string" && request.body.label.trim()) {
      node.label = request.body.label.trim();
      node.storyTitle = node.label;
    }
    if (
      typeof request.body.branchType === "string" &&
      ["happy", "unhappy", "edge", "boundary", "system"].includes(request.body.branchType)
    ) {
      node.branchType = request.body.branchType as DraftNode["branchType"];
    }
    await writeFile(draftManifestPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    response.json(node);
  });

  app.post("/api/manifest/draft/journeys", async (request, response) => {
    let draft: DraftManifest;
    try {
      draft = JSON.parse(await readFile(draftManifestPath, "utf8")) as DraftManifest;
    } catch {
      response.status(404).json({ error: "No draft manifest found. Run derive first." });
      return;
    }
    const {
      label,
      branchType,
      stage,
      stageName,
      module: mod,
      sourceStoryKey,
    } = request.body as Record<string, unknown>;
    if (typeof label !== "string" || !label.trim()) {
      response.status(400).json({ error: "label is required." });
      return;
    }
    if (
      typeof branchType !== "string" ||
      !["happy", "unhappy", "edge", "boundary", "system"].includes(branchType)
    ) {
      response
        .status(400)
        .json({ error: "branchType must be one of: happy, unhappy, edge, boundary, system." });
      return;
    }
    if (typeof stage !== "string" || !stage.trim()) {
      response.status(400).json({ error: "stage is required." });
      return;
    }
    if (typeof stageName !== "string" || !stageName.trim()) {
      response.status(400).json({ error: "stageName is required." });
      return;
    }
    if (typeof mod !== "string" || !mod.trim()) {
      response.status(400).json({ error: "module is required." });
      return;
    }

    const existingNums = draft.nodes
      .map((n) => parseInt(n.id.replace(/^[A-Z0-9]+-/, ""), 10))
      .filter((n) => !isNaN(n));
    const next = existingNums.length > 0 ? Math.max(...existingNums) + 1 : 1;
    const id = `E2E-${String(next).padStart(3, "0")}`;

    const node: DraftNode = {
      schemaVersion: "1.0",
      id,
      projectKey: draft.projectKey,
      stage: (stage as string).trim(),
      stageName: (stageName as string).trim(),
      module: (mod as string).trim(),
      priority: "Medium",
      priorityRank: 1,
      storyTitle: (label as string).trim(),
      storyHash: createHash("sha256")
        .update(id + label)
        .digest("hex"),
      branchType: branchType as DraftNode["branchType"],
      label: (label as string).trim(),
      risk: "medium",
      businessRuleIds: [],
      testFiles: [],
      tags: [],
      linkedStories:
        typeof sourceStoryKey === "string" && sourceStoryKey.trim() ? [sourceStoryKey.trim()] : [],
      draftState: "draft",
      sourceStoryKey: typeof sourceStoryKey === "string" ? sourceStoryKey.trim() : undefined,
    };
    draft.nodes.push(node);
    await writeFile(draftManifestPath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");
    response.status(201).json(node);
  });

  app.post("/api/manifest/lock-from-draft", async (_request, response) => {
    let draft: DraftManifest;
    try {
      draft = JSON.parse(await readFile(draftManifestPath, "utf8")) as DraftManifest;
    } catch {
      response.status(404).json({ error: "No draft manifest found." });
      return;
    }
    const unapproved = draft.nodes.filter((n) => n.draftState === "draft");
    if (unapproved.length > 0) {
      response.status(409).json({
        error: `${unapproved.length} journey${unapproved.length === 1 ? "" : "s"} still in draft state. Approve or reject all journeys before locking.`,
      });
      return;
    }
    const approvedNodes = draft.nodes.filter((n) => n.draftState === "approved");
    if (approvedNodes.length === 0) {
      response
        .status(400)
        .json({ error: "No journeys approved. Approve at least one journey before locking." });
      return;
    }

    const lockedAt = new Date().toISOString();
    const lockedBy = lockingIdentity(projectRoot, identity);
    const rulesWithIds = (draft.suggestedBusinessRules ?? []).map((r) => ({
      id: `BR-${createHash("sha256")
        .update(r.label + (r.description ?? ""))
        .digest("hex")
        .slice(0, 6)
        .toUpperCase()}`,
      label: r.label,
      severity: r.severity,
      description: r.description,
      jurisdiction: r.jurisdiction,
      sourceRef: r.sourceRef,
    }));
    const journeyRuleIds = new Map<string, string[]>();
    (draft.suggestedBusinessRules ?? []).forEach((r, i) => {
      const ruleId = rulesWithIds[i].id;
      for (const journeyId of r.appliesToJourneyIds ?? []) {
        const existing = journeyRuleIds.get(journeyId) ?? [];
        existing.push(ruleId);
        journeyRuleIds.set(journeyId, existing);
      }
    });
    const manifest: ManifestFile = {
      schemaVersion: "1.0",
      projectKey: draft.projectKey,
      lockedAt,
      lockedBy,
      businessRules: rulesWithIds,
      nodes: approvedNodes.map(
        ({ draftState: _ds, sourceStoryKey: _sk, flagged: _fl, ...node }) => ({
          ...node,
          businessRuleIds: journeyRuleIds.get(node.id) ?? [],
        }),
      ),
    };
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await mkdir(pathlightDirectory, { recursive: true });
    const archivePath = join(pathlightDirectory, `draft-archive-${Date.now()}.json`);
    await writeFile(archivePath, `${JSON.stringify(draft, null, 2)}\n`, "utf8");

    response.json({ lockedAt, lockedBy, journeyCount: approvedNodes.length });
  });

  const SCAN_EXCLUDED = new Set(["node_modules", ".auth", "fixtures", "setup", "teardown", ".git"]);
  const SPEC_PATTERN = /\.(spec|test)\.(js|ts|mjs|mts|cjs|cts)$/;

  function extractTestCases(content: string, filePath: string, relPath: string) {
    const results: Array<{ title: string; describe: string; filePath: string; relPath: string }> =
      [];
    const describeStack: string[] = [];
    const lines = content.split("\n");
    for (const line of lines) {
      const describeMatch = line.match(
        /^\s*(?:test\.)?describe(?:\.(?:only|skip))?\s*\(\s*(['"`])(.*?)\1/,
      );
      if (describeMatch) {
        describeStack.push(describeMatch[2]);
        continue;
      }
      if (line.match(/^\s*\}\s*\)/) && describeStack.length > 0) {
        describeStack.pop();
        continue;
      }
      const testMatch = line.match(
        /^\s*(?:test|it)(?:\.(?:only|skip|fixme|fail))?\s*\(\s*(['"`])(.*?)\1/,
      );
      if (testMatch) {
        results.push({
          title: testMatch[2],
          describe: describeStack.join(" > "),
          filePath,
          relPath,
        });
      }
    }
    return results;
  }

  async function scanTestDir(
    absTestDir: string,
    excluded: string[],
  ): Promise<{
    specFiles: string[];
    testCases: Array<{ title: string; describe: string; filePath: string; relPath: string }>;
    folderGroups: Record<string, number>;
    topDescribeBlocks: string[];
  }> {
    const excludedSet = new Set([...SCAN_EXCLUDED, ...excluded]);
    const specFiles: string[] = [];
    const testCases: Array<{ title: string; describe: string; filePath: string; relPath: string }> =
      [];

    async function walk(dir: string) {
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (excludedSet.has(entry.name)) continue;
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
        } else if (entry.isFile() && SPEC_PATTERN.test(entry.name)) {
          const rel = relative(absTestDir, full);
          specFiles.push(full);
          try {
            const content = await readFile(full, "utf8");
            testCases.push(...extractTestCases(content, full, rel));
          } catch {
            // Unreadable files are skipped silently.
          }
        }
      }
    }

    await walk(absTestDir);

    const folderGroups: Record<string, number> = {};
    for (const tc of testCases) {
      const folder = tc.relPath.split("/")[0] ?? ".";
      folderGroups[folder] = (folderGroups[folder] ?? 0) + 1;
    }
    const topDescribeBlocks = [
      ...new Set(testCases.map((tc) => tc.describe).filter(Boolean)),
    ].sort();
    return { specFiles, testCases, folderGroups, topDescribeBlocks };
  }

  app.get("/api/tests/scan", async (_request, response) => {
    try {
      response.json(JSON.parse(await readFile(testScanPath, "utf8")));
    } catch {
      response.json({
        scannedAt: null,
        testDir: null,
        specFiles: [],
        testCases: [],
        folderGroups: {},
        excludedFolders: [],
        topDescribeBlocks: [],
      });
    }
  });

  app.post("/api/tests/scan", async (request, response) => {
    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      response.status(400).json({ error: "Pathlight not configured." });
      return;
    }
    if (!config.projectRoot) {
      response.status(400).json({ error: "Project root is not set." });
      return;
    }

    const rawTestDir =
      typeof request.body.testDir === "string"
        ? request.body.testDir.trim()
        : (config.testDir ?? "");
    if (!rawTestDir) {
      response.status(400).json({ error: "testDir is required." });
      return;
    }

    if (isAbsolute(rawTestDir)) {
      response.status(400).json({ error: "testDir must be a path relative to project root." });
      return;
    }
    const absTestDir = resolve(config.projectRoot!, rawTestDir);
    if (!absTestDir.startsWith(config.projectRoot! + "/")) {
      response.status(400).json({ error: "testDir must be within project root." });
      return;
    }
    if (!(await directoryExists(absTestDir))) {
      response.status(400).json({ error: `Test directory not found: ${absTestDir}` });
      return;
    }

    const excludedFolders: string[] = Array.isArray(request.body.excludedFolders)
      ? (request.body.excludedFolders as unknown[]).filter(
          (f): f is string => typeof f === "string",
        )
      : [];

    if (typeof request.body.testDir === "string" && request.body.testDir.trim()) {
      config.testDir = rawTestDir;
      await writeConfig(path, config);
    }

    const { specFiles, testCases, folderGroups, topDescribeBlocks } = await scanTestDir(
      absTestDir,
      excludedFolders,
    );
    const result = {
      scannedAt: new Date().toISOString(),
      testDir: rawTestDir,
      specFiles: specFiles.map((f) => relative(config.projectRoot!, f)),
      testCases,
      folderGroups,
      topDescribeBlocks,
      excludedFolders,
    };
    await writeFile(testScanPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    response.json({
      scannedAt: result.scannedAt,
      specFileCount: specFiles.length,
      testCaseCount: testCases.length,
      folderGroups,
      topDescribeBlocks,
      excludedFolders,
    });
  });

  app.get("/api/mapping", async (_request, response) => {
    try {
      response.json(JSON.parse(await readFile(testMappingPath, "utf8")));
    } catch {
      response.json({ derivedAt: null, mappings: [], unmappedJourneys: [] });
    }
  });

  app.post("/api/mapping/derive", async (_request, response) => {
    if (!claudeRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response
        .status(503)
        .json({ error: "ANTHROPIC_API_KEY is not set. Add it to your .env file." });
      return;
    }

    let scan: { testCases: Array<{ title: string; describe: string; relPath: string }> };
    try {
      scan = JSON.parse(await readFile(testScanPath, "utf8")) as typeof scan;
    } catch {
      response.status(400).json({ error: "No test scan found. Scan your test suite first." });
      return;
    }
    if (!scan.testCases || scan.testCases.length === 0) {
      response
        .status(400)
        .json({ error: "No test cases found in scan. Scan your test suite first." });
      return;
    }

    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      response
        .status(400)
        .json({ error: "No locked manifest found. Lock your journey manifest first." });
      return;
    }
    if (!manifest.lockedAt) {
      response.status(400).json({ error: "Manifest is not locked. Lock it before mapping tests." });
      return;
    }

    const journeyList = manifest.nodes
      .map(
        (n, i) =>
          `${i + 1}. ID: ${n.id} | Label: ${n.label} | Stage: ${n.stageName} | Module: ${n.module} | Type: ${n.branchType}`,
      )
      .join("\n");

    const testList = scan.testCases
      .map(
        (tc, i) =>
          `${i + 1}. File: ${tc.relPath} | Describe: ${tc.describe || "(none)"} | Title: ${tc.title}`,
      )
      .join("\n");

    const systemPrompt = `You are a QA architect. Map existing Playwright tests to journey IDs based on semantic similarity.

Rules:
- Match tests to journeys by reading the test title, describe block, and file path.
- Confidence levels: "high" = certain match, "medium" = likely match (human review recommended), "low" = possible match but probably needs a new test.
- One test may map to multiple journeys.
- One journey may have multiple matching tests.
- If no test matches a journey, leave it unmapped.
- Only return matches you are genuinely confident about. Prefer fewer high-confidence matches over many low-confidence ones.

Respond with ONLY a JSON object in this exact structure, no commentary:
{
  "mappings": [
    {
      "journeyId": "E2E-001",
      "matchedTests": [
        {
          "testTitle": "...",
          "describe": "...",
          "filePath": "...",
          "confidence": "high",
          "reasoning": "..."
        }
      ]
    }
  ],
  "unmappedJourneyIds": ["E2E-005", "E2E-012"]
}`;

    let derived: {
      mappings: Array<{
        journeyId: string;
        matchedTests: Array<{
          testTitle: string;
          describe: string;
          filePath: string;
          confidence: string;
          reasoning: string;
        }>;
      }>;
      unmappedJourneyIds: string[];
    };

    try {
      const text = await callClaudeImpl({
        system: systemPrompt,
        userContent: `Journeys:\n${journeyList}\n\nTests:\n${testList}`,
        bypass: '{"mappings":[],"unmappedJourneyIds":[]}',
      });
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error("Claude response did not contain a JSON object.");
      derived = JSON.parse(jsonMatch[0]) as typeof derived;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(502).json({ error: `Claude mapping failed: ${reason}` });
      return;
    }

    const CONFIDENCE_SET = new Set(["high", "medium", "low"]);
    const nodeMap = new Map(manifest.nodes.map((n) => [n.id, n.label]));
    const knownTestTitles = new Set(scan.testCases.map((tc) => tc.title.trim().toLowerCase()));
    const filteredMappings = derived.mappings
      .filter((m) => m.journeyId && nodeMap.has(m.journeyId) && Array.isArray(m.matchedTests))
      .map((m) => ({
        journeyId: m.journeyId,
        journeyLabel: nodeMap.get(m.journeyId) ?? m.journeyId,
        matchedTests: m.matchedTests
          .filter(
            (t) =>
              t.testTitle &&
              CONFIDENCE_SET.has(t.confidence) &&
              knownTestTitles.has(t.testTitle.trim().toLowerCase()),
          )
          .map((t) => ({ ...t, approved: false })),
      }))
      .filter((m) => m.matchedTests.length > 0);
    const mappedIds = new Set(filteredMappings.map((m) => m.journeyId));
    const result = {
      derivedAt: new Date().toISOString(),
      mappings: filteredMappings,
      unmappedJourneys: manifest.nodes
        .filter((n) => !mappedIds.has(n.id))
        .map((n) => ({ journeyId: n.id, journeyLabel: n.label })),
    };

    await writeFile(testMappingPath, `${JSON.stringify(result, null, 2)}\n`, "utf8");
    response.json({
      derivedAt: result.derivedAt,
      mappedCount: result.mappings.length,
      unmappedCount: result.unmappedJourneys.length,
      totalJourneys: manifest.nodes.length,
    });
  });

  app.patch("/api/mapping/journeys/:journeyId/tests/:testIdx", async (request, response) => {
    const { journeyId, testIdx } = request.params;
    const idx = parseInt(testIdx, 10);
    const approved = Boolean(request.body.approved);

    let mapping: {
      mappings: Array<{ journeyId: string; matchedTests: Array<{ approved?: boolean }> }>;
    };
    try {
      mapping = JSON.parse(await readFile(testMappingPath, "utf8")) as typeof mapping;
    } catch {
      response.status(404).json({ error: "No mapping found." });
      return;
    }

    const journey = mapping.mappings.find((m) => m.journeyId === journeyId);
    if (!journey) {
      response.status(404).json({ error: `Journey ${journeyId} not found in mapping.` });
      return;
    }
    if (idx < 0 || idx >= journey.matchedTests.length) {
      response.status(404).json({ error: `Test index ${idx} out of range.` });
      return;
    }

    journey.matchedTests[idx].approved = approved;
    await writeFile(testMappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    response.json({ ok: true });
  });

  app.post("/api/mapping/bulk-approve", async (_request, response) => {
    let mapping: {
      mappings: Array<{ matchedTests: Array<{ confidence: string; approved?: boolean }> }>;
    };
    try {
      mapping = JSON.parse(await readFile(testMappingPath, "utf8")) as typeof mapping;
    } catch {
      response.status(404).json({ error: "No mapping found." });
      return;
    }

    let count = 0;
    for (const journey of mapping.mappings) {
      for (const test of journey.matchedTests) {
        if (test.confidence === "high" && !test.approved) {
          test.approved = true;
          count++;
        }
      }
    }
    await writeFile(testMappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    response.json({ approved: count });
  });

  app.post("/api/mapping/manual", async (request, response) => {
    const journeyId =
      typeof request.body.journeyId === "string" ? request.body.journeyId.trim() : "";
    const journeyLabel =
      typeof request.body.journeyLabel === "string" ? request.body.journeyLabel.trim() : journeyId;
    const testTitle =
      typeof request.body.testTitle === "string" ? request.body.testTitle.trim() : "";
    const filePath = typeof request.body.filePath === "string" ? request.body.filePath.trim() : "";
    const describe = typeof request.body.describe === "string" ? request.body.describe.trim() : "";

    if (!journeyId || !testTitle) {
      response.status(400).json({ error: "journeyId and testTitle are required." });
      return;
    }

    let mapping: {
      derivedAt: string | null;
      mappings: Array<{
        journeyId: string;
        journeyLabel: string;
        matchedTests: Array<{
          testTitle: string;
          describe: string;
          filePath: string;
          confidence: string;
          reasoning: string;
          approved: boolean;
          manual?: boolean;
        }>;
      }>;
      unmappedJourneys: Array<{ journeyId: string; journeyLabel: string }>;
    };
    try {
      mapping = JSON.parse(await readFile(testMappingPath, "utf8")) as typeof mapping;
    } catch {
      mapping = { derivedAt: null, mappings: [], unmappedJourneys: [] };
    }

    let journey = mapping.mappings.find((m) => m.journeyId === journeyId);
    if (!journey) {
      journey = { journeyId, journeyLabel, matchedTests: [] };
      mapping.mappings.push(journey);
    }
    journey.matchedTests.push({
      testTitle,
      describe,
      filePath,
      confidence: "high",
      reasoning: "Manual mapping.",
      approved: true,
      manual: true,
    });

    mapping.unmappedJourneys = mapping.unmappedJourneys.filter((j) => j.journeyId !== journeyId);
    if (!mapping.derivedAt) mapping.derivedAt = new Date().toISOString();

    await writeFile(testMappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");
    response.json({ ok: true });
  });

  app.get("/api/mapping/gap-report.csv", async (_request, response) => {
    let manifest: ManifestFile | undefined;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      response.status(400).json({ error: "No locked manifest found." });
      return;
    }

    let mappingData: {
      mappings: Array<{ journeyId: string; matchedTests: Array<{ approved: boolean }> }>;
    } = { mappings: [] };
    try {
      mappingData = JSON.parse(await readFile(testMappingPath, "utf8")) as typeof mappingData;
    } catch {
      // No mapping yet — all journeys are gaps.
    }

    const approvedIds = new Set(
      mappingData.mappings
        .filter((m) => m.matchedTests.some((t) => t.approved))
        .map((m) => m.journeyId),
    );

    const EFFORT: Record<string, string> = {
      happy: "simple",
      unhappy: "moderate",
      edge: "moderate",
      boundary: "complex",
      system: "complex",
    };

    const safeCsvCell = (v: string) => {
      const escaped = v.replace(/"/g, '""');
      return /^[=+\-@]/.test(escaped) ? `"'${escaped}"` : `"${escaped}"`;
    };

    const header = "journey_id,label,stage,module,branch_type,coverage_status,estimated_effort\n";
    const rows = manifest.nodes
      .map((n) => {
        const covered = approvedIds.has(n.id);
        const effort = EFFORT[n.branchType] ?? "moderate";
        return `${n.id},${safeCsvCell(n.label)},${safeCsvCell(n.stageName ?? n.stage)},${safeCsvCell(n.module ?? "")},${n.branchType},${covered ? "covered" : "gap"},${effort}`;
      })
      .join("\n");

    response.setHeader("Content-Type", "text/csv");
    response.setHeader(
      "Content-Disposition",
      'attachment; filename="pathlight-coverage-gap-report.csv"',
    );
    response.send(`${header}${rows}\n`);
  });

  // ── V4 AI Test Generation ────────────────────────────────────────────────

  interface GeneratedTest {
    journeyId: string;
    journeyLabel: string;
    status: "pending" | "approved" | "discarded";
    filePath: string;
    content: string;
    qualityChecks: {
      hasJourneyId: boolean;
      hasExpect: boolean;
      hasPlaywrightImport: boolean;
      noForbiddenImports: boolean;
      passed: boolean;
    };
    styleScore: "High" | "Needs review";
    generatedAt: string;
    approvedAt: string | null;
    runPassed?: boolean;
  }

  async function readGeneratedTests(): Promise<GeneratedTest[]> {
    try {
      const data = JSON.parse(await readFile(generatedTestsPath, "utf8")) as {
        tests: GeneratedTest[];
      };
      return Array.isArray(data.tests) ? data.tests : [];
    } catch {
      return [];
    }
  }

  async function saveGeneratedTests(tests: GeneratedTest[]): Promise<void> {
    await writeFile(generatedTestsPath, `${JSON.stringify({ tests }, null, 2)}\n`, "utf8");
  }

  async function getStyleRefs(absTestDir: string): Promise<string[]> {
    const refs: string[] = [];
    async function walk(dir: string, depth: number): Promise<void> {
      if (refs.length >= 3 || depth > 3) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries) {
        if (refs.length >= 3) return;
        if (SCAN_EXCLUDED.has(e.name) || e.name === "generated" || e.name === "journeys") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full, depth + 1);
        } else if (e.isFile() && SPEC_PATTERN.test(e.name)) {
          try {
            refs.push((await readFile(full, "utf8")).slice(0, 3000));
          } catch {
            /* skip */
          }
        }
      }
    }
    await walk(absTestDir, 0);
    return refs;
  }

  async function detectTestExtension(absTestDir: string): Promise<"ts" | "js"> {
    async function walk(dir: string, depth: number): Promise<"ts" | undefined> {
      if (depth > 3) return undefined;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return undefined;
      }
      for (const e of entries) {
        if (SCAN_EXCLUDED.has(e.name) || e.name === "generated" || e.name === "journeys") continue;
        const full = join(dir, e.name);
        if (e.isDirectory()) {
          const r = await walk(full, depth + 1);
          if (r) return r;
        } else if (e.isFile() && e.name.endsWith(".spec.ts")) return "ts";
      }
      return undefined;
    }
    return (await walk(absTestDir, 0)) ?? "ts";
  }

  function computeStyleScore(content: string, refs: string[]): "High" | "Needs review" {
    if (refs.length === 0) return "Needs review";
    const refESM = refs[0].includes("import ");
    const contentESM = content.includes("import ");
    return refESM === contentESM ? "High" : "Needs review";
  }

  async function generateTestContent(
    journeyId: string,
    hint: string,
  ): Promise<{
    content: string;
    qualityChecks: GeneratedTest["qualityChecks"];
    styleScore: "High" | "Needs review";
    filePath: string;
    journeyLabel: string;
  }> {
    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      throw new Error("Pathlight not configured.");
    }
    if (!config.testDir || !config.projectRoot) {
      throw new Error("testDir is not configured. Set it in Config → Test Suite.");
    }

    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      throw new Error("No locked manifest found. Lock your journey manifest first.");
    }
    if (!manifest.lockedAt)
      throw new Error("No locked manifest found. Lock your journey manifest first.");

    const node = manifest.nodes.find((n) => n.id === journeyId);
    if (!node) throw new Error(`Journey ${journeyId} not found in manifest.`);

    let storyAC = "";
    try {
      const storiesData = JSON.parse(await readFile(storiesPath, "utf8")) as {
        stories: Array<{ key: string; acceptanceCriteria?: string; description?: string }>;
      };
      const story = storiesData.stories.find(
        (s) => s.key === node.storyId || node.linkedStories?.includes(s.key),
      );
      if (story) storyAC = story.acceptanceCriteria ?? story.description ?? "";
    } catch {
      /* no stories */
    }

    if (isAbsolute(config.testDir)) throw new Error("testDir must be relative to project root.");
    const absTestDir = resolve(config.projectRoot!, config.testDir);
    if (!absTestDir.startsWith(config.projectRoot! + "/")) {
      throw new Error("testDir must be within project root.");
    }
    const styleRefs = await getStyleRefs(absTestDir);

    const systemPrompt = `You are a senior Playwright test engineer. Generate a complete Playwright test file.

Rules:
1. The test title MUST contain the journey ID in square brackets: test('[${journeyId}] ...', ...)
2. Include at least one expect() assertion
3. Annotate every selector/locator with: // Selector assumption — verify against live UI
4. Structure: arrange (navigate/setup), act (user interactions), assert (expected outcome)
5. Match the style of the reference tests exactly
6. Output ONLY the complete test file content — no markdown fences, no explanation`;

    const buildUserContent = (retryNote?: string) => {
      let c = `Journey: ${journeyId} — ${node.label}
Stage: ${node.stageName}
Module: ${node.module ?? node.stageName}
Branch type: ${node.branchType}`;
      if (storyAC) c += `\n\nAcceptance criteria:\n${storyAC.slice(0, 2000)}`;
      if (hint) c += `\n\nHint: ${hint}`;
      if (retryNote) c += `\n\nIMPORTANT: ${retryNote}`;
      if (styleRefs.length > 0) {
        c += `\n\nStyle reference tests (match exactly):`;
        styleRefs.forEach((ref, i) => {
          c += `\n\n--- Reference ${i + 1} ---\n${ref}`;
        });
      }
      return c;
    };

    const stubTestContent =
      `import { test, expect } from '@playwright/test';\n\n` +
      `test('[${journeyId}] stub test', async ({ page }) => {\n` +
      `  // Stub — configure an AI provider in Settings to generate real test content.\n` +
      `  expect(page).toBeDefined();\n` +
      `});\n`;
    let generatedContent = await callClaudeImpl({
      system: systemPrompt,
      userContent: buildUserContent(),
      bypass: stubTestContent,
    });
    let quality = checkTestQuality(generatedContent, journeyId);
    if (!quality.passed) {
      const note = [
        !quality.hasJourneyId ? `Test title must contain [${journeyId}] in square brackets.` : "",
        !quality.hasExpect ? "Must include at least one expect() assertion." : "",
        !quality.hasPlaywrightImport ? "Must import from '@playwright/test'." : "",
        !quality.noForbiddenImports
          ? "Only import from '@playwright/test', node builtins (node:*), or relative paths."
          : "",
      ]
        .filter(Boolean)
        .join(" ");
      generatedContent = await callClaudeImpl({
        system: systemPrompt,
        userContent: buildUserContent(note),
        bypass: stubTestContent,
      });
      quality = checkTestQuality(generatedContent, journeyId);
    }

    const ext = await detectTestExtension(absTestDir);
    const generatedDir = join(absTestDir, "generated");
    await mkdir(generatedDir, { recursive: true });
    // Validate before using journeyId as a filename component (defense in depth —
    // primary validation is in the CSV/manifest import path).
    if (!JOURNEY_ID_RE.test(journeyId)) {
      throw new Error(`Journey ID '${journeyId}' is not safe for use as a filename.`);
    }
    const filePath = join(generatedDir, `${journeyId}.spec.${ext}`);
    await writeFile(filePath, generatedContent, "utf8");

    return {
      content: generatedContent,
      qualityChecks: quality,
      styleScore: computeStyleScore(generatedContent, styleRefs),
      filePath,
      journeyLabel: node.label,
    };
  }

  let activeBatch: {
    id: string;
    cancelled: boolean;
    total: number;
    completed: number;
    results: Array<{ journeyId: string; status: "ok" | "failed"; error?: string }>;
    status: "running" | "done" | "cancelled";
  } | null = null;

  app.post("/api/generation/generate", async (request, response) => {
    if (!claudeRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response
        .status(503)
        .json({ error: "ANTHROPIC_API_KEY is not set. Add it to your .env file." });
      return;
    }

    const journeyId =
      typeof request.body.journeyId === "string" ? request.body.journeyId.trim() : "";
    const hint = typeof request.body.hint === "string" ? request.body.hint.trim() : "";
    if (!journeyId) {
      response.status(400).json({ error: "journeyId is required." });
      return;
    }

    let result: Awaited<ReturnType<typeof generateTestContent>>;
    try {
      result = await generateTestContent(journeyId, hint);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      const status = reason.startsWith("Journey ")
        ? 404
        : reason.includes("not configured") || reason.includes("manifest")
          ? 400
          : 502;
      response.status(status).json({ error: reason });
      return;
    }

    const tests = await readGeneratedTests();
    const idx = tests.findIndex((t) => t.journeyId === journeyId);
    const entry: GeneratedTest = {
      journeyId,
      journeyLabel: result.journeyLabel,
      status: "pending",
      filePath: result.filePath,
      content: result.content,
      qualityChecks: result.qualityChecks,
      styleScore: result.styleScore,
      generatedAt: new Date().toISOString(),
      approvedAt: null,
    };
    if (idx >= 0) tests[idx] = entry;
    else tests.push(entry);
    await saveGeneratedTests(tests);

    response.status(201).json({
      journeyId,
      journeyLabel: result.journeyLabel,
      filePath: result.filePath,
      qualityChecks: result.qualityChecks,
      styleScore: result.styleScore,
    });
  });

  app.get("/api/generation", async (_request, response) => {
    const tests = await readGeneratedTests();
    response.json({ tests: tests.map(({ content: _c, ...rest }) => rest) });
  });

  app.get("/api/generation/batch-status", (_request, response) => {
    if (!activeBatch) {
      response.json({ status: null });
      return;
    }
    response.json({
      id: activeBatch.id,
      status: activeBatch.status,
      completed: activeBatch.completed,
      total: activeBatch.total,
      results: activeBatch.results,
    });
  });

  app.post("/api/generation/batch", async (request, response) => {
    if (!claudeRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response.status(503).json({ error: "ANTHROPIC_API_KEY is not set." });
      return;
    }
    if (activeBatch?.status === "running") {
      response.status(409).json({ error: "A batch generation is already running." });
      return;
    }
    const rawIds: unknown[] = Array.isArray(request.body.journeyIds) ? request.body.journeyIds : [];
    const journeyIds = rawIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .slice(0, 10)
      .map((id) => id.trim());
    if (journeyIds.length === 0) {
      response.status(400).json({ error: "journeyIds must have at least one entry (max 10)." });
      return;
    }
    const batchId = `batch-${Date.now()}`;
    activeBatch = {
      id: batchId,
      cancelled: false,
      total: journeyIds.length,
      completed: 0,
      results: [],
      status: "running",
    };

    void (async () => {
      for (const jid of journeyIds) {
        if (activeBatch?.cancelled) break;
        try {
          const r = await generateTestContent(jid, "");
          const tests = await readGeneratedTests();
          const idx = tests.findIndex((t) => t.journeyId === jid);
          const entry: GeneratedTest = {
            journeyId: jid,
            journeyLabel: r.journeyLabel,
            status: "pending",
            filePath: r.filePath,
            content: r.content,
            qualityChecks: r.qualityChecks,
            styleScore: r.styleScore,
            generatedAt: new Date().toISOString(),
            approvedAt: null,
          };
          if (idx >= 0) tests[idx] = entry;
          else tests.push(entry);
          await saveGeneratedTests(tests);
          activeBatch!.results.push({ journeyId: jid, status: "ok" });
        } catch (error) {
          activeBatch!.results.push({
            journeyId: jid,
            status: "failed",
            error: error instanceof Error ? error.message : String(error),
          });
        }
        activeBatch!.completed++;
      }
      if (activeBatch) activeBatch.status = activeBatch.cancelled ? "cancelled" : "done";
    })();

    response.status(202).json({ batchId, total: journeyIds.length });
  });

  app.post("/api/generation/batch-cancel", (_request, response) => {
    if (!activeBatch || activeBatch.status !== "running") {
      response.status(400).json({ error: "No active batch to cancel." });
      return;
    }
    activeBatch.cancelled = true;
    response.json({ ok: true });
  });

  app.get("/api/generation/:journeyId", async (request, response) => {
    const tests = await readGeneratedTests();
    const test = tests.find((t) => t.journeyId === request.params.journeyId);
    if (!test) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    response.json(test);
  });

  app.patch("/api/generation/:journeyId", async (request, response) => {
    const content = typeof request.body.content === "string" ? request.body.content : null;
    if (!content) {
      response.status(400).json({ error: "content is required." });
      return;
    }
    const tests = await readGeneratedTests();
    const test = tests.find((t) => t.journeyId === request.params.journeyId);
    if (!test) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    test.content = content;
    test.qualityChecks = checkTestQuality(content, request.params.journeyId);
    test.runPassed = undefined;
    try {
      await writeFile(test.filePath, content, "utf8");
    } catch {
      /* file may have been removed */
    }
    await saveGeneratedTests(tests);
    response.json({ ok: true, qualityChecks: test.qualityChecks });
  });

  app.post("/api/generation/:journeyId/run", async (request, response) => {
    const tests = await readGeneratedTests();
    const test = tests.find((t) => t.journeyId === request.params.journeyId);
    if (!test) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    const runner = await configuredRunner();
    if ("error" in runner) {
      response.status(400).json({ error: runner.error });
      return;
    }
    let passed: boolean;
    let output: string;
    try {
      const { stdout, stderr } = await execFileAsync(
        "npx",
        [
          "playwright",
          "test",
          test.filePath,
          "--reporter=line",
          ...(runner.playwrightConfigPath !== "playwright.config.ts"
            ? ["--config", runner.playwrightConfigPath]
            : []),
        ],
        { cwd: runner.projectRoot, timeout: 60000 },
      );
      passed = true;
      output = redactOutput((stdout + stderr).slice(-5000));
    } catch (error) {
      const e = error as { stdout?: string; stderr?: string };
      passed = false;
      output = redactOutput(((e.stdout ?? "") + (e.stderr ?? "")).slice(-5000));
    }
    const idx = tests.findIndex((t) => t.journeyId === request.params.journeyId);
    if (idx >= 0) {
      tests[idx].runPassed = passed;
      await saveGeneratedTests(tests);
    }
    response.json({ passed, output });
  });

  app.post("/api/generation/:journeyId/regenerate", async (request, response) => {
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response
        .status(503)
        .json({ error: "ANTHROPIC_API_KEY is not set. Add it to your .env file." });
      return;
    }
    const tests = await readGeneratedTests();
    const test = tests.find((t) => t.journeyId === request.params.journeyId);
    if (!test) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    const hint = typeof request.body.hint === "string" ? request.body.hint.trim() : "";

    let result: Awaited<ReturnType<typeof generateTestContent>>;
    try {
      result = await generateTestContent(request.params.journeyId, hint);
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      response.status(502).json({ error: `Claude generation failed: ${reason}` });
      return;
    }

    const idx = tests.findIndex((t) => t.journeyId === request.params.journeyId);
    tests[idx] = {
      ...tests[idx],
      content: result.content,
      qualityChecks: result.qualityChecks,
      styleScore: result.styleScore,
      filePath: result.filePath,
      generatedAt: new Date().toISOString(),
      runPassed: undefined,
    };
    await saveGeneratedTests(tests);
    response.json({
      journeyId: request.params.journeyId,
      qualityChecks: result.qualityChecks,
      styleScore: result.styleScore,
    });
  });

  app.post("/api/generation/:journeyId/approve", async (request, response) => {
    const tests = await readGeneratedTests();
    const test = tests.find((t) => t.journeyId === request.params.journeyId);
    if (!test) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    if (!test.qualityChecks.passed) {
      response.status(400).json({
        error: "Generated test did not pass quality checks. Fix the test before approving.",
      });
      return;
    }
    if (!test.runPassed) {
      response
        .status(400)
        .json({ error: "Generated test must be run and pass before it can be approved." });
      return;
    }

    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      response.status(400).json({ error: "Pathlight not configured." });
      return;
    }
    if (!config.testDir || !config.projectRoot) {
      response.status(400).json({ error: "testDir not configured." });
      return;
    }

    if (isAbsolute(config.testDir)) {
      response.status(400).json({ error: "testDir must be relative to project root." });
      return;
    }
    const absTestDir = resolve(config.projectRoot!, config.testDir);
    if (!absTestDir.startsWith(config.projectRoot! + "/")) {
      response.status(400).json({ error: "testDir must be within project root." });
      return;
    }
    const journeysDir = join(absTestDir, "journeys");
    await mkdir(journeysDir, { recursive: true });
    if (!JOURNEY_ID_RE.test(test.journeyId)) {
      response
        .status(400)
        .json({ error: `Journey ID '${test.journeyId}' is not safe for use as a filename.` });
      return;
    }
    const ext = test.filePath.endsWith(".ts") ? "ts" : "js";
    const approvedPath = join(journeysDir, `${test.journeyId}.spec.${ext}`);
    await writeFile(approvedPath, test.content, "utf8");
    try {
      await unlink(test.filePath);
    } catch {
      /* may not exist */
    }

    // Update test mapping
    let mapping: {
      derivedAt: string | null;
      mappings: Array<{
        journeyId: string;
        journeyLabel: string;
        matchedTests: Array<{
          testTitle: string;
          describe: string;
          filePath: string;
          confidence: string;
          reasoning: string;
          approved: boolean;
          manual?: boolean;
          generated?: boolean;
        }>;
      }>;
      unmappedJourneys: Array<{ journeyId: string; journeyLabel: string }>;
    };
    try {
      mapping = JSON.parse(await readFile(testMappingPath, "utf8")) as typeof mapping;
    } catch {
      mapping = { derivedAt: null, mappings: [], unmappedJourneys: [] };
    }

    const titleMatch = test.content.match(/test\s*\(\s*['"`]([^'"`]+)['"`]/);
    const testTitle = titleMatch ? titleMatch[1] : `[${test.journeyId}] ${test.journeyLabel}`;
    const relPath = relative(absTestDir, approvedPath);

    let journey = mapping.mappings.find((m) => m.journeyId === test.journeyId);
    if (!journey) {
      journey = { journeyId: test.journeyId, journeyLabel: test.journeyLabel, matchedTests: [] };
      mapping.mappings.push(journey);
    }
    journey.matchedTests = journey.matchedTests.filter((t) => !t.generated);
    journey.matchedTests.push({
      testTitle,
      describe: "",
      filePath: relPath,
      confidence: "high",
      reasoning: "AI-generated and approved.",
      approved: true,
      generated: true,
    });
    mapping.unmappedJourneys = mapping.unmappedJourneys.filter(
      (j) => j.journeyId !== test.journeyId,
    );
    if (!mapping.derivedAt) mapping.derivedAt = new Date().toISOString();
    await writeFile(testMappingPath, `${JSON.stringify(mapping, null, 2)}\n`, "utf8");

    const idx = tests.findIndex((t) => t.journeyId === request.params.journeyId);
    tests[idx] = {
      ...tests[idx],
      status: "approved",
      filePath: approvedPath,
      approvedAt: new Date().toISOString(),
    };
    await saveGeneratedTests(tests);
    response.json({ ok: true, filePath: approvedPath });
  });

  app.delete("/api/generation/:journeyId", async (request, response) => {
    const tests = await readGeneratedTests();
    const idx = tests.findIndex((t) => t.journeyId === request.params.journeyId);
    if (idx < 0) {
      response
        .status(404)
        .json({ error: `No generated test for journey ${request.params.journeyId}.` });
      return;
    }
    const filePath = tests[idx].filePath;
    if (filePath && filePath.startsWith(projectRoot + "/")) {
      try {
        await unlink(filePath);
      } catch {
        /* may not exist */
      }
    }
    tests.splice(idx, 1);
    await saveGeneratedTests(tests);
    response.json({ ok: true });
  });

  app.get("/api/ai/config", async (_request, response) => {
    let aiProvider: PathlightConfig["aiProvider"] | undefined;
    try {
      aiProvider = (await readConfig(path)).aiProvider;
    } catch {
      // Config may not exist yet.
    }
    let hasApiKey = false;
    try {
      const creds = JSON.parse(await readFile(aiCredentialsPath, "utf8")) as AiCredentials;
      hasApiKey = Boolean(creds.apiKey);
    } catch {
      // Credentials file is optional.
    }
    response.json({ ...aiProvider, hasApiKey });
  });

  app.put("/api/ai/config", async (request, response) => {
    const { provider, model, ollamaUrl, apiKey } = request.body as {
      provider?: unknown;
      model?: unknown;
      ollamaUrl?: unknown;
      apiKey?: unknown;
    };
    const PROVIDERS = new Set(["claude", "openai", "gemini", "ollama"]);
    if (typeof provider !== "string" || !PROVIDERS.has(provider)) {
      response
        .status(400)
        .json({ error: "provider must be one of: claude, openai, gemini, ollama" });
      return;
    }
    try {
      const config = await readConfig(path);
      config.aiProvider = {
        provider: provider as NonNullable<PathlightConfig["aiProvider"]>["provider"],
        ...(typeof model === "string" && model.trim() ? { model: model.trim() } : {}),
        ...(typeof ollamaUrl === "string" && ollamaUrl.trim()
          ? { ollamaUrl: ollamaUrl.trim() }
          : {}),
      };
      await writeConfig(path, config);
    } catch {
      response.status(400).json({ error: "Save project configuration first." });
      return;
    }
    if (typeof apiKey === "string" && apiKey.trim()) {
      await mkdir(authDirectory, { recursive: true });
      await writeFile(aiCredentialsPath, JSON.stringify({ provider, apiKey: apiKey.trim() }), {
        mode: 0o600,
      });
      await chmod(aiCredentialsPath, 0o600);
    }
    response.json({ saved: true });
  });

  app.post("/api/ai/test-connection", async (request, response) => {
    if (process.env.BYPASS_EXTERNAL_AI === "true") {
      const p = typeof request.body.provider === "string" ? request.body.provider : "unknown";
      response.json({ connected: true, model: `${p} (bypassed)` });
      return;
    }
    const { provider, model, ollamaUrl, apiKey } = request.body as {
      provider?: unknown;
      model?: unknown;
      ollamaUrl?: unknown;
      apiKey?: unknown;
    };
    let resolvedKey = typeof apiKey === "string" ? apiKey.trim() : "";
    if (!resolvedKey) {
      try {
        const creds = JSON.parse(await readFile(aiCredentialsPath, "utf8")) as AiCredentials;
        resolvedKey = creds.apiKey ?? "";
      } catch {
        // Credentials file may not exist yet.
      }
    }
    const resolvedModel = typeof model === "string" && model.trim() ? model.trim() : undefined;
    const resolvedOllamaUrl =
      typeof ollamaUrl === "string" && ollamaUrl.trim()
        ? ollamaUrl.trim()
        : "http://localhost:11434";
    if (
      provider !== "claude" &&
      provider !== "openai" &&
      provider !== "gemini" &&
      provider !== "ollama"
    ) {
      response.status(400).json({ error: "Unknown provider." });
      return;
    }
    if (provider !== "ollama" && !resolvedKey) {
      const envName =
        provider === "openai"
          ? "OPENAI_API_KEY"
          : provider === "gemini"
            ? "GOOGLE_API_KEY"
            : "ANTHROPIC_API_KEY";
      response.status(502).json({ error: `${envName} is required.` });
      return;
    }
    try {
      // Delegate validation to the provider abstraction rather than duplicating it.
      const aiProvider = createAIProvider({
        provider,
        apiKey: resolvedKey || undefined,
        model: resolvedModel,
        ollamaUrl: provider === "ollama" ? resolvedOllamaUrl : undefined,
      });
      const result = await aiProvider.validateConfig();
      if (!result.ok) {
        response.status(502).json({ error: result.error ?? "Connection failed." });
        return;
      }
      response.json({ connected: true, model: aiProvider.modelName() });
    } catch (err) {
      response.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  const evidenceRl = new RateLimiter({
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS ?? 60_000),
    max: 20,
  });

  // ── V9 Bug Lifecycle ─────────────────────────────────────────────────────
  // V9: JIRA polling job not yet implemented.
  // When implemented: poll every 30 minutes for open bug status changes and
  // update the manifest when a bug is resolved. See PRD V9.
  // (A "passed-again" comment is posted via postJiraPassComment; the webhook
  // endpoint and scheduled poller are intentionally absent until V9 lands.)

  const bugStatusCache = new Map<string, { bugKey: string; status: string; cachedAt: number }>();

  // The manifest is the single source of truth for JIRA keys tracked per journey.
  type BugManifestNode = ManifestNode & { openBugKey?: string; openDebtStoryKey?: string };
  async function readManifestFile(): Promise<ManifestFile | null> {
    try {
      return JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      return null;
    }
  }
  async function getOpenBugKey(journeyId: string): Promise<string | null> {
    const manifest = await readManifestFile();
    const node = manifest?.nodes.find((n) => n.id === journeyId) as BugManifestNode | undefined;
    return node?.openBugKey ?? null;
  }
  async function setOpenBugKey(journeyId: string, key: string): Promise<void> {
    const manifest = await readManifestFile();
    if (!manifest) return;
    const node = manifest.nodes.find((n) => n.id === journeyId) as BugManifestNode | undefined;
    if (!node) return;
    node.openBugKey = key;
    await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }

  // Per-attempt failure evidence, recovered from the run's persisted event stream.
  interface BugEvidence {
    failedStep?: string;
    error?: string;
    errorType?: string;
    duration?: number;
    retryCount?: number;
    attemptId?: string;
    screenshotPath?: string;
    tracePath?: string;
  }
  async function readRunEvidence(
    runId: string,
    nodeId: string,
    preferredAttemptId?: string,
  ): Promise<BugEvidence> {
    if (!runId) return {};
    let lines: string[];
    try {
      lines = (await readFile(join(projectRoot, "reports", runId, "events.jsonl"), "utf8"))
        .split("\n")
        .filter(Boolean);
    } catch {
      return {};
    }
    type Ev = { type: string; payload?: Record<string, unknown> };
    const events = lines
      .map((l) => {
        try {
          return JSON.parse(l) as Ev;
        } catch {
          return null;
        }
      })
      .filter((e): e is Ev => e !== null && e.payload?.testId === nodeId);
    const failed = events.filter((e) => e.type === "test.failed");
    const chosen = preferredAttemptId
      ? (failed.find((e) => e.payload?.attemptId === preferredAttemptId) ?? failed.at(-1))
      : failed.at(-1);
    const attemptId = chosen?.payload?.attemptId as string | undefined;
    const steps = events.filter(
      (e) =>
        e.type === "step.started" &&
        e.payload?.attemptId === attemptId &&
        e.payload?.source === "explicit",
    );
    const artifactPath = (kind: string) =>
      events.find(
        (e) =>
          e.type === "artifact.created" &&
          e.payload?.attemptId === attemptId &&
          e.payload?.artifactType === kind,
      )?.payload?.path as string | undefined;
    return {
      failedStep: steps.at(-1)?.payload?.stepTitle as string | undefined,
      error: chosen?.payload?.error as string | undefined,
      errorType: chosen?.payload?.errorType as string | undefined,
      duration: chosen?.payload?.duration as number | undefined,
      retryCount: chosen?.payload?.retryCount as number | undefined,
      attemptId,
      screenshotPath: artifactPath("screenshot"),
      tracePath: artifactPath("trace"),
    };
  }

  const JIRA_PRIORITY_MAP: Record<string, string> = {
    highest: "Critical",
    high: "High",
    medium: "Medium",
    low: "Low",
  };

  // Shared JIRA bug payload for manual and automatic creation. The only
  // difference is the `pathlight-auto` label added for auto-created bugs.
  function buildJiraBugFields(
    manifest: ManifestFile,
    node: ManifestNode,
    evidence: BugEvidence,
    runId: string,
    opts: { auto: boolean },
  ) {
    type BizRule = { id: string; label?: string; severity?: string };
    const businessRuleLabels = ((manifest.businessRules ?? []) as BizRule[])
      .filter((r) => (node.businessRuleIds ?? []).includes(r.id))
      .map((r) => `${r.label ?? r.id} (${r.severity ?? ""})`);
    const descriptionText = [
      `Journey: ${node.id} — ${node.label ?? node.id}`,
      `Branch type: ${node.branchType ?? "unknown"}`,
      businessRuleLabels.length > 0 ? `Business rules: ${businessRuleLabels.join(", ")}` : null,
      evidence.failedStep ? `Failing step: ${evidence.failedStep}` : null,
      evidence.error ? `Error: ${evidence.error}` : null,
      evidence.errorType ? `Error type: ${evidence.errorType}` : null,
      evidence.duration !== undefined ? `Duration: ${evidence.duration} ms` : null,
      evidence.retryCount !== undefined ? `Retry count: ${evidence.retryCount}` : null,
      evidence.tracePath
        ? `Trace: ${SELF_BASE_URL}/${evidence.tracePath.replace(/^\/+/, "")}`
        : null,
      `Run: ${runId || "unknown"}`,
    ]
      .filter(Boolean)
      .join("\n");
    const labels = ["pathlight", "automated-failure", node.id];
    if (opts.auto) labels.push("pathlight-auto");
    return {
      project: { key: manifest.projectKey },
      summary: `[Pathlight] ${node.id}: ${node.label ?? node.id} — FAILED`,
      issuetype: { name: "Bug" },
      priority: { name: JIRA_PRIORITY_MAP[(node.priority ?? "medium").toLowerCase()] ?? "Medium" },
      description: {
        type: "doc",
        version: 1,
        content: [{ type: "paragraph", content: [{ type: "text", text: descriptionText }] }],
      },
      labels,
    };
  }

  // Best-effort secondary JIRA calls — never fail the primary bug creation.
  async function attachScreenshotToBug(
    token: { access_token: string; cloudId: string },
    bugKey: string,
    screenshotPath: string,
  ) {
    try {
      // Only allow paths inside the reports directory (where run artifacts live).
      // This rejects traversal, absolute paths, and config/credential files that
      // are technically under projectRoot but are not report artifacts.
      const reportsRoot = resolve(projectRoot, "reports");
      const abs = resolve(projectRoot, screenshotPath);
      if (!abs.startsWith(reportsRoot + "/")) {
        throw new Error(`Screenshot path is not a report artifact: ${screenshotPath}`);
      }
      const data = await readFile(abs);
      const form = new FormData();
      form.append("file", new Blob([data]), screenshotPath.split("/").pop() ?? "screenshot.png");
      const jiraFetch = jira.fetch ?? fetch;
      await jiraFetch(
        `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issue/${bugKey}/attachments`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "X-Atlassian-Token": "no-check",
          },
          body: form,
        },
      );
    } catch (err) {
      log.warn("JIRA screenshot attachment failed", {
        operation: "attachScreenshotToBug",
        bugKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function linkBugToStory(
    token: { access_token: string; cloudId: string },
    bugKey: string,
    storyKey: string,
  ) {
    try {
      const jiraFetch = jira.fetch ?? fetch;
      await jiraFetch(`https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issueLink`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token.access_token}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          type: { name: "Test" },
          inwardIssue: { key: bugKey },
          outwardIssue: { key: storyKey },
        }),
      });
    } catch (err) {
      log.warn("JIRA story link failed", {
        operation: "linkBugToStory",
        bugKey,
        storyKey,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // The source story for JIRA linking. linkedStories[] is the schema field (an
  // array, per the domain glossary); storyId is a legacy single-value fallback.
  function sourceStoryKey(node: ManifestNode): string | undefined {
    return node.linkedStories?.[0] ?? node.storyId;
  }

  async function autoCreateBugIfNeeded(journeyId: string) {
    if (await getOpenBugKey(journeyId)) return; // already has a bug
    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      return;
    }
    const threshold =
      (config as PathlightConfig & { autoBugCreateAfterFailures?: number })
        .autoBugCreateAfterFailures ?? 2;
    if (threshold === 0) return;

    const runs = await readRunHistory();
    const consecutiveFailures = runs
      .slice(0, threshold)
      .every((r) => r.testResults?.[journeyId]?.status === "failed");
    if (!consecutiveFailures || runs.length < threshold) return;

    try {
      const manifest = await readManifestFile();
      const node = manifest?.nodes.find((n) => n.id === journeyId);
      if (!manifest || !node) return;
      // Per-journey opt-out from automatic bug creation.
      if ((node.tags ?? []).includes("@no-auto-bug")) {
        log.info(`Auto bug skipped for ${journeyId}: @no-auto-bug tag`);
        return;
      }
      const token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as {
        access_token: string;
        cloudId: string;
      };
      let mockEnabled = false;
      try {
        mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
      } catch {
        /* ignore */
      }
      const runId = runs[0]?.runId ?? eventBus.activeId ?? "";
      const evidence = await readRunEvidence(runId, journeyId);
      const jiraFetch = jira.fetch ?? fetch;
      let bugKey: string;
      if (mockEnabled) {
        bugKey = `MOCK-AUTO-${Date.now()}`;
      } else {
        const r = await jiraFetch(
          `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issue`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token.access_token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              fields: buildJiraBugFields(manifest, node, evidence, runId, { auto: true }),
            }),
          },
        );
        if (!r.ok) return;
        const issue = (await r.json()) as { key: string };
        bugKey = issue.key;
        if (evidence.screenshotPath) {
          await attachScreenshotToBug(token, bugKey, evidence.screenshotPath);
        }
        const storyKey = sourceStoryKey(node);
        if (storyKey) {
          await linkBugToStory(token, bugKey, storyKey);
        }
      }
      await setOpenBugKey(journeyId, bugKey);
      bugStatusCache.set(journeyId, { bugKey, status: "Open", cachedAt: Date.now() });
    } catch (err) {
      log.warn("Auto bug creation failed", {
        operation: "autoCreateBugIfNeeded",
        journeyId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async function postJiraPassComment(journeyId: string, runId: string) {
    const bugKey = await getOpenBugKey(journeyId);
    if (!bugKey) return;
    const cached = bugStatusCache.get(journeyId);
    if (cached?.status === "Done" || cached?.status === "Resolved") return;
    try {
      const token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as {
        access_token: string;
        cloudId: string;
      };
      let mockEnabled = false;
      try {
        mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
      } catch {
        /* ignore */
      }
      if (mockEnabled) return;
      const jiraFetch = jira.fetch ?? fetch;
      await jiraFetch(
        `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issue/${bugKey}/comment`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            body: {
              type: "doc",
              version: 1,
              content: [
                {
                  type: "paragraph",
                  content: [
                    {
                      type: "text",
                      text: `Journey ${journeyId} passed in Pathlight run ${runId}. This failure appears resolved. Please verify and close if confirmed.`,
                    },
                  ],
                },
              ],
            },
          }),
        },
      );
    } catch (err) {
      log.warn("JIRA pass comment failed", {
        operation: "postJiraPassComment",
        journeyId,
        runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  app.post("/api/bugs/auto-create", async (request, response) => {
    if (!jiraRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    const { journeyId } = request.body as { journeyId?: unknown };
    if (typeof journeyId !== "string") {
      response.status(400).json({ error: "journeyId required." });
      return;
    }
    await autoCreateBugIfNeeded(journeyId);
    response.json({ bugKey: await getOpenBugKey(journeyId) });
  });

  app.post("/api/bugs/export-debt", async (request, response) => {
    const { jiraProjectKey: targetProject } = request.body as { jiraProjectKey?: unknown };
    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      response.status(400).json({ error: "No locked manifest found." });
      return;
    }

    let mappingData: {
      mappings: Array<{ journeyId: string; matchedTests: Array<{ approved: boolean }> }>;
    } = { mappings: [] };
    try {
      mappingData = JSON.parse(
        await readFile(join(projectRoot, "pathlight-test-mapping.json"), "utf8"),
      ) as typeof mappingData;
    } catch {
      /* No mapping — all are gaps. */
    }

    const approvedIds = new Set(
      mappingData.mappings
        .filter((m) => m.matchedTests.some((t) => t.approved))
        .map((m) => m.journeyId),
    );
    const gaps = manifest.nodes.filter((n) => !approvedIds.has(n.id));

    const EFFORT: Record<string, string> = {
      happy: "Estimated effort: 0.5 days",
      unhappy: "Estimated effort: 1 day",
      edge: "Estimated effort: 1 day",
      boundary: "Estimated effort: 2 days",
      system: "Estimated effort: 2 days",
    };

    let token: { access_token: string; cloudId: string } | undefined;
    let mockEnabled = false;
    try {
      token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as typeof token;
      mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
    } catch {
      /* Proceed with mock check. */
    }
    if (!token && !mockEnabled) {
      response.status(400).json({ error: "JIRA not connected." });
      return;
    }

    const rawProject = typeof targetProject === "string" ? targetProject.trim() : "";
    if (rawProject && !JIRA_PROJECT_KEY_RE.test(rawProject)) {
      response.status(400).json({
        error:
          "jiraProjectKey must be 2-10 uppercase letters/numbers starting with a letter (e.g. PROJ).",
      });
      return;
    }
    const project = rawProject || manifest.projectKey;

    const jiraFetch = jira.fetch ?? fetch;

    // Create all JIRA issues in parallel, capped at 5 concurrent requests.
    const CONCURRENCY = 5;
    const sem = { running: 0, queue: [] as Array<() => void> };
    const acquire = () =>
      new Promise<void>((resolve) => {
        if (sem.running < CONCURRENCY) {
          sem.running++;
          resolve();
        } else sem.queue.push(resolve);
      });
    const release = () => {
      sem.running--;
      const next = sem.queue.shift();
      if (next) {
        sem.running++;
        next();
      }
    };

    // A debt story counts as still open unless JIRA reports a terminal status.
    const isDebtStoryOpen = async (key: string): Promise<boolean> => {
      if (mockEnabled) return true;
      try {
        const r = await jiraFetch(
          `https://api.atlassian.com/ex/jira/${token!.cloudId}/rest/api/3/issue/${key}?fields=status`,
          {
            headers: { Authorization: `Bearer ${token!.access_token}`, Accept: "application/json" },
          },
        );
        if (!r.ok) return false; // missing/inaccessible → allow a fresh story
        const issue = (await r.json()) as { fields?: { status?: { name?: string } } };
        const name = (issue.fields?.status?.name ?? "").toLowerCase();
        return !["done", "resolved", "closed"].includes(name);
      } catch {
        return false;
      }
    };

    const createOne = async (
      node: ManifestFile["nodes"][number],
    ): Promise<{
      journeyId: string;
      created: boolean;
      skipped?: boolean;
      key?: string;
      error?: string;
    }> => {
      await acquire();
      try {
        // Skip journeys that already have an open debt story (no duplicates).
        if (node.openDebtStoryKey && (await isDebtStoryOpen(node.openDebtStoryKey))) {
          return { journeyId: node.id, created: false, skipped: true, key: node.openDebtStoryKey };
        }
        if (mockEnabled) return { journeyId: node.id, created: true, key: `MOCK-TD-${node.id}` };
        type BizRule = { id: string; label?: string; severity?: string };
        const ruleLines = ((manifest.businessRules ?? []) as BizRule[])
          .filter((rule) => (node.businessRuleIds ?? []).includes(rule.id))
          .map((rule) => `- ${rule.id}: ${rule.label ?? rule.id} [${rule.severity ?? ""}]`);
        const descriptionText = [
          `Journey: ${node.label ?? node.id}`,
          `Stage: ${node.stageName ?? node.stage ?? "Unknown"}`,
          `Branch type: ${node.branchType ?? "unknown"}`,
          `Priority: ${node.priority ?? "Medium"}`,
          ruleLines.length > 0
            ? `Business rules covered:\n${ruleLines.join("\n")}`
            : "Business rules covered: none",
          EFFORT[node.branchType ?? ""] ?? "Estimated effort: 1 day",
        ].join("\n");
        const r = await jiraFetch(
          `https://api.atlassian.com/ex/jira/${token!.cloudId}/rest/api/3/issue`,
          {
            method: "POST",
            headers: {
              Authorization: `Bearer ${token!.access_token}`,
              "Content-Type": "application/json",
              Accept: "application/json",
            },
            body: JSON.stringify({
              fields: {
                project: { key: project },
                summary: `[Test Coverage] ${node.id}: ${node.label ?? node.id}`,
                issuetype: { name: "Story" },
                priority: {
                  name: JIRA_PRIORITY_MAP[(node.priority ?? "medium").toLowerCase()] ?? "Medium",
                },
                description: {
                  type: "doc",
                  version: 1,
                  content: [
                    { type: "paragraph", content: [{ type: "text", text: descriptionText }] },
                  ],
                },
                labels: ["pathlight-test-debt", node.id],
              },
            }),
          },
        );
        if (r.ok) {
          const issue = (await r.json()) as { key: string };
          const storyKey = sourceStoryKey(node);
          if (storyKey) {
            await linkBugToStory(token!, issue.key, storyKey);
          }
          return { journeyId: node.id, created: true, key: issue.key };
        }
        return { journeyId: node.id, created: false, error: `JIRA status ${r.status}` };
      } catch (err) {
        return {
          journeyId: node.id,
          created: false,
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        release();
      }
    };

    const settled = await Promise.allSettled(gaps.map((node) => createOne(node)));
    const results = settled.map((s) =>
      s.status === "fulfilled"
        ? s.value
        : { journeyId: "unknown", created: false, error: "Unexpected rejection" },
    );

    // Persist newly created story keys back to the manifest (single write).
    let manifestDirty = false;
    for (const result of results) {
      if (result.created && result.key) {
        const node = manifest.nodes.find((n) => n.id === result.journeyId);
        if (node) {
          node.openDebtStoryKey = result.key;
          manifestDirty = true;
        }
      }
    }
    if (manifestDirty) {
      await writeFileAtomic(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    }

    const created = results.filter((r) => r.created).length;
    const skipped = results.filter((r) => r.skipped).length;
    const failed = results.filter((r) => !r.created && !r.skipped && r.error).length;
    response.json({ created, skipped, failed, results });
  });

  app.get("/api/bugs/:journeyId/status", async (request, response) => {
    const { journeyId } = request.params;
    const bugKey = await getOpenBugKey(journeyId);
    if (!bugKey) {
      response.json({ bugKey: null, status: null });
      return;
    }

    const cached = bugStatusCache.get(journeyId);
    if (cached && Date.now() - cached.cachedAt < BUG_STATUS_CACHE_MS) {
      response.json({ bugKey: cached.bugKey, status: cached.status });
      return;
    }

    let token: { access_token: string; cloudId: string } | undefined;
    try {
      token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as typeof token;
    } catch {
      // JIRA not connected — return cached bug key without status.
    }

    if (!token) {
      response.json({ bugKey, status: "unknown", warning: "Could not verify existing bugs" });
      return;
    }

    const jiraFetch = jira.fetch ?? fetch;
    try {
      const r = await jiraFetch(
        `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issue/${bugKey}?fields=status`,
        { headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" } },
      );
      if (!r.ok) {
        response.json({ bugKey, status: "unknown", warning: "Could not verify existing bugs" });
        return;
      }
      const issue = (await r.json()) as { fields: { status: { name: string } } };
      const status = issue.fields.status.name;
      bugStatusCache.set(journeyId, { bugKey, status, cachedAt: Date.now() });
      response.json({ bugKey, status });
    } catch {
      response.json({ bugKey, status: "unknown", warning: "Could not verify existing bugs" });
    }
  });

  app.post("/api/bugs/create", async (request, response) => {
    if (!jiraRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    const { journeyId, attemptId } = request.body as {
      journeyId?: unknown;
      attemptId?: unknown;
    };
    if (typeof journeyId !== "string" || !journeyId) {
      response.status(400).json({ error: "journeyId is required." });
      return;
    }

    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      response.status(400).json({ error: "No locked manifest found." });
      return;
    }
    const node = manifest.nodes.find((n) => n.id === journeyId);
    if (!node) {
      response.status(404).json({ error: `Journey ${journeyId} not found.` });
      return;
    }

    let token: { access_token: string; cloudId: string };
    try {
      token = JSON.parse(await readFile(jiraTokenPath, "utf8")) as typeof token;
    } catch {
      response.status(400).json({ error: "JIRA not connected. Connect JIRA first." });
      return;
    }

    const jiraFetch = jira.fetch ?? fetch;
    let mockEnabled = false;
    try {
      mockEnabled = Boolean((await readConfig(path)).PATHLIGHT_JIRA_MOCK);
    } catch {
      // Config errors are non-fatal here.
    }

    const runId = eventBus.activeId ?? (await readRunHistory())[0]?.runId ?? "";
    const evidence = await readRunEvidence(
      runId,
      journeyId,
      typeof attemptId === "string" ? attemptId : undefined,
    );

    let bugKey: string;
    if (mockEnabled) {
      bugKey = `MOCK-${Date.now()}`;
    } else {
      const r = await jiraFetch(
        `https://api.atlassian.com/ex/jira/${token.cloudId}/rest/api/3/issue`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token.access_token}`,
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify({
            fields: buildJiraBugFields(manifest, node, evidence, runId, { auto: false }),
          }),
        },
      );
      if (!r.ok) {
        const body = await r.text();
        response.status(502).json({ error: `JIRA API error ${r.status}: ${body.slice(0, 200)}` });
        return;
      }
      const issue = (await r.json()) as { key: string };
      bugKey = issue.key;
      if (evidence.screenshotPath) {
        await attachScreenshotToBug(token, bugKey, evidence.screenshotPath);
      }
      const storyKey = sourceStoryKey(node);
      if (storyKey) {
        await linkBugToStory(token, bugKey, storyKey);
      }
    }

    await setOpenBugKey(journeyId, bugKey);
    bugStatusCache.set(journeyId, { bugKey, status: "Open", cachedAt: Date.now() });

    response.json({ bugKey });
  });

  app.post("/api/evidence/:nodeId/summarise", async (request, response) => {
    if (!process.env.ANTHROPIC_API_KEY && !callClaudeOverride) {
      response.status(503).json({ error: "AI not configured." });
      return;
    }
    if (!evidenceRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    const { attemptId, steps, error, journeyLabel, branchType } = request.body as {
      attemptId?: unknown;
      steps?: unknown;
      error?: unknown;
      journeyLabel?: unknown;
      branchType?: unknown;
    };
    if (typeof attemptId !== "string" || !attemptId) {
      response.status(400).json({ error: "attemptId is required." });
      return;
    }
    if (typeof journeyLabel !== "string" || !journeyLabel) {
      response.status(400).json({ error: "journeyLabel is required." });
      return;
    }
    const stepList: string[] = Array.isArray(steps)
      ? steps.filter((s): s is string => typeof s === "string")
      : [];
    const errorText = typeof error === "string" ? error : "(no error message)";
    const failingStep = stepList.at(-1) ?? "(unknown step)";
    const systemPrompt =
      "You are a QA assistant. Write a plain English failure summary for a developer. " +
      "No technical jargon. 3-5 sentences only. No bullet points or markdown.";
    const userContent =
      `Journey: ${journeyLabel}\n` +
      `Branch type: ${typeof branchType === "string" ? branchType : "unknown"}\n` +
      `Steps completed in order:\n${stepList.map((s, i) => `${i + 1}. ${s}`).join("\n") || "(none)"}\n` +
      `Failed at step: ${failingStep}\n` +
      `Error message: ${errorText}\n\n` +
      'Write the summary starting with: "The test was verifying that"';
    try {
      const summary = await callClaudeImpl({
        system: systemPrompt,
        userContent,
        bypass:
          "The test was verifying that this feature works correctly. (Stub — configure an AI provider in Settings to enable real failure summaries.)",
      });
      response.json({ summary });
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      response.status(502).json({ error: `Summary generation failed: ${reason}` });
    }
  });

  app.post("/api/events", (request, response) => {
    const result = eventBus.receive(request.body);
    // V9: post JIRA comment when a journey passes with an open bug
    if (
      result.status === 202 &&
      result.body.received === true &&
      typeof request.body === "object" &&
      request.body !== null &&
      (request.body as { type?: string }).type === "test.passed"
    ) {
      const payload = (request.body as { payload?: { testId?: string }; runId?: string }).payload;
      const runId = (request.body as { runId?: string }).runId ?? "";
      if (payload?.testId) {
        void postJiraPassComment(payload.testId, runId);
      }
    }
    response.status(result.status).json(result.body);
  });

  app.get("/api/stream", (request, response) => {
    eventBus.stream(request, response);
  });

  app.get("/api/runs/:runId", (request, response) => {
    const state = eventBus.getState(request.params.runId);
    if (!state) {
      response.sendStatus(404);
      return;
    }
    response.json(state);
  });

  app.get("/api/runs/:runId/output", async (request, response) => {
    if (!/^[A-Za-z0-9_-]+$/.test(request.params.runId)) {
      response.sendStatus(400);
      return;
    }
    const outputPath = join(projectRoot, "reports", request.params.runId, "output.log");
    try {
      const MAX_BYTES = 12_000;
      const info = await stat(outputPath);
      if (info.size === 0) {
        response.type("text/plain").send("");
        return;
      }
      // Read only the last MAX_BYTES to avoid loading large logs into memory.
      const { createReadStream } = await import("node:fs");
      const start = Math.max(0, info.size - MAX_BYTES);
      const stream = createReadStream(outputPath, { start, end: info.size - 1 });
      response.type("text/plain");
      stream.pipe(response);
    } catch {
      response.type("text/plain").send("");
    }
  });

  app.get("/api/health", async (_request, response) => {
    // Dependency checks — never throw; always return 200 with status field.
    let storageWritable = false;
    try {
      const probe = join(projectRoot, ".pathlight-health-probe.tmp");
      await writeFile(probe, "ok", "utf8");
      await unlink(probe);
      storageWritable = true;
    } catch {
      /* storage check failed */
    }

    let jiraConnected = false;
    try {
      await readFile(jiraTokenPath, "utf8");
      jiraConnected = true;
    } catch {
      /* not connected */
    }

    let aiConfigured = false;
    let aiProviderName = "none";
    try {
      const config = await readConfig(path);
      if (config.aiProvider?.provider) {
        aiConfigured = true;
        aiProviderName = config.aiProvider.provider;
      } else if (process.env.ANTHROPIC_API_KEY) {
        aiConfigured = true;
        aiProviderName = "claude";
      }
    } catch {
      /* config not set up */
    }

    const degraded = !storageWritable;
    response.json({
      status: degraded ? "degraded" : "ok",
      activeRunId: eventBus.activeId,
      dependencies: {
        ai: { configured: aiConfigured, provider: aiProviderName },
        jira: { connected: jiraConnected },
        storage: { writable: storageWritable },
      },
    });
  });

  // computeRisk is imported from ./services/RiskService.js

  // ── V8 Run History ──────────────────────────────────────────────────────
  // Business logic lives in services/HistoryService.ts

  const readRunHistory = () => readRunHistorySvc(projectRoot);
  const computeHealthScores = computeHealthScoresSvc;
  const detectRegressions = detectRegressionsSvc;

  // V8 run history is JSON-only. The Postgres store is not implemented; make the
  // fallback explicit (logged once) rather than implying Postgres support exists.
  let historyStorageLogged = false;
  const historyStorageMode = (): "json" | "postgres" => {
    if (!historyStorageLogged) {
      if (process.env.DATABASE_URL) {
        log.error("V8 run history: Postgres not implemented, falling back to local JSON store", {});
      } else {
        log.info("V8 run history: Postgres not configured, using local JSON store");
      }
      historyStorageLogged = true;
    }
    return "json";
  };

  app.get("/api/history", async (request, response) => {
    const storageMode = historyStorageMode();
    const page = Math.max(1, parseInt(String(request.query.page ?? "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(
        1,
        parseInt(String(request.query.limit ?? String(HISTORY_PAGE_LIMIT)), 10) ||
          HISTORY_PAGE_LIMIT,
      ),
    );
    const statusFilter = typeof request.query.status === "string" ? request.query.status : "";

    const allRuns = await readRunHistory();
    const filtered = statusFilter
      ? allRuns.filter((r) => r.status === statusFilter || r.verdict === statusFilter)
      : allRuns;
    // Most recent first (index is already newest-first from updateRunIndex)
    const total = filtered.length;
    const pageRuns = filtered.slice((page - 1) * limit, page * limit);

    const healthScores = computeHealthScores(allRuns);
    const regressions = [...detectRegressions(allRuns)];
    response.json({
      runs: pageRuns.map(({ testResults: _tr, ...r }) => r),
      total,
      page,
      limit,
      hasMore: page * limit < total,
      healthScores,
      regressions,
      storageMode,
    });
  });

  app.get("/api/risk", async (_request, response) => {
    let manifest: ManifestFile;
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      response.status(404).json({ error: "No locked manifest found." });
      return;
    }
    let runSummary: {
      intendedNodeIds?: string[];
      testResults?: Record<string, { status: string }>;
    } = {};
    try {
      const index = JSON.parse(await readFile(join(projectRoot, "runs", "index.json"), "utf8")) as {
        latest?: string;
      };
      if (index.latest) {
        runSummary = JSON.parse(
          await readFile(join(projectRoot, "reports", index.latest, "summary.json"), "utf8"),
        ) as typeof runSummary;
      }
    } catch {
      // No runs yet — all journeys are untested.
    }
    const intendedNodeIds = runSummary.intendedNodeIds ?? manifest.nodes.map((n) => n.id);
    const testResults = runSummary.testResults ?? {};
    const risk = computeRisk(manifest, testResults, intendedNodeIds);
    type BizRule = { id: string; label?: string; severity?: string; jurisdiction?: string };
    const ruleCoverage = ((manifest.businessRules ?? []) as BizRule[]).map((rule) => {
      const nodes = manifest.nodes.filter((n) => (n.businessRuleIds ?? []).includes(rule.id));
      const statuses = nodes.map((n) => testResults[n.id]?.status ?? "untested");
      const status = statuses.includes("failed")
        ? "FAIL"
        : statuses.every((s) => s === "passed")
          ? "PASS"
          : "UNTESTED";
      return { ...rule, status };
    });
    response.json({ ...risk, ruleCoverage, manifest: { projectKey: manifest.projectKey } });
  });

  // ── V10 Regression Scope Recommender ────────────────────────────────────

  // ── V11 Slack/Teams Alerts ──────────────────────────────────────────────

  app.post("/api/alerts/test", async (request, response) => {
    const { webhookUrl, platform } = request.body as {
      webhookUrl?: unknown;
      platform?: unknown;
    };
    const urlCheck = validateWebhookUrl(webhookUrl);
    if (!urlCheck.ok) {
      response.status(400).json({ error: urlCheck.error });
      return;
    }
    const platformName = typeof platform === "string" ? platform : "slack";
    let payload: unknown;
    if (platformName === "teams") {
      payload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        summary: "Pathlight test alert",
        text: "Pathlight alert connection test — this is a test message from Pathlight.",
      };
    } else {
      payload = {
        text: "Pathlight alert connection test — this is a test message from Pathlight.",
      };
    }
    try {
      const r = await fetch(urlCheck.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        response.status(502).json({ error: `Webhook returned ${r.status}` });
        return;
      }
      response.json({ sent: true });
    } catch (err) {
      response.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/alerts/run-complete", async (request, response) => {
    const {
      webhookUrl,
      platform,
      runId: alertRunId,
    } = request.body as {
      webhookUrl?: unknown;
      platform?: unknown;
      runId?: unknown;
    };
    const urlCheck = validateWebhookUrl(webhookUrl);
    if (!urlCheck.ok) {
      response.status(400).json({ error: urlCheck.error });
      return;
    }
    const platformName = typeof platform === "string" ? platform : "slack";
    const targetRunId = typeof alertRunId === "string" ? alertRunId : undefined;
    let summary: { verdict?: string; runId?: string; intendedNodeIds?: string[] } = {};
    try {
      const index = JSON.parse(await readFile(join(projectRoot, "runs", "index.json"), "utf8")) as {
        latest?: string;
      };
      const rid = targetRunId ?? index.latest;
      if (rid) {
        summary = JSON.parse(
          await readFile(join(projectRoot, "reports", rid, "summary.json"), "utf8"),
        ) as typeof summary;
      }
    } catch {
      /* no run yet */
    }
    const verdict = summary.verdict ?? "UNKNOWN";
    const emoji = verdict === "PASSED" ? "✅" : verdict === "WARNING" ? "⚠️" : "❌";
    const text = `${emoji} Pathlight run ${summary.runId ?? "unknown"}: ${verdict} — ${summary.intendedNodeIds?.length ?? 0} journeys in scope`;
    let payload: unknown;
    if (platformName === "teams") {
      payload = {
        "@type": "MessageCard",
        "@context": "http://schema.org/extensions",
        summary: `Pathlight ${verdict}`,
        themeColor: verdict === "PASSED" ? "2d9e6b" : verdict === "WARNING" ? "e09e26" : "c0392b",
        text,
      };
    } else {
      payload = { text };
    }
    try {
      const r = await fetch(urlCheck.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const domain = new URL(urlCheck.url).hostname;
        log.warn("Webhook returned non-2xx", {
          operation: "run-complete",
          webhookDomain: domain,
          status: r.status,
        });
      }
      response.json({ sent: r.ok, verdict });
    } catch (err) {
      response.status(502).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  // ── V11 README Badge ────────────────────────────────────────────────────

  app.get("/api/badge", async (_request, response) => {
    let verdict = "NO DATA";
    let colour = "#a0aec0";
    let passRate = "";
    try {
      const index = JSON.parse(await readFile(join(projectRoot, "runs", "index.json"), "utf8")) as {
        latest?: string;
      };
      if (index.latest) {
        const summary = JSON.parse(
          await readFile(join(projectRoot, "reports", index.latest, "summary.json"), "utf8"),
        ) as {
          verdict?: string;
          intendedNodeIds?: string[];
          testResults?: Record<string, { status: string }>;
        };
        verdict = summary.verdict ?? "UNKNOWN";
        colour = verdict === "PASSED" ? "#2d9e6b" : verdict === "WARNING" ? "#e09e26" : "#c0392b";
        const total = summary.intendedNodeIds?.length ?? 0;
        const passed = Object.values(summary.testResults ?? {}).filter(
          (r) => r.status === "passed",
        ).length;
        passRate = total > 0 ? ` • ${passed}/${total}` : "";
      }
    } catch {
      /* no runs yet */
    }
    const label = "Pathlight";
    const value = `${verdict}${passRate}`;
    const labelW = label.length * 7 + 16;
    const valueW = value.length * 7 + 16;
    const totalW = labelW + valueW;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${totalW}" height="20">
  <linearGradient id="s" x2="0" y2="100%"><stop offset="0" stop-color="#bbb" stop-opacity=".1"/><stop offset="1" stop-opacity=".1"/></linearGradient>
  <rect rx="3" width="${totalW}" height="20" fill="#555"/>
  <rect rx="3" x="${labelW}" width="${valueW}" height="20" fill="${colour}"/>
  <rect width="${totalW}" height="20" fill="url(#s)"/>
  <g fill="#fff" text-anchor="middle" font-family="DejaVu Sans,Verdana,Geneva,sans-serif" font-size="11">
    <text x="${labelW / 2}" y="15" fill="#010101" fill-opacity=".3">${label}</text>
    <text x="${labelW / 2}" y="14">${label}</text>
    <text x="${labelW + valueW / 2}" y="15" fill="#010101" fill-opacity=".3">${value}</text>
    <text x="${labelW + valueW / 2}" y="14">${value}</text>
  </g>
</svg>`;
    response
      .set("Content-Type", "image/svg+xml")
      .set("Cache-Control", "no-cache, max-age=0")
      .send(svg);
  });

  // ── V11 Compliance Audit Trail ──────────────────────────────────────────

  app.get("/api/compliance-report/:runId", async (request, response) => {
    if (!/^[A-Za-z0-9_-]+$/.test(request.params.runId)) {
      response.sendStatus(400);
      return;
    }
    const targetRunId = request.params.runId;
    let summary: Parameters<typeof buildComplianceHtml>[2];
    try {
      summary = JSON.parse(
        await readFile(join(projectRoot, "reports", targetRunId, "summary.json"), "utf8"),
      ) as typeof summary;
    } catch {
      response.status(404).json({ error: "Run not found." });
      return;
    }
    let manifest: ManifestFile = {
      schemaVersion: "1.0",
      projectKey: "",
      lockedAt: null,
      lockedBy: null,
      businessRules: [],
      nodes: [],
    };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
    } catch {
      /* proceed */
    }

    response
      .set("Content-Type", "text/html")
      .send(buildComplianceHtml(targetRunId, manifest, summary));
  });

  // ── V11 MCP Server ──────────────────────────────────────────────────────
  // Exposes Pathlight data to AI IDEs via JSON-RPC style requests.

  app.post("/api/mcp", async (request, response) => {
    // This is a custom HTTP endpoint, not a real MCP transport (see README).
    response.set("X-Pathlight-MCP-Version", "custom-http-v1");
    const { method, params } = request.body as {
      method?: string;
      params?: Record<string, unknown>;
    };
    if (method === "pathlight/gate") {
      try {
        // Read gate inputs directly from local storage — no HTTP loopback.
        const index = JSON.parse(
          await readFile(join(projectRoot, "runs", "index.json"), "utf8"),
        ) as { latest?: string };
        if (!index.latest) throw new Error("No completed runs found.");
        const run = JSON.parse(
          await readFile(join(projectRoot, "reports", index.latest, "summary.json"), "utf8"),
        ) as {
          runId: string;
          verdict?: string;
          intendedNodeIds: string[];
          testResults: Record<string, { status: string }>;
        };
        let manifest: ManifestFile = {
          schemaVersion: "1.0",
          projectKey: "",
          lockedAt: null,
          lockedBy: null,
          businessRules: [],
          nodes: [],
        };
        try {
          manifest = JSON.parse(await readFile(manifestPath, "utf8")) as ManifestFile;
        } catch {
          /* proceed */
        }

        const intended = run.intendedNodeIds ?? [];
        const results = run.testResults ?? {};
        const nodeMap = new Map(manifest.nodes.map((n) => [n.id, n]));
        const passed = intended.filter((id) => results[id]?.status === "passed").length;
        const failed = intended.filter((id) => results[id]?.status === "failed").length;
        const total = intended.length;
        const passRate = total > 0 ? (passed / total) * 100 : 100;
        const isHighest = (p: string | undefined) =>
          /^(highest|p0|p-0|critical|blocker)$/i.test((p ?? "").trim());
        const highestFailures = intended.filter(
          (id) => results[id]?.status === "failed" && isHighest(nodeMap.get(id)?.priority),
        );
        const reasons: string[] = [];
        if (highestFailures.length > 0)
          reasons.push(`${highestFailures.length} Highest priority journey(s) failed`);
        const minPassRate =
          typeof params?.minPassRate === "number" ? params.minPassRate : undefined;
        if (minPassRate !== undefined && passRate < minPassRate)
          reasons.push(`Pass rate ${passRate.toFixed(1)}% below required ${minPassRate}%`);
        response.json({
          result: {
            passed: reasons.length === 0,
            runId: run.runId,
            verdict: run.verdict ?? "UNKNOWN",
            passRate,
            totalJourneys: total,
            passedJourneys: passed,
            failedJourneys: failed,
            reasons,
          },
        });
      } catch (err) {
        response.status(500).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else if (method === "pathlight/risk") {
      const riskRes = await fetch(`${SELF_BASE_URL}/api/risk`);
      const risk = await riskRes.json();
      response.json({ result: risk });
    } else if (method === "pathlight/history") {
      const histRes = await fetch(`${SELF_BASE_URL}/api/history`);
      const hist = await histRes.json();
      response.json({ result: hist });
    } else if (method === "pathlight/query") {
      const question = typeof params?.question === "string" ? params.question : "";
      if (!question) {
        response.status(400).json({ error: "params.question is required" });
        return;
      }
      const [riskRes, histRes] = await Promise.all([
        fetch(`${SELF_BASE_URL}/api/risk`),
        fetch(`${SELF_BASE_URL}/api/history`),
      ]);
      const [risk, history] = await Promise.all([riskRes.json(), histRes.json()]);
      const context = JSON.stringify({ risk, history }, null, 2);
      try {
        const answer = await callClaudeImpl({
          system:
            "You are a Pathlight test analyst. Answer concisely based only on the data provided.",
          userContent: `Context:\n${context}\n\nQuestion: ${question}`,
          bypass:
            "Stub: AI provider not configured. Configure an AI provider in Settings to enable natural-language queries.",
        });
        response.json({ result: answer });
      } catch (err) {
        response.status(502).json({ error: err instanceof Error ? err.message : String(err) });
      }
    } else {
      response.status(400).json({
        error: `Unknown method: ${method ?? "(none)"}. Available: pathlight/gate, pathlight/risk, pathlight/history, pathlight/query`,
      });
    }
  });

  app.get("/api/regression-scope", async (request, response) => {
    const prParam = request.query.pr;
    const pr = typeof prParam === "string" ? prParam.trim() : "";

    // V10 is not complete: reading the linked JIRA stories from a PR is not yet
    // implemented. The previous JIRA full-text search for "PR-<n>" produced
    // unreliable scope, so we return an honest empty recommendation instead of
    // guessing. Callers should run the full suite or pass --nodes manually.
    response.json({
      pr: pr || null,
      recommendedNodeIds: [],
      reason:
        "PR description parsing not yet implemented. Run full suite or specify --nodes manually.",
      fallback: "full-suite",
    });
  });

  // ── V10 Multi-Environment ───────────────────────────────────────────────

  app.get("/api/history/compare", async (request, response) => {
    const { runA, runB } = request.query as { runA?: string; runB?: string };
    if (!runA || !runB) {
      response.status(400).json({ error: "runA and runB query parameters are required." });
      return;
    }
    const RUN_ID_RE = /^[A-Za-z0-9_-]+$/;
    if (!RUN_ID_RE.test(runA) || !RUN_ID_RE.test(runB)) {
      response.status(400).json({
        error: "runA and runB must contain only letters, digits, hyphens, or underscores.",
      });
      return;
    }
    async function loadRunSummary(runId: string) {
      try {
        return JSON.parse(
          await readFile(join(projectRoot, "reports", runId, "summary.json"), "utf8"),
        ) as { testResults?: Record<string, { status: string }>; verdict?: string };
      } catch {
        return null;
      }
    }
    const [summaryA, summaryB] = await Promise.all([loadRunSummary(runA), loadRunSummary(runB)]);
    if (!summaryA || !summaryB) {
      response.status(404).json({ error: "One or both runs not found." });
      return;
    }
    const allIds = new Set([
      ...Object.keys(summaryA.testResults ?? {}),
      ...Object.keys(summaryB.testResults ?? {}),
    ]);
    const differences: Array<{
      journeyId: string;
      statusA: string;
      statusB: string;
    }> = [];
    for (const id of allIds) {
      const statusA = summaryA.testResults?.[id]?.status ?? "untested";
      const statusB = summaryB.testResults?.[id]?.status ?? "untested";
      if (statusA !== statusB) {
        differences.push({ journeyId: id, statusA, statusB });
      }
    }
    response.json({
      runA,
      runB,
      verdictA: summaryA.verdict,
      verdictB: summaryB.verdict,
      differences,
      differenceCount: differences.length,
    });
  });

  app.get("/api/runs/latest", async (_request, response) => {
    try {
      const index = JSON.parse(await readFile(join(projectRoot, "runs", "index.json"), "utf8")) as {
        latest?: string;
        runs?: Array<{ runId: string; status: string }>;
      };
      if (!index.latest) {
        response.status(404).json({ error: "No runs found." });
        return;
      }
      const summary = JSON.parse(
        await readFile(join(projectRoot, "reports", index.latest, "summary.json"), "utf8"),
      ) as Record<string, unknown>;
      response.json(summary);
    } catch {
      response.status(404).json({ error: "No completed runs found." });
    }
  });

  app.get("/reports/:runId/report.html", (request, response) => {
    if (!/^[A-Za-z0-9_-]+$/.test(request.params.runId)) {
      response.sendStatus(400);
      return;
    }
    response.sendFile(join(projectRoot, "reports", request.params.runId, "report.html"));
  });

  async function configuredRunner() {
    let config: PathlightConfig;
    try {
      config = await readConfig(path);
    } catch {
      return { error: "Configure your project location before starting a run" };
    }
    if (
      !config.projectRoot ||
      !isAbsolute(config.projectRoot) ||
      !(await directoryExists(config.projectRoot))
    ) {
      return { error: "Configure your project location before starting a run" };
    }
    const playwrightConfigPath = config.playwrightConfigPath || "playwright.config.ts";
    if (
      isAbsolute(playwrightConfigPath) ||
      !(await fileExists(join(config.projectRoot, playwrightConfigPath)))
    ) {
      return { error: "playwright.config.ts not found" };
    }
    if (!(await fileExists(bundledReporterPath))) {
      return {
        error: "Pathlight bundled reporter not found. Run npm run build before starting a run.",
      };
    }
    return { projectRoot: config.projectRoot, playwrightConfigPath };
  }

  app.post("/api/runs", async (request, response) => {
    if (!runsRl.check("local")) {
      response.status(429).json({ error: "Rate limit exceeded. Try again later." });
      return;
    }
    if (eventBus.isRunning()) {
      response.status(409).json({ error: "Run in progress", activeRunId: eventBus.activeId });
      return;
    }
    let manifest: ManifestFile & {
      nodes: Array<ManifestFile["nodes"][number] & { deprecated?: boolean }>;
    };
    try {
      manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    } catch {
      response.status(400).json({ error: "Lock the manifest before starting a run" });
      return;
    }
    if (!manifest.lockedAt) {
      response.status(400).json({ error: "Lock the manifest before starting a run" });
      return;
    }
    const runner = await configuredRunner();
    if ("error" in runner) {
      response.status(400).json({ error: runner.error });
      return;
    }
    const rawNodeIds: unknown[] = Array.isArray(request.body.nodeIds) ? request.body.nodeIds : [];
    const nodeIds = rawNodeIds
      .filter((id): id is string => typeof id === "string" && id.trim().length > 0)
      .map((id) => id.trim());
    const suiteTag = typeof request.body.suiteTag === "string" ? request.body.suiteTag : undefined;
    const nonDeprecated = manifest.nodes.filter((node) => !node.deprecated);
    const intendedNodeIds =
      nodeIds.length > 0
        ? (() => {
            const validIds = new Set(nonDeprecated.map((node) => node.id));
            return nodeIds.filter((id) => validIds.has(id));
          })()
        : nonDeprecated
            .filter((node) => !suiteTag || (node.tags ?? []).includes(suiteTag))
            .map((node) => node.id);
    const blockedNodeIds = manifest.nodes
      .filter((node) => intendedNodeIds.includes(node.id) && (node.tags ?? []).includes("@blocked"))
      .map((node) => node.id);
    const runId =
      typeof request.body.runId === "string" ? request.body.runId : generatedRunId(projectRoot);
    if (typeof request.body.runId === "string" && !/^[a-zA-Z0-9_-]+$/.test(runId)) {
      response.status(400).json({
        error: "Invalid runId: must contain only letters, digits, hyphens, or underscores.",
      });
      return;
    }
    // Run provenance: explicit body fields win, else fall back to CI env vars.
    // Never store empty strings — use undefined so the field is simply omitted.
    const firstNonEmpty = (...values: Array<string | undefined>): string | undefined => {
      for (const value of values) {
        const trimmed = value?.trim();
        if (trimmed) return trimmed;
      }
      return undefined;
    };
    const runBody = request.body as {
      environment?: unknown;
      branch?: unknown;
      pr?: unknown;
      commit?: unknown;
    };
    const asString = (value: unknown) => (typeof value === "string" ? value : undefined);
    const environment = firstNonEmpty(asString(runBody.environment));
    const branch = firstNonEmpty(
      asString(runBody.branch),
      process.env.GITHUB_REF_NAME,
      process.env.BRANCH_NAME,
    );
    const commit = firstNonEmpty(
      asString(runBody.commit),
      process.env.GITHUB_SHA,
      process.env.COMMIT_SHA,
    );
    const pr = firstNonEmpty(
      asString(runBody.pr),
      process.env.GITHUB_PR_NUMBER,
      process.env.PR_NUMBER,
    );
    const runMetadata = {
      ...(environment ? { environment } : {}),
      ...(branch ? { branch } : {}),
      ...(pr ? { pr } : {}),
      ...(commit ? { commit } : {}),
    };
    const reportDirectory = join(projectRoot, "reports", runId);
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      join(reportDirectory, "summary.json"),
      `${JSON.stringify({ runId, status: "running", intendedNodeIds, ...runMetadata }, null, 2)}\n`,
      "utf8",
    );
    eventBus.startRun(runId, intendedNodeIds, blockedNodeIds, runMetadata);
    const options: LaunchRunOptions = {
      command: "npx",
      args: [
        "playwright",
        "test",
        `--reporter=list,${bundledReporterPath}`,
        ...(runner.playwrightConfigPath === "playwright.config.ts"
          ? []
          : ["--config", runner.playwrightConfigPath]),
      ],
      cwd: runner.projectRoot,
      env: {
        ...process.env,
        PATHLIGHT_MANIFEST_NODE_IDS: JSON.stringify(
          manifest.nodes.filter((node) => !node.deprecated).map((node) => node.id),
        ),
        PATHLIGHT_RUN_ID: runId,
        PATHLIGHT_SERVER_URL: "http://127.0.0.1:4242",
      },
    };
    try {
      const launchedChild = launchRun
        ? launchRun(options)
        : (spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
          }) as RunningChild);
      child = launchedChild;
      captureRunOutput(launchedChild, reportDirectory);
      launchedChild.on?.("close", () => {
        if (eventBus.activeId === runId) {
          eventBus.abandon("crash");
        }
      });
    } catch {
      eventBus.abandon("crash");
      response.status(500).json({
        error: "Playwright could not be started. Install Playwright before starting a run.",
      });
      return;
    }
    response.status(201).json({ runId, intendedNodeIds });
  });

  app.post("/api/runs/:runId/rerun", async (request, response) => {
    if (eventBus.isRunning()) {
      response.status(409).json({ error: "Run in progress", activeRunId: eventBus.activeId });
      return;
    }
    const previous = eventBus.getState(request.params.runId);
    if (!previous) {
      response.sendStatus(404);
      return;
    }
    const failedNodeIds = Object.entries(previous.testResults)
      .filter(([, result]) => result.status === "failed")
      .map(([id]) => id);
    if (request.body.failedOnly !== true || failedNodeIds.length === 0) {
      response.status(400).json({ error: "No failed branches are available to rerun." });
      return;
    }
    const runner = await configuredRunner();
    if ("error" in runner) {
      response.status(400).json({ error: runner.error });
      return;
    }
    const grepPattern = `\\[(${failedNodeIds.map(escapeRegularExpression).join("|")})\\]`;
    const runId = generatedRunId(projectRoot);
    const reportDirectory = join(projectRoot, "reports", runId);
    await mkdir(reportDirectory, { recursive: true });
    await writeFile(
      join(reportDirectory, "summary.json"),
      `${JSON.stringify({ runId, status: "running", intendedNodeIds: failedNodeIds }, null, 2)}\n`,
      "utf8",
    );
    eventBus.startRun(runId, failedNodeIds);
    const options: LaunchRunOptions = {
      command: "npx",
      args: [
        "playwright",
        "test",
        `--reporter=list,${bundledReporterPath}`,
        ...(runner.playwrightConfigPath === "playwright.config.ts"
          ? []
          : ["--config", runner.playwrightConfigPath]),
        "--grep",
        grepPattern,
      ],
      cwd: runner.projectRoot,
      env: {
        ...process.env,
        PATHLIGHT_MANIFEST_NODE_IDS: JSON.stringify(failedNodeIds),
        PATHLIGHT_RUN_ID: runId,
        PATHLIGHT_SERVER_URL: "http://127.0.0.1:4242",
      },
    };
    try {
      const launchedChild = launchRun
        ? launchRun(options)
        : (spawn(options.command, options.args, {
            cwd: options.cwd,
            env: options.env,
            stdio: ["pipe", "pipe", "pipe"],
            detached: false,
          }) as RunningChild);
      child = launchedChild;
      captureRunOutput(launchedChild, reportDirectory);
      launchedChild.on?.("close", () => {
        if (eventBus.activeId === runId) {
          eventBus.abandon("crash");
        }
      });
    } catch {
      eventBus.abandon("crash");
      response.status(500).json({
        error: "Playwright could not be started. Install Playwright before starting a run.",
      });
      return;
    }
    response.status(201).json({ runId, intendedNodeIds: failedNodeIds });
  });

  app.delete("/api/runs/:runId", (request, response) => {
    const state = eventBus.getState(request.params.runId);
    if (!state || state.status !== "running") {
      response.sendStatus(404);
      return;
    }
    child?.kill("SIGTERM");
    const killTimer = setTimeout(() => {
      if (child && !child.killed) {
        child.kill("SIGKILL");
        if (child.pid) {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            // Process may have exited between the status check and group kill.
          }
        }
      }
    }, 5000);
    killTimer.unref();
    eventBus.abandon("user_stopped");
    response.status(202).json({ status: "stopping" });
  });

  return app;
}
