# Pathlight Spike

Throwaway spike — not production code — 2 day time box.

Proves four assumptions:
- A1: Playwright reporter can emit events to a local server
- A2: SSE can stream events to a browser in real time  
- A3: Fishbone SVG can animate from SSE events
- A4: Static HTML report generates from run data

## Prerequisites

- Node.js 20 or later
- npm install (already run by the build script)
- npx playwright install chromium (run once if needed)

## Running the spike

Open three terminal windows.

**Terminal 1 — ZovKu mock API:**
node mock/mock-server.js
Expected: `[mock] ZovKu mock server running on http://localhost:3000`

**Terminal 2 — Pathlight server:**
node spike/server.js
Expected:
[pathlight] Server ready — http://localhost:4242
[pathlight] Manifest loaded — S1-US002-UNHAPPY-001: Duplicate email returns 409

**Browser:**
Open http://localhost:4242
Expected: fishbone with one grey branch labelled "Duplicate email → 409"

**Terminal 3 — Run the test:**
npx playwright test e2e/waitlist.spec.ts

## What you should observe

1. Terminal 2: `[pathlight] Run started — run_001`
2. Browser status bar: "Run started — waiting for test..."
3. Within 1 second: branch turns amber and pulses
4. Terminal 2: `[pathlight] Test started — S1-US002-UNHAPPY-001`
5. Test completes. Branch turns green (passed) or red (failed)
6. Terminal 2: `[pathlight] Report ready — reports/run_001/report.html`
7. Browser: "View Report →" link appears. Click it. Report opens.

All seven must work in sequence without touching the keyboard
between steps 3 and 7.

## Assumption results — record after running

| Assumption | Result | Notes |
|-----------|--------|-------|
| A1 — Reporter emits events | PASS | Playwright reporter emitted run.started, test.started, test.passed, and run.finished to the local Pathlight server without affecting the test run. The @pathlight: title tag mapped cleanly to the manifest node ID. |
| A2 — SSE streams to browser | PASS | SSE connection worked and the browser restored final state from buffered/run-state data. Important operational note: the browser must be connected before running the test to observe the live amber pulse and report.ready event. |
| A3 — Fishbone animates | PASS | The SVG branch updated to the final passed state and the live path is wired through the manifest node ID. The main surprise was timing: if the run finishes before the browser connects, restoreState shows the green branch but cannot prove the live pulse. |
| A4 — Report generates | PASS | Server generated reports/run_001/report.html after run.finished. This was easier than expected; the only architecture note is that report.ready is server-generated SSE, not a reporter-sourced event written to events.jsonl. |

**Overall verdict:**
- [x] All four passed — proceed to Step 3 (production implementation)
- [ ] One or more failed — stop and redesign before continuing

## What gets kept

- Event schema shape (update domain glossary)
- Manifest node schema shape (confirm or update)
- The @pathlight: tag mapping convention (if it worked)
- Assumption results and surprises

## What gets thrown away

All spike code. The production implementation is written from scratch
using proper TDD after the spike proves the approach works.

Absolute prohibitions

No JIRA API calls
No Anthropic or OpenAI API calls
No database of any kind
No authentication or sessions
No WebSocket
No TypeScript in spike files (test file excepted)
No React, Vue, or any frontend framework
No webpack, Vite, or any build tool
No npm packages beyond express and @playwright/test
No environment variables
No multi-run support — run ID is always run_001
No process.exit() in the reporter under any circumstances
No throw in reporter lifecycle hooks
Do NOT run npx playwright test — the human runs this
Do NOT declare the spike complete based on terminal output alone
Do NOT create files not listed in the required file structure


Deliverables checklist
When you finish, every item below must exist:
FileStatuspackage.jsonspike/pathlight-manifest.jsonspike/reporter.jsspike/server.jsspike/index.htmlmock/mock-server.jse2e/waitlist.spec.tsplaywright.config.ts.gitignoreREADME.mdServer starts on port 4242Mock starts on port 3000/api/manifest returns correct JSON/api/events POST accepts valid events/api/events POST rejects invalid events with 400
