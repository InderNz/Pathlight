import { type MouseEvent as ReactMouseEvent, useEffect, useMemo, useRef, useState } from "react";
import { apiFetch } from "../../api";

type NodeStatus = "pending" | "running" | "passed" | "failed" | "skipped" | "blocked" | "abandoned";

interface ManifestNode {
  id: string;
  stage: string;
  stageName: string;
  priority: string;
  priorityRank: number;
  label: string;
  branchType: string;
  tags: string[];
  businessRuleIds?: string[];
}

interface BusinessRule {
  id: string;
  label: string;
  severity: string;
}

interface Manifest {
  lockedAt: string | null;
  businessRules?: BusinessRule[];
  nodes: ManifestNode[];
}

interface StreamEvent {
  type: string;
  payload: {
    testId?: string;
    attemptId?: string;
    stepTitle?: string;
    source?: "explicit" | "auto";
    reason?: string;
    reportPath?: string;
    runId?: string;
    isFinalAttempt?: boolean;
    status?: "running" | "finished" | "abandoned";
    total?: number;
    passed?: number;
    failed?: number;
    testResults?: Record<string, { status: NodeStatus }>;
    errorType?: string;
    error?: string;
    retryCount?: number;
    artifactType?: string;
    path?: string;
  };
}

interface CommentaryLine {
  text: string;
  tone: "info" | "pass" | "fail" | "warn";
}

interface StepRecord {
  title: string;
  source: "explicit" | "auto";
}

interface Evidence {
  errorType?: string;
  error?: string;
  retryCount?: number;
  failedStep?: string;
  attemptId?: string;
  bugKey?: string;
  steps: StepRecord[];
  artifacts: Array<{ type: string; path: string }>;
}

interface TooltipState {
  node: ManifestNode;
  x: number;
  y: number;
}

type DraftState = "draft" | "approved" | "rejected";

interface DraftNode extends ManifestNode {
  draftState: DraftState;
  sourceStoryKey?: string;
  flagged?: boolean;
}

interface DraftManifest {
  schemaVersion: string;
  projectKey: string;
  createdAt: string;
  nodes: DraftNode[];
}

interface AddJourneyForm {
  label: string;
  branchType: string;
  stage: string;
  stageName: string;
  module: string;
  sourceStoryKey: string;
}

export function computeHealthState(
  statuses: Record<string, NodeStatus>,
  nodes: ManifestNode[],
): "good" | "warning" | "critical" | "idle" {
  const values = Object.values(statuses);
  const active = values.filter((s) => s !== "pending");
  if (active.length === 0) return "idle";

  const anyFailed = active.some((s) => s === "failed");
  if (!anyFailed) return "good";

  const highestNodes = nodes.filter((n) => prioritySortValue(n) === 0);
  const anyHighestFailed = highestNodes.some((n) => statuses[n.id] === "failed");
  const failureRate = active.filter((s) => s === "failed").length / active.length;

  if (anyHighestFailed || failureRate >= 0.3) return "critical";
  return "warning";
}

const HEALTH_NEEDLE_ANGLE: Record<"good" | "warning" | "critical" | "idle", number> = {
  idle: 0,
  good: 65,
  warning: 0,
  critical: -65,
};

const HEALTH_LABEL: Record<"good" | "warning" | "critical" | "idle", string> = {
  idle: "—",
  good: "Good",
  warning: "Warning",
  critical: "Critical",
};

// 7 segments, red → green, with 3° white gaps between them
const GAUGE_COLORS = ["#c0392b", "#d95c1a", "#e88820", "#e0b820", "#c4c820", "#86c020", "#2db840"];
const GAUGE_SEG_DEG = 162 / 7; // 162° usable arc split evenly across 7 segments

function gaugeSectorPath(
  cx: number,
  cy: number,
  outerR: number,
  innerR: number,
  startDeg: number,
  endDeg: number,
): string {
  const d = Math.PI / 180;
  const c1 = Math.cos(startDeg * d),
    s1 = Math.sin(startDeg * d);
  const c2 = Math.cos(endDeg * d),
    s2 = Math.sin(endDeg * d);
  const f = (n: number) => n.toFixed(1);
  // outer arc: sweep=0 (screen CCW = through the top)
  // inner arc back: sweep=1 (screen CW = returns along bottom)
  return (
    `M${f(cx + outerR * c1)},${f(cy - outerR * s1)} ` +
    `A${outerR},${outerR} 0 0 0 ${f(cx + outerR * c2)},${f(cy - outerR * s2)} ` +
    `L${f(cx + innerR * c2)},${f(cy - innerR * s2)} ` +
    `A${innerR},${innerR} 0 0 1 ${f(cx + innerR * c1)},${f(cy - innerR * s1)} Z`
  );
}

function Speedometer({ health }: { health: "good" | "warning" | "critical" | "idle" }) {
  const angle = HEALTH_NEEDLE_ANGLE[health];
  const cx = 200,
    cy = 208,
    outerR = 183,
    innerR = 108;
  // needle: teardrop — tip at cy-122, base rounds below cy (covered by pivot cap)
  const needlePath = `M${cx},${cy - 122} L${cx - 7},${cy} A7,7 0 0 1 ${cx + 7},${cy} Z`;
  return (
    <svg
      viewBox="0 0 400 220"
      style={{ width: 140, height: 77, flexShrink: 0 }}
      aria-label={`Health: ${HEALTH_LABEL[health]}`}
      role="img"
    >
      {GAUGE_COLORS.map((color, i) => {
        const start = 180 - i * (GAUGE_SEG_DEG + 3);
        const end = start - GAUGE_SEG_DEG;
        return (
          <path key={i} d={gaugeSectorPath(cx, cy, outerR, innerR, start, end)} fill={color} />
        );
      })}
      <g
        style={{
          transform: `rotate(${angle}deg)`,
          transformOrigin: `${cx}px ${cy}px`,
          transition: "transform 0.8s ease",
        }}
      >
        <path d={needlePath} fill="#2d3748" />
      </g>
      <circle cx={cx} cy={cy} r="16" fill="#2d3748" />
      <circle cx={cx} cy={cy} r="9" fill="#718096" />
      <text x={cx} y="218" textAnchor="middle" fontSize="14" fill="#4a5568" fontWeight="500">
        {HEALTH_LABEL[health]}
      </text>
    </svg>
  );
}

function stageState(nodes: ManifestNode[], statuses: Record<string, NodeStatus>) {
  const values = nodes.map((node) => statuses[node.id] ?? "pending");
  if (values.some((value) => value === "failed")) return "failed";
  if (values.some((value) => value === "running")) return "running";
  if (values.every((value) => value === "passed")) return "passed";
  return "pending";
}

function visibleNodeStatus(status: NodeStatus) {
  return status === "pending" ? "untested" : status;
}

