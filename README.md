# Pathlight

Pathlight is a local test intelligence application.

## Start

Requires Node.js 22 or later.

```bash
npm install
cp config/environments/development.env.example .env
npm run dev
```

Open `http://127.0.0.1:4242/config`.

## Connect A Project

In **Project Location**, set:

- **Project root**: the absolute path to the application project containing Playwright tests.
- **Playwright config path**: the config file path relative to that root, defaulting to `playwright.config.ts`.

Use **Verify connection** before saving. Pathlight runs the configured project's tests and
injects its own reporter at run time; the selected project does not install a Pathlight package
or modify its Playwright configuration.

## How Journey Matching Works

Include the manifest journey ID in each tracked Playwright test title, for example:

```ts
test("[E2E-005] Owner sends a review request SMS", async ({ page }) => {
  // test steps
});
```

When a run starts, Pathlight matches the first bracketed ID in each title to a locked manifest
node. Tests without a bracketed journey ID and IDs absent from the manifest are reported as
untracked health counts and do not update fishbone branches.

## CLI

Install once, then run from any CI or terminal:

```bash
npm install -g @pathlight/cli   # or: npx pathlight
```

| Command                           | Description                            |
| --------------------------------- | -------------------------------------- |
| `pathlight run`                   | Trigger a test run                     |
| `pathlight status`                | Show latest run result                 |
| `pathlight stop`                  | Stop the running suite                 |
| `pathlight report`                | Print URL of the latest report         |
| `pathlight journeys`              | List journeys from the locked manifest |
| `pathlight gaps`                  | Show journeys with no test coverage    |
| `pathlight generate --journey=ID` | AI-generate a test for a journey       |
| `pathlight derive`                | Derive journeys from JIRA stories      |
| `pathlight map`                   | Map existing tests to journeys         |
| `pathlight scope --pr=N`          | Journeys in scope for a PR             |
| `pathlight gate`                  | Run the release quality gate           |
| `pathlight query "..."`           | Ask a natural-language question        |

## CI Quality Gate

Add to any GitHub Actions workflow:

```yaml
- run: pathlight gate --min-pass-rate=90 --no-critical-failures
  env:
    PATHLIGHT_SERVER_URL: ${{ secrets.PATHLIGHT_URL }}
```

Exit code 0 = gate passes. Exit code 1 = gate fails (blocks merge).

## AI Provider

Configure in **Settings → AI Provider** or by setting env vars:

| Provider         | Env var                                                |
| ---------------- | ------------------------------------------------------ |
| Claude (default) | `ANTHROPIC_API_KEY`                                    |
| OpenAI           | Set in UI or `OPENAI_API_KEY`                          |
| Gemini           | Set in UI or `GOOGLE_API_KEY`                          |
| Ollama (local)   | Set Ollama URL in UI, default `http://localhost:11434` |

Use `BYPASS_EXTERNAL_AI=true` to run without any AI provider (stub responses).

## Slack / Teams Alerts

In **Settings → Alerts**, paste a webhook URL:

- Slack: create an Incoming Webhook at `api.slack.com/apps`
- Teams: use a channel connector webhook

Webhooks must use HTTPS and cannot target localhost.

## MCP Server (AI IDE Integration)

Connect Claude Code or another MCP-capable IDE to Pathlight:

```
POST http://127.0.0.1:4242/api/mcp
{ "method": "pathlight/gate" }
{ "method": "pathlight/risk" }
{ "method": "pathlight/history" }
{ "method": "pathlight/query", "params": { "question": "Which journeys are flaky?" } }
```

This is a custom HTTP endpoint, not a real MCP transport — responses carry the
header `X-Pathlight-MCP-Version: custom-http-v1`.

## Implementation Source Of Truth

Implementation status, architecture, configuration, API routes, engineering controls,
acceptance criteria and verification results are consolidated in:

[Pathlight Development Handoff — Complete Edition v2.0](Docs/pathlight-development-handoff-combined.docx)

The PRD, technical architecture and engineering plan under `Docs/` are input requirements.
