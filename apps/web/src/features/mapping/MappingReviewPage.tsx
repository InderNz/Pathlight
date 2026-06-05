import { useEffect, useState } from "react";
import { apiFetch } from "../../api";

interface MappedTest {
  testTitle: string;
  describe: string;
  filePath: string;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  approved: boolean;
  manual?: boolean;
}

interface JourneyMapping {
  journeyId: string;
  journeyLabel: string;
  matchedTests: MappedTest[];
}

interface UnmappedJourney {
  journeyId: string;
  journeyLabel: string;
}

interface MappingFile {
  derivedAt: string | null;
  mappings: JourneyMapping[];
  unmappedJourneys: UnmappedJourney[];
}

interface TestCase {
  title: string;
  describe: string;
  filePath: string;
  relPath: string;
}

type ConfidenceGroup = "high" | "medium" | "low" | "unmapped";

const CONFIDENCE_LABEL: Record<ConfidenceGroup, string> = {
  high: "High Confidence",
  medium: "Medium Confidence",
  low: "Low Confidence",
  unmapped: "Unmapped Journeys",
};

export function MappingReviewPage() {
  const [mapping, setMapping] = useState<MappingFile>({
    derivedAt: null,
    mappings: [],
    unmappedJourneys: [],
  });
  const [loading, setLoading] = useState(true);
  const [bulkApproving, setBulkApproving] = useState(false);
  const [statusMessage, setStatusMessage] = useState("");
  const [pickerJourney, setPickerJourney] = useState<UnmappedJourney | null>(null);
  const [allTests, setAllTests] = useState<TestCase[]>([]);
  const [pickerSearch, setPickerSearch] = useState("");
  const [assigning, setAssigning] = useState(false);

  useEffect(() => {
    apiFetch("/api/mapping")
      .then((r) => r.json())
      .then((data) => {
        setMapping(data as MappingFile);
        setLoading(false);
      })
      .catch(() => setLoading(false));

    apiFetch("/api/tests/scan")
      .then((r) => r.json())
      .then((data: { testCases?: TestCase[] }) => {
        setAllTests(data.testCases ?? []);
      })
      .catch(() => {});
  }, []);

  async function approveTest(journeyId: string, testIdx: number, approved: boolean) {
    const response = await apiFetch(
      `/api/mapping/journeys/${encodeURIComponent(journeyId)}/tests/${testIdx}`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ approved }),
      },
    );
    if (!response.ok) return;
    setMapping((prev) => ({
      ...prev,
      mappings: prev.mappings.map((m) =>
        m.journeyId !== journeyId
          ? m
          : {
              ...m,
              matchedTests: m.matchedTests.map((t, i) => (i === testIdx ? { ...t, approved } : t)),
            },
      ),
    }));
  }

  async function bulkApprove() {
    setBulkApproving(true);
    setStatusMessage("");
    try {
      const response = await apiFetch("/api/mapping/bulk-approve", { method: "POST" });
      const result = (await response.json()) as { approved: number };
      if (response.ok) {
        setStatusMessage(`Bulk approved ${result.approved} high-confidence mappings.`);
        setMapping((prev) => ({
          ...prev,
          mappings: prev.mappings.map((m) => ({
            ...m,
            matchedTests: m.matchedTests.map((t) =>
              t.confidence === "high" ? { ...t, approved: true } : t,
            ),
          })),
        }));
      }
    } finally {
      setBulkApproving(false);
    }
  }

  async function assignTest(journey: UnmappedJourney, tc: TestCase) {
    setAssigning(true);
    try {
      const response = await apiFetch("/api/mapping/manual", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          journeyId: journey.journeyId,
          journeyLabel: journey.journeyLabel,
          testTitle: tc.title,
          describe: tc.describe,
          filePath: tc.relPath,
        }),
      });
      if (response.ok) {
        setMapping((prev) => {
          const existingJourney = prev.mappings.find((m) => m.journeyId === journey.journeyId);
          const newTest: MappedTest = {
            testTitle: tc.title,
            describe: tc.describe,
            filePath: tc.relPath,
            confidence: "high",
            reasoning: "Manual mapping.",
            approved: true,
            manual: true,
          };
          const updatedMappings = existingJourney
            ? prev.mappings.map((m) =>
                m.journeyId === journey.journeyId
                  ? { ...m, matchedTests: [...m.matchedTests, newTest] }
                  : m,
              )
            : [
                ...prev.mappings,
                {
                  journeyId: journey.journeyId,
                  journeyLabel: journey.journeyLabel,
                  matchedTests: [newTest],
                },
              ];
          return {
            ...prev,
            mappings: updatedMappings,
            unmappedJourneys: prev.unmappedJourneys.filter(
              (j) => j.journeyId !== journey.journeyId,
            ),
          };
        });
        setPickerJourney(null);
        setPickerSearch("");
        setStatusMessage(`Manually mapped "${tc.title}" to "${journey.journeyLabel}".`);
      }
    } finally {
      setAssigning(false);
    }
  }

  const flatTests = mapping.mappings.flatMap((m) =>
    m.matchedTests.map((t, i) => ({
      ...t,
      journeyId: m.journeyId,
      journeyLabel: m.journeyLabel,
      testIdx: i,
    })),
  );

  const reviewedCount = flatTests.filter((t) => t.approved).length;
  const totalCount = flatTests.length;
  const highCount = flatTests.filter((t) => t.confidence === "high").length;

  const byConfidence: Record<ConfidenceGroup, typeof flatTests> = {
    high: flatTests.filter((t) => t.confidence === "high"),
    medium: flatTests.filter((t) => t.confidence === "medium"),
    low: flatTests.filter((t) => t.confidence === "low"),
    unmapped: [],
  };

  const filteredTests = pickerSearch.trim()
    ? allTests.filter((tc) =>
        [tc.title, tc.describe, tc.relPath]
          .join(" ")
          .toLowerCase()
          .includes(pickerSearch.toLowerCase()),
      )
    : allTests.slice(0, 50);

  if (loading) {
    return (
      <div className="page-shell">
        <div className="config-content">
          <p>Loading mapping…</p>
        </div>
      </div>
    );
  }

  if (!mapping.derivedAt) {
    return (
      <div className="page-shell">
        <div className="config-content">
          <p>
            No mapping found. Go to <a href="/config">Config</a> and run "Start mapping" first.
          </p>
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
        </nav>
      </header>

      <div className="config-content">
        <div className="panel-heading">
          <h1>Mapping Review</h1>
          <div className="panel-actions">
            {highCount > 0 ? (
              <button
                type="button"
                className="primary-button"
                disabled={bulkApproving}
                onClick={() => void bulkApprove()}
              >
                {bulkApproving ? "Approving…" : `Bulk approve ${highCount} high-confidence`}
              </button>
            ) : null}
          </div>
        </div>

        <div className="mapping-progress">
          <span>
            {reviewedCount} of {totalCount} mappings approved
          </span>
          {mapping.unmappedJourneys.length > 0 ? (
            <span className="mapping-gaps">
              {mapping.unmappedJourneys.length} journeys unmapped
            </span>
          ) : null}
        </div>

        {statusMessage ? (
          <p className="saved-status" role="status">
            {statusMessage}
          </p>
        ) : null}

        {(["high", "medium", "low"] as ConfidenceGroup[]).map((level) => {
          const group = byConfidence[level];
          if (group.length === 0) return null;
          return (
            <section key={level} className="panel mapping-group">
              <h2 className={`mapping-group-title confidence-${level}`}>
                {CONFIDENCE_LABEL[level]}
              </h2>
              <ul className="mapping-list">
                {group.map((t) => (
                  <li
                    key={`${t.journeyId}-${t.testIdx}`}
                    className={`mapping-item ${t.approved ? "approved" : ""}`}
                  >
                    <div className="mapping-item-header">
                      <span className="mapping-journey-label">{t.journeyLabel}</span>
                      <span className={`confidence-badge confidence-${t.confidence}`}>
                        {t.confidence}
                      </span>
                      {t.manual ? (
                        <span className="confidence-badge confidence-manual">manual</span>
                      ) : null}
                    </div>
                    <div className="mapping-test-title">
                      {t.describe ? `${t.describe} › ` : ""}
                      {t.testTitle}
                    </div>
                    <div className="mapping-file-path">{t.filePath}</div>
                    <div className="mapping-reasoning">{t.reasoning}</div>
                    <div className="mapping-actions">
                      {t.approved ? (
                        <button
                          type="button"
                          className="secondary-button mapping-reject-btn"
                          onClick={() => void approveTest(t.journeyId, t.testIdx, false)}
                        >
                          Reject
                        </button>
                      ) : (
                        <button
                          type="button"
                          className="primary-button mapping-approve-btn"
                          onClick={() => void approveTest(t.journeyId, t.testIdx, true)}
                        >
                          Approve
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          );
        })}

        {mapping.unmappedJourneys.length > 0 ? (
          <section className="panel mapping-group">
            <h2 className="mapping-group-title">{CONFIDENCE_LABEL.unmapped}</h2>
            <ul className="mapping-list">
              {mapping.unmappedJourneys.map((j) => (
                <li key={j.journeyId} className="mapping-item unmapped">
                  <div className="mapping-item-header">
                    <span className="mapping-journey-label">{j.journeyLabel}</span>
                    <span className="confidence-badge confidence-unmapped">No match</span>
                  </div>
                  <div className="mapping-reasoning">
                    Claude found no matching test. Assign manually or write a new test.
                  </div>
                  <div className="mapping-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setPickerJourney(j);
                        setPickerSearch("");
                      }}
                    >
                      Assign test
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>

      {pickerJourney ? (
        <div className="picker-overlay" role="dialog" aria-modal="true" aria-label="Test picker">
          <div className="picker-modal">
            <div className="picker-header">
              <h2>Assign test to "{pickerJourney.journeyLabel}"</h2>
              <button
                type="button"
                className="remove-button"
                aria-label="Close"
                onClick={() => setPickerJourney(null)}
              >
                ×
              </button>
            </div>
            <input
              className="picker-search"
              placeholder="Search test titles, describe blocks, or file paths…"
              value={pickerSearch}
              onChange={(e) => setPickerSearch(e.target.value)}
              autoFocus
            />
            <ul className="picker-list">
              {filteredTests.map((tc, i) => (
                <li key={i} className="picker-item">
                  <div className="picker-test-title">
                    {tc.describe ? `${tc.describe} › ` : ""}
                    {tc.title}
                  </div>
                  <div className="mapping-file-path">{tc.relPath}</div>
                  <button
                    type="button"
                    className="primary-button picker-assign-btn"
                    disabled={assigning}
                    onClick={() => void assignTest(pickerJourney, tc)}
                  >
                    Assign
                  </button>
                </li>
              ))}
              {filteredTests.length === 0 ? (
                <li className="field-help">No tests match your search.</li>
              ) : null}
            </ul>
          </div>
        </div>
      ) : null}
    </div>
  );
}
