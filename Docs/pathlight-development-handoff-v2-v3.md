# Pathlight Development Handoff — V2 & V3 Updates
**Date:** May 2026 | **Branch:** spike/demo-slice

This document supplements `pathlight-development-handoff-v1.0.docx` with all V2 (Path Intelligence Engine) and V3 (Automatic Test Mapping) implementation details.

---

## V2 — Path Intelligence Engine

### What was built

V2 adds AI-driven journey derivation from JIRA stories, replacing the manual CSV workflow with a Claude-powered pipeline. The CSV workflow still works unchanged.

### New files / changed files

| File | Change |
|------|--------|
| `apps/server/src/app.ts` | Added 8 new endpoints, Anthropic SDK import, DraftManifest types |
| `apps/web/src/features/config/ConfigPage.tsx` | Added Journey Intelligence panel and draft manifest UI |
| `apps/web/src/features/fishbone/FishbonePage.tsx` | Added draft mode rendering path |
| `apps/web/src/styles.css` | Added draft mode CSS, story list CSS |
| `packages/manifest-schema/src/index.ts` | Added DraftState, DraftNode, SuggestedBusinessRule, DraftManifest types |

### New server endpoints

```
GET  /api/jira/stories          — returns pathlight-stories.json cache
POST /api/jira/fetch-stories    — fetches JIRA stories (or mock), saves cache
PATCH /api/jira/stories/:key    — toggle story exclusion
POST /api/journeys/derive       — Claude derivation → pathlight-draft-manifest.json
GET  /api/manifest/draft        — returns draft manifest
PATCH /api/manifest/draft/journeys/:id  — approve/edit/reject a draft journey
POST /api/manifest/draft/journeys       — add manual journey to draft
POST /api/manifest/lock-from-draft      — lock approved journeys → pathlight-manifest.json
```

### Artifacts produced

| Artifact | Location | Description |
|----------|----------|-------------|
| `pathlight-stories.json` | `{projectRoot}/` | JIRA stories cache with exclusion flags |
| `pathlight-draft-manifest.json` | `{projectRoot}/` | AI-derived draft journeys pending review |
| `pathlight-manifest.json` | `{projectRoot}/` | Locked manifest (same schema as V1 CSV flow) |

### Draft workflow

1. Config page → "Journey Intelligence" panel → fetch stories from JIRA (or mock)
2. Optionally exclude stories
3. Click "Derive journeys" → Claude generates draft manifest
4. Fishbone shows draft branches (grey=pending, green=approved, red=rejected)
5. Click any branch to approve/reject/edit
6. Click "Lock manifest" → approved journeys become production manifest
7. Run tests as normal

### JIRA mock mode

When JIRA is not connected, fetch-stories returns 6 ZovKu sample stories. Set `MOCK_JIRA=true` in environment or the mock returns automatically when no JIRA token exists.

### Config page changes

- Added `jiraProjectKey` field
- Added "Fetch stories" button with story list (exclude, epic filter)
- Added "Derive journeys" button (requires ANTHROPIC_API_KEY in env)
- Fishbone page shows draft mode when no locked manifest + draft exists

---

## V3 — Automatic Test Mapping

### What was built

V3 maps existing Playwright tests to manifest journeys using Claude semantic analysis. No test files are modified.

### New files / changed files

| File | Change |
|------|--------|
| `apps/server/src/app.ts` | Added 7 new endpoints for test scanning, mapping, review |
| `apps/web/src/features/config/ConfigPage.tsx` | Added Test Suite panel with scan, mapping trigger |
| `apps/web/src/features/fishbone/FishbonePage.tsx` | Added coverage overlay (amber/grey), summary card, gap list |
| `apps/web/src/features/mapping/MappingReviewPage.tsx` | New page at `/mapping-review` |
| `apps/web/src/App.tsx` | Added `/mapping-review` route |
| `apps/web/src/styles.css` | Added scan summary, exclude folder, mapping review, coverage CSS |