function prioritySortValue(node: ManifestNode) {
  const normalized = node.priority.trim().toLowerCase();
  if (/^(highest|p0|p-0|critical|blocker)$/.test(normalized)) return 0;
  if (/^(high|p1|p-1)$/.test(normalized)) return 1;
  if (/^(medium|med|p2|p-2)$/.test(normalized)) return 2;
  if (/^(low|p3|p-3)$/.test(normalized)) return 3;
  if (/^(lowest|p4|p-4)$/.test(normalized)) return 4;
  return Number.isFinite(node.priorityRank) ? node.priorityRank + 10 : 99;
}

function visibleOnFishbone(status: NodeStatus) {
  return status !== "pending";
}

function terminalStatus(status: NodeStatus) {
  return ["passed", "failed", "skipped", "blocked", "abandoned"].includes(status);
}

function rowSpineStatus(
  nodes: ManifestNode[],
  statuses: Record<string, NodeStatus>,
  runStatus: "idle" | "running" | "stopped" | "finished",
) {
  const rowStatuses = nodes.map((node) => statuses[node.id] ?? "pending");
  if (rowStatuses.some((status) => status === "failed" || status === "abandoned")) return "failed";
  if (
    runStatus === "finished" &&
    rowStatuses.some((status) => terminalStatus(status)) &&
    !rowStatuses.some((status) => status === "running")
  ) {
    return "passed";
  }
  if (
    rowStatuses.some((status) => terminalStatus(status)) &&
    !rowStatuses.some((status) => status === "running" || status === "pending")
  ) {
    return "passed";
  }
  return "in-progress";
}

