import { createHash } from "node:crypto";

interface ReporterOptions {
  serverUrl?: string;
  runId?: string;
  manifestIds?: string[];
  manifestNodeIds?: string[];
  fetch?: typeof fetch;
  stderr?: (message: string) => void;
  suiteTag?: string | null;
}

interface TestCaseLike {
  id?: string;
  title: string;
  titlePath?: () => string[];
  location?: { file: string };
}

interface ResultLike {
  workerIndex?: number;
  retry?: number;
  status?: string;
  duration?: number;
  error?: { message?: string } | string;
  willRetry?: boolean;
}

interface StepLike {
  title: string;
  category?: string;
}

interface Mapping {
  testId: string;
  attemptId: string;
  workerId: string;
  retry: number;
  stepIndex: number;
}

function redact(value: string) {
  return value
    .replace(/(authorization:\s*bearer\s+)\S+/gi, "$1[REDACTED]")
    .replace(/((?:api[_-]?key|token|secret|password)\s*[=:]\s*)\S+/gi, "$1[REDACTED]");
}

export default class PathlightReporter {
  private readonly serverUrl: string;
  private readonly runId?: string;
  private knownIds?: Set<string>;
  private readonly semanticMapping = new Map<string, string>(); // normalized title → journeyId
  private semanticMappingLoaded: Promise<void> = Promise.resolve();
  private readonly send: typeof fetch;
  private readonly stderr: (message: string) => void;
  private suiteTag: string | null;
  private readonly mappings = new Map<string, Mapping>();
  private readonly stepIndices = new WeakMap<object, number>();
  private eventNumber = 0;
  private deliveredCount = 0;
  private droppedEventCount = 0;
  private untaggedTestCount = 0;
  private invalidTagCount = 0;
  private unknownTagCount = 0;
  private totalTests = 0;
  private passed = 0;
  private failed = 0;
  private skipped = 0;
  private warnedMissingRunId = false;
  private postChain: Promise<void> = Promise.resolve();

  constructor(options: ReporterOptions = {}) {
    this.serverUrl = options.serverUrl ?? "http://127.0.0.1:4242";
    this.runId = options.runId ?? process.env.PATHLIGHT_RUN_ID;
    const manifestIds = options.manifestNodeIds ?? options.manifestIds;
    this.knownIds = manifestIds
      ? new Set(manifestIds)
      : this.envManifestNodeIds(process.env.PATHLIGHT_MANIFEST_NODE_IDS);
    this.send = options.fetch ?? fetch;
    this.stderr = options.stderr ?? ((message) => console.error(message));
    this.suiteTag = options.suiteTag ?? null;
    if (!this.runId) {
      this.warnMissingId();
    }
  }

  // onBegin is awaited by test harnesses; Playwright itself does not await it in production.
  // We start loading synchronously so hooks fired immediately after onBegin see consistent state.
  async onBegin(config: { grep?: unknown }, suite: { allTests: () => TestCaseLike[] }) {
    this.totalTests = suite.allTests().length;
    if (!this.suiteTag && this.isMeaningfulGrep(config.grep)) {
      this.suiteTag = String(config.grep);
    }
    void this.loadKnownIds();
    this.semanticMappingLoaded = this.loadSemanticMapping();
    this.enqueue("run.started", {
      totalTests: this.totalTests,
      suiteTag: this.suiteTag,
      runType: this.suiteTag ? "partial" : "full",
    });
    await this.postChain;
  }

  // onEnd is awaited by Playwright. Chaining run.finished last ensures it follows all test events.
  async onEnd(result: { status?: string; duration?: number }) {
    if (this.runId) {
      this.postChain = this.postChain.then(() =>
        this.deliverPost("run.finished", {
          total: this.totalTests,
          passed: this.passed,
          failed: this.failed,
          skipped: this.skipped,
          duration: result.duration ?? 0,
          totalEventsSent: this.deliveredCount + 1,
          droppedEventCount: this.droppedEventCount,
          untaggedTestCount: this.untaggedTestCount,
          invalidTagCount: this.invalidTagCount,
          unknownTagCount: this.unknownTagCount,
        }),
      );
    }
    await this.postChain;
  }