### New server endpoints

```
GET  /api/tests/scan           — returns pathlight-test-scan.json cache
POST /api/tests/scan           — scans testDir for spec files, writes cache
GET  /api/mapping              — returns pathlight-test-mapping.json
POST /api/mapping/derive       — Claude maps tests to journeys → pathlight-test-mapping.json
PATCH /api/mapping/journeys/:id/tests/:idx  — approve or reject a single test mapping
POST /api/mapping/bulk-approve — approve all high-confidence mappings
POST /api/mapping/manual       — manually assign a test to an unmapped journey
GET  /api/mapping/gap-report.csv  — CSV export of all journeys with coverage status
```

### Artifacts produced

| Artifact | Location | Description |
|----------|----------|-------------|
| `pathlight-test-scan.json` | `{projectRoot}/` | Spec file inventory: titles, describe blocks, folder groups |
| `pathlight-test-mapping.json` | `{projectRoot}/` | Journey-to-test mappings with confidence and approval flags |

### V3 user flow

1. Config page → "Test Suite" panel → enter `testDir` (e.g. `tests/e2e`)
2. Click "Scan test suite" → shows folder breakdown, describe blocks
3. Optionally exclude folders (legacy, disabled tests)
4. Click "Start mapping" → Claude reads all test cases and locked manifest journeys
5. Navigate to `/mapping-review` → review High/Medium/Low/Unmapped groups
6. Approve individual mappings, or bulk-approve all high-confidence
7. For unmapped journeys → "Assign test" → searchable test picker modal
8. Fishbone now shows coverage: amber (mapped, not run), grey (gap), green (mapped + passed)
9. Coverage summary card shows "X of Y journeys" + gap count
10. "Export gap report" downloads CSV for sprint planning

### Coverage state on fishbone

| State | Color | Meaning |
|-------|-------|---------|
| Green | `var(--success)` | Approved mapping + test passed in last run |
| Amber | `#e09e26` | Approved mapping, test not yet run this session |
| Grey (dim) | `#aeb8c7 @ 50%` | No approved mapping = genuine gap |
| Red | `var(--error)` | Approved mapping + test failed in last run |

Coverage overlay only shows when `pathlight-test-mapping.json` exists and has approved mappings. During an active run, live test events take precedence over coverage state.

### Gap report CSV format

```csv
journey_id,label,stage,module,branch_type,coverage_status,estimated_effort
E2E-001,"Owner submits request","Core SMS Review Flow","Review Flow",happy,covered,simple
E2E-007,"SMS gateway times out","Core SMS Review Flow","Review Flow",system,gap,complex
```

Effort mapping: `happy=simple`, `unhappy/edge=moderate`, `boundary/system=complex`.

### Test scan: exclusion defaults

`node_modules`, `.auth`, `fixtures`, `setup`, `teardown`, `.git` are always excluded. Additional folders can be excluded per scan.

### Spec file pattern

`/\.(spec|test)\.(js|ts|mjs|mts|cjs|cts)$/` — covers all common Playwright extensions.

---

## Environment variables required

| Variable | Used by | Required for |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | `POST /api/journeys/derive`, `POST /api/mapping/derive` | V2 journey derivation, V3 test mapping |

Add to `.env` at project root (see `.env.example`).

---

## Test counts

| Before V2 | After V2 | After V3 | After V4 | After post-V4 fixes | After second-pass fixes |
|-----------|----------|----------|----------|---------------------|-------------------------|
| ~50 tests | 71 tests | 71 tests | 93 tests | 94 tests | 94 tests |

All tests pass. TypeScript strict mode — no errors. All new functionality is in server endpoints (app.ts) and React components with no breaking changes to existing test suites.

---

## Post-V4 bug fixes (codex review — first pass)

