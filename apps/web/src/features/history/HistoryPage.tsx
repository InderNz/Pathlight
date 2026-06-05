import { useEffect, useState } from "react";
import { apiFetch } from "../../api";

interface RunEntry {
  runId: string;
  status: string;
  verdict?: string;
  reportPath?: string | null;
}

interface HealthScore {
  score: number;
  badge: string;
}

interface HistoryData {
  runs: RunEntry[];
  healthScores: Record<string, HealthScore>;
  regressions: string[];
}

const BADGE_COLOUR: Record<string, string> = {
  Stable: "#2d9e6b",
  Unstable: "#e09e26",
  Flaky: "#e53e3e",
  "Insufficient data": "#a0aec0",
};

const VERDICT_COLOUR: Record<string, string> = {
  PASSED: "#2d9e6b",
  WARNING: "#e09e26",
  FAILED: "#e53e3e",
};

export function HistoryPage() {
  const [data, setData] = useState<HistoryData | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    void (async () => {
      try {
        const res = await apiFetch("/api/history");
        if (!res.ok) {
          setError("Unable to load run history.");
          return;
        }
        setData((await res.json()) as HistoryData);
      } catch {
        setError("Unable to reach Pathlight server.");
      }
    })();
  }, []);

  if (error) {
    return (
      <main style={{ padding: 32 }}>
        <p style={{ color: "#c0392b" }}>{error}</p>
        <a href="/">Back to fishbone</a>
      </main>
    );
  }

  if (!data) {
    return <main style={{ padding: 32 }}>Loading history…</main>;
  }

  const flaky = Object.entries(data.healthScores)
    .filter(([, h]) => h.badge === "Flaky")
    .sort(([, a], [, b]) => a.score - b.score);

  return (
    <div style={{ fontFamily: "sans-serif", maxWidth: 1000, margin: "0 auto", padding: 32 }}>
      <header style={{ display: "flex", alignItems: "center", gap: 16, marginBottom: 24 }}>
        <a href="/" style={{ textDecoration: "none", color: "#5c687a", fontSize: 14 }}>
          ← Fishbone
        </a>
        <h1 style={{ margin: 0, fontSize: 20 }}>Run history</h1>
      </header>

      {data.regressions.length > 0 ? (
        <section
          style={{
            background: "#fff5f5",
            border: "1px solid #fc8181",
            borderRadius: 6,
            padding: "12px 16px",
            marginBottom: 20,
          }}
        >
          <strong style={{ color: "#c0392b" }}>
            Possible regressions ({data.regressions.length})
          </strong>
          <ul style={{ margin: "6px 0 0", fontSize: 13 }}>
            {data.regressions.map((id) => (
              <li key={id}>{id} — passed in previous runs, failed in latest run</li>
            ))}
          </ul>
        </section>
      ) : null}

      {/* Pass rate trend chart (inline SVG bar chart) */}
      {data.runs.length > 0 ? (
        <section style={{ marginBottom: 24 }}>
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>
            Pass rate trend (last {data.runs.length} runs)
          </h2>
          <svg
            viewBox={`0 0 ${Math.max(300, data.runs.length * 24)} 80`}
            style={{ width: "100%", maxWidth: 640, height: 80, display: "block" }}
          >
            {[...data.runs].reverse().map((run, i) => {
              const verdict = run.verdict ?? "UNKNOWN";
              const colour = VERDICT_COLOUR[verdict] ?? "#a0aec0";
              const barH = verdict === "PASSED" ? 60 : verdict === "WARNING" ? 40 : 20;
              return (
                <g key={run.runId}>
                  <rect x={i * 24} y={80 - barH} width={18} height={barH} fill={colour} rx={2} />
                  <title>
                    {run.runId}: {verdict}
                  </title>
                </g>
              );
            })}
          </svg>
        </section>
      ) : null}

      {/* Runs table */}
      <section style={{ marginBottom: 24 }}>
        <h2 style={{ fontSize: 15, marginBottom: 8 }}>All runs</h2>
        {data.runs.length === 0 ? (
          <p style={{ color: "#718096", fontSize: 13 }}>No runs yet.</p>
        ) : (
          <table
            style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}
            border={1}
            cellPadding={8}
          >
            <thead>
              <tr style={{ background: "#f7fafc" }}>
                <th style={{ textAlign: "left" }}>Run ID</th>
                <th style={{ textAlign: "left" }}>Status</th>
                <th style={{ textAlign: "left" }}>Verdict</th>
                <th style={{ textAlign: "left" }}>Report</th>
              </tr>
            </thead>
            <tbody>
              {data.runs.map((run) => (
                <tr key={run.runId}>
                  <td>{run.runId}</td>
                  <td>{run.status}</td>
                  <td
                    style={{ color: VERDICT_COLOUR[run.verdict ?? ""] ?? "#333", fontWeight: 600 }}
                  >
                    {run.verdict ?? "—"}
                  </td>
                  <td>
                    {run.reportPath ? (
                      <a
                        href={
                          run.reportPath.startsWith("/") ? run.reportPath : `/${run.reportPath}`
                        }
                      >
                        View report
                      </a>
                    ) : (
                      "—"
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      {/* Flaky journeys */}
      {flaky.length > 0 ? (
        <section>
          <h2 style={{ fontSize: 15, marginBottom: 8 }}>Flaky journeys</h2>
          <ul style={{ fontSize: 13 }}>
            {flaky.map(([id, h]) => (
              <li key={id} style={{ marginBottom: 4 }}>
                <strong>{id}</strong>{" "}
                <span
                  style={{
                    background: BADGE_COLOUR[h.badge] + "22",
                    color: BADGE_COLOUR[h.badge],
                    padding: "1px 6px",
                    borderRadius: 4,
                    fontWeight: 600,
                    fontSize: 11,
                  }}
                >
                  {h.badge}
                </span>{" "}
                — {h.score}% pass rate
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