  // Playwright does not await these hooks. Each synchronously extends postChain so that
  // run.finished (appended in onEnd) is always sequenced after all test and step events.
  onTestBegin(test: TestCaseLike, result: ResultLike): void {
    this.postChain = this.postChain.then(async () => {
      await this.semanticMappingLoaded;
      const mapping = this.mapTest(test, result);
      if (!mapping) return;
      this.mappings.set(this.testKey(test), mapping);
      const title = this.fullTitle(test);
      const file = test.location?.file ?? "";
      await this.deliverPost("test.started", {
        testId: mapping.testId,
        attemptId: mapping.attemptId,
        workerId: mapping.workerId,
        attempt: mapping.retry,
        testFile: file,
        testTitle: title,
        testCaseHash: createHash("sha256")
          .update(file + title)
          .digest("hex")
          .slice(0, 8),
      });
    });
  }

  onTestEnd(test: TestCaseLike, result: ResultLike): void {
    this.postChain = this.postChain.then(async () => {
      const mapping = this.mappings.get(this.testKey(test));
      if (!mapping) return;
      const common = {
        testId: mapping.testId,
        attemptId: mapping.attemptId,
        duration: result.duration ?? 0,
        retryCount: result.retry ?? 0,
        workerId: mapping.workerId,
      };
      if (result.status === "passed") {
        this.passed += 1;
        await this.deliverPost("test.passed", common);
      } else if (result.status === "skipped") {
        this.skipped += 1;
        await this.deliverPost("test.skipped", {
          testId: mapping.testId,
          attemptId: mapping.attemptId,
        });
      } else {
        this.failed += 1;
        const error =
          typeof result.error === "string"
            ? result.error
            : (result.error?.message ?? "Test failed");
        await this.deliverPost("test.failed", {
          ...common,
          error: redact(error),
          errorType: error.toLowerCase().includes("timeout") ? "timeout" : "assertion_failure",
          isFinalAttempt: result.willRetry !== true,
        });
      }
    });
  }

  onStepBegin(test: TestCaseLike, _result: ResultLike, step: StepLike): void {
    this.postChain = this.postChain.then(async () => {
      const mapping = this.mappings.get(this.testKey(test));
      if (!mapping) return;
      const index = mapping.stepIndex++;
      this.stepIndices.set(step, index);
      await this.deliverPost("step.started", this.stepPayload(mapping, step, index));
    });
  }

  onStepEnd(test: TestCaseLike, _result: ResultLike, step: StepLike): void {
    this.postChain = this.postChain.then(async () => {
      const mapping = this.mappings.get(this.testKey(test));
      if (!mapping) return;
      const index = this.stepIndices.get(step);
      if (index === undefined) return;
      await this.deliverPost("step.finished", this.stepPayload(mapping, step, index));
    });
  }

  private mapTest(test: TestCaseLike, result: ResultLike) {
    const title = this.fullTitle(test);
    const bracketMatch = title.match(/\[([A-Za-z0-9-]+)\]/);
    const testId = bracketMatch ? bracketMatch[1] : this.lookupSemantic(title);
    if (!testId) {
      this.untaggedTestCount += 1;
      return null;
    }
    if (this.knownIds && !this.knownIds.has(testId)) {
      this.unknownTagCount += 1;
      return null;
    }
    const file = test.location?.file ?? "";
    const hash = createHash("sha256")
      .update(file + title)
      .digest("hex")
      .slice(0, 8);
    const retry = result.retry ?? 0;
    return {
      testId,
      attemptId: `${testId}_${hash}_${this.runId ?? "missing"}_att_${retry}`,
      workerId: String(result.workerIndex ?? 0),
      retry,
      stepIndex: 0,
    };
  }