| ID | Severity | Fix |
|----|----------|-----|
| P0 | Critical | Reporter semantic mapping: `PathlightReporter` now loads `GET /api/mapping` at run start and uses approved test-title→journeyId mappings as a fallback in `mapTest` when no `[ID]` tag is present in the test title. |
| P1 | High | Business rules at lock: `POST /api/manifest/lock-from-draft` now copies `draft.suggestedBusinessRules` into `manifest.businessRules` instead of writing `[]`. |
| P1 | High | runId path traversal: `POST /api/runs` now validates that a caller-supplied `runId` matches `[a-zA-Z0-9_-]+` before using it to construct a file path. |
| P1 | High | V4 approval bypass: `GeneratedTest` gains `runPassed?: boolean`; the run endpoint sets it; the approve endpoint rejects (400) unless both quality checks pass and `runPassed` is true. Editing content resets `runPassed`. |
| P1 | High | testDir path escape: scan, generation, and approve endpoints now reject absolute `testDir` values. |
| P1 | High | Story AC in V4 generation: `generateTestContent` checks `node.linkedStories` as a fallback when `node.storyId` is absent (V2-derived locked nodes store the source key in `linkedStories`, not `storyId`). |
| P2 | Medium | V2/V3 AI calls: `POST /api/journeys/derive` and `POST /api/mapping/derive` now use the injectable `callClaudeImpl` instead of directly instantiating `new Anthropic()`. |
| P2 | Medium | Lint: `eslint.config.js` adds `varsIgnorePattern: "^_"` so intentionally-unused destructuring variables (`_ds`, `_sk`, `_fl`, `_c`) are not flagged. |

---

## Post-V4 bug fixes (second pass)

| ID | Severity | Fix |
|----|----------|-----|
| P1 | High | Reporter semantic mapping race: `semanticMappingLoaded` promise stored at `onBegin`; `onTestBegin` awaits it before calling `mapTest`, eliminating intermittent untagged-test misses when mappings load slowly. |
| P1 | High | Semantic mis-mapping: removed `includes()` substring match from `lookupSemantic`; only exact match and suffix (describe-prefix) match are kept, preventing common-title collision across journeys. |
| P1 | High | Regenerate clears approval gate: `POST /api/generation/:journeyId/regenerate` now resets `runPassed: undefined` alongside content/quality, so a previously-passing test cannot be approved after regeneration without re-running. |
| P1 | High | Mapping derivation trusts Claude blindly: `POST /api/mapping/derive` now filters out any `journeyId` returned by Claude that is not present in the locked manifest, preventing phantom entries in `pathlight-test-mapping.json`. |
| P2 | Medium | JIRA story pagination: `POST /api/jira/fetch-stories` now loops with `startAt` until all pages are fetched (50 per page), replacing the silent 200-story cap. |
| P2 | Medium | CSV formula injection: gap-report CSV cells are now checked for leading `=`, `+`, `-`, `@` characters and prefixed with `'` to prevent spreadsheet formula execution. |
| P2 | Medium | Multer upload size limit: `multer` config now enforces a 5 MB `fileSize` limit on all file uploads (logo, CSV validate, CSV import), preventing memory exhaustion from oversized files. |
| P2 | Medium | Run output redaction: `POST /api/generation/:journeyId/run` now applies `redactOutput()` to stdout/stderr before returning, stripping `Authorization` headers and `api_key`/`token`/`secret`/`password` values that may appear in test failure output. |

---

## Post-V4 bug fixes (third pass)

