import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api";

interface QualityChecks {
  hasJourneyId: boolean;
  hasExpect: boolean;
  passed: boolean;
}

interface GeneratedTestMeta {
  journeyId: string;
  journeyLabel: string;
  status: "pending" | "approved" | "discarded";
  filePath: string;
  qualityChecks: QualityChecks;
  styleScore: "High" | "Needs review";
  generatedAt: string;
  approvedAt: string | null;
}

interface GeneratedTestFull extends GeneratedTestMeta {
  content: string;
}

interface BatchStatus {
  id: string;
  status: "running" | "done" | "cancelled";
  completed: number;
  total: number;
  results: Array<{ journeyId: string; status: "ok" | "failed"; error?: string }>;
}

export function TestGenerationPage() {
  const params = new URLSearchParams(window.location.search);
  const journeyIdParam = params.get("journeyId") ?? "";

  const [list, setList] = useState<GeneratedTestMeta[]>([]);
  const [loadingList, setLoadingList] = useState(true);
  const [current, setCurrent] = useState<GeneratedTestFull | null>(null);
  const [loadingCurrent, setLoadingCurrent] = useState(false);

  // Generate form state
  const [generating, setGenerating] = useState(false);
  const [generateHint, setGenerateHint] = useState("");
  const [generateError, setGenerateError] = useState("");

  // Review state
  const [editContent, setEditContent] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [runResult, setRunResult] = useState<{ passed: boolean; output: string } | null>(null);
  const [running, setRunning] = useState(false);
  const [approving, setApproving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const [regenerating, setRegenerating] = useState(false);
  const [regenHint, setRegenHint] = useState("");
  const [statusMsg, setStatusMsg] = useState("");

  // Batch state
  const [batchIds, setBatchIds] = useState<string[]>([]);
  const [batchStatus, setBatchStatus] = useState<BatchStatus | null>(null);
  const batchPollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    apiFetch("/api/generation")
      .then((r) => r.json())
      .then((data: { tests: GeneratedTestMeta[] }) => {
        if (!cancelled) {
          setList(data.tests ?? []);
          setLoadingList(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadingList(false);
      });

    if (journeyIdParam) {
      setLoadingCurrent(true);
      apiFetch(`/api/generation/${encodeURIComponent(journeyIdParam)}`)
        .then((r) => (r.ok ? r.json() : null))
        .then((data: GeneratedTestFull | null) => {
          if (!cancelled) {
            if (data) {
              setCurrent(data);
              setEditContent(data.content);
            }
            setLoadingCurrent(false);
          }
        })
        .catch(() => {
          if (!cancelled) setLoadingCurrent(false);
        });
    }
    return () => {
      cancelled = true;
      if (batchPollRef.current) clearInterval(batchPollRef.current);
    };
  }, [journeyIdParam]);

  async function generateTest(jid: string, hint: string) {
    setGenerating(true);
    setGenerateError("");
    try {
      const res = await apiFetch("/api/generation/generate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journeyId: jid, hint }),
      });
      if (!res.ok) {
        const body = (await res.json()) as { error?: string };
        setGenerateError(body.error ?? "Generation failed.");
        return;
      }
      // Reload current test
      const detail = await apiFetch(`/api/generation/${encodeURIComponent(jid)}`);
      const data = (await detail.json()) as GeneratedTestFull;
      setCurrent(data);
      setEditContent(data.content);
      setRunResult(null);
      // Update list
      setList((prev) => {
        const idx = prev.findIndex((t) => t.journeyId === jid);
        const meta: GeneratedTestMeta = { ...data };
        return idx >= 0 ? prev.map((t, i) => (i === idx ? meta : t)) : [...prev, meta];
      });
    } finally {
      setGenerating(false);
    }
  }

  async function saveEdit() {
    if (!current) return;
    setSaving(true);
    const res = await apiFetch(`/api/generation/${encodeURIComponent(current.journeyId)}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content: editContent }),
    });
    if (res.ok) {
      const body = (await res.json()) as { qualityChecks: QualityChecks };
      setCurrent((prev) =>
        prev ? { ...prev, content: editContent, qualityChecks: body.qualityChecks } : prev,
      );
      setEditing(false);
      setRunResult(null);
    }
    setSaving(false);
  }

  async function runTest() {
    if (!current) return;
    setRunning(true);
    setRunResult(null);
    const res = await apiFetch(`/api/generation/${encodeURIComponent(current.journeyId)}/run`, {
      method: "POST",
    });
    const body = (await res.json()) as { passed: boolean; output: string };
    setRunResult(body);
    setRunning(false);
  }

  async function approveTest() {
    if (!current) return;
    setApproving(true);
    const res = await apiFetch(`/api/generation/${encodeURIComponent(current.journeyId)}/approve`, {
      method: "POST",
    });
    if (res.ok) {
      setCurrent((prev) => (prev ? { ...prev, status: "approved" } : prev));
      setList((prev) =>
        prev.map((t) => (t.journeyId === current.journeyId ? { ...t, status: "approved" } : t)),
      );
      setStatusMsg("Test approved and saved to testDir/journeys/.");
    }
    setApproving(false);
  }

  async function discardTest() {
    if (!current) return;
    setDiscarding(true);
    const res = await apiFetch(`/api/generation/${encodeURIComponent(current.journeyId)}`, {
      method: "DELETE",
    });
    if (res.ok) {
      setList((prev) => prev.filter((t) => t.journeyId !== current.journeyId));
      setCurrent(null);
      window.history.pushState(null, "", "/test-generation");
    }
    setDiscarding(false);
  }

  async function regenerateTest() {
    if (!current) return;
    setRegenerating(true);
    setStatusMsg("");
    const res = await apiFetch(
      `/api/generation/${encodeURIComponent(current.journeyId)}/regenerate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ hint: regenHint }),
      },
    );
    if (res.ok) {
      const detail = await apiFetch(`/api/generation/${encodeURIComponent(current.journeyId)}`);
      const data = (await detail.json()) as GeneratedTestFull;
      setCurrent(data);
      setEditContent(data.content);
      setRunResult(null);
      setRegenHint("");
      setStatusMsg("Test regenerated.");
    }
    setRegenerating(false);
  }

  async function startBatch() {
    const res = await apiFetch("/api/generation/batch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ journeyIds: batchIds }),
    });
    if (!res.ok) return;
    const body = (await res.json()) as { batchId: string; total: number };
    setBatchStatus({
      id: body.batchId,
      status: "running",
      completed: 0,
      total: body.total,
      results: [],
    });
    batchPollRef.current = setInterval(async () => {
      const sr = await apiFetch("/api/generation/batch-status");
      const sd = (await sr.json()) as BatchStatus | { status: null };
      if (sd.status === null) return;
      setBatchStatus(sd as BatchStatus);
      if ((sd as BatchStatus).status !== "running") {
        if (batchPollRef.current) clearInterval(batchPollRef.current);
        // Refresh list
        const lr = await apiFetch("/api/generation");
        const ld = (await lr.json()) as { tests: GeneratedTestMeta[] };
        setList(ld.tests ?? []);
      }
    }, 2000);
  }

  async function cancelBatch() {
    await apiFetch("/api/generation/batch-cancel", { method: "POST" });
  }

  const pendingList = list.filter((t) => t.status === "pending");
  const approvedList = list.filter((t) => t.status === "approved");

  // ── Review panel for a specific journey ──────────────────────────────────
  if (journeyIdParam) {
    if (loadingCurrent) {
      return (
        <div className="page-shell">
          <div className="config-content">
            <p>Loading…</p>
          </div>
        </div>
      );
    }

    return (
      <div className="page-shell">
        <header className="top-bar">
          <span className="wordmark">Pathlight</span>
          <nav className="top-nav">
            <a href="/config">Config</a>
            <a href="/">Fishbone</a>
            <a href="/test-generation">All generated tests</a>
          </nav>
        </header>

        <div className="config-content">
          <h1 className="panel-heading">{journeyIdParam}</h1>

          {!current ? (
            // Generate form
            <section className="panel">
              <h2>Generate Playwright test</h2>
              <p className="field-help">
                Claude will generate a starting-point test. A human must review and approve before
                it runs in CI.
              </p>
              <label className="field-label" htmlFor="gen-hint">
                Hint{" "}
                <span className="field-help">(optional — e.g. "user is pre-authenticated")</span>
              </label>
              <input
                id="gen-hint"
                className="text-input"
                value={generateHint}
                onChange={(e) => setGenerateHint(e.target.value)}
                placeholder="Add context Claude should know…"
              />
              {generateError ? <p className="error-message">{generateError}</p> : null}
              <button
                type="button"
                className="primary-button"
                disabled={generating}
                onClick={() => void generateTest(journeyIdParam, generateHint)}
              >
                {generating ? "Generating…" : "Generate test"}
              </button>
            </section>
          ) : (
            // Review form
            <section className="panel">
              <div className="generation-header">
                <div className="generation-meta">
                  <span className="gen-journey-label">{current.journeyLabel}</span>
                  <span
                    className={`quality-badge ${current.qualityChecks.passed ? "quality-pass" : "quality-fail"}`}
                  >
                    Quality: {current.qualityChecks.passed ? "Pass" : "Fail"}
                  </span>
                  <span
                    className={`style-badge style-${current.styleScore === "High" ? "high" : "review"}`}
                  >
                    Style: {current.styleScore}
                  </span>
                  {current.status === "approved" ? (
                    <span className="gen-approved-badge">Approved</span>
                  ) : null}
                </div>
                {!current.qualityChecks.passed ? (
                  <ul className="quality-issues">
                    {!current.qualityChecks.hasJourneyId ? (
                      <li>Missing [{current.journeyId}] in test title</li>
                    ) : null}
                    {!current.qualityChecks.hasExpect ? <li>Missing expect() assertion</li> : null}
                  </ul>
                ) : null}
              </div>

              {editing ? (
                <div className="gen-editor">
                  <textarea
                    className="gen-code-editor"
                    value={editContent}
                    onChange={(e) => setEditContent(e.target.value)}
                    rows={30}
                    aria-label="Edit generated test"
                  />
                  <div className="gen-editor-actions">
                    <button
                      type="button"
                      className="primary-button"
                      disabled={saving}
                      onClick={() => void saveEdit()}
                    >
                      {saving ? "Saving…" : "Save changes"}
                    </button>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setEditing(false);
                        setEditContent(current.content);
                      }}
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              ) : (
                <pre className="gen-code-display" aria-label="Generated test code">
                  <code>{current.content}</code>
                </pre>
              )}

              {statusMsg ? (
                <p className="saved-status" role="status">
                  {statusMsg}
                </p>
              ) : null}

              {runResult ? (
                <div className={`gen-run-result ${runResult.passed ? "run-passed" : "run-failed"}`}>
                  <strong>{runResult.passed ? "Test passed" : "Test failed"}</strong>
                  <pre className="gen-run-output">{runResult.output}</pre>
                </div>
              ) : null}

              <div className="gen-actions">
                {!editing ? (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => setEditing(true)}
                  >
                    Edit
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={running}
                  onClick={() => void runTest()}
                >
                  {running ? "Running…" : "Run test"}
                </button>
                {current.status !== "approved" ? (
                  <button
                    type="button"
                    className="primary-button"
                    disabled={approving || runResult?.passed !== true}
                    title={
                      runResult?.passed !== true
                        ? "Run the test first — Approve becomes available after it passes"
                        : undefined
                    }
                    onClick={() => void approveTest()}
                  >
                    {approving ? "Approving…" : "Approve and save"}
                  </button>
                ) : null}
                <button
                  type="button"
                  className="secondary-button"
                  disabled={discarding}
                  onClick={() => void discardTest()}
                >
                  {discarding ? "Discarding…" : "Discard"}
                </button>
              </div>

              <details className="gen-regen-details">
                <summary>Regenerate with hint</summary>
                <div className="gen-regen-form">
                  <input
                    className="text-input"
                    placeholder="Hint for Claude (optional)…"
                    value={regenHint}
                    onChange={(e) => setRegenHint(e.target.value)}
                  />
                  <button
                    type="button"
                    className="secondary-button"
                    disabled={regenerating}
                    onClick={() => void regenerateTest()}
                  >
                    {regenerating ? "Regenerating…" : "Regenerate"}
                  </button>
                </div>
              </details>
            </section>
          )}
        </div>
      </div>
    );
  }

  // ── List view ─────────────────────────────────────────────────────────────
  return (
    <div className="page-shell">
      <header className="top-bar">
        <span className="wordmark">Pathlight</span>
        <nav className="top-nav">
          <a href="/config">Config</a>
          <a href="/">Fishbone</a>
          <a href="/mapping-review">Mapping Review</a>
        </nav>
      </header>

      <div className="config-content">
        <div className="panel-heading">
          <h1>AI Test Generation</h1>
          <p className="field-help">
            Generate starting-point Playwright tests for coverage gaps. Every generated test
            requires human review before running in CI.
          </p>
        </div>

        {batchStatus ? (
          <section className="panel gen-batch-panel">
            <h2>Batch generation</h2>
            <div className="gen-batch-progress">
              <span>
                {batchStatus.status === "running"
                  ? `Generating ${batchStatus.completed + 1} of ${batchStatus.total}…`
                  : batchStatus.status === "cancelled"
                    ? "Cancelled"
                    : `Done — ${batchStatus.results.filter((r) => r.status === "ok").length} generated`}
              </span>
              {batchStatus.status === "running" ? (
                <button
                  type="button"
                  className="secondary-button"
                  onClick={() => void cancelBatch()}
                >
                  Cancel
                </button>
              ) : null}
            </div>
          </section>
        ) : (
          <section className="panel gen-batch-panel">
            <h2>Batch generate</h2>
            <p className="field-help">
              Enter journey IDs (max 10, comma-separated) to generate tests for multiple gaps at
              once.
            </p>
            <textarea
              className="text-input gen-batch-input"
              rows={3}
              placeholder="E2E-007, E2E-008, E2E-009…"
              value={batchIds.join(", ")}
              onChange={(e) =>
                setBatchIds(
                  e.target.value
                    .split(",")
                    .map((s) => s.trim())
                    .filter(Boolean),
                )
              }
            />
            <button
              type="button"
              className="primary-button"
              disabled={batchIds.length === 0 || batchIds.length > 10}
              onClick={() => void startBatch()}
            >
              Generate all ({batchIds.length})
            </button>
          </section>
        )}

        {loadingList ? <p>Loading…</p> : null}

        {pendingList.length > 0 ? (
          <section className="panel">
            <h2>Pending review ({pendingList.length})</h2>
            <ul className="gen-list">
              {pendingList.map((t) => (
                <li key={t.journeyId} className="gen-list-item">
                  <div className="gen-list-meta">
                    <span className="gap-id">{t.journeyId}</span>
                    <span className="gap-label">{t.journeyLabel}</span>
                    <span
                      className={`quality-badge ${t.qualityChecks.passed ? "quality-pass" : "quality-fail"}`}
                    >
                      {t.qualityChecks.passed ? "Pass" : "Fail"}
                    </span>
                    <span
                      className={`style-badge style-${t.styleScore === "High" ? "high" : "review"}`}
                    >
                      {t.styleScore}
                    </span>
                  </div>
                  <a
                    href={`/test-generation?journeyId=${encodeURIComponent(t.journeyId)}`}
                    className="primary-button gen-review-btn"
                  >
                    Review
                  </a>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {approvedList.length > 0 ? (
          <section className="panel">
            <h2>Approved ({approvedList.length})</h2>
            <ul className="gen-list">
              {approvedList.map((t) => (
                <li key={t.journeyId} className="gen-list-item gen-approved">
                  <div className="gen-list-meta">
                    <span className="gap-id">{t.journeyId}</span>
                    <span className="gap-label">{t.journeyLabel}</span>
                    <span className="gen-approved-badge">Approved</span>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        {!loadingList && list.length === 0 ? (
          <p className="field-help">
            No generated tests yet. Go to the <a href="/">Fishbone</a> and click "Generate test" on
            any coverage gap.
          </p>
        ) : null}
      </div>
    </div>
  );
}
