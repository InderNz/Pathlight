import { ChangeEvent, FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { apiFetch } from "../../api";

interface ConfigResponse {
  configured: boolean;
  configPath: string;
  config: {
    project: {
      name: string;
      key: string;
    };
    server: {
      host: string;
      port: number;
    };
    projectRoot?: string;
    playwrightConfigPath?: string;
    testDir?: string;
    logoPath?: string;
  } | null;
}

interface SavedResponse extends Omit<ConfigResponse, "configured"> {
  saved: boolean;
}

interface FormErrors {
  projectName?: string;
  projectKey?: string;
  projectRoot?: string;
}

interface JiraStatus {
  status: "not_connected" | "connected" | "expired";
  cloudId?: string;
  message?: string;
  mockEnabled: boolean;
}

interface JourneyValidation {
  journeyCount: number;
  stages: Record<string, number>;
  priorities: Record<string, number>;
}

interface ManifestState {
  schemaVersion: string;
  projectKey: string;
  lockedAt?: string | null;
  lockedBy?: string | null;
  nodes: unknown[];
}

interface JiraStory {
  key: string;
  summary: string;
  description: string | null;
  status: string;
  epic: string | null;
  excluded: boolean;
}

interface StoriesCache {
  fetchedAt: string | null;
  jiraProjectKey: string | null;
  stories: JiraStory[];
}

interface ScanResult {
  scannedAt: string | null;
  testDir: string | null;
  specFileCount: number;
  testCaseCount: number;
  folderGroups: Record<string, number>;
  topDescribeBlocks: string[];
  excludedFolders: string[];
}

interface MappingResult {
  derivedAt: string | null;
  mappedCount: number;
  unmappedCount: number;
  totalJourneys: number;
}

type Section = "project" | "integrations" | "journeys" | "notifications" | "advanced";

function ConfigSidebar({
  active,
  onSelect,
  jiraConnected,
  aiConfigured,
  manifestDot,
  hasNotifications,
}: {
  active: Section;
  onSelect: (s: Section) => void;
  jiraConnected: boolean;
  aiConfigured: boolean;
  manifestDot: "green" | "amber" | "grey";
  hasNotifications: boolean;
}) {
  return (
    <nav className="config-sidebar" aria-label="Configuration sections">
      <ul className="config-sidebar-nav">
        <li>
          <button
            type="button"
            className={`config-sidebar-item${active === "project" ? " active" : ""}`}
            onClick={() => onSelect("project")}
          >
            <svg
              className="config-sidebar-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <rect x="1.5" y="5.5" width="13" height="9" rx="1.5" />
              <path
                d="M5.5 5.5V4A1.5 1.5 0 0 1 7 2.5h2A1.5 1.5 0 0 1 10.5 4v1.5"
                strokeLinecap="round"
              />
            </svg>
            <span className="config-sidebar-label">Project</span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`config-sidebar-item${active === "integrations" ? " active" : ""}`}
            onClick={() => onSelect("integrations")}
          >
            <svg
              className="config-sidebar-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path d="M2 8h3M11 8h3" strokeLinecap="round" />
              <rect x="5" y="5.5" width="6" height="5" rx="1" />
            </svg>
            <span className="config-sidebar-label">Integrations</span>
            <span className="config-nav-dots" aria-hidden="true">
              <span
                className={`config-nav-dot config-nav-dot-${jiraConnected ? "green" : "grey"}`}
              />
              <span
                className={`config-nav-dot config-nav-dot-${aiConfigured ? "green" : "grey"}`}
              />
            </span>
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`config-sidebar-item${active === "journeys" ? " active" : ""}`}
            onClick={() => onSelect("journeys")}
          >
            <svg
              className="config-sidebar-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <circle cx="3" cy="12.5" r="1.5" />
              <circle cx="13" cy="3.5" r="1.5" />
              <path d="M4.5 11.5C6 9.5 10 6.5 11.5 4.5" strokeLinecap="round" />
            </svg>
            <span className="config-sidebar-label">Journeys</span>
            <span className={`config-nav-dot config-nav-dot-${manifestDot}`} aria-hidden="true" />
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`config-sidebar-item${active === "notifications" ? " active" : ""}`}
            onClick={() => onSelect("notifications")}
          >
            <svg
              className="config-sidebar-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <path
                d="M8 2a4.5 4.5 0 0 0-4.5 4.5V9L2 11h12l-1.5-2V6.5A4.5 4.5 0 0 0 8 2z"
                strokeLinejoin="round"
              />
              <path d="M6.5 11a1.5 1.5 0 0 0 3 0" />
            </svg>
            <span className="config-sidebar-label">Notifications</span>
            <span
              className={`config-nav-dot config-nav-dot-${hasNotifications ? "green" : "grey"}`}
              aria-hidden="true"
            />
          </button>
        </li>
        <li>
          <button
            type="button"
            className={`config-sidebar-item${active === "advanced" ? " active" : ""}`}
            onClick={() => onSelect("advanced")}
          >
            <svg
              className="config-sidebar-icon"
              width="16"
              height="16"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden="true"
            >
              <line x1="2" y1="5" x2="14" y2="5" strokeLinecap="round" />
              <line x1="2" y1="11" x2="14" y2="11" strokeLinecap="round" />
              <circle cx="6" cy="5" r="1.5" fill="white" />
              <circle cx="10" cy="11" r="1.5" fill="white" />
            </svg>
            <span className="config-sidebar-label">Advanced</span>
          </button>
        </li>
      </ul>
    </nav>
  );
}

const PROJECT_KEY_ERROR =
  "Project Key must contain only uppercase letters and numbers, up to 10 characters.";

function validate(projectName: string, projectKey: string, projectRoot: string) {
  const errors: FormErrors = {};

  if (!projectName.trim()) {
    errors.projectName = "Project Name is required.";
  }
  if (!projectKey.trim()) {
    errors.projectKey = "Project Key is required.";
  } else if (!/^[A-Z0-9]{1,10}$/.test(projectKey.trim())) {
    errors.projectKey = PROJECT_KEY_ERROR;
  }
  if (!projectRoot.trim()) {
    errors.projectRoot = "Project root is required.";
  }

  return errors;
}

