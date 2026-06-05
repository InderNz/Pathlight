# Codex Brief — Pathlight Architecture v1.1
## Project-Agnostic Reporter Injection

---

## Context

Pathlight v1.0 required users to install `@pathlight/playwright-reporter` in every project they wanted to test, and tag every Playwright test with `@pathlight:{nodeId}`. This breaks the project-agnostic promise — Pathlight should work against any Playwright project with zero changes to that project.

This brief describes the v1.1 architecture change. Read it fully before writing any code.

**Source documents (all updated to v1.1):**
- `pathlight-technical-architecture-v1.1.docx` — TAD. This is the contract.
- `pathlight-prd-v1.1.docx` — PRD. Changed stories: US-P001, US-P009, US-P010, US-P012.
- `pathlight-engineering-plan-v1.1.docx` — Engineering Plan.

---

## What changes

### 1. Config page gains two new fields (US-P001)

Add to the config page at `/config`, in a new "Project Location" section:

**projectRoot** (required)
- A folder path input (text field with a helper: "Absolute path to your project root")
- Validated on blur: directory must exist
- Example: `/Users/inder/projects/ZovKu`

**playwrightConfigPath** (optional)
- Defaults to `playwright.config.ts`
- Relative to projectRoot
- Validated on save: file must exist at `{projectRoot}/{playwrightConfigPath}`

**Verify connection button**
- Runs: `npx playwright --version` from `projectRoot`
- Shows success ("Playwright X.Y found") or error with installation instructions

Both fields are written to `pathlight.config.json`:
```json
{
  "projectRoot": "/Users/inder/projects/ZovKu",
  "playwrightConfigPath": "playwright.config.ts"
}
```

---

### 2. Reporter is bundled and injected (US-P009)

The `@pathlight/playwright-reporter` package stays in the monorepo but is no longer published for user installation. Instead:

- Build step produces `packages/playwright-reporter/dist/bundled-reporter.js`
- Runner Orchestrator appends `--reporter=list,{absolutePathToBundledReporter}` to the `npx playwright test` command
- `PATHLIGHT_RUN_ID` and `PATHLIGHT_SERVER_URL` remain as env vars on the child process

**The user installs nothing. The user changes no files in their project.**

The reporter itself is unchanged in behaviour. Only delivery mechanism changes.

---

### 3. Journey matching via title bracket pattern (US-P010)

Remove the `@pathlight:` tag system entirely. Replace with automatic bracket pattern matching.

**Extraction logic (in bundled-reporter.js):**
```javascript
const match = testTitle.match(/\[([A-Za-z0-9-]+)\]/);
if (!match) {
  // untaggedTestCount++, no events emitted
  return;
}
const nodeId = match[1]; // e.g. "E2E-005"
if (!manifest.has(nodeId)) {
  // unknownTagCount++, no events emitted
  return;
}
// proceed with normal event emission
```

**Examples:**
- `[E2E-005] Owner Sends a Single Review Request SMS` → nodeId: `E2E-005` ✓
- `Admin can view waitlist` → no bracket → untaggedTestCount++ 
- `[E2E-999] Some journey` → not in manifest → unknownTagCount++

---

### 4. Runner spawns from projectRoot (US-P012)

```javascript
const child = spawn('npx', [
  'playwright', 'test',
  `--reporter=list,${bundledReporterPath}`,
  ...allowlistedArgs
], {
  cwd: config.projectRoot,  // READ FROM pathlight.config.json
  env: {
    ...process.env,
    PATHLIGHT_RUN_ID: runId,
    PATHLIGHT_SERVER_URL: 'http://127.0.0.1:4242'
  }
});
```

**Before spawning, validate:**
- `config.projectRoot` exists and is a directory → else 400 "Configure your project location before starting a run"
- `config.projectRoot/{config.playwrightConfigPath}` exists → else 400 "playwright.config.ts not found"
- Locked manifest exists → else 400 "Lock the manifest before starting a run"

---

## What does NOT change

- Event schemas (ReporterEventInput, StoredPathlightEvent) — unchanged
- SSE streaming — unchanged
- Fishbone renderer — unchanged
- Dashboard publisher — unchanged
- All other stories US-P002 through US-P008, US-P011, US-P013 through US-P023 — unchanged
- The reporter's internal behaviour (lifecycle hooks, health counting, error redaction) — unchanged

---

## Acceptance criteria

Work through these in order. All must pass before this change is complete.

**Config page:**
- [ ] "Project Location" section visible on config page
- [ ] projectRoot field validates directory exists on blur
- [ ] playwrightConfigPath field defaults to `playwright.config.ts`
- [ ] Verify connection button runs `npx playwright --version` from projectRoot
- [ ] Both fields written to pathlight.config.json on save
- [ ] Both fields loaded from pathlight.config.json on page open

**Reporter injection:**
- [ ] `packages/playwright-reporter/dist/bundled-reporter.js` exists after build
- [ ] `npx playwright test --reporter=list,{bundledReporterPath}` is the spawn command
- [ ] PATHLIGHT_RUN_ID and PATHLIGHT_SERVER_URL set in child env
- [ ] No reference to `@pathlight/playwright-reporter` npm installation anywhere in docs or README

**Journey matching:**
- [ ] `/\[([A-Za-z0-9-]+)\]/` regex used in bundled-reporter.js
- [ ] Test `[E2E-005] Owner Sends SMS` → nodeId `E2E-005` extracted and matched
- [ ] Test `Admin view waitlist` → untaggedTestCount incremented, no events
- [ ] Test `[E2E-999] Unknown` → unknownTagCount incremented, no events
- [ ] Unit tests cover all three cases

**Run start:**
- [ ] POST /api/runs reads projectRoot from config
- [ ] Spawn uses cwd: projectRoot
- [ ] Returns 400 with clear message if projectRoot not set
- [ ] Returns 400 with clear message if playwright.config not found
- [ ] Existing 409 (run already active) still works

**Regression:**
- [ ] All 58 Vitest tests still pass
- [ ] All 8 Playwright E2E tests still pass
- [ ] TypeScript build succeeds

---

## Engineering rules (from CLAUDE.md)

- No features beyond what was asked
- Touch only what you must
- Every changed line must trace directly to this brief
- State assumptions explicitly before implementing
- If something is unclear, stop and ask

---

## Definition of done

- All acceptance criteria above checked off
- No TypeScript errors (strict mode)
- No ESLint warnings
- Unit tests written for journey matching (all three cases)
- README updated: remove any reference to installing @pathlight/playwright-reporter
- README updated: add section "How journey matching works" explaining the [E2E-NNN] pattern