export function FishbonePage() {
  const [manifest, setManifest] = useState<Manifest>();
  const [selectedStage, setSelectedStage] = useState("");
  const [logoVisible, setLogoVisible] = useState(true);
  const [statuses, setStatuses] = useState<Record<string, NodeStatus>>({});
  const [runId, setRunId] = useState("");
  const [runStatus, setRunStatus] = useState<"idle" | "running" | "stopped" | "finished">("idle");
  const [message, setMessage] = useState("");
  const [commentary, setCommentary] = useState<CommentaryLine[]>([]);
  const [reportPath, setReportPath] = useState("");
  const [selectedNode, setSelectedNode] = useState<ManifestNode>();
  const [navVisible, setNavVisible] = useState(true);
  const [evidence, setEvidence] = useState<Record<string, Evidence>>({});
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  const [commentaryHeight, setCommentaryHeight] = useState(220);
  const [approvedMappingIds, setApprovedMappingIds] = useState<Set<string>>(new Set());
  const [draftManifest, setDraftManifest] = useState<DraftManifest>();
  const [selectedDraftNode, setSelectedDraftNode] = useState<DraftNode>();
  const [draftEditLabel, setDraftEditLabel] = useState("");
  const [draftEditBranchType, setDraftEditBranchType] = useState("");
  const [draftSaving, setDraftSaving] = useState(false);
  const [draftLocking, setDraftLocking] = useState(false);
  const [draftLockError, setDraftLockError] = useState("");
  const [showAddJourney, setShowAddJourney] = useState(false);
  const [addJourneyForm, setAddJourneyForm] = useState<AddJourneyForm>({
    label: "",
    branchType: "happy",
    stage: "",
    stageName: "",
    module: "",
    sourceStoryKey: "",
  });
  const [showInternals, setShowInternals] = useState(false);
  const [aiSummary, setAiSummary] = useState<string | null>(null);
  const [summaryLoading, setSummaryLoading] = useState(false);
  const summaryCache = useRef<Map<string, string>>(new Map());
  const [bugStatus, setBugStatus] = useState<
    Record<string, { bugKey: string | null; status: string | null; warning?: string }>
  >({});
  const [bugCreating, setBugCreating] = useState(false);
  const source = useRef<EventSource | null>(null);
  const manifestRef = useRef<Manifest | undefined>(undefined);
  const commentaryEnd = useRef<HTMLDivElement | null>(null);
  const tooltipCloseTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let ignore = false;
    async function load() {
      const manifestResponse = await apiFetch("/api/manifest");
      if (ignore) return;
      if (manifestResponse.ok) {
        const loaded = (await manifestResponse.json()) as Manifest;
        if (!loaded.lockedAt) {
          const draftResponse = await apiFetch("/api/manifest/draft");
          if (!ignore && draftResponse.ok) {
            const draft = (await draftResponse.json()) as DraftManifest;
            setDraftManifest(draft);
            setSelectedStage(draft.nodes[0]?.stage ?? "");
          }
        } else {
          manifestRef.current = loaded;
          setManifest(loaded);
          setSelectedStage(loaded.nodes[0]?.stage ?? "");
          setStatuses(Object.fromEntries(loaded.nodes.map((node) => [node.id, "pending"])));
          try {
            const mappingResponse = await apiFetch("/api/mapping");
            if (!ignore && mappingResponse.ok) {
              const mappingData = (await mappingResponse.json()) as {
                mappings: Array<{ journeyId: string; matchedTests: Array<{ approved: boolean }> }>;
              };
              const ids = new Set(
                mappingData.mappings
                  .filter((m) => m.matchedTests.some((t) => t.approved))
                  .map((m) => m.journeyId),
              );
              setApprovedMappingIds(ids);
            }
          } catch {
            // Mapping is optional.
          }
        }
      } else {
        const draftResponse = await apiFetch("/api/manifest/draft");
        if (!ignore && draftResponse.ok) {
          const draft = (await draftResponse.json()) as DraftManifest;
          setDraftManifest(draft);
          setSelectedStage(draft.nodes[0]?.stage ?? "");
        }
      }
    }
    void load();
    connect();
    return () => {
      ignore = true;
      source.current?.close();
      clearTimeout(tooltipCloseTimer.current);
    };
  }, []);

  useEffect(() => {
    commentaryEnd.current?.scrollIntoView?.({ block: "nearest" });
  }, [commentary]);

  const stages = useMemo(() => {
    const ordered = new Map<string, ManifestNode[]>();
    for (const node of manifest?.nodes ?? []) {
      const stageNodes = ordered.get(node.stage) ?? [];
      stageNodes.push(node);
      ordered.set(node.stage, stageNodes);
    }
    return [...ordered.entries()];
  }, [manifest]);

  const visibleNodes = manifest?.nodes.filter((node) => node.stage === selectedStage) ?? [];
  const priorityGroups = useMemo(() => {
    const grouped = new Map<string, ManifestNode[]>();
    for (const node of visibleNodes) {
      const nodes = grouped.get(node.priority) ?? [];
      nodes.push(node);
      grouped.set(node.priority, nodes);
    }
    return [...grouped.entries()].sort(
      ([leftPriority, left], [rightPriority, right]) =>
        prioritySortValue(left[0]) - prioritySortValue(right[0]) ||
        leftPriority.localeCompare(rightPriority),
    );
  }, [visibleNodes]);
  const passed = Object.values(statuses).filter((status) => status === "passed").length;
  const failed = Object.values(statuses).filter((status) => status === "failed").length;
  const selectedEvidence = selectedNode ? evidence[selectedNode.id] : undefined;
  const selectedRules = selectedNode
    ? (manifest?.businessRules ?? []).filter((rule) =>
        (selectedNode.businessRuleIds ?? []).includes(rule.id),
      )
    : [];
  const needsConfig = message.toLowerCase().includes("project location");
  const isDraftMode = Boolean(draftManifest && !manifest?.lockedAt);
  const draftStages = useMemo(() => {
    if (!isDraftMode || !draftManifest) return new Map<string, DraftNode[]>();
    const ordered = new Map<string, DraftNode[]>();
    for (const node of draftManifest.nodes) {
      const stageNodes = ordered.get(node.stage) ?? [];
      stageNodes.push(node);
      ordered.set(node.stage, stageNodes);
    }
    return ordered;
  }, [isDraftMode, draftManifest]);
  const draftVisibleNodes = isDraftMode
    ? (draftManifest?.nodes.filter((n) => n.stage === selectedStage) ?? [])
    : [];
  const draftPriorityGroups = useMemo(() => {
    if (!isDraftMode) return [] as Array<[string, DraftNode[]]>;
    const grouped = new Map<string, DraftNode[]>();
    for (const node of draftVisibleNodes) {
      const nodes = grouped.get(node.priority) ?? [];
      nodes.push(node);
      grouped.set(node.priority, nodes);
    }
    return [...grouped.entries()].sort(
      ([leftPriority, left], [rightPriority, right]) =>
        prioritySortValue(left[0]) - prioritySortValue(right[0]) ||
        leftPriority.localeCompare(rightPriority),
    );
  }, [isDraftMode, draftVisibleNodes]);
  const draftReviewedCount =
    draftManifest?.nodes.filter((n) => n.draftState !== "draft").length ?? 0;
  const draftTotalCount = draftManifest?.nodes.length ?? 0;
  const allDraftReviewed = draftTotalCount > 0 && draftReviewedCount === draftTotalCount;

  function openDraftReview(node: DraftNode) {
    setSelectedDraftNode(node);
    setDraftEditLabel(node.label);
    setDraftEditBranchType(node.branchType);
    setNavVisible(false);
  }

  async function saveDraftJourney(
    id: string,
    patch: { draftState?: DraftState; label?: string; branchType?: string },
  ) {
    setDraftSaving(true);
    try {
      const response = await apiFetch(`/api/manifest/draft/journeys/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patch),
      });
      if (response.ok) {
        const updated = (await response.json()) as DraftNode;
        setDraftManifest((current) =>
          current
            ? { ...current, nodes: current.nodes.map((n) => (n.id === id ? updated : n)) }
            : current,
        );
        if (patch.draftState) {
          setSelectedDraftNode(undefined);
          setNavVisible(true);
        }
      }
    } finally {
      setDraftSaving(false);
    }
  }

  async function addDraftJourney() {
    const response = await apiFetch("/api/manifest/draft/journeys", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(addJourneyForm),
    });
    if (response.ok) {
      const node = (await response.json()) as DraftNode;
      setDraftManifest((current) =>
        current ? { ...current, nodes: [...current.nodes, node] } : current,
      );
      setShowAddJourney(false);
      setAddJourneyForm({
        label: "",
        branchType: "happy",
        stage: "",
        stageName: "",
        module: "",
        sourceStoryKey: "",
      });
    }
  }

  async function lockFromDraft() {
    setDraftLocking(true);
    setDraftLockError("");
    try {
      const response = await apiFetch("/api/manifest/lock-from-draft", { method: "POST" });
      const result = (await response.json()) as {
        lockedAt?: string;
        lockedBy?: string;
        journeyCount?: number;
        error?: string;
      };
      if (!response.ok) {
        setDraftLockError(result.error ?? "Lock failed.");
        return;
      }
      const manifestResponse = await apiFetch("/api/manifest");
      if (manifestResponse.ok) {
        const loaded = (await manifestResponse.json()) as Manifest;
        manifestRef.current = loaded;
        setManifest(loaded);
        setDraftManifest(undefined);
        setSelectedStage(loaded.nodes[0]?.stage ?? "");
        setStatuses(Object.fromEntries(loaded.nodes.map((node) => [node.id, "pending"])));
      }
    } finally {
      setDraftLocking(false);
    }
  }

  function appendCommentary(line: CommentaryLine) {
    setCommentary((current) => [...current.slice(-499), line]);
  }

  function journeyLine(action: string, testId: string, tone: CommentaryLine["tone"]) {
    const node = manifestRef.current?.nodes.find((candidate) => candidate.id === testId);
    appendCommentary({
      text: `${action} ${testId}${node ? ` - ${node.label}` : ""}`,
      tone,
    });
  }

  function selectNode(node: ManifestNode) {
    setSelectedNode(node);
    setNavVisible(false);
    setShowInternals(false);
    const ev = evidence[node.id];
    const cached = ev?.attemptId ? summaryCache.current.get(ev.attemptId) : undefined;
    setAiSummary(cached ?? null);
    void fetchBugStatus(node.id);
  }

  async function fetchBugStatus(nodeId: string) {
    try {
      const res = await apiFetch(`/api/bugs/${encodeURIComponent(nodeId)}/status`);
      if (res.ok) {
        const data = (await res.json()) as {
          bugKey: string | null;
          status: string | null;
          warning?: string;
        };
        setBugStatus((prev) => ({ ...prev, [nodeId]: data }));
      }
    } catch {
      // Bug status is non-critical.
    }
  }

  async function createBug(nodeId: string) {
    setBugCreating(true);
    try {
      const ev = evidence[nodeId];
      const res = await apiFetch("/api/bugs/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ journeyId: nodeId, attemptId: ev?.attemptId }),
      });
      const data = (await res.json()) as { bugKey?: string; error?: string };
      if (res.ok && data.bugKey) {
        setBugStatus((prev) => ({ ...prev, [nodeId]: { bugKey: data.bugKey!, status: "Open" } }));
      }
    } finally {
      setBugCreating(false);
    }
  }

  async function requestSummary(nodeId: string, forceRefresh = false) {
    const ev = evidence[nodeId];
    if (!ev?.attemptId) return;
    if (!forceRefresh) {
      const cached = summaryCache.current.get(ev.attemptId);
      if (cached) {
        setAiSummary(cached);
        return;
      }
    }
    setSummaryLoading(true);
    setAiSummary(null);
    try {
      const res = await apiFetch(`/api/evidence/${encodeURIComponent(nodeId)}/summarise`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          attemptId: ev.attemptId,
          steps: ev.steps.filter((s) => s.source === "explicit").map((s) => s.title),
          error: ev.error,
          journeyLabel: manifest?.nodes.find((n) => n.id === nodeId)?.label ?? nodeId,
          branchType: manifest?.nodes.find((n) => n.id === nodeId)?.branchType,
        }),
      });
      const data = (await res.json()) as { summary?: string; error?: string };
      if (res.ok && data.summary) {
        summaryCache.current.set(ev.attemptId, data.summary);
        setAiSummary(data.summary);
      }
    } finally {
      setSummaryLoading(false);
    }
  }

  function keepTooltipOpen() {
    if (tooltipCloseTimer.current) {
      clearTimeout(tooltipCloseTimer.current);
    }
  }

  function tooltipAt(node: ManifestNode, clientX: number, clientY: number) {
    keepTooltipOpen();
    setTooltip({ node, x: clientX + 14, y: clientY + 14 });
  }

  function scheduleTooltipClose() {
    tooltipCloseTimer.current = setTimeout(() => setTooltip(null), 150);
  }

  async function appendRunDiagnostic(diagnosticRunId: string) {
    try {
      const response = await apiFetch(`/api/runs/${diagnosticRunId}/output`);
      const output = await response.text();
      const runningTests = output.match(/Running\s+(\d+)\s+tests?\s+using/i);
      const portConflict = output.match(/Error:\s+(https?:\/\/[^\s]+).*already used/i);
      if (portConflict) {
        appendCommentary({
          text: `Playwright could not start the target app because ${portConflict[1]} is already in use. Stop the app servers on those ports, then start the run again.`,
          tone: "fail",
        });
        return;
      }
      if (runningTests) {
        appendCommentary({
          text: `Playwright ran ${runningTests[1]} tests, but none matched Pathlight journey IDs. Add bracketed IDs like [E2E-001] to Playwright test titles, then rerun.`,
          tone: "warn",
        });
        return;
      }
      const firstErrorLine = output
        .split("\n")
        .map((line) => line.replace(/^\[(stdout|stderr)\]\s*/, "").trim())
        .find((line) => line.startsWith("Error:"));
      if (firstErrorLine) {
        appendCommentary({ text: firstErrorLine, tone: "fail" });
      }
    } catch {
      // The static HTML report remains the fallback diagnostic surface.
    }
  }

  function beginCommentaryResize(event: ReactMouseEvent<HTMLButtonElement>) {
    const startY = event.clientY;
    const startHeight = commentaryHeight;
    function move(moveEvent: MouseEvent) {
      const nextHeight = Math.min(520, Math.max(120, startHeight + startY - moveEvent.clientY));
      setCommentaryHeight(nextHeight);
    }
    function end() {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", end);
    }
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", end);
  }

  function receive(event: StreamEvent) {
    const testId = event.payload.testId;
    if (event.type === "run.state") {
      setRunId(event.payload.runId ?? "");
      setRunStatus(
        event.payload.status === "running"
          ? "running"
          : event.payload.status === "finished"
            ? "finished"
            : "stopped",
      );
      setStatuses(
        Object.fromEntries(
          Object.entries(event.payload.testResults ?? {}).map(([id, result]) => [
            id,
            result.status,
          ]),
        ),
      );
    } else if (event.type === "run.started") {
      setStatuses(
        Object.fromEntries((manifestRef.current?.nodes ?? []).map((node) => [node.id, "pending"])),
      );
      setEvidence({});
      setReportPath("");
      setCommentary([]);
      setRunStatus("running");
    } else if (event.type === "test.started" && testId) {
      setStatuses((current) => ({ ...current, [testId]: "running" }));
      const node = manifestRef.current?.nodes.find((candidate) => candidate.id === testId);
      if (node) {
        setSelectedStage(node.stage);
      }
      journeyLine("Started", testId, "info");
    } else if (event.type === "test.passed" && testId) {
      setStatuses((current) => ({ ...current, [testId]: "passed" }));
      journeyLine("Passed", testId, "pass");
    } else if (event.type === "test.failed" && testId && event.payload.isFinalAttempt !== false) {
      setStatuses((current) => ({ ...current, [testId]: "failed" }));
      journeyLine(
        `Failed${event.payload.errorType ? ` (${event.payload.errorType})` : ""}`,
        testId,
        "fail",
      );
      setEvidence((current) => {
        const steps = current[testId]?.steps ?? [];
        const lastExplicit = [...steps].reverse().find((s) => s.source === "explicit");
        return {
          ...current,
          [testId]: {
            steps,
            artifacts: current[testId]?.artifacts ?? [],
            errorType: event.payload.errorType,
            error: event.payload.error,
            retryCount: event.payload.retryCount,
            failedStep: lastExplicit?.title ?? steps.at(-1)?.title,
            attemptId:
              typeof event.payload.attemptId === "string" ? event.payload.attemptId : undefined,
          },
        };
      });
    } else if (event.type === "test.skipped" && testId) {
      setStatuses((current) => ({ ...current, [testId]: "skipped" }));
      journeyLine("Skipped", testId, "warn");
    } else if (event.type === "step.started" || event.type === "step.finished") {
      if (testId && event.payload.stepTitle) {
        const stepSource = event.payload.source === "auto" ? "auto" : ("explicit" as const);
        setEvidence((current) => ({
          ...current,
          [testId]: {
            ...current[testId],
            steps:
              event.type === "step.started"
                ? [
                    ...(current[testId]?.steps ?? []),
                    { title: event.payload.stepTitle!, source: stepSource },
                  ]
                : (current[testId]?.steps ?? []),
            artifacts: current[testId]?.artifacts ?? [],
          },
        }));
      }
    } else if (
      event.type === "artifact.created" &&
      testId &&
      event.payload.artifactType &&
      event.payload.path
    ) {
      setEvidence((current) => ({
        ...current,
        [testId]: {
          ...current[testId],
          steps: current[testId]?.steps ?? [],
          artifacts: [
            ...(current[testId]?.artifacts ?? []),
            { type: event.payload.artifactType!, path: event.payload.path! },
          ],
        },
      }));
      journeyLine(`Captured ${event.payload.artifactType}`, testId, "warn");
    } else if (event.type === "run.abandoned") {
      setRunStatus("stopped");
      setMessage("Run stopped");
      appendCommentary({ text: "Run stopped before completion.", tone: "warn" });
    } else if (event.type === "run.finished") {
      setRunStatus("finished");
      const diagnosticRunId = event.payload.runId ?? runId;
      const total = event.payload.total ?? 0;
      const passedCount = event.payload.passed ?? passed;
      const failedCount = event.payload.failed ?? failed;
      appendCommentary(
        total === 0 && passedCount === 0 && failedCount === 0
          ? {
              text: `Run ${event.payload.runId ?? runId} finished, but no mapped Playwright tests reported back. Open the report and check Playwright output/test IDs.`,
              tone: "warn",
            }
          : {
              text: `Run ${diagnosticRunId} complete - ${passedCount} passed, ${failedCount} failed`,
              tone: failedCount ? "fail" : "pass",
            },
      );
      if (total === 0 && passedCount === 0 && failedCount === 0) {
        void appendRunDiagnostic(diagnosticRunId);
      }
    } else if (event.type === "report.ready" && event.payload.reportPath) {
      setReportPath(event.payload.reportPath);
      setRunId(event.payload.runId ?? runId);
    }
  }

  function connect() {
    source.current?.close();
    const stream = new EventSource("/api/stream");
    stream.onmessage = (messageEvent) => {
      const event = JSON.parse(messageEvent.data) as StreamEvent;
      receive(event);
    };
    source.current = stream;
  }

  async function startRun(nodeIds?: string[]) {
    setMessage("");
    const body: Record<string, unknown> = nodeIds ? { nodeIds } : {};
    const response = await apiFetch("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const result = (await response.json()) as {
      runId?: string;
      intendedNodeIds?: string[];
      error?: string;
    };
    if (!response.ok || !result.runId) {
      setMessage(result.error ?? "Unable to start run.");
      return;
    }
    const intended = new Set(result.intendedNodeIds ?? []);
    setRunId(result.runId);
    setRunStatus("running");
    setStatuses(
      Object.fromEntries(
        (manifest?.nodes ?? []).map((node) => [
          node.id,
          intended.has(node.id) && node.tags.includes("@blocked") ? "blocked" : "pending",
        ]),
      ),
    );
    connect();
  }

  async function stopRun() {
    const response = await apiFetch(`/api/runs/${runId}`, { method: "DELETE" });
    if (response.ok) {
      setRunStatus("stopped");
      setMessage("Run stopped");
      setStatuses((current) =>
        Object.fromEntries(
          Object.entries(current).map(([id, status]) => [
            id,
            status === "pending" || status === "running" ? "abandoned" : status,
          ]),
        ),
      );
    }
  }

  async function rerunFailedBranch() {
    const response = await apiFetch(`/api/runs/${runId}/rerun`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ failedOnly: true }),
    });
    const result = (await response.json()) as {
      runId?: string;
      intendedNodeIds?: string[];
      error?: string;
    };
    if (!response.ok || !result.runId) {
      setMessage(result.error ?? "Unable to rerun branch.");
      return;
    }
    setRunId(result.runId);
    setRunStatus("running");
    setReportPath("");
    setStatuses(
      Object.fromEntries(
        (manifest?.nodes ?? []).map((node) => [
          node.id,
          (result.intendedNodeIds ?? []).includes(node.id)
            ? "pending"
            : (statuses[node.id] ?? "pending"),
        ]),
      ),
    );
    connect();
  }

  if (!manifest && !draftManifest) {
    return <main className="fishbone-loading">Loading journey view...</main>;
  }

  if (isDraftMode && draftManifest) {
    const draftStageList = [...draftStages.entries()];
    return (
      <div className="fishbone-page">
        <header className="dashboard-topbar">
          <a className="dashboard-brand" href="/config">
            {logoVisible ? (
              <img src="/api/logo" alt="Project logo" onError={() => setLogoVisible(false)} />
            ) : (
              <span className="wordmark">Pathlight</span>
            )}
          </a>
          <a className="dashboard-config-link" href="/config">
            Config
          </a>
          <span className="draft-mode-badge">Draft Review</span>
          <span className="draft-progress">
            {draftReviewedCount} / {draftTotalCount} reviewed
          </span>
          {allDraftReviewed ? (
            <button
              className="primary-button"
              type="button"
              disabled={draftLocking}
              onClick={() => void lockFromDraft()}
            >
              {draftLocking ? "Locking…" : "Lock manifest"}
            </button>
          ) : null}
        </header>
        {draftLockError ? (
          <p className="alert alert-error" style={{ margin: "8px 36px 0" }} role="alert">
            {draftLockError}
          </p>
        ) : null}

        <div className="fishbone-layout">
          {navVisible && draftStageList.length > 1 ? (
            <nav className="stage-rail" aria-label="Journey stages">
              {draftStageList.map(([stage, nodes]) => (
                <button
                  className={stage === selectedStage ? "active" : ""}
                  key={stage}
                  type="button"
                  aria-label={stage}
                  aria-current={stage === selectedStage ? "true" : undefined}
                  onClick={() => setSelectedStage(stage)}
                >
                  <span
                    className={`stage-dot ${nodes.every((n) => n.draftState === "approved") ? "passed" : nodes.some((n) => n.draftState === "rejected") ? "failed" : "pending"}`}
                  />
                  {stage}{" "}
                  <small>
                    {nodes[0].stageName}
                    <span>
                      {nodes.length} {nodes.length === 1 ? "journey" : "journeys"}
                    </span>
                  </small>
                </button>
              ))}
            </nav>
          ) : null}

          <main className="fishbone-content">
            <h1>Journey confidence — Draft review</h1>
            {draftPriorityGroups.map(([priority, nodes]) => (
              <section className="fishbone-row" key={priority}>
                <h2 data-testid="priority-label">{priority}</h2>
                {(() => {
                  const viewWidth = Math.max(460, nodes.length * 124 + 120);
                  const spineStart = 32;
                  const spineEnd = viewWidth - 52;
                  return (
                    <svg
                      className="fishbone draft-fishbone"
                      role="img"
                      aria-label={`${priority} draft fishbone`}
                      preserveAspectRatio="xMinYMid meet"
                      viewBox={`0 0 ${viewWidth} 124`}
                    >
                      <circle className="spine-origin" cx={spineStart} cy="62" r="4" />
                      <line className="spine" x1={spineStart} x2={spineEnd} y1="62" y2="62" />
                      <path
                        className="arrow"
                        d={`M${spineEnd} 62 L${spineEnd - 12} 56 M${spineEnd} 62 L${spineEnd - 12} 68`}
                      />
                      {nodes.map((node, index) => {
                        const x = 92 + index * 112;
                        const above = index % 2 === 0;
                        const tipY = above ? 22 : 102;
                        return (
                          <g
                            aria-label={`${node.id}: ${node.label}`}
                            className={`fishbone-branch draft-${node.draftState}`}
                            data-testid={`draft-${node.id}`}
                            key={node.id}
                            onClick={() => openDraftReview(node)}
                            onBlur={() => setTooltip(null)}
                            onFocus={() => setTooltip({ node, x: 180, y: 180 })}
                            onKeyDown={(event) => {
                              if (event.key === "Enter" || event.key === " ") {
                                event.preventDefault();
                                openDraftReview(node);
                              }
                            }}
                            onMouseEnter={(event) => tooltipAt(node, event.clientX, event.clientY)}
                            onMouseLeave={scheduleTooltipClose}
                            onMouseMove={(event) => tooltipAt(node, event.clientX, event.clientY)}
                            role="button"
                            tabIndex={0}
                          >
                            <line
                              className={`bone draft-${node.draftState}`}
                              x1={x}
                              y1="62"
                              x2={x + 32}
                              y2={tipY}
                            />
                            <circle
                              className={`node-dot draft-${node.draftState}`}
                              cx={x + 32}
                              cy={tipY}
                              r="5"
                            />
                            <text x={x + 40} y={tipY - 6}>
                              {node.id}
                            </text>
                          </g>
                        );
                      })}
                    </svg>
                  );
                })()}
              </section>
            ))}

            <div style={{ marginTop: 16 }}>
              <button
                className="secondary-button"
                type="button"
                onClick={() => setShowAddJourney((v) => !v)}
              >
                {showAddJourney ? "Cancel" : "Add journey"}
              </button>
            </div>

            {showAddJourney ? (
              <section className="panel" style={{ marginTop: 12, padding: 16 }}>
                <h3 style={{ marginBottom: 12 }}>Add journey manually</h3>
                <div className="project-location-fields">
                  <label>
                    Label
                    <input
                      value={addJourneyForm.label}
                      onChange={(e) => setAddJourneyForm((f) => ({ ...f, label: e.target.value }))}
                    />
                  </label>
                  <label>
                    Branch type
                    <select
                      value={addJourneyForm.branchType}
                      onChange={(e) =>
                        setAddJourneyForm((f) => ({ ...f, branchType: e.target.value }))
                      }
                    >
                      {["happy", "unhappy", "edge", "boundary", "system"].map((t) => (
                        <option key={t} value={t}>
                          {t}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label>
                    Stage key
                    <input
                      value={addJourneyForm.stage}
                      onChange={(e) => setAddJourneyForm((f) => ({ ...f, stage: e.target.value }))}
                      placeholder="e.g. S1"
                    />
                  </label>
                  <label>
                    Stage name
                    <input
                      value={addJourneyForm.stageName}
                      onChange={(e) =>
                        setAddJourneyForm((f) => ({ ...f, stageName: e.target.value }))
                      }
                    />
                  </label>
                  <label>
                    Module
                    <input
                      value={addJourneyForm.module}
                      onChange={(e) => setAddJourneyForm((f) => ({ ...f, module: e.target.value }))}
                    />
                  </label>
                  <label>
                    Source story key (optional)
                    <input
                      value={addJourneyForm.sourceStoryKey}
                      onChange={(e) =>
                        setAddJourneyForm((f) => ({ ...f, sourceStoryKey: e.target.value }))
                      }
                      placeholder="e.g. ZOV-12"
                    />
                  </label>
                </div>
                <button
                  className="primary-button"
                  type="button"
                  onClick={() => void addDraftJourney()}
                  style={{ marginTop: 8 }}
                >
                  Add journey
                </button>
              </section>
            ) : null}
          </main>

          {selectedDraftNode ? (
            <aside className="evidence-panel">
              <button
                className="close-button"
                type="button"
                onClick={() => {
                  setSelectedDraftNode(undefined);
                  setNavVisible(true);
                }}
              >
                ✕
              </button>
              <div className="evidence-content">
                <h3>{selectedDraftNode.id}</h3>
                {selectedDraftNode.flagged ? (
                  <p className="alert alert-error" style={{ fontSize: 12 }}>
                    No acceptance criteria — derived from summary only.
                  </p>
                ) : null}
                <label style={{ display: "block", marginBottom: 8 }}>
                  <span
                    style={{ fontSize: 12, color: "#5c687a", display: "block", marginBottom: 4 }}
                  >
                    Label
                  </span>
                  <input
                    value={draftEditLabel}
                    onChange={(e) => setDraftEditLabel(e.target.value)}
                    style={{ width: "100%", boxSizing: "border-box" }}
                  />
                </label>
                <label style={{ display: "block", marginBottom: 12 }}>
                  <span
                    style={{ fontSize: 12, color: "#5c687a", display: "block", marginBottom: 4 }}
                  >
                    Branch type
                  </span>
                  <select
                    value={draftEditBranchType}
                    onChange={(e) => setDraftEditBranchType(e.target.value)}
                    style={{ width: "100%" }}
                  >
                    {["happy", "unhappy", "edge", "boundary", "system"].map((t) => (
                      <option key={t} value={t}>
                        {t}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedDraftNode.sourceStoryKey ? (
                  <p style={{ fontSize: 12, color: "#5c687a", marginBottom: 12 }}>
                    Source: {selectedDraftNode.sourceStoryKey}
                  </p>
                ) : null}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={draftSaving}
                    onClick={() =>
                      void saveDraftJourney(selectedDraftNode.id, {
                        label: draftEditLabel,
                        branchType: draftEditBranchType,
                      })
                    }
                  >
                    Save edits
                  </button>
                  <button
                    className="primary-button"
                    type="button"
                    disabled={draftSaving}
                    onClick={() =>
                      void saveDraftJourney(selectedDraftNode.id, {
                        draftState: "approved",
                        label: draftEditLabel,
                        branchType: draftEditBranchType,
                      })
                    }
                  >
                    Approve
                  </button>
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={draftSaving}
                    style={{ color: "#c0392b" }}
                    onClick={() =>
                      void saveDraftJourney(selectedDraftNode.id, { draftState: "rejected" })
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            </aside>
          ) : null}
        </div>

        {tooltip ? (
          <div
            className="fishbone-tooltip"
            style={{ left: tooltip.x, top: tooltip.y }}
            onMouseEnter={keepTooltipOpen}
            onMouseLeave={scheduleTooltipClose}
          >
            <p className="tooltip-id">{tooltip.node.id}</p>
            <p className="tooltip-label">{tooltip.node.label}</p>
            <p className="tooltip-branch">{tooltip.node.branchType}</p>
          </div>
        ) : null}
      </div>
    );
  }

  if (!manifest?.lockedAt) {
    return (
      <main className="fishbone-loading">
        <p>Lock the manifest before starting a run</p>
        <a href="/config">Back to config</a>
      </main>
    );
  }

  return (
    <div className="fishbone-page">
      <header className="dashboard-topbar">
        <a className="dashboard-brand" href="/config">
          {logoVisible ? (
            <img src="/api/logo" alt="Project logo" onError={() => setLogoVisible(false)} />
          ) : (
            <span className="wordmark">Pathlight</span>
          )}
        </a>
        <a className="dashboard-config-link" href="/config">
          Config
        </a>
        <a className="dashboard-config-link" href="/risk">
          Risk
        </a>
        <a className="dashboard-config-link" href="/history">
          History
        </a>
        <button
          className="nav-toggle"
          type="button"
          onClick={() => setNavVisible((visible) => !visible)}
        >
          {navVisible && !selectedNode ? "Hide stages" : "Show stages"}
        </button>
        <div className="counter passed">Pass {passed}</div>
        <div className="counter failed">Fail {failed}</div>
        <Speedometer health={computeHealthState(statuses, manifest?.nodes ?? [])} />
        {reportPath ? (
          <a
            className="secondary-button report-link"
            href={reportPath.startsWith("/") ? reportPath : `/${reportPath}`}
          >
            View report
          </a>
        ) : null}
        {message ? (
          <p className="run-alert" role="alert">
            {message}
            {needsConfig ? (
              <>
                {" "}
                <a href="/config">Open Config</a>
              </>
            ) : null}
          </p>
        ) : null}
        {runStatus === "running" ? (
          <button className="stop-button" type="button" onClick={stopRun}>
            Stop run
          </button>
        ) : (
          <button
            className="primary-button dashboard-action"
            type="button"
            onClick={() => void startRun()}
          >
            Start run
          </button>
        )}
      </header>
      <div className="dashboard-body">
        {navVisible && !selectedNode ? (
          <nav className="stage-nav" aria-label="Stages">
            {stages.map(([stage, nodes]) => (
              <button
                className={stage === selectedStage ? "active" : ""}
                key={stage}
                type="button"
                aria-label={stage}
                aria-current={stage === selectedStage ? "true" : undefined}
                onClick={() => setSelectedStage(stage)}
              >
                <span className={`stage-dot ${stageState(nodes, statuses)}`} />
                {stage}{" "}
                <small>
                  {nodes[0].stageName}
                  <span>
                    {nodes.length} {nodes.length === 1 ? "journey" : "journeys"}
                  </span>
                </small>
              </button>
            ))}
          </nav>
        ) : null}
        <main className="fishbone-content">
          <h1>Journey confidence</h1>
          {priorityGroups.map(([priority, nodes]) => (
            <section className="fishbone-row" key={priority}>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <h2 data-testid="priority-label" style={{ margin: 0 }}>
                  {priority}
                </h2>
                <button
                  className="secondary-button"
                  type="button"
                  disabled={runStatus === "running"}
                  onClick={() => void startRun(nodes.map((n) => n.id))}
                  style={{ fontSize: 12, padding: "2px 8px" }}
                >
                  Run {priority}
                </button>
              </div>
              {(() => {
                const viewWidth = Math.max(460, nodes.length * 124 + 120);
                const spineStart = 32;
                const spineEnd = viewWidth - 52;
                const visibleIndexes = nodes
                  .map((node, index) => ({ index, status: statuses[node.id] ?? "pending" }))
                  .filter(({ status }) => visibleOnFishbone(status))
                  .map(({ index }) => index);
                const lastVisibleIndex =
                  visibleIndexes.length > 0 ? Math.max(...visibleIndexes) : -1;
                const progressEnd =
                  lastVisibleIndex === -1
                    ? spineStart
                    : runStatus === "finished"
                      ? spineEnd
                      : Math.min(spineEnd, 92 + lastVisibleIndex * 112);
                const spineStatus = rowSpineStatus(nodes, statuses, runStatus);
                return (
                  <svg
                    className={`fishbone priority-${priority.toLowerCase().replace(/[^a-z0-9]+/g, "-")} spine-${spineStatus}`}
                    role="img"
                    aria-label={`${priority} fishbone`}
                    preserveAspectRatio="xMinYMid meet"
                    viewBox={`0 0 ${viewWidth} 124`}
                  >
                    <circle className="spine-origin" cx={spineStart} cy="62" r="4" />
                    <line className="spine" x1={spineStart} x2={progressEnd} y1="62" y2="62" />
                    {progressEnd > spineStart + 12 ? (
                      <path
                        className="arrow"
                        d={`M${progressEnd} 62 L${progressEnd - 12} 56 M${progressEnd} 62 L${progressEnd - 12} 68`}
                      />
                    ) : null}
                    {nodes.map((node, index) => {
                      const x = 92 + index * 112;
                      const above = index % 2 === 0;
                      const tipY = above ? 22 : 102;
                      const status = statuses[node.id] ?? "pending";
                      const hasCoverage = approvedMappingIds.size > 0;
                      const active = visibleOnFishbone(status) || hasCoverage;
                      if (!active) {
                        return null;
                      }
                      const coverage =
                        hasCoverage && status === "pending"
                          ? approvedMappingIds.has(node.id)
                            ? "covered"
                            : "uncovered"
                          : undefined;
                      const boneClass =
                        coverage === "covered"
                          ? "bone coverage-covered"
                          : coverage === "uncovered"
                            ? "bone coverage-uncovered"
                            : `bone ${status}`;
                      const dotClass =
                        coverage === "covered"
                          ? "node-dot coverage-covered"
                          : coverage === "uncovered"
                            ? "node-dot coverage-uncovered"
                            : `node-dot ${status}`;
                      return (
                        <g
                          aria-label={`${node.id}: ${node.label}`}
                          className="fishbone-branch"
                          data-coverage={coverage}
                          data-status={visibleNodeStatus(status)}
                          data-testid={`status-${node.id}`}
                          key={node.id}
                          onClick={() => selectNode(node)}
                          onBlur={() => setTooltip(null)}
                          onFocus={() => setTooltip({ node, x: 180, y: 180 })}
                          onKeyDown={(event) => {
                            if (event.key === "Enter" || event.key === " ") {
                              event.preventDefault();
                              selectNode(node);
                            }
                          }}
                          onMouseEnter={(event) => tooltipAt(node, event.clientX, event.clientY)}
                          onMouseLeave={scheduleTooltipClose}
                          onMouseMove={(event) => tooltipAt(node, event.clientX, event.clientY)}
                          role="button"
                          tabIndex={0}
                        >
                          <line className={boneClass} x1={x} y1="62" x2={x + 32} y2={tipY} />
                          <circle className={dotClass} cx={x + 32} cy={tipY} r="5" />
                          <text x={x + 40} y={tipY - 6}>
                            {node.id}
                          </text>
                        </g>
                      );
                    })}
                  </svg>
                );
              })()}
            </section>
          ))}
          {approvedMappingIds.size > 0 && manifest ? (
            <section className="coverage-summary-panel">
              <div className="coverage-summary-card">
                <span className="coverage-summary-title">Coverage</span>
                <span className="coverage-fraction">
                  {approvedMappingIds.size} / {manifest.nodes.length} journeys
                </span>
                <a href="/api/mapping/gap-report.csv" className="secondary-button" download>
                  Export gap report
                </a>
                <a href="/test-generation" className="secondary-button">
                  Generate tests for gaps
                </a>
              </div>
              {manifest.nodes.filter((n) => !approvedMappingIds.has(n.id)).length > 0 ? (
                <details className="gap-list-details">
                  <summary className="gap-list-summary">
                    {manifest.nodes.filter((n) => !approvedMappingIds.has(n.id)).length} gaps — no
                    test mapped
                  </summary>
                  <ul className="gap-list">
                    {manifest.nodes
                      .filter((n) => !approvedMappingIds.has(n.id))
                      .map((n) => (
                        <li key={n.id} className="gap-item">
                          <span className="gap-id">{n.id}</span>
                          <span className="gap-label">{n.label}</span>
                          <span className="gap-stage">{n.stageName}</span>
                          <a
                            href={`/test-generation?journeyId=${encodeURIComponent(n.id)}`}
                            className="gap-generate-btn"
                          >
                            Generate test
                          </a>
                        </li>
                      ))}
                  </ul>
                </details>
              ) : null}
            </section>
          ) : null}
        </main>
        {selectedNode ? (
          <aside className="evidence-panel">
            <button
              className="close-button"
              type="button"
              onClick={() => {
                setSelectedNode(undefined);
                setNavVisible(true);
              }}
            >
              Close
            </button>
            <h2>{selectedNode.id}</h2>
            <p>{selectedNode.label}</p>
            <p>Status: {statuses[selectedNode.id] ?? "pending"}</p>
            <p>Branch: {selectedNode.branchType}</p>
            {selectedRules.length > 0 ? (
              <div>
                <h3>Business rules</h3>
                {selectedRules.map((rule) => (
                  <p key={rule.id}>
                    {rule.label} ({rule.severity})
                  </p>
                ))}
              </div>
            ) : null}
            {selectedEvidence?.errorType ? <p>Error type: {selectedEvidence.errorType}</p> : null}
            {selectedEvidence?.error ? <p>{selectedEvidence.error}</p> : null}
            {selectedEvidence?.retryCount !== undefined ? (
              <p>Retry count: {selectedEvidence.retryCount}</p>
            ) : null}
            {selectedEvidence?.attemptId && statuses[selectedNode.id] === "failed" ? (
              <div style={{ marginBottom: 12 }}>
                <h3>Failure summary</h3>
                {aiSummary ? (
                  <div
                    style={{
                      background: "#ebf8ff",
                      border: "1px solid #bee3f8",
                      borderRadius: 4,
                      padding: "8px 10px",
                      fontSize: 13,
                      lineHeight: 1.5,
                    }}
                  >
                    {aiSummary}
                  </div>
                ) : (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={summaryLoading}
                    onClick={() => void requestSummary(selectedNode.id)}
                    style={{ fontSize: 12 }}
                  >
                    {summaryLoading ? "Generating…" : "Generate summary"}
                  </button>
                )}
                {aiSummary ? (
                  <button
                    className="secondary-button"
                    type="button"
                    disabled={summaryLoading}
                    onClick={() => void requestSummary(selectedNode.id, true)}
                    style={{ fontSize: 12, marginTop: 6 }}
                  >
                    {summaryLoading ? "Regenerating…" : "Regenerate summary"}
                  </button>
                ) : null}
              </div>
            ) : null}
            <div>
              <h3>Test execution timeline</h3>
              {selectedEvidence?.steps.length ? (
                <>
                  <ol className="journey-steps">
                    {selectedEvidence.steps
                      .filter((step) => showInternals || step.source !== "auto")
                      .map((step, index) => {
                        const isFailing = step.title === selectedEvidence.failedStep;
                        return (
                          <li
                            className={isFailing ? "failed-step" : undefined}
                            key={`${step.title}-${index}`}
                          >
                            {step.title}
                            {isFailing ? <strong> Failed here</strong> : null}
                          </li>
                        );
                      })}
                  </ol>
                  {(() => {
                    const autoCount = selectedEvidence.steps.filter(
                      (s) => s.source === "auto",
                    ).length;
                    return autoCount > 0 ? (
                      <button
                        className="secondary-button"
                        type="button"
                        onClick={() => setShowInternals((v) => !v)}
                        style={{ fontSize: 12, marginTop: 4 }}
                      >
                        {showInternals ? "Hide internals" : `Show internals (${autoCount})`}
                      </button>
                    ) : null;
                  })()}
                </>
              ) : (
                <p>No step events captured yet.</p>
              )}
            </div>
            {selectedEvidence?.artifacts.map((artifact) => (
              <a href={artifact.path} key={artifact.path}>
                {artifact.type}
              </a>
            ))}
            <button className="secondary-button" type="button" onClick={rerunFailedBranch}>
              Rerun branch
            </button>
            {statuses[selectedNode.id] === "failed"
              ? (() => {
                  const bs = bugStatus[selectedNode.id];
                  const hasOpenBug = bs?.bugKey && bs.status !== "Done" && bs.status !== "Resolved";
                  return (
                    <div style={{ marginTop: 8 }}>
                      {hasOpenBug ? (
                        <p className="field-help">
                          JIRA bug: <strong>{bs.bugKey}</strong> — {bs.status}
                        </p>
                      ) : (
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={bugCreating || runStatus === "running"}
                          onClick={() => void createBug(selectedNode.id)}
                        >
                          {bugCreating ? "Creating…" : "Create JIRA bug"}
                        </button>
                      )}
                      {bs?.warning ? (
                        <p className="field-help" style={{ color: "#e09e26" }}>
                          {bs.warning}
                        </p>
                      ) : null}
                    </div>
                  );
                })()
              : null}
          </aside>
        ) : null}
      </div>
      {tooltip ? (
        <div
          className="journey-tooltip"
          onMouseEnter={keepTooltipOpen}
          onMouseLeave={scheduleTooltipClose}
          role="tooltip"
          style={{ left: tooltip.x, top: tooltip.y }}
        >
          <strong>{tooltip.node.id}</strong>
          <button
            className="journey-tooltip-title"
            onClick={() => selectNode(tooltip.node)}
            type="button"
          >
            {tooltip.node.label}
          </button>
        </div>
      ) : null}
      <aside
        className="commentary"
        aria-label="Live commentary"
        style={{ height: commentaryHeight }}
      >
        <button
          aria-label="Resize commentary"
          className="commentary-resize"
          onMouseDown={beginCommentaryResize}
          type="button"
        />
        <h2>Live commentary</h2>
        {commentary.length === 0 ? (
          <p>Ready</p>
        ) : (
          commentary.map((line, index) => (
            <p className={`commentary-${line.tone}`} key={`${line.text}-${index}`}>
              {line.text}
            </p>
          ))
        )}
        <div ref={commentaryEnd} />
      </aside>
    </div>
  );
}