export function ConfigPage() {
  const [projectName, setProjectName] = useState("");
  const [projectKey, setProjectKey] = useState("");
  const [projectRoot, setProjectRoot] = useState("");
  const [playwrightConfigPath, setPlaywrightConfigPath] = useState("playwright.config.ts");
  const [server, setServer] = useState({ host: "127.0.0.1", port: 4242 });
  const [configured, setConfigured] = useState(false);
  const [errors, setErrors] = useState<FormErrors>({});
  const [status, setStatus] = useState("");
  const [savedPath, setSavedPath] = useState("");
  const [locationMessage, setLocationMessage] = useState("");
  const [loadError, setLoadError] = useState("");
  const [logoPath, setLogoPath] = useState("");
  const [logoMessage, setLogoMessage] = useState("");
  const [jiraStatus, setJiraStatus] = useState<JiraStatus>({
    status: "not_connected",
    mockEnabled: false,
  });
  const [jiraMessage, setJiraMessage] = useState("");
  const [journeyFile, setJourneyFile] = useState<File>();
  const [journeyValidation, setJourneyValidation] = useState<JourneyValidation>();
  const [journeyErrors, setJourneyErrors] = useState<string[]>([]);
  const [journeyMessage, setJourneyMessage] = useState("");
  const [manifest, setManifest] = useState<ManifestState>();
  const [jiraProjectKey, setJiraProjectKey] = useState("");
  const [storiesCache, setStoriesCache] = useState<StoriesCache>({
    fetchedAt: null,
    jiraProjectKey: null,
    stories: [],
  });
  const [storiesFetching, setStoriesFetching] = useState(false);
  const [storiesMessage, setStoriesMessage] = useState("");
  const [epicFilter, setEpicFilter] = useState("");
  const [deriving, setDeriving] = useState(false);
  const [deriveMessage, setDeriveMessage] = useState("");
  const [testDir, setTestDir] = useState("");
  const [scanResult, setScanResult] = useState<ScanResult>({
    scannedAt: null,
    testDir: null,
    specFileCount: 0,
    testCaseCount: 0,
    folderGroups: {},
    topDescribeBlocks: [],
    excludedFolders: [],
  });
  const [excludedFoldersDraft, setExcludedFoldersDraft] = useState<string[]>([]);
  const [excludeInput, setExcludeInput] = useState("");
  const [scanning, setScanning] = useState(false);
  const [scanMessage, setScanMessage] = useState("");
  const [mappingResult, setMappingResult] = useState<MappingResult>({
    derivedAt: null,
    mappedCount: 0,
    unmappedCount: 0,
    totalJourneys: 0,
  });
  const [derivingMapping, setDerivingMapping] = useState(false);
  const [mappingMessage, setMappingMessage] = useState("");
  const [aiProvider, setAiProvider] = useState<"claude" | "openai" | "gemini" | "ollama">("claude");
  const [aiModel, setAiModel] = useState("");
  const [ollamaUrl, setOllamaUrl] = useState("http://localhost:11434");
  const [aiApiKey, setAiApiKey] = useState("");
  const [hasExistingApiKey, setHasExistingApiKey] = useState(false);
  const [aiSaving, setAiSaving] = useState(false);
  const [aiTesting, setAiTesting] = useState(false);
  const [aiMessage, setAiMessage] = useState("");
  const [activeSection, setActiveSection] = useState<Section>("project");
  const [configReady, setConfigReady] = useState(false);
  const [manifestLoadDone, setManifestLoadDone] = useState(false);
  const sectionInitialized = useRef(false);
  const handleSectionSelect = useCallback((s: Section) => {
    sectionInitialized.current = true;
    setActiveSection(s);
  }, []);

  useEffect(() => {
    let ignore = false;
    const jiraResult = new URLSearchParams(window.location.search).get("jira");
    if (jiraResult === "csrf") {
      setJiraMessage(
        "JIRA connection could not be completed because the security check failed. Try again.",
      );
    } else if (jiraResult === "denied") {
      setJiraMessage("JIRA authorization was denied. Try again when you are ready.");
    } else if (jiraResult === "error") {
      setJiraMessage("JIRA connection failed. Try again.");
    }

    async function loadConfig() {
      try {
        const response = await apiFetch("/api/config");
        const result = (await response.json()) as ConfigResponse | { error: string };
        if (!response.ok) {
          throw new Error("error" in result ? result.error : "Unable to load configuration.");
        }
        if (ignore || !("configured" in result)) {
          return;
        }
        if (result.config) {
          setProjectName(result.config.project.name);
          setProjectKey(result.config.project.key);
          setProjectRoot(result.config.projectRoot ?? "");
          setPlaywrightConfigPath(result.config.playwrightConfigPath ?? "playwright.config.ts");
          setTestDir(result.config.testDir ?? "");
          setServer(result.config.server);
          setLogoPath(result.config.logoPath ?? "");
        }
        setConfigured(result.configured);
        setConfigReady(true);
      } catch (error) {
        if (!ignore) {
          setLoadError(error instanceof Error ? error.message : "Unable to load configuration.");
          setConfigReady(true);
        }
      }
    }

    async function loadJiraStatus() {
      try {
        const response = await apiFetch("/api/jira/status");
        if (response.ok && !ignore) {
          setJiraStatus((await response.json()) as JiraStatus);
        }
      } catch {
        // The project form remains usable while an optional integration is unavailable.
      }
    }

    async function loadStories() {
      try {
        const response = await apiFetch("/api/jira/stories");
        if (response.ok && !ignore) {
          const data = (await response.json()) as StoriesCache;
          setStoriesCache(data);
          if (data.jiraProjectKey) setJiraProjectKey(data.jiraProjectKey);
        }
      } catch {
        // Stories are optional; cache load failure is non-fatal.
      }
    }

    async function loadScan() {
      try {
        const response = await apiFetch("/api/tests/scan");
        if (response.ok && !ignore) {
          const result = (await response.json()) as ScanResult;
          setScanResult(result);
          setExcludedFoldersDraft(result.excludedFolders);
        }
      } catch {
        // Scan cache is optional.
      }
    }

    async function loadMapping() {
      try {
        const response = await apiFetch("/api/mapping");
        if (response.ok && !ignore) {
          const result = (await response.json()) as MappingResult;
          setMappingResult(result);
        }
      } catch {
        // Mapping cache is optional.
      }
    }

    async function loadAiConfig() {
      try {
        const response = await apiFetch("/api/ai/config");
        if (response.ok && !ignore) {
          const data = (await response.json()) as {
            provider?: "claude" | "openai" | "gemini" | "ollama";
            model?: string;
            ollamaUrl?: string;
            hasApiKey?: boolean;
          };
          if (data.provider) setAiProvider(data.provider);
          if (data.model) setAiModel(data.model);
          if (data.ollamaUrl) setOllamaUrl(data.ollamaUrl);
          setHasExistingApiKey(data.hasApiKey ?? false);
        }
      } catch {
        // AI config is optional.
      }
    }

    void loadConfig();
    void loadJiraStatus();
    void loadStories();
    void loadScan();
    void loadMapping();
    void loadAiConfig();
    return () => {
      ignore = true;
    };
  }, []);

  useEffect(() => {
    if (!configured) {
      return;
    }
    let ignore = false;
    async function loadManifest() {
      const response = await apiFetch("/api/manifest");
      if (response.ok && !ignore) {
        setManifest((await response.json()) as ManifestState);
      }
      if (!ignore) setManifestLoadDone(true);
    }
    void loadManifest();
    return () => {
      ignore = true;
    };
  }, [configured]);

  useEffect(() => {
    if (sectionInitialized.current) return;
    if (!configReady) return;
    if (configured && !manifestLoadDone) return;

    sectionInitialized.current = true;
    const jiraParam = new URLSearchParams(window.location.search).get("jira");
    if (jiraParam) {
      setActiveSection("integrations");
      return;
    }
    if (!manifest?.lockedAt) {
      setActiveSection("journeys");
    } else if (jiraStatus.status !== "connected") {
      setActiveSection("integrations");
    }
    // else stays "project"
  }, [configReady, configured, manifestLoadDone, manifest, jiraStatus.status]);

  async function persist(confirmOverwrite = false) {
    return apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        projectName,
        projectKey,
        projectRoot,
        playwrightConfigPath,
        confirmOverwrite,
      }),
    });
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setStatus("");
    setSavedPath("");
    const nextErrors = validate(projectName, projectKey, projectRoot);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length > 0) {
      return;
    }

    try {
      let response = await persist();
      if (response.status === 409) {
        if (!window.confirm("A configuration already exists. Overwrite it?")) {
          return;
        }
        response = await persist(true);
      }

      const result = (await response.json()) as
        | SavedResponse
        | { error?: string; errors?: string[] };
      if (!response.ok) {
        const message =
          "error" in result && result.error
            ? result.error
            : "errors" in result && result.errors?.[0]
              ? result.errors[0]
              : "Unable to save configuration.";
        setStatus(message);
        return;
      }

      if ("config" in result && result.config) {
        setConfigured(true);
        setServer(result.config.server);
        setProjectRoot(result.config.projectRoot ?? "");
        setPlaywrightConfigPath(result.config.playwrightConfigPath ?? "playwright.config.ts");
        setStatus("Configuration saved");
        setSavedPath(result.configPath);
      }
    } catch (error) {
      setStatus(error instanceof Error ? error.message : "Unable to save configuration.");
    }
  }

  async function validateProjectRoot() {
    setLocationMessage("");
    if (!projectRoot.trim()) {
      setErrors((current) => ({ ...current, projectRoot: "Project root is required." }));
      return;
    }
    const response = await apiFetch("/api/config/validate-project-root", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot }),
    });
    const result = (await response.json()) as { valid?: boolean; error?: string };
    setErrors((current) => ({
      ...current,
      projectRoot: response.ok
        ? undefined
        : (result.error ?? "Directory not found. Check the path and try again."),
    }));
  }

  async function verifyConnection() {
    setLocationMessage("");
    if (!projectRoot.trim()) {
      setErrors((current) => ({ ...current, projectRoot: "Project root is required." }));
      return;
    }
    const response = await apiFetch("/api/config/verify-playwright", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ projectRoot, playwrightConfigPath }),
    });
    const result = (await response.json()) as { message?: string; error?: string };
    setLocationMessage(result.message ?? result.error ?? "Unable to verify Playwright.");
  }

  async function uploadLogo(file: File | undefined) {
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append("logo", file);
    const response = await apiFetch("/api/logo", { method: "POST", body });
    const result = (await response.json()) as { logoPath?: string; error?: string };
    if (!response.ok || !result.logoPath) {
      setLogoMessage(result.error ?? "Unable to upload logo.");
      return;
    }
    setLogoMessage("Logo uploaded");
    setLogoPath(result.logoPath);
  }

  async function handleLogoUpload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const input = event.currentTarget.elements.namedItem("logo") as HTMLInputElement;
    await uploadLogo(input.files?.[0]);
  }

  async function handleLogoChange(event: ChangeEvent<HTMLInputElement>) {
    await uploadLogo(event.target.files?.[0]);
  }

  async function handleJiraMockChange(event: ChangeEvent<HTMLInputElement>) {
    const enabled = event.target.checked;
    const previous = jiraStatus.mockEnabled;
    setJiraStatus((current) => ({ ...current, mockEnabled: enabled }));
    const response = await apiFetch("/api/jira/mock", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ enabled }),
    });
    if (!response.ok) {
      setJiraStatus((current) => ({ ...current, mockEnabled: previous }));
      setJiraMessage("Unable to update JIRA mock setting.");
    }
  }

  async function connectJira() {
    const response = await apiFetch("/api/jira/connect", { method: "POST" });
    const result = (await response.json()) as { authorizationUrl?: string; error?: string };
    if (response.ok && result.authorizationUrl) {
      window.location.assign(result.authorizationUrl);
      return;
    }
    setJiraMessage(result.error ?? "Unable to connect to JIRA.");
  }

  async function disconnectJira() {
    const response = await apiFetch("/api/jira/connection", { method: "DELETE" });
    if (response.ok) {
      setJiraStatus({ status: "not_connected", mockEnabled: jiraStatus.mockEnabled });
    }
  }

  async function validateJourneys(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    setJourneyFile(file);
    setJourneyValidation(undefined);
    setJourneyErrors([]);
    setJourneyMessage("");
    if (!file) {
      return;
    }
    const body = new FormData();
    body.append("journeys", file);
    const response = await apiFetch("/api/journeys/validate", { method: "POST", body });
    const result = (await response.json()) as JourneyValidation & {
      valid?: boolean;
      errors?: string[];
    };
    if (!response.ok) {
      setJourneyErrors(result.errors ?? ["Unable to validate journey CSV."]);
      return;
    }
    setJourneyValidation(result);
  }

  async function importJourneys() {
    if (!journeyFile) {
      return;
    }
    const body = new FormData();
    body.append("journeys", journeyFile);
    const response = await apiFetch("/api/journeys/import", { method: "POST", body });
    const result = (await response.json()) as {
      message?: string;
      manifest?: ManifestState;
      error?: string;
      errors?: string[];
    };
    if (!response.ok) {
      setJourneyErrors(result.errors ?? [result.error ?? "Unable to import journeys."]);
      return;
    }
    setJourneyMessage(result.message ?? "");
    setManifest(result.manifest);
  }

  async function lockManifest() {
    if (!manifest) {
      return;
    }
    const response = await apiFetch("/api/manifest/lock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ manifest, currentLockedAt: manifest.lockedAt ?? undefined }),
    });
    const result = (await response.json()) as {
      lockedAt?: string;
      lockedBy?: string;
      error?: string;
      currentLockedAt?: string;
      errors?: string[];
    };
    if (!response.ok) {
      setJourneyErrors(
        result.errors ?? [
          result.error === "MANIFEST_LOCK_CONFLICT"
            ? `Manifest lock conflict. Current lock is ${result.currentLockedAt}.`
            : (result.error ?? "Unable to lock manifest."),
        ],
      );
      return;
    }
    setManifest({ ...manifest, lockedAt: result.lockedAt, lockedBy: result.lockedBy });
  }

  async function unlockManifest() {
    if (!window.confirm("Unlock this manifest and allow journey re-import?")) {
      return;
    }
    const response = await apiFetch("/api/manifest/unlock", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ confirm: true }),
    });
    if (response.ok) {
      setManifest((current) =>
        current ? { ...current, lockedAt: null, lockedBy: null } : current,
      );
      setJourneyMessage("Manifest unlocked. Upload a CSV to re-import journeys.");
    }
  }

  async function fetchStories() {
    if (!jiraProjectKey.trim()) {
      setStoriesMessage("Enter the JIRA project key first.");
      return;
    }
    setStoriesFetching(true);
    setStoriesMessage("");
    try {
      const response = await apiFetch("/api/jira/fetch-stories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jiraProjectKey: jiraProjectKey.trim() }),
      });
      const result = (await response.json()) as {
        storyCount?: number;
        fetchedAt?: string;
        error?: string;
      };
      if (!response.ok) {
        setStoriesMessage(result.error ?? "Unable to fetch stories.");
        return;
      }
      setStoriesMessage(`${result.storyCount ?? 0} stories fetched.`);
      const storiesResponse = await apiFetch("/api/jira/stories");
      if (storiesResponse.ok) {
        setStoriesCache((await storiesResponse.json()) as StoriesCache);
      }
    } finally {
      setStoriesFetching(false);
    }
  }

  async function toggleStoryExclusion(key: string, excluded: boolean) {
    await apiFetch(`/api/jira/stories/${key}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ excluded }),
    });
    setStoriesCache((current) => ({
      ...current,
      stories: current.stories.map((s) => (s.key === key ? { ...s, excluded } : s)),
    }));
  }

  async function deriveJourneys() {
    setDeriving(true);
    setDeriveMessage("");
    try {
      const response = await apiFetch("/api/journeys/derive", { method: "POST" });
      const result = (await response.json()) as {
        journeyCount?: number;
        createdAt?: string;
        error?: string;
      };
      if (!response.ok) {
        setDeriveMessage(result.error ?? "Derivation failed.");
        return;
      }
      setDeriveMessage(
        `${result.journeyCount ?? 0} journeys derived. Review them on the Journeys page.`,
      );
    } finally {
      setDeriving(false);
    }
  }

  async function scanTestSuite() {
    if (!testDir.trim()) {
      setScanMessage("Enter the test directory first.");
      return;
    }
    setScanning(true);
    setScanMessage("");
    try {
      const response = await apiFetch("/api/tests/scan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ testDir: testDir.trim(), excludedFolders: excludedFoldersDraft }),
      });
      const result = (await response.json()) as ScanResult & { error?: string };
      if (!response.ok) {
        setScanMessage(result.error ?? "Scan failed.");
        return;
      }
      setScanResult(result);
      setExcludedFoldersDraft(result.excludedFolders);
      setScanMessage(
        `Found ${result.specFileCount} spec files, ${result.testCaseCount} test cases.`,
      );
    } finally {
      setScanning(false);
    }
  }

  async function deriveMapping() {
    setDerivingMapping(true);
    setMappingMessage("");
    try {
      const response = await apiFetch("/api/mapping/derive", { method: "POST" });
      const result = (await response.json()) as MappingResult & { error?: string };
      if (!response.ok) {
        setMappingMessage(result.error ?? "Mapping failed.");
        return;
      }
      setMappingResult(result);
      setMappingMessage(
        `Mapped ${result.mappedCount} of ${result.totalJourneys} journeys. ${result.unmappedCount} gaps found.`,
      );
    } finally {
      setDerivingMapping(false);
    }
  }

  async function saveAiConfig() {
    setAiSaving(true);
    setAiMessage("");
    try {
      const body: Record<string, string> = { provider: aiProvider };
      if (aiModel.trim()) body.model = aiModel.trim();
      if (aiProvider === "ollama" && ollamaUrl.trim()) body.ollamaUrl = ollamaUrl.trim();
      if (aiApiKey.trim()) body.apiKey = aiApiKey.trim();
      const response = await apiFetch("/api/ai/config", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as { saved?: boolean; error?: string };
      if (!response.ok) {
        setAiMessage(result.error ?? "Unable to save AI config.");
        return;
      }
      if (aiApiKey.trim()) setHasExistingApiKey(true);
      setAiApiKey("");
      setAiMessage("AI provider saved.");
    } finally {
      setAiSaving(false);
    }
  }

  async function testAiConnection() {
    setAiTesting(true);
    setAiMessage("");
    try {
      const body: Record<string, string> = { provider: aiProvider };
      if (aiModel.trim()) body.model = aiModel.trim();
      if (aiProvider === "ollama") body.ollamaUrl = ollamaUrl.trim() || "http://localhost:11434";
      if (aiApiKey.trim()) body.apiKey = aiApiKey.trim();
      const response = await apiFetch("/api/ai/test-connection", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const result = (await response.json()) as {
        connected?: boolean;
        model?: string;
        error?: string;
      };
      setAiMessage(
        response.ok && result.connected
          ? `Provider connected · Model: ${result.model}`
          : (result.error ?? "Connection failed."),
      );
    } finally {
      setAiTesting(false);
    }
  }

  const fishboneAvailable = configured && Boolean(manifest?.lockedAt);
  const manifestDot: "green" | "amber" | "grey" = manifest?.lockedAt
    ? "green"
    : manifest
      ? "amber"
      : "grey";

  return (
    <div className="page-shell">
      <header className="top-bar">
        <a className="wordmark" href="/config">
          Pathlight
        </a>
        <nav aria-label="Main navigation">
          {fishboneAvailable ? (
            <a className="nav-link" href="/">
              Fishbone
            </a>
          ) : (
            <span className="nav-link nav-link-disabled" aria-disabled="true">
              Fishbone
            </span>
          )}
        </nav>
        <div className="server-indicator">
          <span className="status-dot" />
          Local · 127.0.0.1:4242
        </div>
      </header>

      <main className="config-content">
        <h1>Project configuration</h1>
        <p className="introduction">
          Set up the local project before importing journeys or starting runs.
        </p>

        {loadError ? <p className="alert alert-error">{loadError}</p> : null}

        <div className="config-layout">
          <ConfigSidebar
            active={activeSection}
            onSelect={handleSectionSelect}
            jiraConnected={jiraStatus.status === "connected"}
            aiConfigured={hasExistingApiKey}
            manifestDot={manifestDot}
            hasNotifications={false}
          />

          <div className="config-main">
            {activeSection === "project" && (
              <>
                <form className="panel identity-panel" onSubmit={handleSubmit} noValidate>
                  <div className="panel-heading">
                    <h2>Project Identity</h2>
                    {status === "Configuration saved" ? (
                      <p className="saved-status" role="status">
                        <span aria-hidden="true">✓</span> {status}
                      </p>
                    ) : null}
                  </div>

                  <label htmlFor="project-name">Project Name</label>
                  <input
                    id="project-name"
                    value={projectName}
                    onChange={(event) => setProjectName(event.target.value)}
                    aria-invalid={Boolean(errors.projectName)}
                    aria-describedby={errors.projectName ? "project-name-error" : undefined}
                  />
                  {errors.projectName ? (
                    <p className="field-error" id="project-name-error">
                      {errors.projectName}
                    </p>
                  ) : null}

                  <label htmlFor="project-key">Project Key</label>
                  <input
                    id="project-key"
                    value={projectKey}
                    onChange={(event) => setProjectKey(event.target.value)}
                    aria-invalid={Boolean(errors.projectKey)}
                    aria-describedby={errors.projectKey ? "project-key-error" : "project-key-help"}
                  />
                  {errors.projectKey ? (
                    <p className="field-error" id="project-key-error">
                      {errors.projectKey}
                    </p>
                  ) : (
                    <p className="field-help" id="project-key-help">
                      Uppercase letters and numbers, up to 10 characters.
                    </p>
                  )}

                  {status && status !== "Configuration saved" ? (
                    <p className="alert alert-error" role="alert">
                      {status}
                    </p>
                  ) : null}

                  <button className="primary-button" type="submit">
                    Save configuration
                  </button>
                  {savedPath ? (
                    <p className="saved-detail">
                      Saved to <code>{savedPath}</code>
                    </p>
                  ) : null}
                </form>

                <section className="panel settings-panel">
                  <h2>Project Location</h2>
                  <div className="project-location-fields">
                    <label htmlFor="project-root">Project root</label>
                    <input
                      id="project-root"
                      value={projectRoot}
                      onChange={(event) => setProjectRoot(event.target.value)}
                      onBlur={() => void validateProjectRoot()}
                      placeholder="/Users/inder/projects/ZovKu"
                      aria-invalid={Boolean(errors.projectRoot)}
                      aria-describedby={
                        errors.projectRoot ? "project-root-error" : "project-root-help"
                      }
                    />
                    {errors.projectRoot ? (
                      <p className="field-error" id="project-root-error">
                        {errors.projectRoot}
                      </p>
                    ) : (
                      <p className="field-help" id="project-root-help">
                        Absolute path to your project root.
                      </p>
                    )}

                    <label htmlFor="playwright-config-path">Playwright config path</label>
                    <input
                      id="playwright-config-path"
                      value={playwrightConfigPath}
                      onChange={(event) => setPlaywrightConfigPath(event.target.value)}
                      aria-describedby="playwright-config-help"
                    />
                    <p className="field-help" id="playwright-config-help">
                      Relative to the project root. Defaults to playwright.config.ts.
                    </p>
                  </div>
                  <div className="project-location-actions">
                    <button className="secondary-button" type="button" onClick={verifyConnection}>
                      Verify connection
                    </button>
                    {locationMessage ? (
                      <p
                        className={
                          locationMessage.includes("found") ? "saved-status" : "alert alert-error"
                        }
                        role="status"
                      >
                        {locationMessage}
                      </p>
                    ) : null}
                  </div>
                </section>

                <section className="panel integration-panel">
                  <div className="section-heading">
                    <h2>Logo</h2>
                    {logoPath ? (
                      <img className="logo-preview" src="/api/logo" alt="Project logo" />
                    ) : null}
                  </div>
                  <form className="upload-row" onSubmit={handleLogoUpload}>
                    <label className="file-label" htmlFor="logo-upload">
                      Upload project logo
                    </label>
                    <input
                      id="logo-upload"
                      name="logo"
                      type="file"
                      accept=".png,.jpg,.jpeg,image/png,image/jpeg"
                      onChange={handleLogoChange}
                    />
                    <button className="secondary-button" type="submit">
                      Upload logo
                    </button>
                  </form>
                  <p
                    className={
                      logoMessage.includes("Only") || logoMessage.includes("must")
                        ? "field-error"
                        : "field-help"
                    }
                  >
                    {logoMessage || "PNG or JPG only. Maximum file size 2MB."}
                  </p>
                </section>
              </>
            )}

            {activeSection === "integrations" && (
              <>
                <section className="panel integration-panel">
                  <div className="section-heading">
                    <h2>JIRA Connection</h2>
                    {jiraStatus.status === "connected" ? (
                      <span className="connection-status success">
                        Connected · {jiraStatus.cloudId}
                      </span>
                    ) : null}
                  </div>
                  {jiraStatus.status === "expired" ? (
                    <p className="alert alert-error">{jiraStatus.message}</p>
                  ) : jiraStatus.status === "not_connected" ? (
                    <p className="field-help">Not connected</p>
                  ) : null}
                  <div className="action-row">
                    {jiraStatus.status === "connected" ? (
                      <button className="secondary-button" type="button" onClick={disconnectJira}>
                        Disconnect
                      </button>
                    ) : (
                      <button className="secondary-button" type="button" onClick={connectJira}>
                        {jiraStatus.status === "expired" ? "Reconnect" : "Connect JIRA"}
                      </button>
                    )}
                  </div>
                  {jiraMessage ? <p className="alert alert-error">{jiraMessage}</p> : null}
                </section>

                <section className="panel integration-panel">
                  <h2>AI Provider</h2>
                  <div className="project-location-fields">
                    <label htmlFor="ai-provider">Provider</label>
                    <select
                      id="ai-provider"
                      value={aiProvider}
                      onChange={(e) =>
                        setAiProvider(e.target.value as "claude" | "openai" | "gemini" | "ollama")
                      }
                    >
                      <option value="claude">Claude (Anthropic)</option>
                      <option value="openai">OpenAI</option>
                      <option value="gemini">Gemini (Google)</option>
                      <option value="ollama">Ollama (local)</option>
                    </select>

                    {aiProvider === "ollama" ? (
                      <>
                        <label htmlFor="ollama-url">Ollama URL</label>
                        <input
                          id="ollama-url"
                          value={ollamaUrl}
                          onChange={(e) => setOllamaUrl(e.target.value)}
                          placeholder="http://localhost:11434"
                        />
                      </>
                    ) : (
                      <>
                        <label htmlFor="ai-api-key">
                          {aiProvider === "claude"
                            ? "Anthropic API key"
                            : aiProvider === "openai"
                              ? "OpenAI API key"
                              : "Google API key"}
                        </label>
                        <input
                          id="ai-api-key"
                          type="password"
                          value={aiApiKey}
                          onChange={(e) => setAiApiKey(e.target.value)}
                          placeholder={
                            hasExistingApiKey ? "Key saved — enter new key to replace" : "sk-…"
                          }
                        />
                      </>
                    )}

                    <label htmlFor="ai-model">
                      Model name
                      {aiProvider === "claude"
                        ? " (default: claude-sonnet-4-6)"
                        : aiProvider === "openai"
                          ? " (default: gpt-4o)"
                          : aiProvider === "gemini"
                            ? " (default: gemini-1.5-pro)"
                            : " (default: llama3)"}
                    </label>
                    <input
                      id="ai-model"
                      value={aiModel}
                      onChange={(e) => setAiModel(e.target.value)}
                      placeholder={
                        aiProvider === "claude"
                          ? "claude-sonnet-4-6"
                          : aiProvider === "openai"
                            ? "gpt-4o"
                            : aiProvider === "gemini"
                              ? "gemini-1.5-pro"
                              : "llama3"
                      }
                    />
                  </div>
                  <div className="action-row">
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={aiSaving}
                      onClick={() => void saveAiConfig()}
                    >
                      {aiSaving ? "Saving…" : "Save AI config"}
                    </button>
                    <button
                      className="secondary-button"
                      type="button"
                      disabled={aiTesting}
                      onClick={() => void testAiConnection()}
                    >
                      {aiTesting ? "Testing…" : "Test connection"}
                    </button>
                  </div>
                  {aiMessage ? (
                    <p
                      className={
                        aiMessage.includes("connected") || aiMessage.includes("saved")
                          ? "saved-status"
                          : "alert alert-error"
                      }
                      role="status"
                    >
                      {aiMessage}
                    </p>
                  ) : null}
                  {aiProvider === "ollama" ? (
                    <p className="field-help">
                      Local models may produce lower quality derivations than cloud providers.
                      Review outputs carefully.
                    </p>
                  ) : null}
                </section>
              </>
            )}

            {activeSection === "journeys" && (
              <>
                <section className="panel journey-panel">
                  <div className="section-heading">
                    <h2>Journey Import</h2>
                    {configured ? (
                      <a
                        className="secondary-button button-link"
                        href="/api/journeys/template"
                        download
                      >
                        Download template
                      </a>
                    ) : null}
                  </div>
                  {!configured ? (
                    <p className="field-help">
                      Import becomes available after configuration is saved.
                    </p>
                  ) : (
                    <>
                      <label className="file-label" htmlFor="journey-upload">
                        Upload journey CSV
                      </label>
                      <input
                        id="journey-upload"
                        type="file"
                        accept=".csv,text/csv"
                        onChange={validateJourneys}
                      />
                      {journeyErrors.length > 0 ? (
                        <ol className="validation-errors">
                          {journeyErrors.map((error) => (
                            <li className="field-error" key={error}>
                              {error}
                            </li>
                          ))}
                        </ol>
                      ) : null}
                      {journeyValidation ? (
                        <div className="validation-summary">
                          <p>{journeyValidation.journeyCount} journeys validated</p>
                          <p>
                            Stages:{" "}
                            {Object.entries(journeyValidation.stages).map(([stage, count]) => (
                              <span key={stage}>
                                {stage}: {count}
                              </span>
                            ))}
                          </p>
                          <p>
                            Priorities:{" "}
                            {Object.entries(journeyValidation.priorities).map(
                              ([priority, count]) => (
                                <span key={priority}>
                                  {priority}: {count}
                                </span>
                              ),
                            )}
                          </p>
                          {!manifest?.lockedAt ? (
                            <button
                              className="secondary-button"
                              type="button"
                              onClick={importJourneys}
                            >
                              Import journeys
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                      {journeyMessage ? <p className="saved-status">{journeyMessage}</p> : null}
                      {manifest && !manifest.lockedAt ? (
                        <button className="primary-button" type="button" onClick={lockManifest}>
                          Lock manifest
                        </button>
                      ) : null}
                      {manifest?.lockedAt ? (
                        <div className="locked-state">
                          <p className="saved-status">Locked at {manifest.lockedAt}</p>
                          <button
                            className="secondary-button"
                            type="button"
                            onClick={unlockManifest}
                          >
                            Unlock and re-import
                          </button>
                        </div>
                      ) : null}
                    </>
                  )}
                </section>

                {configured ? (
                  <section className="panel journey-intelligence-panel">
                    <h2>Journey Intelligence</h2>
                    {jiraStatus.status !== "connected" && !jiraStatus.mockEnabled ? (
                      <p className="field-help">
                        Connect JIRA (or enable the mock) to fetch stories.
                      </p>
                    ) : (
                      <>
                        <div className="project-location-fields">
                          <label htmlFor="jira-project-key">JIRA project key</label>
                          <input
                            id="jira-project-key"
                            value={jiraProjectKey}
                            onChange={(event) =>
                              setJiraProjectKey(event.target.value.toUpperCase())
                            }
                            placeholder="e.g. ZOV"
                            aria-describedby="jira-project-key-help"
                          />
                          <p className="field-help" id="jira-project-key-help">
                            The JIRA project key to fetch Story-type issues from.
                          </p>
                        </div>
                        <div className="action-row">
                          <button
                            className="secondary-button"
                            type="button"
                            disabled={storiesFetching}
                            onClick={() => void fetchStories()}
                          >
                            {storiesFetching
                              ? "Fetching…"
                              : storiesCache.fetchedAt
                                ? "Refetch stories"
                                : "Fetch stories"}
                          </button>
                          {storiesCache.fetchedAt ? (
                            <span className="field-help">
                              {storiesCache.stories.length} stories · fetched{" "}
                              {new Date(storiesCache.fetchedAt).toLocaleString()}
                            </span>
                          ) : null}
                        </div>
                        {storiesMessage ? (
                          <p
                            className={
                              storiesMessage.includes("Unable") || storiesMessage.includes("Enter")
                                ? "alert alert-error"
                                : "saved-status"
                            }
                            role="status"
                          >
                            {storiesMessage}
                          </p>
                        ) : null}

                        {storiesCache.stories.length > 0 ? (
                          <>
                            <div className="action-row" style={{ marginTop: 12 }}>
                              <label htmlFor="epic-filter" style={{ fontSize: 13 }}>
                                Filter by epic:
                              </label>
                              <select
                                id="epic-filter"
                                value={epicFilter}
                                onChange={(e) => setEpicFilter(e.target.value)}
                                style={{ fontSize: 13, padding: "2px 6px" }}
                              >
                                <option value="">All epics</option>
                                {[
                                  ...new Set(
                                    storiesCache.stories
                                      .map((s) => s.epic ?? "No epic")
                                      .filter(Boolean),
                                  ),
                                ].map((epic) => (
                                  <option key={epic} value={epic}>
                                    {epic}
                                  </option>
                                ))}
                              </select>
                            </div>
                            <ul className="story-list">
                              {storiesCache.stories
                                .filter((s) => !epicFilter || (s.epic ?? "No epic") === epicFilter)
                                .map((story) => (
                                  <li
                                    key={story.key}
                                    className={`story-item${story.excluded ? " excluded" : ""}`}
                                  >
                                    <label className="checkbox-label">
                                      <input
                                        type="checkbox"
                                        checked={!story.excluded}
                                        onChange={(e) =>
                                          void toggleStoryExclusion(story.key, !e.target.checked)
                                        }
                                      />
                                      <span className="story-key">{story.key}</span>
                                      <span className="story-summary">{story.summary}</span>
                                    </label>
                                    {story.epic ? (
                                      <span className="story-epic">{story.epic}</span>
                                    ) : null}
                                    <span className="story-status">{story.status}</span>
                                  </li>
                                ))}
                            </ul>
                            <div className="action-row" style={{ marginTop: 12 }}>
                              <button
                                className="primary-button"
                                type="button"
                                disabled={deriving || storiesCache.stories.every((s) => s.excluded)}
                                onClick={() => void deriveJourneys()}
                              >
                                {deriving ? "Deriving journeys…" : "Derive journeys with Claude"}
                              </button>
                            </div>
                            {deriveMessage ? (
                              <p
                                className={
                                  deriveMessage.includes("failed") ||
                                  deriveMessage.includes("Failed")
                                    ? "alert alert-error"
                                    : "saved-status"
                                }
                                role="status"
                              >
                                {deriveMessage}
                              </p>
                            ) : null}
                          </>
                        ) : null}
                      </>
                    )}
                  </section>
                ) : null}

                {configured ? (
                  <section className="panel test-suite-panel">
                    <h2>Test Suite</h2>
                    <div className="project-location-fields">
                      <label htmlFor="test-dir">Test directory</label>
                      <input
                        id="test-dir"
                        value={testDir}
                        onChange={(e) => setTestDir(e.target.value)}
                        placeholder="e.g. tests/e2e"
                        aria-describedby="test-dir-help"
                      />
                      <p className="field-help" id="test-dir-help">
                        Path to your spec files, relative to the project root.
                      </p>
                    </div>
                    <div className="action-row">
                      <button
                        className="secondary-button"
                        type="button"
                        disabled={scanning}
                        onClick={() => void scanTestSuite()}
                      >
                        {scanning
                          ? "Scanning…"
                          : scanResult.scannedAt
                            ? "Re-scan"
                            : "Scan test suite"}
                      </button>
                      {scanResult.scannedAt ? (
                        <span className="field-help">
                          {scanResult.specFileCount} files · {scanResult.testCaseCount} tests ·
                          scanned {new Date(scanResult.scannedAt).toLocaleString()}
                        </span>
                      ) : null}
                    </div>
                    {scanMessage ? (
                      <p
                        className={
                          scanMessage.includes("failed") ||
                          scanMessage.includes("Enter") ||
                          scanMessage.includes("not found")
                            ? "alert alert-error"
                            : "saved-status"
                        }
                        role="status"
                      >
                        {scanMessage}
                      </p>
                    ) : null}
                    {scanResult.scannedAt ? (
                      <>
                        {Object.keys(scanResult.folderGroups).length > 0 ? (
                          <div className="scan-summary">
                            <p className="scan-summary-label">Folder breakdown</p>
                            <ul className="folder-tree">
                              {Object.entries(scanResult.folderGroups)
                                .sort(([a], [b]) => a.localeCompare(b))
                                .map(([folder, count]) => (
                                  <li key={folder}>
                                    <span className="folder-name">{folder}</span>
                                    <span className="folder-count">{count} tests</span>
                                  </li>
                                ))}
                            </ul>
                          </div>
                        ) : null}
                        {scanResult.topDescribeBlocks.length > 0 ? (
                          <div className="scan-summary">
                            <p className="scan-summary-label">
                              Top-level describe blocks ({scanResult.topDescribeBlocks.length})
                            </p>
                            <ul className="describe-list">
                              {scanResult.topDescribeBlocks.slice(0, 10).map((block) => (
                                <li key={block}>{block}</li>
                              ))}
                              {scanResult.topDescribeBlocks.length > 10 ? (
                                <li className="field-help">
                                  …and {scanResult.topDescribeBlocks.length - 10} more
                                </li>
                              ) : null}
                            </ul>
                          </div>
                        ) : null}
                        <div className="scan-summary">
                          <p className="scan-summary-label">Excluded folders</p>
                          <ul className="excluded-list">
                            {excludedFoldersDraft.map((folder) => (
                              <li key={folder}>
                                <span>{folder}</span>
                                <button
                                  type="button"
                                  className="remove-button"
                                  onClick={() =>
                                    setExcludedFoldersDraft((prev) =>
                                      prev.filter((f) => f !== folder),
                                    )
                                  }
                                  aria-label={`Remove ${folder} from exclusions`}
                                >
                                  ×
                                </button>
                              </li>
                            ))}
                          </ul>
                          <div className="exclude-input-row">
                            <input
                              value={excludeInput}
                              onChange={(e) => setExcludeInput(e.target.value)}
                              onKeyDown={(e) => {
                                if (e.key === "Enter" && excludeInput.trim()) {
                                  setExcludedFoldersDraft((prev) => [
                                    ...new Set([...prev, excludeInput.trim()]),
                                  ]);
                                  setExcludeInput("");
                                }
                              }}
                              placeholder="Folder to exclude (press Enter)"
                              aria-label="Add folder to exclude"
                            />
                            <button
                              type="button"
                              className="secondary-button"
                              onClick={() => {
                                if (excludeInput.trim()) {
                                  setExcludedFoldersDraft((prev) => [
                                    ...new Set([...prev, excludeInput.trim()]),
                                  ]);
                                  setExcludeInput("");
                                }
                              }}
                            >
                              Add
                            </button>
                          </div>
                        </div>
                        <div className="action-row">
                          <button
                            type="button"
                            className="primary-button"
                            disabled={derivingMapping}
                            onClick={() => void deriveMapping()}
                          >
                            {derivingMapping
                              ? "Mapping…"
                              : mappingResult.derivedAt
                                ? "Re-map tests"
                                : "Start mapping"}
                          </button>
                          {mappingResult.derivedAt ? (
                            <>
                              <span className="field-help">
                                {mappingResult.mappedCount} of {mappingResult.totalJourneys}{" "}
                                journeys mapped · {mappingResult.unmappedCount} gaps
                              </span>
                              <a href="/mapping-review" className="secondary-button">
                                Review mappings
                              </a>
                            </>
                          ) : null}
                        </div>
                        {mappingMessage ? (
                          <p
                            className={
                              mappingMessage.includes("failed") || mappingMessage.includes("Error")
                                ? "alert alert-error"
                                : "saved-status"
                            }
                            role="status"
                          >
                            {mappingMessage}
                          </p>
                        ) : null}
                      </>
                    ) : null}
                  </section>
                ) : null}
              </>
            )}

            {activeSection === "notifications" && (
              <section className="panel">
                <h2>Notifications</h2>
                <p className="field-help" style={{ marginTop: 12 }}>
                  No webhook notifications are configured.
                </p>
              </section>
            )}

            {activeSection === "advanced" && (
              <>
                <section className="panel settings-panel">
                  <h2>Server Settings</h2>
                  <div className="settings-grid">
                    <label>
                      Host
                      <input readOnly value={server.host} />
                    </label>
                    <label>
                      Port
                      <input readOnly value={server.port} />
                    </label>
                  </div>
                </section>

                <section className="panel">
                  <h2>Feature Flags</h2>
                  <div style={{ marginTop: 14 }}>
                    <label className="checkbox-label">
                      <input
                        type="checkbox"
                        checked={jiraStatus.mockEnabled}
                        onChange={handleJiraMockChange}
                      />
                      Use JIRA mock
                    </label>
                  </div>
                  {jiraMessage ? <p className="alert alert-error">{jiraMessage}</p> : null}
                </section>
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