  private lookupSemantic(fullTitle: string): string | undefined {
    if (this.semanticMapping.size === 0) return undefined;
    const normalized = fullTitle.trim().toLowerCase();
    if (this.semanticMapping.has(normalized)) return this.semanticMapping.get(normalized);
    for (const [mappedTitle, journeyId] of this.semanticMapping) {
      if (normalized.endsWith(` ${mappedTitle}`)) {
        return journeyId;
      }
    }
    return undefined;
  }

  private async loadKnownIds() {
    if (this.knownIds) {
      return;
    }
    try {
      const response = await this.send(`${this.serverUrl}/api/manifest`);
      if (response.ok) {
        const manifest = (await response.json()) as { nodes?: Array<{ id?: string }> };
        this.knownIds = new Set(
          (manifest.nodes ?? [])
            .map((node) => node.id)
            .filter((nodeId): nodeId is string => typeof nodeId === "string"),
        );
      }
    } catch {
      this.stderr("[pathlight] Manifest unavailable; unmatched test IDs cannot be classified.");
    }
  }

  private async loadSemanticMapping() {
    if (!this.runId) return;
    try {
      const response = await this.send(`${this.serverUrl}/api/mapping`);
      if (response.ok) {
        const data = (await response.json()) as {
          mappings?: Array<{
            journeyId: string;
            matchedTests?: Array<{ testTitle: string; describe?: string; approved?: boolean }>;
          }>;
        };
        for (const journey of data.mappings ?? []) {
          for (const t of journey.matchedTests ?? []) {
            if (t.approved && t.testTitle) {
              const leafKey = t.testTitle.trim().toLowerCase();
              this.semanticMapping.set(leafKey, journey.journeyId);
              if (t.describe) {
                const compoundKey = `${t.describe.trim()} ${t.testTitle.trim()}`.toLowerCase();
                this.semanticMapping.set(compoundKey, journey.journeyId);
              }
            }
          }
        }
      }
    } catch {
      // Mapping unavailable; semantic fallback disabled for this run.
    }
  }

  private stepPayload(mapping: Mapping, step: StepLike, stepIndex: number) {
    return {
      testId: mapping.testId,
      attemptId: mapping.attemptId,
      stepTitle: step.title,
      stepIndex,
      source: step.category === "test.step" ? "explicit" : "auto",
    };
  }

  private fullTitle(test: TestCaseLike) {
    return test.titlePath ? test.titlePath().join(" ") : test.title;
  }

  private testKey(test: TestCaseLike) {
    return test.id ?? this.fullTitle(test);
  }

  private envManifestNodeIds(value: string | undefined) {
    if (!value) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) {
        return undefined;
      }
      const ids = parsed.filter((item): item is string => typeof item === "string");
      return new Set(ids);
    } catch {
      this.stderr("[pathlight] PATHLIGHT_MANIFEST_NODE_IDS could not be parsed.");
      return undefined;
    }
  }

  private isMeaningfulGrep(grep: unknown) {
    if (!grep) {
      return false;
    }
    const value = String(grep);
    return value !== "/.*/" && value !== "";
  }

  // Synchronously extends postChain so callers (Playwright hooks) don't need to await.
  private enqueue(type: string, payload: object): void {
    if (!this.runId) return;
    this.postChain = this.postChain.then(() => this.deliverPost(type, payload));
  }

  private async deliverPost(type: string, payload: object): Promise<void> {
    const event = {
      eventId: `evt_${String(++this.eventNumber).padStart(4, "0")}`,
      runId: this.runId,
      type,
      timestamp: new Date().toISOString(),
      payload,
    };
    try {
      const response = await this.send(`${this.serverUrl}/api/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(event),
      });
      if (!response.ok) {
        this.droppedEventCount += 1;
      } else {
        this.deliveredCount += 1;
      }
    } catch {
      this.droppedEventCount += 1;
    }
  }

  private warnMissingId() {
    if (!this.warnedMissingRunId) {
      this.stderr("[pathlight] PATHLIGHT_RUN_ID is not set; reporter events disabled.");
      this.warnedMissingRunId = true;
    }
  }
}