| ID | Severity | Fix |
|----|----------|-----|
| P0 | Critical | Reporter hooks not awaited by Playwright: `onTestBegin`, `onTestEnd`, `onStepBegin`, `onStepEnd` now return `void` and synchronously extend `postChain`. `onBegin` starts `loadKnownIds` and `semanticMappingLoaded` synchronously before any `await`. `onEnd` appends `run.finished` as the final chain link and `await`s the full chain, guaranteeing run.finished is never sent before test events. `post()` split into `enqueue()` (chain append, sync) and `deliverPost()` (HTTP, async). |
| P1 | High | Semantic mapping uses describe compound key: `loadSemanticMapping` now stores both the leaf `testTitle` key and a `"describe testTitle"` compound key when V3 mapping has a `describe` field, reducing false-positive collisions on common leaf titles. |
| P1 | High | Mapping derivation constrained to scanned tests: `POST /api/mapping/derive` now builds a `knownTestTitles` set from `pathlight-test-scan.json` and filters Claude's `matchedTests` to only titles present in the scan. Journeys with zero valid matches are excluded from `mappings` and do appear in `unmappedJourneys`. `mappedIds` is computed from the filtered result, not raw Claude output. |
| P1 | High | Business rules get stable IDs at lock: `SuggestedBusinessRule` gains `appliesToJourneyIds?: string[]`. V2 derive prompt now asks Claude to output `appliesToJourneyIds` for each rule. At lock, each rule receives a deterministic `BR-XXXXXX` ID (SHA-256 of label+description) and node `businessRuleIds` are populated from the linkage. Report rule-coverage now works for V2-derived manifests. |
| P1 | High | Full run output redacted at source: `captureRunOutput` now applies `redactOutput()` to each stdout/stderr chunk before writing to `output.log`, so stored logs and the HTML report are already clean without per-endpoint redaction. |
| P2 | Medium | Test scanner detects `test.describe`: `extractTestCases` regex now matches both `describe(...)` and `test.describe(...)`, improving V3 mapping quality for tests using Playwright's `test.describe` grouping form. |

---

## Key design decisions

**Why no test file modification?** Zero-friction adoption. If V3 required tagging 300 tests, teams would not use it.

**Why Claude for semantic mapping?** Filename conventions and regex matching break on any team with non-standard test names. Claude understands intent from test titles.

**Why a review step?** False mappings corrupt coverage data permanently. All AI proposals require human sign-off before affecting the fishbone.

**Why amber for mapped-but-unrun?** Distinguishes "we have a test" (amber) from "the test actually passed" (green). Teams can see coverage before running the full suite.

---

## V4 — AI Test Generation

### What was built

V4 closes coverage gaps identified by V3. Claude generates a Playwright test starting point for each uncovered journey. A human reviews, optionally edits, runs, and approves before the test is added to CI. No generated test ever reaches CI without explicit approval.

### New files / changed files

| File | Change |
|------|--------|
| `apps/server/src/app.ts` | Added 11 new endpoints, `callClaude` injection option, generation helpers |
| `apps/web/src/features/testgeneration/TestGenerationPage.tsx` | New page at `/test-generation` |
| `apps/web/src/App.tsx` | Added `/test-generation` route |
| `apps/web/src/features/fishbone/FishbonePage.tsx` | Added "Generate test" links in gap list, "Generate tests for gaps" link |
| `apps/web/src/styles.css` | Added generation page CSS |

### New server endpoints

```
POST /api/generation/generate              — generate test for one journey (Claude)
GET  /api/generation                       — list all generated tests (metadata, no content)
GET  /api/generation/batch-status          — poll active batch progress
POST /api/generation/batch                 — batch generate up to 10 journeys sequentially
POST /api/generation/batch-cancel          — cancel active batch
GET  /api/generation/:journeyId            — get one generated test with content
PATCH /api/generation/:journeyId           — update content inline (re-runs quality checks)
POST /api/generation/:journeyId/run        — run generated test against local app
POST /api/generation/:journeyId/regenerate — regenerate with optional hint
POST /api/generation/:journeyId/approve    — save to testDir/journeys/, update mapping
DELETE /api/generation/:journeyId          — discard and delete file
```

### Artifacts produced

| Artifact | Location | Description |
|----------|----------|-------------|
| `pathlight-generated-tests.json` | `{projectRoot}/` | Metadata + content for all generated tests |
| `testDir/generated/{journeyId}.spec.ts` | User's test directory | Generated test pending review |
| `testDir/journeys/{journeyId}.spec.ts` | User's test directory | Approved test (runs in CI) |

### V4 user flow

1. Fishbone coverage panel → gap list → "Generate test" for an individual journey
2. `/test-generation` page opens with "Generate test" button + optional hint
3. Claude generates a starting-point test using journey details, source story AC, and up to 3 existing spec files as style reference
4. Quality checks run (has `[journeyId]` in title, has `expect()`); retried once if failed
5. Style conformance score computed (ESM/CJS match vs reference = "High", else "Needs review")
6. Developer reviews generated code, edits inline if needed
7. Click "Run test" → test executes against local app, output shown
8. If test passes: "Approve and save" becomes available
9. Approve → file moves from `testDir/generated/` to `testDir/journeys/`, mapping updated
10. On next run: test executes normally via Playwright, fishbone updates to show covered journey

Alternatively: "Batch generate" panel accepts comma-separated journey IDs (max 10), generates sequentially with progress, allows mid-batch cancellation.

### Quality checks

| Check | Criterion |
|-------|-----------|
| `hasJourneyId` | `content.includes('[${journeyId}]')` |
| `hasExpect` | `/\bexpect\s*\(/.test(content)` |
| Auto-retry | If either check fails, Claude is called once more with a specific correction note |

### Style conformance score

- **High**: generated test and reference test both use ESM (`import`) or both use CJS (`require`)
- **Needs review**: style mismatch or no reference tests found

### Key design decisions

**Why require a run before approving?** Generated selectors are best-effort — Claude cannot see the live UI. Running first catches the most common failure mode (wrong selector) before the test reaches CI.

**Why `testDir/journeys/` for approved tests?** Playwright's default `testMatch` picks up all `*.spec.ts` files within `testDir`. Approved tests in `journeys/` run automatically on the next CI trigger without any config change.

**Why `callClaude` injection in `CreateAppOptions`?** Allows server tests to mock the Claude API cleanly without vi.mock hoisting, following the same pattern as `launchRun` and `jira.fetch`.

**Why sequential batch generation?** Rate limit protection. 10 parallel Claude calls would exhaust token budgets. Sequential with progress feedback keeps the UX responsive while staying within limits.

---

## What's next (V5)

Possible directions: automatic test maintenance when UI changes (requires UI change detection), Visual regression test integration, non-Playwright framework support.

---

## 100-Point Audit Fixes (post-V4)

Applied during code review remediation. All changes are surgical; test counts went from 94 → 129.

### 1. Local API protection

**What changed:** `createApp()` accepts an optional `localToken?: string`. When provided, a middleware runs on every `POST`, `PUT`, `PATCH`, and `DELETE` request (excluding `/api/events` which is used by the Playwright reporter). It requires an `X-Pathlight-Token` header matching the token. `GET /api/local-token` (unprotected) returns the current token so the frontend can fetch it once on startup.

`apps/server/src/index.ts` now generates a fresh token via `generateToken()` and passes it to `createApp()`.

**Frontend:** All four page components now import `apiFetch` from `apps/web/src/api.ts` instead of calling `fetch` directly. `apiFetch` fetches the token once from `GET /api/local-token`, caches it, and adds the `X-Pathlight-Token` header to all non-GET requests.

**Testing:** Pass `localToken` in `CreateAppOptions` to activate auth in integration tests. The global `apps/web/src/test/setup.ts` pre-seeds the token cache to `null` (no-auth) before each test so existing tests are unaffected.

**Port 4242 conflicts:** If you see `EADDRINUSE: address already in use` when starting Pathlight, another process is using port 4242. Run `lsof -ti:4242 | xargs kill -9` to clear it, or change the port in `pathlight.config.json` (requires matching server start command).

### 2. Rate limiting

**What changed:** Three `RateLimiter` instances (sliding window, `apps/server/src/rate-limit.ts`) are created inside `createApp()`:

| Limiter | Endpoints | Default | Env override |
|---------|-----------|---------|--------------|
| `claudeRl` | `/api/journeys/derive`, `/api/mapping/derive`, `/api/generation/generate`, `/api/generation/batch` | 10 req/min | `RATE_LIMIT_CLAUDE` |
| `jiraRl` | `/api/jira/fetch-stories` | 20 req/min | `RATE_LIMIT_JIRA` |
| `runsRl` | `/api/runs` | 5 req/min | `RATE_LIMIT_RUNS` |

Window size defaults to 60 000 ms and is overridable via `RATE_LIMIT_WINDOW_MS`. All three keyed on `"local"` (single-user localhost tool). Returns `429` with `{ error: "Rate limit exceeded. Try again later." }`.

### 3. Test quality check improvements

**What changed:** `checkTestQuality` extracted to `apps/server/src/quality-checks.ts`. Extended with two additional checks:

| Check | Criterion |
|-------|-----------|
| `hasJourneyId` | `content.includes('[${journeyId}]')` |
| `hasExpect` | `/\bexpect\s*\(/.test(content)` |
| `hasPlaywrightImport` | `from '@playwright/test'` or `require('@playwright/test')` is present |
| `noForbiddenImports` | All imports are `@playwright/test`, `node:*` built-ins, or relative paths |

`passed = hasJourneyId && hasExpect && hasPlaywrightImport && noForbiddenImports`. All four failures are included in the retry hint sent to Claude on the first quality failure.

### 4. Output redaction consolidation

`redactOutput` extracted to `apps/server/src/redact.ts` (shared). The inline copy in `app.ts` removed. Both the reporter's `redact` helper and `app.ts` now use the same patterns: Bearer token redaction and `api_key`/`token`/`secret`/`password` value redaction.

### 5. Path traversal prevention

Three `testDir` resolution sites now use `resolve()` + `startsWith(projectRoot + '/')` instead of `join()` alone:
- `POST /api/tests/scan` (line ~1395 of app.ts)  
- `generateTestContent()` helper (~line 1906)
- `POST /api/generation/:journeyId/approve` (~line 2309)

`DELETE /api/generation/:journeyId` now verifies `filePath.startsWith(projectRoot + '/')` before calling `unlink()`.

### 6. God-function partial extraction

Pure-function helpers extracted from `createApp()`:
- `redactOutput` → `redact.ts`
- `checkTestQuality` → `quality-checks.ts`
- `generateToken` / `createLocalAuthMiddleware` → `local-auth.ts`
- `RateLimiter` → `rate-limit.ts`

Route registration, closures over `projectRoot`/`path`/etc., and inner async helpers remain in `app.ts` (safe: they close over `createApp` parameters and would not gain testability from extraction).

### 7. Operational robustness

- `FishbonePage` cleanup effect now calls `clearTimeout(tooltipCloseTimer.current)` on unmount, suppressing the stale-timer warning in tests.
- `TestGenerationPage` `useEffect` returns a cleanup that sets a `cancelled` flag and clears `batchPollRef` on unmount.

### New files added

| File | Purpose |
|------|---------|
| `apps/server/src/redact.ts` | Shared output redaction |
| `apps/server/src/redact.test.ts` | 8 unit tests |
| `apps/server/src/rate-limit.ts` | Sliding-window rate limiter |
| `apps/server/src/rate-limit.test.ts` | 5 unit tests |
| `apps/server/src/local-auth.ts` | Token generation + Express middleware |
| `apps/server/src/local-auth.test.ts` | 5 unit tests |
| `apps/server/src/quality-checks.ts` | Extended `checkTestQuality` |
| `apps/server/src/quality-checks.test.ts` | 8 unit tests |
| `apps/server/src/auth-ratelimit.test.ts` | 9 integration tests for auth + rate limiting |
| `apps/web/src/api.ts` | `apiFetch` wrapper with auth token injection |
