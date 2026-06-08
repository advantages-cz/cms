import {
  applyFrontMatterTitleToPath as applyFrontMatterTitleToPathState,
  applyFrontMatterTitleToSha,
  decodeContentApiText,
  frontMatterTitleForEntry as frontMatterTitleForEntryState,
  prepareEditorForSave,
  readSaveFileFormData,
  upsertFileMetadata as upsertFileMetadataState,
} from "editorWorkflow";
import { GitHubClient, GitHubError } from "github";
import { DEFAULT_LANGUAGE, LANGUAGES, normalizeLanguage, translate } from "i18n";
import {
  loadCachedContents,
  loadRepositoryCache,
  saveCachedContent,
  saveRepositoryCache,
} from "repoCache";
import { clearToken, loadLastSave, loadSettings, loadToken, saveLastSave, saveSettings, saveToken } from "storage";
import {
  blobFromBase64,
  classifyConclusion,
  debounce,
  escapeHtml,
  extensionOf,
  formatDate,
  humanBytes,
  isActionAuthor,
  isHtmlPath,
  isImagePath,
  isMarkdownPath,
  isPdfPath,
  isTextPath,
  mimeForPath,
  shortSha,
  textToBase64,
} from "utils";

const app = document.querySelector("#app");
const settings = loadSettings();
const tokenInfo = loadToken();
const query = new URLSearchParams(window.location.search);
const FIXED_REPOSITORY = "advantages-cz/avds";
const FIXED_DEFAULT_BRANCH = "master";
const DEFAULT_TREE_PANE_WIDTH = 380;
const MIN_TREE_PANE_WIDTH = 260;
const MIN_PREVIEW_PANE_WIDTH = 360;
const MAX_SEARCH_INDEX_BYTES = 256 * 1024;
const THEME_MODES = ["auto", "light", "dark"];
const STARTUP_CONTENT_EXTENSIONS = ["md", "mdx", "html", "htm"];
const systemDarkQuery = window.matchMedia?.("(prefers-color-scheme: dark)") || null;

const state = {
  publicConfig: {},
  client: tokenInfo.token ? new GitHubClient(tokenInfo.token) : null,
  token: tokenInfo.token,
  tokenPersistence: tokenInfo.persistence,
  language: normalizeLanguage(settings.language || DEFAULT_LANGUAGE),
  theme: normalizeTheme(settings.theme),
  user: null,
  userMenuOpen: false,
  owner: "",
  repo: "",
  repositoryInput: "",
  defaultBranch: FIXED_DEFAULT_BRANCH,
  branch: settings.branch || "",
  branchPrefix: "cms/",
  branches: [],
  files: [],
  frontMatterTitleBySha: new Map(),
  frontMatterTitleAttemptedBySha: new Set(),
  frontMatterTitleDraftByPath: new Map(),
  searchTextBySha: new Map(),
  searchContentBySha: new Map(),
  treeTruncated: false,
  headSha: "",
  tab: normalizeTab(settings.tab),
  editMode: false,
  pathFilter: "",
  selectedPath: "",
  selectedDir: "",
  expandedDirs: new Set(),
  treeScrollTop: 0,
  revealSelectedInTree: false,
  treePaneWidth: normalizeTreePaneWidth(settings.treePaneWidth),
  treePaneResizing: false,
  frontMatterOpen: false,
  editor: null,
  preview: null,
  previewUrls: [],
  lastSave: null,
  externalCompare: null,
  compare: null,
  pullRequest: null,
  pullFiles: [],
  pullCommits: [],
  checkRuns: [],
  checkRunsError: "",
  checksApiUnavailable: false,
  workflowRuns: [],
  annotations: {},
  modal: null,
  busy: false,
  busyLabel: "",
  busyProgress: null,
  connectionError: "",
  toasts: [],
  permissionCheck: null,
  actionPolling: false,
  actionPollStartedAt: null,
  allowDefaultBranchEdits: Boolean(settings.allowDefaultBranchEdits),
  dismissedAutomationBannerKey: "",
};

const ACTION_POLL_INTERVAL_MS = 12000;

let actionPollTimer = null;
let actionPollInFlight = false;
let restoringBrowserNavigation = false;
let treePaneResizeDrag = null;
let backgroundRenderPending = false;
let globalSearchTypingTimer = null;
let globalSearchTyping = false;
let focusRestoreToken = 0;

function normalizeTab(tab) {
  return ["files", "changes", "commits", "actions"].includes(tab) ? tab : tab === "review" ? "changes" : "files";
}

const scheduleFilterRender = debounce(() => {
  globalSearchTyping = false;
  render();
}, 320);
const scheduleEditorMetadataRender = debounce(() => render(), 160);

applyTheme();
registerServiceWorker();
void init();

function t(key, params = {}) {
  return translate(state.language, key, params);
}

function registerServiceWorker() {
  const isSecureContext =
    window.location.protocol === "https:" ||
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1";

  if (!("serviceWorker" in navigator) || !isSecureContext) {
    return;
  }

  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("./sw.js", { updateViaCache: "none" });
  });
}

function syncThemeColor() {
  const meta = document.querySelector('meta[name="theme-color"]');
  if (!(meta instanceof HTMLMetaElement)) {
    return;
  }
  meta.setAttribute("content", document.documentElement.dataset.theme === "dark" ? "#111315" : "#f6f7f8");
}

app.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  void handleForm(form);
});

app.addEventListener("click", (event) => {
  if (event.target instanceof HTMLElement && event.target.classList.contains("modal-backdrop")) {
    event.preventDefault();
    state.modal = null;
    render();
    return;
  }

  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }
  event.preventDefault();
  void handleAction(button);
});

app.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  void handleChange(target);
});

app.addEventListener("input", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) {
    return;
  }
  handleInput(target);
});

app.addEventListener("keydown", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement) || target.dataset.resize !== "tree-pane") {
    return;
  }
  handleTreePaneResizeKey(event, target);
});

app.addEventListener("pointerdown", (event) => {
  const handle = event.target.closest("[data-resize='tree-pane']");
  if (!handle) {
    return;
  }
  event.preventDefault();
  startTreePaneResize(event, handle);
});

window.addEventListener("pointermove", (event) => {
  handleTreePaneResize(event);
});

window.addEventListener("pointerup", () => {
  finishTreePaneResize();
});

window.addEventListener("pointercancel", () => {
  finishTreePaneResize();
});

window.addEventListener("popstate", () => {
  void restoreSelectionFromLocation();
});

window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || !state.modal) {
    return;
  }
  state.modal = null;
  render();
});

systemDarkQuery?.addEventListener("change", () => {
  if (state.theme === "auto") {
    applyTheme();
  }
});

async function init() {
  state.publicConfig = await loadPublicConfig();
  hydrateRepositoryDefaults();
  render();

  if (state.token && state.owner && state.repo) {
    await connectRepository({ silent: true });
  }
}

async function loadPublicConfig() {
  try {
    const response = await fetch("./cms.config.json", { cache: "no-store" });
    if (response.ok) {
      return response.json();
    }
  } catch {
    // Optional config is expected to be absent in local file previews.
  }
  return {};
}

function hydrateRepositoryDefaults() {
  const queryBranch = query.get("branch");
  const parsed = parseRepository(FIXED_REPOSITORY);
  state.owner = parsed.owner;
  state.repo = parsed.repo;
  state.repositoryInput = FIXED_REPOSITORY;
  state.defaultBranch = FIXED_DEFAULT_BRANCH;
  state.branch = queryBranch || settings.branch || FIXED_DEFAULT_BRANCH;
  state.branchPrefix = state.publicConfig.branchPrefix || "cms/";
}

async function handleForm(form) {
  const formName = form.dataset.form;
  const data = new FormData(form);

  if (formName === "auth") {
    const token = String(data.get("token") || "").trim();
    const persistence = "local";
    let shouldCheckToken = Boolean(state.token && state.client);
    state.tokenPersistence = persistence;
    if (token) {
      state.token = token;
      state.client = new GitHubClient(token);
      state.permissionCheck = null;
      resetChecksApiState();
      saveToken(token, persistence);
      toast(t("auth.tokenSaved"), "ok");
      shouldCheckToken = true;
    } else if (state.token) {
      saveToken(state.token, persistence);
      toast(t("auth.tokenStorageChanged"), "ok");
      shouldCheckToken = true;
    }

    if (shouldCheckToken && state.owner && state.repo) {
      state.modal = null;
      await connectRepository();
      return;
    }
    state.modal = null;
    render();
    return;
  }

  if (formName === "repository") {
    const parsed = parseRepository(FIXED_REPOSITORY);
    state.owner = parsed.owner;
    state.repo = parsed.repo;
    state.repositoryInput = FIXED_REPOSITORY;
    state.defaultBranch = FIXED_DEFAULT_BRANCH;
    state.branch = state.branch || state.defaultBranch;
    persistSettings();
    await connectRepository();
    return;
  }

  if (formName === "save-file") {
    await saveCurrentFile(readSaveFileFormData(data));
    return;
  }

  if (formName === "create-text-file") {
    await createTextFile(form, data);
    return;
  }

  if (formName === "create-folder") {
    await createFolder(data);
    return;
  }

  if (formName === "create-pr") {
    await createPullRequest(data);
  }
}

async function handleAction(button) {
  const action = button.dataset.action;

  if (action === "clear-token") {
    state.token = "";
    state.client = null;
    state.user = null;
    state.userMenuOpen = false;
    state.permissionCheck = null;
    resetChecksApiState();
    clearToken();
    toast(t("auth.tokenCleared"), "ok");
    render();
    return;
  }

  if (action === "dismiss-toast") {
    dismissToast(button.dataset.toastId || "");
    return;
  }

  if (action === "dismiss-connection-error") {
    state.connectionError = "";
    render();
    return;
  }

  if (action === "dismiss-automation-banner") {
    state.dismissedAutomationBannerKey = automationBannerKey();
    render();
    return;
  }

  if (action === "tab") {
    state.tab = normalizeTab(button.dataset.tab || "files");
    persistSettings();
    render();
    return;
  }

  if (action === "refresh") {
    await refreshRepositoryData({ preserveSelection: true });
    return;
  }

  if (action === "open-discourse-topic") {
    openDiscourseSearch();
    return;
  }

  if (action === "open-discourse-composer") {
    openDiscourseComposer();
    return;
  }

  if (action === "clear-global-search") {
    state.pathFilter = "";
    globalSearchTyping = false;
    window.clearTimeout(globalSearchTypingTimer);
    render();
    return;
  }

  if (action === "refresh-actions") {
    await refreshActions();
    syncActionPollingWithStatus();
    render();
    return;
  }

  if (action === "check-token-access") {
    await checkTokenAccess();
    return;
  }

  if (action === "login") {
    state.userMenuOpen = false;
    state.modal = { type: "auth" };
    render();
    return;
  }

  if (action === "toggle-user-menu") {
    state.userMenuOpen = !state.userMenuOpen;
    render();
    return;
  }

  if (action === "start-edit-session") {
    await startEditSession();
    return;
  }

  if (action === "new-edit-branch") {
    await startEditSession({ forceNewBranch: true });
    return;
  }

  if (action === "leave-edit-session") {
    leaveEditSession();
    return;
  }

  if (action === "toggle-frontmatter") {
    state.frontMatterOpen = !state.frontMatterOpen;
    render();
    return;
  }

  if (action === "select-file") {
    const path = button.dataset.path || "";
    await loadFile(path, { navigation: "push" });
    return;
  }

  if (action === "open-markdown-link") {
    await openMarkdownLink(button.dataset.path || "", button.dataset.anchor || "");
    return;
  }

  if (action === "open-markdown-dir-link") {
    openMarkdownDirectoryLink(button.dataset.path || "");
    return;
  }

  if (action === "missing-markdown-link") {
    toast(t("markdown.missingLink", { href: button.dataset.href || "" }), "warn");
    return;
  }

  if (action === "toggle-dir") {
    toggleDirectory(button.dataset.path || "", { navigation: "push" });
    return;
  }

  if (action === "delete-file") {
    await deleteSelectedFile();
    return;
  }

  if (action === "delete-folder") {
    await deleteSelectedFolder();
    return;
  }

  if (action === "preview-file") {
    state.tab = "files";
    persistSettings();
    await loadFile(button.dataset.path || "", { navigation: "push", revealInTree: true });
    return;
  }

  if (action === "create-branch") {
    const input = document.querySelector("#new-branch-name");
    await createBranch(String(input?.value || "").trim());
    return;
  }

  if (action === "open-modal") {
    if (["create-text-file", "create-folder"].includes(button.dataset.modal || "") && !state.editMode) {
      toast(t("edit.startFirst"), "warn");
      return;
    }
    state.modal = {
      type: button.dataset.modal,
      imageSrc: button.dataset.imageSrc || "",
      imageAlt: button.dataset.imageAlt || "",
    };
    state.userMenuOpen = false;
    render();
    return;
  }

  if (action === "close-modal") {
    state.modal = null;
    render();
    return;
  }

  if (action === "prepare-pr") {
    state.modal = { type: "create-pr" };
    render();
    return;
  }

  if (action === "open-link") {
    const url = button.dataset.url;
    if (url) {
      window.open(url, "_blank", "noopener,noreferrer");
    }
    return;
  }

  if (action === "load-annotations") {
    await loadAnnotations(Number(button.dataset.checkId));
    render();
    return;
  }

  if (action === "rerun-workflow") {
    await rerunWorkflow(Number(button.dataset.runId));
    return;
  }

  if (action === "refresh-preview") {
    await refreshSelectedPreview();
    return;
  }

}

async function handleChange(target) {
  if (target.id === "branch-select" && target instanceof HTMLSelectElement) {
    if (state.editor?.dirty && !window.confirm(t("files.switchBranchConfirm"))) {
      target.value = state.branch;
      return;
    }
    state.editMode = false;
    state.branch = target.value;
    state.selectedPath = "";
    state.selectedDir = "";
    state.editor = null;
    persistSettings();
    await refreshRepositoryData({ knownHeadSha: headShaForBranch(state.branch) });
    updateBrowserNavigation({ mode: "push" });
    return;
  }

  if (target.id === "allow-default-edits" && target instanceof HTMLInputElement) {
    state.allowDefaultBranchEdits = target.checked;
    persistSettings();
    render();
  }

  if (target.dataset.setting === "language" && target instanceof HTMLSelectElement) {
    state.language = normalizeLanguage(target.value);
    persistSettings();
    render();
  }

  if (target.dataset.setting === "theme" && target instanceof HTMLSelectElement) {
    state.theme = normalizeTheme(target.value);
    applyTheme();
    persistSettings();
    render();
  }
}

function handleInput(target) {
  if (target.id === "global-search" && target instanceof HTMLInputElement) {
    state.pathFilter = target.value;
    globalSearchTyping = true;
    window.clearTimeout(globalSearchTypingTimer);
    globalSearchTypingTimer = window.setTimeout(() => {
      globalSearchTyping = false;
    }, 360);
    scheduleFilterRender();
    return;
  }

  if (target.id === "editor-content" && target instanceof HTMLTextAreaElement && state.editor) {
    state.editor.content = target.value;
    state.editor.dirty = true;
    if (syncEditorFrontMatterTitle()) {
      scheduleEditorMetadataRender();
    }
  }
}

function startTreePaneResize(event, handle) {
  const workbench = handle.closest(".files-workbench");
  if (!(workbench instanceof HTMLElement)) {
    return;
  }

  const rect = workbench.getBoundingClientRect();
  const maxWidth = Math.max(MIN_TREE_PANE_WIDTH, rect.width - MIN_PREVIEW_PANE_WIDTH);
  treePaneResizeDrag = {
    workbench,
    left: rect.left,
    min: MIN_TREE_PANE_WIDTH,
    max: Math.min(maxWidth, 760),
  };
  state.treePaneResizing = true;
  workbench.classList.add("is-resizing");
  document.body.classList.add("is-resizing-tree-pane");
  applyTreePaneWidth(event.clientX);
}

function handleTreePaneResize(event) {
  if (!treePaneResizeDrag) {
    return;
  }
  event.preventDefault();
  applyTreePaneWidth(event.clientX);
}

function finishTreePaneResize() {
  if (!treePaneResizeDrag) {
    return;
  }
  treePaneResizeDrag.workbench.classList.remove("is-resizing");
  treePaneResizeDrag = null;
  state.treePaneResizing = false;
  document.body.classList.remove("is-resizing-tree-pane");
  persistSettings();
}

function handleTreePaneResizeKey(event, handle) {
  if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
    return;
  }

  const workbench = handle.closest(".files-workbench");
  if (!(workbench instanceof HTMLElement)) {
    return;
  }

  event.preventDefault();
  const rect = workbench.getBoundingClientRect();
  const max = Math.min(Math.max(MIN_TREE_PANE_WIDTH, rect.width - MIN_PREVIEW_PANE_WIDTH), 760);
  const step = event.shiftKey ? 48 : 16;
  const nextWidth =
    event.key === "Home"
      ? MIN_TREE_PANE_WIDTH
      : event.key === "End"
        ? max
        : state.treePaneWidth + (event.key === "ArrowLeft" ? -step : step);
  state.treePaneWidth = clamp(Math.round(nextWidth), MIN_TREE_PANE_WIDTH, max);
  workbench.style.setProperty("--tree-pane-width", `${state.treePaneWidth}px`);
  handle.setAttribute("aria-valuenow", String(state.treePaneWidth));
  persistSettings();
}

function applyTreePaneWidth(clientX) {
  if (!treePaneResizeDrag) {
    return;
  }
  const width = clamp(Math.round(clientX - treePaneResizeDrag.left), treePaneResizeDrag.min, treePaneResizeDrag.max);
  state.treePaneWidth = width;
  treePaneResizeDrag.workbench.style.setProperty("--tree-pane-width", `${width}px`);
  treePaneResizeDrag.workbench.querySelector("[data-resize='tree-pane']")?.setAttribute("aria-valuenow", String(width));
}

async function connectRepository({ silent = false } = {}) {
  captureTokenFromAuthForm();

  if (!state.token || !state.client) {
    toast(t("auth.needToken"), "warn");
    return;
  }

  if (!state.owner || !state.repo) {
    toast(t("repo.needRepo"), "warn");
    return;
  }

  await withBusy(t("repo.connecting"), async () => {
    state.connectionError = "";
    state.user = null;
    await state.client.getRepository(state.owner, state.repo);
    const userResult = await state.client.getAuthenticatedUser().catch(() => null);
    state.user = userResult;
    state.defaultBranch = FIXED_DEFAULT_BRANCH;
    state.branch = state.branch || state.defaultBranch;
    state.branches = await state.client.listBranches(state.owner, state.repo);

    if (!state.branches.some((branch) => branch.name === state.branch)) {
      const branchExists = await branchExistsOnGitHub(state.branch);
      if (branchExists) {
        upsertBranchOption(state.branch);
      } else {
        state.branch = state.defaultBranch;
        upsertBranchOption(state.branch);
      }
    } else {
      upsertBranchOption(state.branch);
    }

    persistSettings();
    await refreshRepositoryData({ keepBusy: true, knownHeadSha: headShaForBranch(state.branch) });
    await restoreSelectionFromLocation({ keepBusy: true });
    await selectDefaultRootReadme({ keepBusy: true });
    updateBrowserNavigation({ mode: "replace" });
    await checkTokenAccess({ keepBusy: true });
    if (!silent) {
      toast(t("repo.connected"), "ok");
    }
  });
}

async function checkTokenAccess({ keepBusy = false } = {}) {
  if (!state.token || !state.client) {
    state.permissionCheck = null;
    render();
    return;
  }

  const run = async () => {
    const checkedAt = new Date().toISOString();
    const items = [];
    const userProbe = await probeTokenEndpoint(items, {
      label: t("permissions.loginProbe"),
      required: t("permissions.validToken"),
      run: () => state.client.requestWithMeta("/user"),
    });

    if (userProbe?.payload) {
      state.user = userProbe.payload;
    }

    const repoReady = Boolean(state.owner && state.repo);
    if (!repoReady) {
      addManualTokenChecks(items, t("permissions.addRepoAndRetry"));
      state.permissionCheck = {
        status: userProbe ? "warn" : "danger",
        checkedAt,
        message: t("permissions.tokenOnlyMessage"),
        items,
      };
      return;
    }

    const owner = encodeURIComponent(state.owner);
    const repo = encodeURIComponent(state.repo);
    const branch = encodeURIComponent(state.branch || state.defaultBranch || "main");
    const repoPath = `/repos/${owner}/${repo}`;
    await probeTokenEndpoint(items, {
      label: t("permissions.repoMetadata"),
      required: "Metadata: read a repository access",
      run: () => state.client.requestWithMeta(repoPath),
    });

    const contentsReadProbe = state.files.length || state.headSha;
    items.push({
      label: t("permissions.contentsRead"),
      required: "Contents: read",
      status: contentsReadProbe ? "ok" : "warn",
      optional: false,
      endpoint: "repository cache / Git tree refresh",
      detail: contentsReadProbe ? t("permissions.readPassedMessage") : t("permissions.addRepoAndRetry"),
    });

    await probeTokenEndpoint(items, {
      label: t("permissions.pullRequestsRead"),
      required: "Pull requests: read",
      run: () => state.client.requestWithMeta(`${repoPath}/pulls?state=open&per_page=1`),
    });

    const ref = state.headSha || state.branch || state.defaultBranch || "main";
    await probeTokenEndpoint(items, {
      label: t("permissions.checks"),
      required: `Checks: ${t("permissions.checksOptional")}`,
      optional: true,
      run: () => state.client.requestWithMeta(`${repoPath}/commits/${encodeURIComponent(ref)}/check-runs?per_page=1`),
    });

    await probeTokenEndpoint(items, {
      label: t("permissions.actionsRead"),
      required: "Actions: read",
      run: () => state.client.requestWithMeta(`${repoPath}/actions/runs?branch=${branch}&per_page=1`),
    });

    addManualTokenChecks(items, contentsReadProbe ? t("permissions.safeWriteNotTested") : "");
    const failed = items.filter((item) => item.status === "danger" && !item.optional).length;
    state.permissionCheck = {
      status: failed ? "danger" : "warn",
      checkedAt,
      message: failed ? t("permissions.failedMessage", { count: failed }) : t("permissions.readPassedMessage"),
      items,
    };
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.checkingToken"), run);
  }
}

async function probeTokenEndpoint(items, { label, required, optional = false, run }) {
  try {
    const result = await run();
    items.push({
      label,
      required,
      status: "ok",
      optional,
      endpoint: formatRequestMeta(result.meta),
      detail: formatPermissionMeta(result.meta) || "OK",
    });
    return result;
  } catch (error) {
    const meta = error instanceof GitHubError ? error.meta : null;
    items.push({
      label,
      required,
      status: optional || !(error instanceof GitHubError) || error.status !== 403 ? "warn" : "danger",
      optional,
      endpoint: formatRequestMeta(meta),
      detail: summarizeTokenProbeError(error),
    });
    return null;
  }
}

function addManualTokenChecks(items, detail) {
  items.push(
    {
      label: t("permissions.contentsWrite"),
      required: "Contents: write",
      status: "warn",
      endpoint: "PUT /repos/{owner}/{repo}/contents/{path}",
      detail: detail || t("permissions.contentsWriteDetail"),
    },
    {
      label: t("permissions.pullRequestsWrite"),
      required: "Pull requests: write",
      status: "warn",
      endpoint: "POST /repos/{owner}/{repo}/pulls",
      detail: t("permissions.pullRequestsWriteDetail"),
    },
    {
      label: "Actions write",
      required: `Actions: ${t("permissions.actionsWriteOptional")}`,
      status: "warn",
      endpoint: "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
      detail: t("permissions.actionsWriteManualDetail"),
    },
  );
}

async function refreshRepositoryData({ keepBusy = false, preserveSelection = false, knownHeadSha = "" } = {}) {
  const run = async () => {
    assertConnected();
    const previousPath = preserveSelection && !state.editor?.dirty ? state.selectedPath : "";
    const previousDir = preserveSelection ? state.selectedDir : "";
    const tree = await loadRepositorySnapshot(knownHeadSha);
    revokePreviewUrls();
    state.editor = null;
    state.preview = null;
    state.selectedPath = "";
    state.selectedDir = "";
    applyRepositoryTree(tree);
    state.lastSave = loadLastSave(state.owner, state.repo, state.branch);
    const reviewRefresh = Promise.allSettled([
      refreshReviewData({ keepBusy: true }),
      refreshActions({ keepBusy: true, syncBranch: false }),
    ]);
    if (keepBusy) {
      await reviewRefresh;
    } else {
      void reviewRefresh.then(() => {
        syncActionPollingWithStatus();
        backgroundRenderPending = true;
        renderWhenBackgroundRefreshCompletes();
      });
    }

    if (previousPath && state.files.some((file) => file.path === previousPath)) {
      await loadFile(previousPath, { keepBusy: true });
    } else if (previousDir && directoryExists(previousDir)) {
      state.selectedDir = previousDir;
    }
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.loadingBranch"), run);
  }
}

async function refreshRepositoryTree({ keepBusy = false, expectedHeadSha = "" } = {}) {
  const run = async () => {
    assertConnected();
    const tree = await loadRepositorySnapshot(expectedHeadSha || headShaForBranch(state.branch));
    if (expectedHeadSha && tree.headSha !== expectedHeadSha) {
      return;
    }
    applyRepositoryTree(tree);
    state.lastSave = loadLastSave(state.owner, state.repo, state.branch);
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.loadingBranch"), run);
  }
}

async function loadRepositorySnapshot(headSha = "") {
  const cached = await loadRepositoryCache(state.owner, state.repo, state.branch).catch(() => null);
  if (cached && headSha && cached.headSha === headSha && sameStartupContentExtensions(cached.startupContentExtensions)) {
    return {
      headSha: cached.headSha,
      treeSha: cached.treeSha || "",
      truncated: Boolean(cached.truncated),
      tree: cached.tree || [],
      cacheHit: true,
    };
  }

  const tree = await state.client.listTree(state.owner, state.repo, state.branch, { headSha });
  const nextTree = await hydrateStartupContent(tree, cached);
  await saveRepositoryCache(state.owner, state.repo, state.branch, {
    headSha: nextTree.headSha,
    treeSha: nextTree.treeSha || "",
    truncated: Boolean(nextTree.truncated),
    startupContentExtensions: STARTUP_CONTENT_EXTENSIONS,
    tree: nextTree.tree,
  }).catch(() => {});
  return nextTree;
}

async function hydrateStartupContent(tree, cached) {
  const startupEntries = tree.tree.filter((entry) => entry.type === "blob" && shouldHydrateStartupContentPath(entry.path));
  const cachedTreeBySha = new Map();
  for (const entry of cached?.tree || []) {
    if (entry?.sha && typeof entry.content === "string") {
      cachedTreeBySha.set(entry.sha, entry.content);
    }
  }
  const storedBySha = await loadCachedContents(
    state.owner,
    state.repo,
    startupEntries.map((entry) => entry.sha),
  ).catch(() => new Map());
  const contentBySha = new Map([...cachedTreeBySha, ...storedBySha]);
  const missingEntries = startupEntries.filter((entry) => !contentBySha.has(entry.sha));
  setBusyProgress(
    missingEntries.length
      ? {
          label: t("repo.loadingStartupContent"),
          current: 0,
          total: missingEntries.length,
        }
      : null,
  );

  for (let index = 0; index < missingEntries.length; index += 1) {
    const entry = missingEntries[index];
    const content = await state.client.getContent(state.owner, state.repo, entry.path, tree.headSha || state.branch);
    if (Array.isArray(content) || content.type !== "file") {
      setBusyProgress({
        label: t("repo.loadingStartupContent"),
        current: index + 1,
        total: missingEntries.length,
      });
      continue;
    }
    const text = decodeContentApiText(content.content || "");
    contentBySha.set(entry.sha, text);
    await saveCachedContent(state.owner, state.repo, entry.sha, text, entry.path).catch(() => {});
    setBusyProgress({
      label: t("repo.loadingStartupContent"),
      current: index + 1,
      total: missingEntries.length,
    });
  }
  setBusyProgress(null);

  return {
    ...tree,
    tree: tree.tree.map((entry) => {
      if (entry.type !== "blob" || !shouldHydrateStartupContentPath(entry.path) || !contentBySha.has(entry.sha)) {
        return entry;
      }
      return { ...entry, content: contentBySha.get(entry.sha) };
    }),
  };
}

function headShaForBranch(branchName) {
  return state.branches.find((branch) => branch.name === branchName)?.commit?.sha || "";
}

function isStartupContentPath(path) {
  return STARTUP_CONTENT_EXTENSIONS.includes(extensionOf(path));
}

function shouldHydrateStartupContentPath(path) {
  return isStartupContentPath(path) && isStartupContentVisiblePath(path);
}

function sameStartupContentExtensions(extensions) {
  return JSON.stringify(extensions || []) === JSON.stringify(STARTUP_CONTENT_EXTENSIONS);
}

async function refreshReviewData({ keepBusy = false } = {}) {
  const run = async () => {
    assertConnected();
    state.pullRequest = null;
    state.pullFiles = [];
    state.pullCommits = [];
    state.compare = null;
    state.externalCompare = null;

    if (state.branch !== state.defaultBranch) {
      const pulls = await state.client.listPullRequests(state.owner, state.repo, {
        head: `${state.owner}:${state.branch}`,
        base: state.defaultBranch,
      });
      state.pullRequest = pulls[0] || null;
      const [compare, files, commits] = await Promise.all([
        state.client.compare(state.owner, state.repo, state.defaultBranch, state.branch),
        state.pullRequest
          ? state.client.getPullFiles(state.owner, state.repo, state.pullRequest.number)
          : Promise.resolve([]),
        state.pullRequest
          ? state.client.getPullCommits(state.owner, state.repo, state.pullRequest.number)
          : Promise.resolve([]),
      ]);
      state.compare = compare;
      state.pullFiles = files;
      state.pullCommits = commits;
    }

    if (state.lastSave?.commitSha && state.lastSave.commitSha !== state.headSha) {
      state.externalCompare = await state.client.compare(state.owner, state.repo, state.lastSave.commitSha, state.headSha);
    }
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.loadingReview"), run);
  }
}

async function refreshActions({ keepBusy = false, syncBranch = true } = {}) {
  let headChanged = false;
  const run = async () => {
    assertConnected();
    if (syncBranch) {
      headChanged = await syncRepositoryHead({ notify: false });
    }
    const checkRunsPromise = state.checksApiUnavailable
      ? Promise.resolve({ check_runs: [] })
      : state.client.getCheckRuns(state.owner, state.repo, state.headSha || state.branch);
    const [checkRunsResult, workflowRunsResult] = await Promise.allSettled([
      checkRunsPromise,
      state.client.getWorkflowRuns(state.owner, state.repo, state.branch),
    ]);
    if (checkRunsResult.status === "fulfilled") {
      state.checkRuns = checkRunsResult.value.check_runs || [];
      if (!state.checksApiUnavailable) {
        state.checkRunsError = "";
      }
    } else {
      state.checkRuns = [];
      state.checkRunsError = formatError(checkRunsResult.reason);
      if (isOptionalChecksApiError(checkRunsResult.reason)) {
        state.checksApiUnavailable = true;
      }
    }
    if (workflowRunsResult.status === "rejected") {
      throw workflowRunsResult.reason;
    }
    const workflowRuns = workflowRunsResult.value;
    state.workflowRuns = workflowRuns.workflow_runs || [];
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.loadingActions"), run);
  }

  return { headChanged };
}

function isOptionalChecksApiError(error) {
  if (!(error instanceof GitHubError)) {
    return false;
  }
  return error.status === 403 || error.status === 404;
}

function startActionPolling() {
  if (!state.client || !state.owner || !state.repo) {
    return;
  }

  state.actionPolling = true;
  state.actionPollStartedAt = state.actionPollStartedAt || new Date().toISOString();
  window.clearTimeout(actionPollTimer);
  actionPollTimer = window.setTimeout(() => {
    void pollActionsUntilIdle();
  }, ACTION_POLL_INTERVAL_MS);
}

function stopActionPolling() {
  window.clearTimeout(actionPollTimer);
  actionPollTimer = null;
  state.actionPolling = false;
  state.actionPollStartedAt = null;
}

function syncActionPollingWithStatus() {
  if (hasRunningActionStatus()) {
    startActionPolling();
  } else if (state.actionPolling && (actionStatusItems().length || !shouldKeepWaitingForActionStatus())) {
    stopActionPolling();
  }
}

async function pollActionsUntilIdle() {
  if (!state.actionPolling || actionPollInFlight) {
    return;
  }

  actionPollInFlight = true;
  try {
    const result = await refreshActions({ keepBusy: true });
    if (result.headChanged) {
      await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
      if (hasRunningActionStatus()) {
        render();
        startActionPolling();
        return;
      }
      stopActionPolling();
      toast(t("actions.actionsMovedBranch"), "ok");
      render();
      return;
    }

    if (hasRunningActionStatus() || shouldKeepWaitingForActionStatus()) {
      render();
      startActionPolling();
      return;
    }

    stopActionPolling();
    await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
    toast(t("actions.actionsFinished"), "ok");
    render();
  } catch (error) {
    stopActionPolling();
    state.connectionError = formatError(error);
    toast(state.connectionError, "danger");
    render();
  } finally {
    actionPollInFlight = false;
  }
}

async function syncRepositoryHead({ reloadSelection = true, notify = true } = {}) {
  const previousHeadSha = state.headSha;
  const previousPath = state.selectedPath;
  const canReloadSelection = reloadSelection && Boolean(previousPath) && !state.editor?.dirty;
  const tree = await loadRepositorySnapshot(headShaForBranch(state.branch));
  const headChanged = Boolean(previousHeadSha) && tree.headSha !== previousHeadSha;

  applyRepositoryTree(tree);
  state.lastSave = loadLastSave(state.owner, state.repo, state.branch);

  if (!headChanged) {
    return false;
  }

  await refreshReviewData({ keepBusy: true });

  if (!canReloadSelection) {
    return true;
  }

  if (state.files.some((file) => file.path === previousPath)) {
    await loadFile(previousPath, { keepBusy: true });
  } else {
    revokePreviewUrls();
    state.selectedPath = "";
    state.selectedDir = directoryOfPath(previousPath);
    state.editor = null;
    state.preview = null;
  }

  if (notify) {
    toast(t("repo.branchMoved", { sha: shortSha(state.headSha) }), "ok");
  }
  return true;
}

function applyRepositoryTree(tree) {
  state.headSha = tree.headSha;
  state.treeTruncated = tree.truncated;
  state.files = tree.tree
    .filter((entry) => entry.type === "blob")
    .map((entry) => ({
      ...entry,
      frontMatterTitle: frontMatterTitleForEntry(entry),
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  pruneBlobCaches();
  hydrateContentCachesFromFiles();
}

function pruneBlobCaches() {
  const activeShas = new Set(state.files.map((file) => file.sha).filter(Boolean));
  pruneMapKeys(state.frontMatterTitleBySha, activeShas);
  pruneSetValues(state.frontMatterTitleAttemptedBySha, activeShas);
  pruneMapKeys(state.searchTextBySha, activeShas);
  pruneMapKeys(state.searchContentBySha, activeShas);
}

function hydrateContentCachesFromFiles() {
  for (const file of state.files) {
    if (!isStartupContentPath(file.path) || typeof file.content !== "string") {
      continue;
    }
    if (isSearchIndexablePath(file.path) && file.size <= MAX_SEARCH_INDEX_BYTES) {
      state.searchTextBySha.set(file.sha, normalizeSearchText(file.content));
      state.searchContentBySha.set(file.sha, file.content);
    }
    if (isMarkdownPath(file.path)) {
      const title = extractFrontMatterTitle(file.content);
      state.frontMatterTitleBySha.set(file.sha, title);
      state.frontMatterTitleAttemptedBySha.add(file.sha);
      applyFrontMatterTitleToFile(file.sha, title);
    }
  }
}

function pruneMapKeys(map, activeKeys) {
  for (const key of map.keys()) {
    if (!activeKeys.has(key)) {
      map.delete(key);
    }
  }
}

function pruneSetValues(set, activeValues) {
  for (const value of set.values()) {
    if (!activeValues.has(value)) {
      set.delete(value);
    }
  }
}

function frontMatterTitleForEntry(entry) {
  return frontMatterTitleForEntryState(entry, {
    draftByPath: state.frontMatterTitleDraftByPath,
    titleBySha: state.frontMatterTitleBySha,
  });
}

function setFrontMatterTitleDraft(path, title) {
  state.frontMatterTitleDraftByPath.set(path, title);
}

async function startEditSession({ forceNewBranch = false } = {}) {
  if (state.editor?.dirty) {
    toast(t("edit.dirty"), "warn");
    return;
  }

  if (state.selectedPath && !isMarkdownPath(state.selectedPath)) {
    toast(t("files.markdownOnlyEdit"), "warn");
    return;
  }

  await withBusy(t("edit.preparing"), async () => {
    assertConnected();
    const previousPath = state.selectedPath;

    if (forceNewBranch || state.branch === state.defaultBranch) {
      const branchName = await createAutomaticEditBranch();
      state.branch = branchName;
      state.branches = await state.client.listBranches(state.owner, state.repo);
      upsertBranchOption(branchName);
      toast(t("edit.branchCreated", { branch: branchName }), "ok");
    } else {
      upsertBranchOption(state.branch);
      toast(t("edit.branchContinued", { branch: state.branch }), "ok");
    }

    state.editMode = true;
    persistSettings();
    updateBrowserNavigation({ mode: "replace" });
    await refreshRepositoryData({ keepBusy: true });

    if (previousPath && state.files.some((file) => file.path === previousPath)) {
      await loadFile(previousPath);
    }
  });
}

function leaveEditSession() {
  if (state.editor?.dirty && !window.confirm(t("files.leaveUnsavedConfirm"))) {
    return;
  }

  state.editMode = false;
  persistSettings();
  render();
}

async function loadFile(path, { keepBusy = false, syncLatest = false, navigation = "", revealInTree = false } = {}) {
  if (!path) {
    return;
  }

  const run = async () => {
    assertConnected();
    if (syncLatest && !state.editor?.dirty) {
      await syncRepositoryHead({ reloadSelection: false });
    }
    revokePreviewUrls();
    const entry = state.files.find((file) => file.path === path);
    if (!entry) {
      throw new Error(t("files.fileMissingInTree"));
    }

    state.selectedPath = path;
    state.selectedDir = directoryOfPath(path);
    expandPathToFile(path);
    state.revealSelectedInTree = state.revealSelectedInTree || revealInTree;
    state.editor = {
      path,
      sha: entry.sha,
      size: entry.size,
      content: "",
      baseContent: "",
      binary: !isTextPath(path),
      dirty: false,
    };

    if (isTextPath(path)) {
      state.editor.content = await loadTextContentForEntry(entry);
      state.editor.baseContent = state.editor.content;
      if (isSearchIndexablePath(path) && entry.size <= MAX_SEARCH_INDEX_BYTES) {
        state.searchTextBySha.set(entry.sha, normalizeSearchText(state.editor.content));
        state.searchContentBySha.set(entry.sha, state.editor.content);
      }
      if (isMarkdownPath(path)) {
        const title = extractFrontMatterTitle(state.editor.content);
        state.frontMatterTitleBySha.set(entry.sha, title);
        state.frontMatterTitleAttemptedBySha.add(entry.sha);
        state.frontMatterTitleDraftByPath.delete(path);
        applyFrontMatterTitleToPath(path, title);
      }
    }

    await buildPreview(entry, state.editor.content);
    if (navigation) {
      updateBrowserNavigation({ mode: navigation });
    }
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy(t("repo.loadingFile"), run);
  }
}

async function loadTextContentForEntry(entry) {
  if (typeof entry.content === "string") {
    return entry.content;
  }
  const cached = await loadCachedContents(state.owner, state.repo, [entry.sha]).catch(() => new Map());
  if (cached.has(entry.sha)) {
    return cached.get(entry.sha);
  }
  const content = await state.client.getContent(state.owner, state.repo, entry.path, state.headSha || state.branch);
  if (Array.isArray(content) || content.type !== "file") {
    throw new Error(t("files.selectedMissing"));
  }
  const text = decodeContentApiText(content.content || "");
  await saveCachedContent(state.owner, state.repo, entry.sha, text, entry.path).catch(() => {});
  return text;
}

async function openMarkdownLink(path, anchor) {
  if (path) {
    await loadFile(path, { navigation: "push", revealInTree: true });
  }

  if (anchor) {
    window.setTimeout(() => scrollMarkdownAnchor(anchor), 0);
  }
}

function openMarkdownDirectoryLink(path) {
  const dir = normalizePath(path);
  if (!dir || !directoryExists(dir)) {
    return;
  }

  selectDirectory(dir, { navigation: "push", revealInTree: true });
}

function scrollMarkdownAnchor(anchor) {
  const preview = document.querySelector(".markdown-preview");
  const normalized = normalizeMarkdownAnchor(anchor);
  const anchors = normalized && normalized !== anchor ? [anchor, normalized] : [anchor];
  const target = anchors
    .map((candidate) => {
      const byId = document.getElementById(candidate);
      const byName = preview?.querySelector(`[name="${attrEscape(candidate)}"]`);
      return byId && preview?.contains(byId) ? byId : byName;
    })
    .find((candidate) => candidate instanceof HTMLElement);

  if (target instanceof HTMLElement) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    toast(t("markdown.missingAnchor", { anchor }), "warn");
  }
}

function attrEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

async function refreshSelectedPreview() {
  if (!state.selectedPath) {
    return;
  }

  await withBusy(t("actions.refreshPreview"), async () => {
    if (state.editor?.dirty) {
      const entry = state.files.find((file) => file.path === state.selectedPath);
      if (!entry) {
        throw new Error(t("files.selectedMissing"));
      }
      await buildPreview(entry, state.editor.content || "");
      return;
    }

    await loadFile(state.selectedPath, { keepBusy: true, syncLatest: true });
  });
}

async function buildPreview(entry, textContent = "") {
  revokePreviewUrls();
  const path = entry.path;
  const mime = mimeForPath(path);

  if (isHtmlPath(path)) {
    const html = await inlineHtmlPreviewAssets(textContent || "", path);
    state.preview = { kind: "html", path, html };
    return;
  }

  if (isImagePath(path) || isPdfPath(path)) {
    const blobData = await state.client.getBlob(state.owner, state.repo, entry.sha);
    const blob = blobFromBase64(blobData.content || "", mime);
    const url = trackPreviewUrl(URL.createObjectURL(blob));
    state.preview = { kind: isPdfPath(path) ? "pdf" : "image", path, url };
    return;
  }

  if (isTextPath(path)) {
    state.preview = { kind: "text", path, text: textContent };
    return;
  }

  state.preview = {
    kind: "unsupported",
    path,
    text: t("files.unsupportedPreview", { mime }),
  };
}

async function inlineHtmlPreviewAssets(html, htmlPath) {
  const assetRefs = collectHtmlAssetRefs(html);
  const replacements = new Map();

  for (const ref of assetRefs) {
    const assetPath = resolvePreviewAssetPath(ref, htmlPath);
    const file = state.files.find((item) => item.path === assetPath);
    if (!file) {
      continue;
    }

    if (!(isImagePath(assetPath) || extensionOf(assetPath) === "css")) {
      continue;
    }

    try {
      const blob = await state.client.getBlob(state.owner, state.repo, file.sha);
      const dataUrl = `data:${mimeForPath(assetPath)};base64,${String(blob.content || "").replace(/\s/g, "")}`;
      replacements.set(ref, dataUrl);
    } catch {
      // Preview should still render even if one asset cannot be loaded.
    }
  }

  if (!replacements.size) {
    return html;
  }

  return html.replace(/\b(src|href)=("|')([^"']+)\2/g, (match, attr, quote, value) => {
    const replacement = replacements.get(value);
    return replacement ? `${attr}=${quote}${replacement}${quote}` : match;
  });
}

function collectHtmlAssetRefs(html) {
  const refs = new Set();
  for (const match of String(html || "").matchAll(/\b(?:src|href)=("|')([^"']+)\1/g)) {
    const value = match[2];
    if (isPreviewRelativeUrl(value)) {
      refs.add(value);
    }
  }
  return refs;
}

function isPreviewRelativeUrl(value) {
  return Boolean(value) && !/^(?:[a-z][a-z0-9+.-]*:|#|\/\/)/i.test(value);
}

function resolvePreviewAssetPath(ref, fromPath) {
  const clean = ref.split("#")[0].split("?")[0];
  return resolveRepoRelativePath(clean, fromPath);
}

function recordCmsCommit({ commitSha, path, message }) {
  if (!commitSha) {
    return;
  }

  saveLastSave(state.owner, state.repo, state.branch, {
    commitSha,
    path,
    message,
    savedAt: new Date().toISOString(),
    actor: state.user?.login || "",
  });
  state.lastSave = loadLastSave(state.owner, state.repo, state.branch);
  state.dismissedAutomationBannerKey = "";
}

async function saveCurrentFile({ message = "", content = "" } = {}) {
  if (!state.editor || state.editor.binary) {
    toast(t("files.selectMarkdown"), "warn");
    return;
  }

  if (!isMarkdownPath(state.editor.path)) {
    toast(t("files.markdownOnlyEdit"), "warn");
    return;
  }

  state.editor.content = content;
  state.editor.dirty = true;

  await withBusy(t("files.savingCommit"), async () => {
    assertCanWrite();
    const savedPath = state.editor.path;
    const commitMessage = message || `CMS: update ${state.editor.path}`;
    syncEditorFrontMatterTitle();
    await prepareCurrentFileForSave();
    syncEditorFrontMatterTitle();
    const response = await putCurrentEditorFile(commitMessage);

    state.editor.sha = response.content?.sha || state.editor.sha;
    state.editor.dirty = false;
    state.editor.baseContent = state.editor.content;
    state.headSha = response.commit?.sha || state.headSha;
    recordCmsCommit({ commitSha: state.headSha, path: state.editor.path, message: commitMessage });
    await refreshRepositoryTree({ keepBusy: true, expectedHeadSha: state.headSha });
    await loadFileFromContents(savedPath, { ref: state.headSha || state.branch });
    await refreshActions({ keepBusy: true, syncBranch: false });
    await refreshReviewData({ keepBusy: true });
    startActionPolling();
    persistSettings();
    toast(t("files.commitSaved"), "ok");
  });
}

async function loadFileFromContents(path, { ref = state.branch } = {}) {
  const content = await state.client.getContent(state.owner, state.repo, path, ref, { cacheBust: true });
  if (Array.isArray(content) || content.type !== "file" || !content.sha) {
    throw new Error(t("files.selectedMissing"));
  }

  const existing = state.files.find((file) => file.path === path) || {};
  const entry = {
    ...existing,
    path,
    name: path.split("/").pop() || path,
    type: "blob",
    sha: content.sha,
    size: content.size || existing.size || 0,
    frontMatterTitle: existing.frontMatterTitle || "",
    content: isTextPath(path) ? decodeContentApiText(content.content || "") : undefined,
  };
  upsertFileMetadata(entry);

  const textContent = isTextPath(path) ? entry.content || "" : "";
  if (textContent) {
    await saveCachedContent(state.owner, state.repo, entry.sha, textContent, path).catch(() => {});
  }
  revokePreviewUrls();
  state.selectedPath = path;
  state.selectedDir = directoryOfPath(path);
  expandPathToFile(path);
  state.editor = {
    path,
    sha: entry.sha,
    size: entry.size,
    content: textContent,
    baseContent: textContent,
    binary: !isTextPath(path),
    dirty: false,
  };

  if (isMarkdownPath(path)) {
    const title = extractFrontMatterTitle(textContent);
    state.frontMatterTitleBySha.set(entry.sha, title);
    state.frontMatterTitleAttemptedBySha.add(entry.sha);
    state.frontMatterTitleDraftByPath.delete(path);
    applyFrontMatterTitleToPath(path, title);
  }
  if (isSearchIndexablePath(path) && entry.size <= MAX_SEARCH_INDEX_BYTES) {
    state.searchTextBySha.set(entry.sha, normalizeSearchText(textContent));
    state.searchContentBySha.set(entry.sha, textContent);
  }

  await buildPreview(entry, textContent);
}

function upsertFileMetadata(entry) {
  state.files = upsertFileMetadataState(state.files, entry);
}

async function putCurrentEditorFile(commitMessage) {
  try {
    return await putCurrentEditorFileOnce(commitMessage);
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 409) {
      throw error;
    }
    await prepareCurrentFileForSave({ cacheBust: true });
    syncEditorFrontMatterTitle();
    return putCurrentEditorFileOnce(commitMessage);
  }
}

function putCurrentEditorFileOnce(commitMessage) {
  return state.client.putFile(state.owner, state.repo, state.editor.path, {
    branch: state.branch,
    message: commitMessage,
    contentBase64: textToBase64(state.editor.content),
    sha: state.editor.sha,
  });
}

async function prepareCurrentFileForSave({ cacheBust = false } = {}) {
  if (!state.editor) {
    return;
  }

  const path = state.editor.path;
  const result = await prepareEditorForSave({
    client: state.client,
    owner: state.owner,
    repo: state.repo,
    branch: state.branch,
    editor: state.editor,
    conflictMessage: t("files.remoteChangedConflict", { path }),
    cacheBust,
  });
  state.editor = result.editor;
  applyFrontMatterTitleToPath(path, extractFrontMatterTitle(state.editor.content || ""));
}

async function createTextFile(form, data) {
  const name = normalizeMarkdownFileName(String(data.get("name") || ""));
  const dir = currentDirectoryPath();
  const path = joinPath(dir, name);
  const content = String(data.get("content") || "");
  const message = String(data.get("message") || "").trim() || `CMS: create ${path}`;

  if (!name) {
    toast(t("files.needFileName"), "warn");
    return;
  }

  if (!isMarkdownPath(path)) {
    toast(t("files.newMarkdownOnly"), "warn");
    return;
  }

  if (state.files.some((file) => file.path === path)) {
    toast(t("files.fileExists"), "warn");
    return;
  }

  await withBusy(t("files.creatingFile"), async () => {
    assertCanWrite();
    const response = await state.client.putFile(state.owner, state.repo, path, {
      branch: state.branch,
      message,
      contentBase64: textToBase64(content),
    });
    state.headSha = response.commit?.sha || state.headSha;
    recordCmsCommit({ commitSha: state.headSha, path, message });
    state.modal = null;
    await refreshRepositoryData({ keepBusy: true });
    state.selectedDir = dir;
    await loadFile(path, { navigation: "push", revealInTree: true });
    await refreshActions({ keepBusy: true });
    await refreshReviewData({ keepBusy: true });
    startActionPolling();
    toast(t("files.fileCreated"), "ok");
  });
}

async function createFolder(data) {
  const name = normalizePathPart(String(data.get("name") || ""));
  const parentDir = currentDirectoryPath();
  const dirPath = joinPath(parentDir, name);
  const markerPath = joinPath(dirPath, ".gitkeep");
  const message = String(data.get("message") || "").trim() || `CMS: create folder ${dirPath || "/"}`;

  if (!name) {
    toast(t("files.needFolderName"), "warn");
    return;
  }

  if (state.files.some((file) => file.path === markerPath || file.path.startsWith(`${dirPath}/`))) {
    toast(t("files.folderExists"), "warn");
    return;
  }

  await withBusy(t("files.creatingFolder"), async () => {
    assertCanWrite();
    const response = await state.client.putFile(state.owner, state.repo, markerPath, {
      branch: state.branch,
      message,
      contentBase64: textToBase64(""),
    });
    state.headSha = response.commit?.sha || state.headSha;
    recordCmsCommit({ commitSha: state.headSha, path: markerPath, message });
    state.modal = null;
    state.selectedDir = dirPath;
    expandPathToFile(markerPath);
    await refreshRepositoryData({ keepBusy: true });
    state.selectedDir = dirPath;
    state.expandedDirs.add(dirPath);
    persistSettings();
    await refreshActions({ keepBusy: true });
    await refreshReviewData({ keepBusy: true });
    startActionPolling();
    toast(t("files.folderCreated"), "ok");
  });
}

async function deleteSelectedFile() {
  if (!state.selectedPath || !state.editor) {
    toast(t("files.selectFileToDelete"), "warn");
    return;
  }

  const path = state.selectedPath;
  if (state.editor.dirty && !window.confirm(t("files.deleteUnsavedConfirm"))) {
    return;
  }

  if (!window.confirm(t("files.deleteFileConfirm", { path, branch: state.branch }))) {
    return;
  }

  await withBusy(t("files.deletingFile"), async () => {
    assertCanWrite();
    const entry = state.files.find((file) => file.path === path);
    const sha = entry?.sha || state.editor.sha;
    if (!sha) {
      throw new Error(t("files.missingFileSha"));
    }

    const response = await state.client.deleteFile(state.owner, state.repo, path, {
      branch: state.branch,
      message: `CMS: delete ${path}`,
      sha,
    });

    state.headSha = response.commit?.sha || state.headSha;
    recordCmsCommit({ commitSha: state.headSha, path, message: `CMS: delete ${path}` });
    state.selectedPath = "";
    state.selectedDir = directoryOfPath(path);
    state.editor = null;
    state.preview = null;
    removeFilesFromState([path]);
    await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
    removeFilesFromState([path]);
    state.selectedDir = directoryOfPath(path);
    await refreshActions({ keepBusy: true });
    await refreshReviewData({ keepBusy: true });
    removeFilesFromState([path]);
    updateBrowserNavigation({ mode: "replace" });
    startActionPolling();
    toast(t("files.fileDeleted"), "ok");
  });
}

async function deleteSelectedFolder() {
  const dir = currentDirectoryPath();
  if (!dir) {
    toast(t("files.needFolderName"), "warn");
    return;
  }

  const files = filesInDirectory(dir);
  if (!files.length) {
    toast(t("files.folderEmpty"), "warn");
    return;
  }

  if (
    !window.confirm(
      t("files.deleteFolderConfirm", { dir, count: files.length, branch: state.branch }),
    )
  ) {
    return;
  }

  await withBusy(t("files.deletingFolder"), async () => {
    assertCanWrite();
    const branchInfo = await state.client.getBranch(state.owner, state.repo, state.branch);
    const parentSha = branchInfo.commit.sha;
    const parentCommit = await state.client.getGitCommit(state.owner, state.repo, parentSha);
    const baseTree = parentCommit.tree.sha;
    const tree = await state.client.createTree(state.owner, state.repo, {
      baseTree,
      tree: files.map((file) => ({
        path: file.path,
        mode: "100644",
        type: "blob",
        sha: null,
      })),
    });
    const commit = await state.client.createCommit(state.owner, state.repo, {
      message: `CMS: delete folder ${dir}`,
      tree: tree.sha,
      parents: [parentSha],
    });
    await state.client.updateBranchRef(state.owner, state.repo, state.branch, {
      sha: commit.sha,
      force: false,
    });

    state.headSha = commit.sha || state.headSha;
    recordCmsCommit({ commitSha: state.headSha, path: dir, message: `CMS: delete folder ${dir}` });
    state.selectedPath = "";
    state.selectedDir = parentDirectoryOfDir(dir);
    state.editor = null;
    state.preview = null;
    removeFilesFromState(files.map((file) => file.path));
    state.expandedDirs.delete(dir);
    persistSettings();
    await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
    removeFilesFromState(files.map((file) => file.path));
    state.selectedDir = parentDirectoryOfDir(dir);
    await refreshActions({ keepBusy: true });
    await refreshReviewData({ keepBusy: true });
    removeFilesFromState(files.map((file) => file.path));
    state.selectedDir = parentDirectoryOfDir(dir);
    updateBrowserNavigation({ mode: "replace" });
    startActionPolling();
    toast(t("files.folderDeleted"), "ok");
  });
}

async function createBranch(rawName) {
  const name = normalizeBranchName(rawName);
  if (!name) {
    toast(t("edit.needBranchName"), "warn");
    return;
  }

  if (state.branches.some((branch) => branch.name === name)) {
    toast(t("edit.branchExists"), "warn");
    return;
  }

  await withBusy(t("edit.creatingBranch"), async () => {
    assertConnected();
    await state.client.createBranch(state.owner, state.repo, name, state.headSha);
    state.branches = await state.client.listBranches(state.owner, state.repo);
    state.branch = name;
    upsertBranchOption(name);
    persistSettings();
    updateBrowserNavigation({ mode: "replace" });
    await refreshRepositoryData({ keepBusy: true });
    toast(t("edit.branchReady", { branch: name }), "ok");
  });
}

async function createAutomaticEditBranch() {
  const stamp = new Date()
    .toISOString()
    .slice(0, 19)
    .replace("T", "-")
    .replace(/:/g, "");
  const baseName = normalizeBranchName(`${state.branchPrefix}edit-${stamp}`);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const name = attempt ? `${baseName}-${attempt + 1}` : baseName;
    if (state.branches.some((branch) => branch.name === name)) {
      continue;
    }

    try {
      await state.client.createBranch(state.owner, state.repo, name, state.headSha);
      return name;
    } catch (error) {
      if (error instanceof GitHubError && error.status === 422) {
        continue;
      }
      throw error;
    }
  }

  throw new Error(t("edit.cannotFindBranchName"));
}

async function branchExistsOnGitHub(branchName) {
  if (!branchName) {
    return false;
  }

  try {
    await state.client.getBranch(state.owner, state.repo, branchName);
    return true;
  } catch {
    return false;
  }
}

function upsertBranchOption(branchName) {
  if (!branchName) {
    return;
  }

  if (!state.branches.some((branch) => branch.name === branchName)) {
    state.branches = [...state.branches, { name: branchName }];
  }
  state.branches = state.branches
    .filter((branch, index, branches) => branches.findIndex((item) => item.name === branch.name) === index)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function createPullRequest(data) {
  if (state.branch === state.defaultBranch) {
    toast(t("pr.defaultBranch"), "warn");
    return;
  }

  await withBusy(t("pr.creating"), async () => {
    assertConnected();
    const title = String(data.get("title") || "").trim() || `CMS: ${state.branch}`;
    const body =
      String(data.get("body") || "").trim() ||
      t("pr.fallbackBody");
    state.pullRequest = await state.client.createPullRequest(state.owner, state.repo, {
      title,
      body,
      head: state.branch,
      base: state.defaultBranch,
      maintainer_can_modify: true,
    });
    state.modal = null;
    state.editMode = false;
    await refreshReviewData({ keepBusy: true });
    state.tab = "changes";
    persistSettings();
    toast(t("pr.created"), "ok");
  });
}

async function loadAnnotations(checkRunId) {
  if (!checkRunId) {
    return;
  }

  await withBusy(t("actions.annotations"), async () => {
    assertConnected();
    state.annotations[checkRunId] = await state.client.getCheckRunAnnotations(state.owner, state.repo, checkRunId);
  });
}

async function rerunWorkflow(runId) {
  if (!runId) {
    return;
  }

  await withBusy(t("actions.rerunning"), async () => {
    assertConnected();
    await state.client.rerunWorkflowRun(state.owner, state.repo, runId);
    await refreshActions({ keepBusy: true });
    startActionPolling();
    toast(t("actions.rerunQueued"), "ok");
  });
}

function render({ treeScrollTop = null } = {}) {
  if (treeScrollTop === null) {
    captureTreeScroll();
  } else {
    state.treeScrollTop = treeScrollTop;
  }
  const focusSnapshot = captureFocusSnapshot();
  app.innerHTML = `
    <div class="app-shell ${state.busy ? "loading" : ""}">
      ${renderTopbar()}
      <div class="layout">
        <main class="content">${renderContent()}</main>
      </div>
    </div>
    ${renderBusyOverlay()}
    ${renderModal()}
    <div class="toast-stack">${state.toasts.map(renderToast).join("")}</div>
  `;
  restoreTreeScroll();
  revealSelectedTreeRow();
  restoreFocusSnapshot(focusSnapshot);
  highlightSearchMatches();
  syncDiscussionEmbed();
}

function renderBusyOverlay() {
  if (!state.busy || (state.token && state.owner && state.repo && !state.headSha)) {
    return "";
  }

  const progress = state.busyProgress;
  const label = progress?.label || state.busyLabel || t("common.loading");
  const total = Math.max(0, Number(progress?.total || 0));
  const current = clamp(Number(progress?.current || 0), 0, total || 0);
  const remaining = Math.max(0, total - current);
  const percent = total ? Math.round((current / total) * 100) : 0;
  const detail = total
    ? t("repo.loadingStartupContentProgress", { current, total, remaining })
    : state.busyLabel || "";

  return `
    <div class="busy-overlay" role="status" aria-live="polite">
      <div class="busy-indicator" aria-hidden="true"></div>
      <div class="busy-main">
        <p class="busy-title">${escapeHtml(label)}</p>
        ${detail ? `<p class="busy-detail">${escapeHtml(detail)}</p>` : ""}
        ${
          total
            ? `<div class="busy-progress" aria-label="${escapeHtml(detail)}"><span style="width: ${percent}%"></span></div>`
            : `<div class="busy-progress busy-progress-indeterminate" aria-hidden="true"><span></span></div>`
        }
      </div>
    </div>
  `;
}

function renderTopbar() {
  const repoLabel = state.owner && state.repo ? `${state.owner}/${state.repo}` : t("repo.disconnected");
  const modeClass = state.editMode ? "is-editing" : "is-browsing";
  return `
    <header class="topbar ${modeClass}">
      <div class="brand">
        <img class="brand-symbol" src="./assets/brand/adaptivio-symbol-cerny-rgb.svg" alt="" aria-hidden="true" />
        <div class="brand-copy">
          <h1>Adaptivio CMS</h1>
          <span class="repo-label">${escapeHtml(repoLabel)}</span>
        </div>
      </div>
      <div class="top-actions">
        ${renderGlobalSearch()}
        ${renderTopbarWorkflowControls()}
        ${renderUserMenu()}
      </div>
    </header>
  `;
}

function renderGlobalSearch() {
  if (!state.token || !state.owner || !state.repo || !state.headSha) {
    return "";
  }

  return `
    <div class="global-search" role="search">
      <span class="sr-only" id="global-search-label">${t("search.label")}</span>
      <span class="global-search-icon" aria-hidden="true">${treeIconSvg("search")}</span>
      <input id="global-search" value="${escapeHtml(state.pathFilter)}" aria-labelledby="global-search-label" placeholder="${t("search.placeholder")}" autocomplete="off" />
      ${state.pathFilter ? `<button class="global-search-clear" type="button" data-action="clear-global-search" aria-label="${t("search.clear")}"><span aria-hidden="true">×</span></button>` : ""}
    </div>
  `;
}

function renderWhenBackgroundRefreshCompletes() {
  if (!backgroundRenderPending) {
    return;
  }
  backgroundRenderPending = false;
  render();
}

function renderThemeSelect(location = "") {
  const id = `theme-select${location ? `-${location}` : ""}`;
  const labelClass = location === "menu" ? "menu-field-label" : "sr-only";
  return `
    <label class="theme-control ${location ? `theme-control-${escapeHtml(location)}` : ""}">
      <span class="${labelClass}">${t("common.theme")}</span>
      <select id="${escapeHtml(id)}" data-setting="theme" aria-label="${t("common.theme")}">
        ${THEME_MODES.map((theme) => `<option value="${escapeHtml(theme)}" ${theme === state.theme ? "selected" : ""}>${escapeHtml(t(`theme.${theme}`))}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderLanguageSelect(location = "") {
  const id = `language-select${location ? `-${location}` : ""}`;
  const labelClass = location === "menu" ? "menu-field-label" : "sr-only";
  return `
    <label class="language-control ${location ? `language-control-${escapeHtml(location)}` : ""}">
      <span class="${labelClass}">${t("common.language")}</span>
      <select id="${escapeHtml(id)}" data-setting="language" aria-label="${t("common.language")}">
        ${LANGUAGES.map((language) => `<option value="${escapeHtml(language.code)}" ${language.code === state.language ? "selected" : ""}>${escapeHtml(language.label)}</option>`).join("")}
      </select>
    </label>
  `;
}

function renderUserMenu() {
  if (!state.token) {
    return `
      <div class="topbar-public-controls">
        ${renderLanguageSelect("topbar")}
        ${renderThemeSelect("topbar")}
      </div>
    `;
  }

  const label = state.user?.login || t("auth.tokenSavedLabel");
  return `
    <div class="user-menu-wrap">
      <button class="account-button user-menu-trigger" type="button" data-action="toggle-user-menu" aria-expanded="${state.userMenuOpen ? "true" : "false"}" aria-haspopup="true">
        <span class="account-dot" aria-hidden="true"></span>
        <span>${escapeHtml(label)}</span>
        <span class="menu-caret" aria-hidden="true"></span>
      </button>
      ${
        state.userMenuOpen
          ? `<div class="user-menu">
              <div class="user-menu-section">
                ${renderLanguageSelect("menu")}
                ${renderThemeSelect("menu")}
              </div>
              <div class="user-menu-actions">
                <button class="user-menu-action user-menu-action-accent" type="button" data-action="login">${t("auth.changeToken")}</button>
                <button class="user-menu-action user-menu-action-danger" type="button" data-action="clear-token">${t("auth.logout")}</button>
              </div>
            </div>`
          : ""
      }
    </div>
  `;
}

function renderTopbarWorkflowControls() {
  if (!state.token || !state.owner || !state.repo || !state.headSha) {
    return "";
  }

  const branchOptions = state.branches
    .map((branch) => `<option value="${escapeHtml(branch.name)}" ${branch.name === state.branch ? "selected" : ""}>${escapeHtml(branch.name)}</option>`)
    .join("");
  const branchKind = state.branch === state.defaultBranch ? t("toolbar.protectedBranch") : t("toolbar.workingBranch");
  const branchClass = state.branch === state.defaultBranch ? "branch-default" : "branch-working";
  const hasChanges = changedFileCount() > 0;
  const prButton = state.branch === state.defaultBranch
    ? ""
    : state.pullRequest
      ? `<button class="button-secondary external-link-button" type="button" data-action="open-link" data-url="${escapeHtml(state.pullRequest.html_url)}">PR #${state.pullRequest.number}</button>`
      : hasChanges
        ? `<button class="primary" type="button" data-action="prepare-pr">${t("common.createPr")}</button>`
        : "";

  return `
    <div class="branch-control">
      <span class="status-pill ${branchClass}">${branchKind}</span>
      <select id="branch-select" class="top-branch-select" aria-label="${t("toolbar.currentBranch")}">${branchOptions}</select>
      <span class="status-pill status-sha" title="${t("common.headTitle")}">head ${escapeHtml(shortSha(state.headSha))}</span>
    </div>
    ${prButton}
    <button class="icon-button button-quiet refresh-button" type="button" data-action="refresh" title="${t("toolbar.refreshGithub")}" aria-label="${t("toolbar.refreshGithub")}">${treeIconSvg("refresh")}</button>
  `;
}

function renderContent() {
  if (!state.token) {
    return `${renderConnectionError()}${renderWelcome(t("repo.loginPrompt"))}`;
  }

  if (!state.owner || !state.repo || !state.headSha) {
    return renderConnectionStatus();
  }

  return `
    ${renderConnectionError()}
    ${renderWorkflowBanners()}
    ${state.treeTruncated ? `<p class="banner warn">${t("repo.treeTruncated")}</p>` : ""}
    ${renderTabs()}
    <div class="tab-content tab-content-${escapeHtml(state.tab)}">
      ${state.tab === "files" ? renderFilesTab() : ""}
      ${state.tab === "changes" ? renderChangesTab() : ""}
      ${state.tab === "commits" ? renderCommitsTab() : ""}
      ${state.tab === "actions" ? renderActionsTab() : ""}
    </div>
  `;
}

function renderConnectionStatus() {
  const hasError = Boolean(state.connectionError);
  const progress = state.busyProgress;
  const title = hasError
    ? t("repo.connectionFailed")
    : progress?.label || state.busyLabel || t("repo.connecting");
  const total = Math.max(0, Number(progress?.total || 0));
  const current = clamp(Number(progress?.current || 0), 0, total || 0);
  const remaining = Math.max(0, total - current);
  const percent = total ? Math.round((current / total) * 100) : 0;
  const detail = hasError
    ? state.connectionError
    : total
      ? t("repo.loadingStartupContentProgress", { current, total, remaining })
      : t("repo.connectionInProgress");

  return `
    <section class="connection-status ${hasError ? "is-error" : "is-loading"}" role="status" aria-live="polite">
      <div class="connection-status-indicator" aria-hidden="true"></div>
      <h2>${escapeHtml(title)}</h2>
      <p>${escapeHtml(detail)}</p>
      ${
        hasError
          ? `<div class="button-row">
              <button class="primary" type="button" data-action="login">${t("auth.changeToken")}</button>
              <button type="button" data-action="refresh">${t("common.refresh")}</button>
            </div>`
          : `<div class="connection-status-progress ${total ? "" : "is-indeterminate"}" aria-label="${escapeHtml(detail)}"><span style="width: ${percent}%"></span></div>`
      }
    </section>
  `;
}

function renderConnectionError() {
  return state.connectionError
    ? `
      <div class="banner danger dismissible">
        <span>${escapeHtml(state.connectionError)}</span>
        <button class="dismiss-button" type="button" data-action="dismiss-connection-error" aria-label="${t("common.closeError")}">×</button>
      </div>
    `
    : "";
}

function renderWelcome(message) {
  if (!state.token) {
    return renderLoginScreen(message);
  }

  return `
    <p class="banner info">${escapeHtml(message)}</p>
    <div class="split">
      <section class="panel">
        <div class="panel-header"><h2>${t("workflow.title")}</h2></div>
        <div class="panel-body">
          <div class="list">
            <div class="row"><div class="row-main"><p class="row-title">${t("workflow.step1Title")}</p><p class="help">${t("workflow.step1Help")}</p></div></div>
            <div class="row"><div class="row-main"><p class="row-title">${t("workflow.step2Title")}</p><p class="help">${t("workflow.step2Help")}</p></div></div>
            <div class="row"><div class="row-main"><p class="row-title">${t("workflow.step3Title")}</p><p class="help">${t("workflow.step3Help")}</p></div></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>${t("workflow.permissionsTitle")}</h2></div>
        <div class="panel-body">
          <p class="help">${t("workflow.permissionsHelp")}</p>
        </div>
      </section>
    </div>
  `;
}

function renderLoginScreen(message) {
  return `
    <section class="login-screen">
      <form class="login-card" data-form="auth">
        <div class="login-card-main">
          <div class="login-card-header">
            <h1>${t("auth.title")}</h1>
            <p>${escapeHtml(message)}</p>
          </div>
          <div class="field">
            <label for="token">${t("auth.tokenLabel")}</label>
            <input id="token" name="token" type="password" autocomplete="off" placeholder="${escapeHtml(t("auth.tokenHint"))}" autofocus />
          </div>
          <div class="login-help">
            <p>${t("auth.fixedRepo", { repo: `<span class="path">${escapeHtml(FIXED_REPOSITORY)}</span>`, branch: `<span class="path">${escapeHtml(FIXED_DEFAULT_BRANCH)}</span>` })}</p>
            <p>${t("auth.minimumPermissions")}</p>
            <p>${t("auth.tokenRepoScope")}</p>
            <p><a href="https://github.com/settings/personal-access-tokens" target="_blank" rel="noopener noreferrer">${t("auth.openTokenSettings")}</a></p>
          </div>
        </div>
        <figure class="login-permissions-example">
          <figcaption>
            <strong>${t("auth.permissionsExampleTitle")}</strong>
            <span>${t("auth.permissionsExampleBody")}</span>
          </figcaption>
          <button
            class="login-permissions-trigger"
            type="button"
            data-action="open-modal"
            data-modal="image-preview"
            data-image-src="assets/permissions-example.svg"
            data-image-alt="${escapeHtml(t("auth.permissionsExampleBody"))}"
            aria-label="${escapeHtml(t("auth.permissionsZoom"))}"
          >
            <img src="assets/permissions-example.svg" alt="${escapeHtml(t("auth.permissionsExampleBody"))}" loading="lazy" />
            <span class="login-permissions-zoom">${t("auth.permissionsZoom")}</span>
          </button>
        </figure>
        <button class="primary" type="submit">${t("auth.saveToken")}</button>
      </form>
    </section>
  `;
}

function renderWorkflowBanners() {
  return renderPostPushStatus();
}

function renderPostPushStatus() {
  if (!state.lastSave || state.branch === state.defaultBranch) {
    return "";
  }

  const statusItems = actionStatusItems();
  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger");
  const running = statusItems.filter((run) => run.status && run.status !== "completed");
  const source = actionStatusSource();

  if (failing.length) {
    return `<p class="banner danger">${t("actions.afterCommitFailing", { count: failing.length, source })}</p>`;
  }

  if (running.length) {
    return `<p class="banner warn">${t("actions.afterCommitRunning", { count: running.length, source })}</p>`;
  }

  return renderAutomationFilesBanner();
}

function renderAutomationFilesBanner() {
  const files = state.externalCompare?.files || [];
  if (!state.lastSave || !files.length) {
    return "";
  }

  if (state.dismissedAutomationBannerKey === automationBannerKey()) {
    return "";
  }

  const fileLinks = files
    .map(
      (file) => {
        const status = normalizeFileStatus(file.status);
        const iconClass = fileIconClass(file.filename);
        const content = `
          <span class="tree-icon tree-icon-lucide tree-icon-file file-link-icon ${escapeHtml(iconClass)}" aria-hidden="true">${treeIconSvg(iconClass)}</span>
          <span class="path">${escapeHtml(file.filename)}</span>
          <span class="tag status-${escapeHtml(status)}">${escapeHtml(formatFileStatusLabel(file.status))}</span>
        `;
        return status === "removed"
          ? `<div class="file-link file-link-static">${content}</div>`
          : `<button class="file-link" type="button" data-action="preview-file" data-path="${escapeHtml(file.filename)}">${content}</button>`;
      },
    )
    .join("");

  return `
    <div class="banner info automation-files-banner dismissible">
      <div>
        <p>${t("actions.automationFiles", { sha: shortSha(state.lastSave.commitSha) })}</p>
        ${fileLinks ? `<div class="file-link-list">${fileLinks}</div>` : `<p class="help">${t("actions.automationOnlyMissing")}</p>`}
      </div>
      <button class="dismiss-button" type="button" data-action="dismiss-automation-banner" aria-label="${t("actions.closeAutomation")}">×</button>
    </div>
  `;
}

function automationBannerKey() {
  return [state.branch, state.lastSave?.commitSha || "", state.headSha || ""].join(":");
}

function normalizeFileStatus(status) {
  const clean = String(status || "").toLowerCase();
  if (clean === "added" || clean === "modified" || clean === "removed" || clean === "deleted") {
    return clean === "deleted" ? "removed" : clean;
  }
  return "other";
}

function formatFileStatusLabel(status) {
  const normalized = normalizeFileStatus(status);
  const translated = t(`status.file.${normalized}`);
  return translated === `status.file.${normalized}` ? String(status || normalized) : translated;
}

function normalizeRunStatus(status) {
  return String(status || "")
    .trim()
    .toLowerCase()
    .replace(/-/g, "_");
}

function formatRunStatusLabel(status) {
  const normalized = normalizeRunStatus(status);
  if (!normalized) {
    return "";
  }
  const translated = t(`status.run.${normalized}`);
  return translated === `status.run.${normalized}` ? String(status) : translated;
}

function renderTabs() {
  const tabs = [
    ["files", t("tabs.files")],
    ["changes", t("tabs.changes")],
    ["commits", t("tabs.commits")],
    ["actions", t("tabs.actions")],
  ];
  return `
    <nav class="tabbar" aria-label="${t("tabs.sections")}">
      <div class="tabbar-tabs">
        ${tabs
          .map(([id, label]) => `<button type="button" class="${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${renderTabBadge(id)}</button>`)
          .join("")}
      </div>
      <div class="tabbar-status">${summarizeChecks()}</div>
    </nav>
  `;
}

function renderTabBadge(tabId) {
  if (tabId === "files") {
    return `<span class="tab-badge">${escapeHtml(state.files.length)}</span>`;
  }

  if (tabId === "changes") {
    const count = changedFileCount();
    return count ? `<span class="tab-badge">${escapeHtml(count)}</span>` : "";
  }

  if (tabId === "commits") {
    const count = commitCount();
    return count ? `<span class="tab-badge">${escapeHtml(count)}</span>` : "";
  }

  if (tabId === "actions") {
    return renderActionsTabBadge();
  }

  return "";
}

function renderActionsTabBadge() {
  if (!state.workflowRuns.length) {
    return state.actionPolling ? `<span class="tab-badge warn">...</span>` : "";
  }

  return `<span class="tab-badge">${escapeHtml(state.workflowRuns.length)}</span>`;
}

function changedFileCount() {
  return changedFilesForBranch().length;
}

function changedFilesForBranch() {
  return state.compare?.files?.length ? state.compare.files : state.pullFiles || [];
}

function changedFileStatusByPath() {
  const statuses = new Map();
  for (const file of changedFilesForBranch()) {
    if (file.filename) {
      statuses.set(file.filename, normalizeFileStatus(file.status));
    }
  }
  return statuses;
}

function commitsForBranch() {
  return state.pullCommits.length ? state.pullCommits : state.compare?.commits || [];
}

function commitCount() {
  return commitsForBranch().length;
}

function renderFilesTab() {
  const currentDir = currentDirectoryPath();
  const canDeleteFolder = state.editMode && Boolean(currentDir) && !state.selectedPath && filesInDirectory(currentDir).length > 0;
  return `
    <div class="workbench files-workbench ${state.treePaneResizing ? "is-resizing" : ""}" style="--tree-pane-width: ${state.treePaneWidth}px;">
      <section class="panel tree-panel">
        <div class="panel-body">
          ${
            state.editMode
              ? `<div class="tree-actions">
                  <div class="current-dir">${t("files.currentFolder", { dir: "" })}<span class="path">${escapeHtml(currentDir || "/")}</span></div>
                  <div class="button-row">
                    <button type="button" data-action="open-modal" data-modal="create-text-file">${t("files.newMarkdown")}</button>
                    <button type="button" data-action="open-modal" data-modal="create-folder">${t("files.newFolder")}</button>
                    ${
                      canDeleteFolder
                        ? `<button class="danger" type="button" data-action="delete-folder">${t("files.deleteFolder")}</button>`
                        : ""
                    }
                  </div>
                </div>`
              : ""
          }
          ${renderFileList()}
        </div>
      </section>
      <div class="tree-splitter" role="separator" aria-orientation="vertical" aria-label="${t("files.resizeTree")}" aria-valuemin="${MIN_TREE_PANE_WIDTH}" aria-valuenow="${state.treePaneWidth}" tabindex="0" data-resize="tree-pane"></div>
      <section class="panel editor-panel">
        <div class="panel-header">
          <div class="panel-header-main">
            ${renderSelectedFileHeading()}
            <div class="button-row panel-actions">
              ${renderDiscussionHeaderActions()}
              ${state.editor?.dirty ? `<span class="tag warn">${t("files.unsaved")}</span>` : ""}
              ${
                state.editMode && state.selectedPath
                  ? `<button class="danger" type="button" data-action="delete-file">${t("files.delete")}</button>`
                  : ""
              }
            </div>
          </div>
          ${renderSelectedFileMeta()}
        </div>
        <div class="panel-body">${renderEditor()}</div>
      </section>
    </div>
  `;
}

function renderSelectedFileHeading() {
  const label = state.selectedPath ? state.selectedPath : t("files.editor");
  const selectedStatus = state.selectedPath ? changedFileStatusByPath().get(state.selectedPath) || "" : "";
  const hasFrontMatter = selectedFrontMatterEntries().length > 0;
  return `
    <div class="selected-file-heading">
      <div class="selected-file-heading-row">
        ${
          hasFrontMatter
            ? `<button
                class="icon-button button-quiet frontmatter-toggle"
                type="button"
                data-action="toggle-frontmatter"
                title="${escapeHtml(t("common.frontMatter"))}"
                aria-label="${escapeHtml(t("common.frontMatter"))}"
                aria-expanded="${state.frontMatterOpen ? "true" : "false"}"
              >${treeIconSvg("info")}</button>`
            : ""
        }
        <h2>${escapeHtml(label)}</h2>
        ${selectedStatus ? `<span class="tag status-${escapeHtml(selectedStatus)}">${escapeHtml(formatFileStatusLabel(selectedStatus))}</span>` : ""}
      </div>
    </div>
  `;
}

function renderSelectedFileMeta() {
  const frontMatter = selectedFrontMatterEntries();
  if (!frontMatter.length || !state.frontMatterOpen) {
    return "";
  }
  return `<div class="panel-header-meta">${renderFrontMatterPanel(frontMatter)}</div>`;
}

function renderDiscussionHeaderActions(context = selectedDiscussionContext()) {
  if (!state.selectedPath) {
    return "";
  }

  const buttons = [];

  if (canEditSelectedFile()) {
    if (state.editMode) {
      buttons.push(renderHeaderActionButton("button-secondary", "leave-edit-session", "preview", t("toolbar.backToPreview")));
    } else {
      buttons.push(renderHeaderActionButton("primary", "start-edit-session", "edit", t("common.edit")));
    }
  }

  if (!state.editMode && context.supported) {
    buttons.push(renderHeaderActionButton("", "open-discourse-topic", "search", t("discussion.openTopic")));
    buttons.push(renderHeaderActionButton("primary", "open-discourse-composer", "discussion", t("discussion.createTopic")));
  }

  return buttons.join("");
}

function renderHeaderActionButton(className, action, icon, label) {
  const classes = ["button-with-icon", className].filter(Boolean).join(" ");
  return `<button class="${classes}" type="button" data-action="${action}">${treeIconSvg(icon)}<span>${escapeHtml(label)}</span></button>`;
}

function canEditSelectedFile() {
  return Boolean(state.selectedPath && isMarkdownPath(state.selectedPath));
}

function renderFileList() {
  syncFrontMatterTitlesFromCache();
  if (state.pathFilter.trim()) {
    return renderSearchResults();
  }

  const files = filteredFiles();
  if (!files.length) {
    return `<div class="empty">${t("files.noMatches")}</div>`;
  }

  const tree = buildFileTree(files);
  const filtering = Boolean(state.pathFilter.trim());
  const changedStatuses = changedFileStatusByPath();

  return `
    <div class="file-list tree-browser" role="tree" aria-label="${t("files.repositoryFiles")}">
      ${renderTreeNodes(tree, 0, filtering, changedStatuses)}
    </div>
  `;
}

function syncFrontMatterTitlesFromCache() {
  let changed = false;
  const files = state.files.map((file) => {
    if (!isMarkdownPath(file.path) || state.frontMatterTitleDraftByPath.has(file.path)) {
      return file;
    }
    const cached = state.frontMatterTitleBySha.get(file.sha);
    if (cached === undefined || file.frontMatterTitle === cached) {
      return file;
    }
    changed = true;
    return { ...file, frontMatterTitle: cached };
  });
  if (changed) {
    state.files = files;
  }
}

function renderSearchResults() {
  const results = searchResults();
  if (!results.length) {
    return `<div class="empty">${t("search.noMatches")}</div>`;
  }

  return `
    <div class="search-results file-list" role="list" aria-label="${t("search.results")}">
      <div class="search-results-summary">
        <span>${t("search.resultCount", { count: results.length })}</span>
      </div>
      ${results.map(renderSearchResult).join("")}
    </div>
  `;
}

function renderSearchResult(result) {
  const file = result.file;
  const displayName = treeFileDisplayName(file);
  const iconClass = fileIconClass(file.path);
  const activeClass = state.selectedPath === file.path ? " active" : "";
  return `
    <button class="search-result${activeClass}" type="button" data-action="select-file" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}">
      <span class="tree-icon tree-icon-lucide tree-icon-file ${escapeHtml(iconClass)}" aria-hidden="true">${treeIconSvg(iconClass)}</span>
      <span class="search-result-main">
        <span class="search-result-title">
          <span>${highlightText(displayName.title, result.query)}</span>
          ${displayName.filename ? `<span class="tree-file-name-muted">(${highlightText(displayName.filename, result.query)})</span>` : ""}
        </span>
        <span class="search-result-path">${highlightText(file.path, result.query)}</span>
        ${result.snippet ? `<span class="search-result-snippet">${result.snippet}</span>` : ""}
      </span>
      <span class="tag search-result-kind">${escapeHtml(t(`search.match.${result.kind}`))}</span>
    </button>
  `;
}

function renderTreeNodes(node, depth, forceExpanded = false, changedStatuses = new Map()) {
  const children = [...node.files, ...node.dirs.values()]
    .filter((child) => !isHiddenRootTreeChild(child, depth))
    .sort(compareTreeChildren);
  if (!children.length) {
    return "";
  }

  return children
    .map((child) => (child.type === "dir" ? renderTreeDirectory(child, depth, forceExpanded, changedStatuses) : renderTreeFile(child, depth, changedStatuses)))
    .join("");
}

function renderTreeDirectory(dir, depth, forceExpanded = false, changedStatuses = new Map()) {
  const expanded = forceExpanded || state.expandedDirs.has(dir.path);
  const fileCount = dir.count || 0;
  const isSelectedAncestor = Boolean(state.selectedPath) && state.selectedPath.startsWith(`${dir.path}/`);
  const isSelectedDir = state.selectedDir === dir.path && !state.selectedPath;
  const displayName = treeDirectoryDisplayName(dir);
  const mutedClass = isLowEmphasisRootDirectory(dir, depth) ? " is-muted-root-dir" : "";
  return `
    <div class="tree-row tree-dir ${isSelectedAncestor ? "contains-active" : ""} ${isSelectedDir ? "active-dir" : ""}${mutedClass}" role="treeitem" aria-expanded="${expanded}" style="--depth: ${depth};">
      <button class="tree-toggle" type="button" data-action="toggle-dir" data-path="${escapeHtml(dir.path)}" aria-label="${expanded ? t("files.collapse") : t("files.expand")} ${escapeHtml(dir.name)}">
        <span class="tree-caret" aria-hidden="true">${expanded ? "" : ""}</span>
        <span class="tree-icon tree-icon-lucide tree-icon-dir" aria-hidden="true">${treeIconSvg("folder")}</span>
        <span class="tree-label">
          <span class="path">
            ${escapeHtml(displayName.title)}
            ${displayName.filename ? `<span class="tree-file-name-muted">(${escapeHtml(displayName.filename)})</span>` : ""}
          </span>
        </span>
        <span class="tree-size">${fileCount} ${t("common.files")}</span>
      </button>
    </div>
    ${expanded ? renderTreeNodes(dir, depth + 1, forceExpanded, changedStatuses) : ""}
  `;
}

function renderTreeFile(file, depth, changedStatuses = new Map()) {
  const displayName = treeFileDisplayName(file);
  const changedStatus = changedStatuses.get(file.path) || "";
  const changedClass = changedStatus ? ` is-changed change-${changedStatus}` : "";
  const mutedClass = isLowEmphasisTreeFile(file.path) ? " is-muted-file" : "";
  const iconClass = fileIconClass(file.path);
  return `
    <button class="tree-row tree-file ${state.selectedPath === file.path ? "active" : ""}${changedClass}${mutedClass}" role="treeitem" type="button" data-action="select-file" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}" style="--depth: ${depth};">
      <span class="tree-change-slot" aria-hidden="true">${changedStatus ? `<span class="tree-change-marker"></span>` : ""}</span>
      <span class="tree-icon tree-icon-lucide tree-icon-file ${escapeHtml(iconClass)}" aria-hidden="true">${treeIconSvg(iconClass)}</span>
      <span class="tree-label">
        <span class="path">
          ${escapeHtml(displayName.title)}
          ${displayName.filename ? `<span class="tree-file-name-muted">(${escapeHtml(displayName.filename)})</span>` : ""}
        </span>
      </span>
    </button>
  `;
}

function treeFileDisplayName(file) {
  const title = markdownDisplayTitle(file);
  return title ? { title, filename: "" } : { title: file.name, filename: "" };
}

function treeDirectoryDisplayName(dir) {
  const readme = directoryReadmeEntry(dir.path);
  const title = markdownDisplayTitle(readme);
  return title ? { title, filename: "" } : { title: dir.name, filename: "" };
}

function directoryReadmeEntry(dirPath) {
  const readmePath = dirPath ? `${dirPath}/README.md` : "README.md";
  return state.files.find((file) => file.path === readmePath) || null;
}

function markdownDisplayTitle(file) {
  if (!file) {
    return "";
  }
  return normalizeFrontMatterTitle(file.frontMatterTitle || "");
}

function isLowEmphasisRootDirectory(dir, depth) {
  return depth === 0 && !["capabilities", "content"].includes(dir.name);
}

function fileIconClass(path) {
  if (isRozcestnikPath(path)) {
    return "tree-icon-rozcestnik";
  }
  if (isReadmePath(path)) {
    return "tree-icon-home";
  }

  const ext = extensionOf(path);
  if (["md", "mdx"].includes(ext)) {
    return "tree-icon-md";
  }
  if (["html", "htm"].includes(ext)) {
    return "tree-icon-html";
  }
  if (ext === "svg") {
    return "tree-icon-svg";
  }
  if (ext === "pdf") {
    return "tree-icon-pdf";
  }
  if (ext === "txt") {
    return "tree-icon-text";
  }
  if (["json", "yaml", "yml", "toml", "csv"].includes(ext)) {
    return "tree-icon-data";
  }
  if (["css", "js", "mjs", "ts", "tsx", "jsx", "astro"].includes(ext)) {
    return "tree-icon-code";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext)) {
    return "tree-icon-image";
  }
  return "";
}

function isRozcestnikPath(path) {
  return String(path || "").toLowerCase().endsWith("/rozcestnik.md") || String(path || "").toLowerCase() === "rozcestnik.md";
}

function treeIconSvg(iconClass) {
  const attrs = 'viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
  const fileBase = '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"></path><path d="M14 2v4a2 2 0 0 0 2 2h4"></path>';
  const icons = {
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"></path>',
    "tree-icon-home":
      '<path d="m3 10 9-7 9 7"></path><path d="M5 10v10a1 1 0 0 0 1 1h5v-7h2v7h5a1 1 0 0 0 1-1V10"></path>',
    "tree-icon-rozcestnik":
      '<path d="M12 3v18"></path><path d="M12 7h5.5a2 2 0 0 0 1.4-.6l1.1-1.1"></path><path d="M12 11H6.5a2 2 0 0 1-1.4-.6L4 9.3"></path><path d="M12 15h4.5a2 2 0 0 1 1.4.6l1.1 1.1"></path><path d="M12 8.5l-2-2"></path><path d="M12 12.5l2-2"></path><path d="M12 16.5l-2 2"></path>',
    "tree-icon-md": `${fileBase}<path d="M8 13v4"></path><path d="M8 13l2 2 2-2"></path><path d="M12 13v4"></path><path d="M16 13v4"></path><path d="M14 15h4"></path>`,
    "tree-icon-html": `${fileBase}<path d="m10 13-2 2 2 2"></path><path d="m14 13 2 2-2 2"></path>`,
    "tree-icon-svg": `${fileBase}<circle cx="12" cy="15" r="3"></circle><path d="M12 12v-2"></path><path d="M9.4 16.5l-1.7 1"></path><path d="M14.6 16.5l1.7 1"></path>`,
    "tree-icon-pdf": `${fileBase}<path d="M8 17h1.5a1.5 1.5 0 0 0 0-3H8v4"></path><path d="M12.5 14v4h1a2 2 0 0 0 0-4h-1Z"></path><path d="M17 18v-4h2"></path><path d="M17 16h1.6"></path>`,
    "tree-icon-text": `${fileBase}<path d="M8 13h8"></path><path d="M8 17h6"></path>`,
    "tree-icon-data": `${fileBase}<path d="M10 13H9a1 1 0 0 0-1 1v1a1 1 0 0 1-1 1 1 1 0 0 1 1 1v1a1 1 0 0 0 1 1h1"></path><path d="M14 13h1a1 1 0 0 1 1 1v1a1 1 0 0 0 1 1 1 1 0 0 0-1 1v1a1 1 0 0 1-1 1h-1"></path>`,
    "tree-icon-code": `${fileBase}<path d="m10 13-2 2 2 2"></path><path d="m14 13 2 2-2 2"></path>`,
    "tree-icon-image": `${fileBase}<circle cx="10" cy="13" r="1"></circle><path d="m8 18 2.4-2.4a1 1 0 0 1 1.4 0L14 17l1-1a1 1 0 0 1 1.4 0L18 18"></path>`,
    discussion: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"></path><path d="M8 9h8"></path><path d="M8 13h5"></path>',
    edit: '<path d="M12 20h9"></path><path d="m16.5 3.5 4 4"></path><path d="M3 17.3V21h3.7L18.9 8.8a2.8 2.8 0 1 0-4-4Z"></path>',
    info: '<circle cx="12" cy="12" r="9"></circle><path d="M12 10v6"></path><path d="M12 7.5h.01"></path>',
    preview: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6Z"></path><circle cx="12" cy="12" r="3"></circle>',
    refresh: '<path d="M21 12a9 9 0 0 1-15.6 6.1L3 16"></path><path d="M3 21v-5h5"></path><path d="M3 12A9 9 0 0 1 18.6 5.9L21 8"></path><path d="M21 3v5h-5"></path>',
    search: '<path d="m21 21-4.34-4.34"></path><circle cx="11" cy="11" r="8"></circle>',
    file: fileBase,
  };
  return `<svg ${attrs}>${icons[iconClass] || icons.file}</svg>`;
}

function isLowEmphasisTreeFile(path) {
  if (isAgentsPath(path)) {
    return true;
  }
  const ext = extensionOf(path);
  return !["md", "mdx", "html", "htm", "svg", "pdf", "png", "jpg", "jpeg", "gif", "webp", "avif"].includes(ext);
}

function renderEditor() {
  if (!state.editor) {
    return `<div class="empty">${t("files.selectFileEmpty")}</div>`;
  }

  if (!state.editMode) {
    return renderBrowsePreview();
  }

  if (!isMarkdownPath(state.editor.path)) {
    return `
      <div class="browse-preview">
        <p class="banner warn">${t("files.readOnlyMarkdownOnly")}</p>
        ${renderPreviewPane("full")}
      </div>
    `;
  }

  return `
    <form data-form="save-file">
      <div>
        <textarea id="editor-content" name="content" class="editor-textarea editor-textarea-full" spellcheck="false">${escapeHtml(state.editor.content)}</textarea>
        <div class="field" style="margin-top: 10px;">
          <label for="message">${t("files.commitMessage")}</label>
          <input id="message" name="message" placeholder="CMS: update ${escapeHtml(state.editor.path)}" />
        </div>
        <div class="button-row" style="margin-top: 10px;">
          <button class="primary" type="submit">${t("files.saveCommit")}</button>
        </div>
        <p class="help" style="margin-top: 10px;">${t("files.editPreviewHelp")}</p>
      </div>
    </form>
  `;
}

function renderBrowsePreview() {
  if (!state.preview) {
    return `<div class="empty">${t("files.previewNotLoaded")}</div>`;
  }

  if (state.editor && isMarkdownPath(state.editor.path)) {
    return `
      <div class="browse-preview">
        <article class="markdown-preview">${renderMarkdown(state.editor.content)}</article>
      </div>
    `;
  }

  return `
    <div class="browse-preview">
      ${renderPreviewPane("full")}
    </div>
  `;
}

function renderPreviewPane(mode = "") {
  if (!state.preview) {
    return `<div class="empty">${t("files.previewNotLoaded")}</div>`;
  }

  const fullClass = mode === "full" ? " preview-full" : "";

  if (state.preview.kind === "html") {
    return `<iframe class="preview-frame${fullClass}" title="HTML preview" sandbox="" srcdoc="${escapeHtml(state.preview.html || "")}"></iframe>`;
  }

  if (state.preview.kind === "image") {
    const alt = `Preview ${state.preview.path}`;
    return `
      <button
        class="preview-image-trigger${fullClass}"
        type="button"
        data-action="open-modal"
        data-modal="image-preview"
        data-image-src="${escapeHtml(state.preview.url)}"
        data-image-alt="${escapeHtml(alt)}"
        aria-label="${escapeHtml(t("files.zoomImage"))}"
      >
        <img class="preview-image${fullClass}" alt="${escapeHtml(alt)}" src="${escapeHtml(state.preview.url)}" />
        <span class="preview-image-zoom">${t("files.zoomImage")}</span>
      </button>
    `;
  }

  if (state.preview.kind === "pdf") {
    return `<object class="preview-object${fullClass}" data="${escapeHtml(state.preview.url)}" type="application/pdf"><a href="${escapeHtml(state.preview.url)}" download>${t("files.downloadPdf")}</a></object>`;
  }

  return `<pre class="preview-code${fullClass}">${escapeHtml(state.preview.text || "")}</pre>`;
}

function renderMarkdown(markdown) {
  const parsed = splitFrontMatter(markdown);
  const lines = parsed.body.replace(/\r\n/g, "\n").split("\n");
  const html = [];
  let paragraph = [];
  let list = null;
  let inCode = false;
  let codeLines = [];
  let blockquote = [];

  const flushParagraph = () => {
    if (!paragraph.length) {
      return;
    }
    html.push(`<p>${renderMarkdownInline(paragraph.join(" "))}</p>`);
    paragraph = [];
  };

  const flushList = () => {
    if (!list?.items?.length) {
      return;
    }
    const tag = list.type === "ol" ? "ol" : "ul";
    html.push(`<${tag}>${list.items.map((item) => `<li>${renderMarkdownInline(item)}</li>`).join("")}</${tag}>`);
    list = null;
  };

  const flushBlockquote = () => {
    if (!blockquote.length) {
      return;
    }
    html.push(`<blockquote>${blockquote.map((line) => `<p>${renderMarkdownInline(line)}</p>`).join("")}</blockquote>`);
    blockquote = [];
  };

  const flushBlocks = () => {
    flushParagraph();
    flushList();
    flushBlockquote();
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.trim().startsWith("```")) {
      if (inCode) {
        html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
        codeLines = [];
        inCode = false;
      } else {
        flushBlocks();
        inCode = true;
      }
      continue;
    }

    if (inCode) {
      codeLines.push(line);
      continue;
    }

    if (!line.trim()) {
      flushBlocks();
      continue;
    }

    if (/^\s*<!--.*-->\s*$/.test(line)) {
      flushBlocks();
      continue;
    }

    if (/^\s*---+\s*$/.test(line)) {
      flushBlocks();
      html.push("<hr />");
      continue;
    }

    const heading = line.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      flushBlocks();
      const level = heading[1].length;
      const id = slugifyMarkdownHeading(heading[2]);
      html.push(`<h${level} id="${escapeHtml(id)}">${renderMarkdownInline(heading[2])}</h${level}>`);
      continue;
    }

    if (line.includes("|") && lines[index + 1] && isMarkdownTableSeparator(lines[index + 1])) {
      flushBlocks();
      const tableLines = [line];
      index += 2;
      while (index < lines.length && lines[index].includes("|") && lines[index].trim()) {
        tableLines.push(lines[index]);
        index += 1;
      }
      index -= 1;
      html.push(renderMarkdownTable(tableLines));
      continue;
    }

    const quote = line.match(/^\s*>\s?(.*)$/);
    if (quote) {
      flushParagraph();
      flushList();
      blockquote.push(quote[1]);
      continue;
    }

    const unordered = line.match(/^\s*[-*]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushBlockquote();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }

    const ordered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushBlockquote();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }

    flushList();
    flushBlockquote();
    paragraph.push(line.trim());
  }

  flushBlocks();

  if (inCode) {
    html.push(`<pre><code>${escapeHtml(codeLines.join("\n"))}</code></pre>`);
  }

  return html.join("");
}

function renderMarkdownInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\((?:&lt;(.+?)&gt;|([^)\s]+))(?:\s+&quot;[^&]*&quot;)?\)/g,
      (match, label, bracketedHref, plainHref) => renderMarkdownLink(label, bracketedHref || plainHref) || match,
    );
}

function slugifyMarkdownHeading(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-");
}

function normalizeMarkdownAnchor(anchor) {
  const decoded = decodeMarkdownHref(anchor);
  return slugifyMarkdownHeading(decoded) || decoded;
}

function renderMarkdownLink(label, href) {
  const safeHref = normalizeMarkdownHref(href);
  if (!safeHref) {
    return "";
  }

  const external = /^(https?:|mailto:)/i.test(safeHref);
  if (external) {
    return `<a href="${escapeHtml(safeHref)}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  }

  const target = resolveMarkdownLinkTarget(safeHref);
  if (target.anchorOnly) {
    const anchor = normalizeMarkdownAnchor(target.anchor);
    return `<a href="#${escapeHtml(anchor)}" data-action="open-markdown-link" data-anchor="${escapeHtml(target.anchor)}">${label}</a>`;
  }

  if (target.path) {
    const anchor = target.anchor ? normalizeMarkdownAnchor(target.anchor) : "";
    const href = internalSelectionHref({ path: target.path, anchor });
    return `<a href="${escapeHtml(href)}" data-action="open-markdown-link" data-path="${escapeHtml(target.path)}" data-anchor="${escapeHtml(target.anchor || "")}">${label}</a>`;
  }

  if (target.dir) {
    const href = internalSelectionHref({ dir: target.dir });
    return `<a href="${escapeHtml(href)}" data-action="open-markdown-dir-link" data-path="${escapeHtml(target.dir)}">${label}</a>`;
  }

  return `<a href="#" data-action="missing-markdown-link" data-href="${escapeHtml(safeHref)}">${label}</a>`;
}

function internalSelectionHref({ path = "", dir = "", anchor = "" } = {}) {
  const url = new URL(window.location.href);
  if (state.branch) {
    url.searchParams.set("branch", state.branch);
  }
  if (path) {
    url.searchParams.set("path", path);
    url.searchParams.delete("dir");
  } else if (dir) {
    url.searchParams.set("dir", dir);
    url.searchParams.delete("path");
  }
  url.hash = anchor ? `#${anchor}` : "";
  return `${url.pathname}${url.search}${url.hash}`;
}

function normalizeMarkdownHref(href) {
  const clean = String(href || "").trim();
  if (!clean) {
    return "";
  }

  const decoded = clean
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');

  if (/^(javascript|data|vbscript):/i.test(decoded)) {
    return "";
  }

  if (/^(https?:|mailto:)/i.test(decoded) || decoded.startsWith("#") || decoded.startsWith("/") || decoded.startsWith("./") || decoded.startsWith("../")) {
    return decoded;
  }

  if (/^[^\u0000-\u001F\u007F<>"]+$/.test(decoded)) {
    return decoded;
  }

  return "";
}

function resolveMarkdownLinkTarget(href) {
  const [rawPath, anchor = ""] = href.split("#");
  if (!rawPath) {
    return { anchorOnly: true, anchor };
  }

  const cleanPath = rawPath.split("?")[0];
  const resolved = normalizePath(resolveRepoRelativePath(cleanPath, state.editor?.path || "")).replace(/\/+$/g, "");
  if (state.files.some((file) => file.path === resolved)) {
    return { path: resolved, anchor };
  }

  if (directoryExists(resolved)) {
    return { dir: resolved, anchor };
  }

  const candidates = [
    `${resolved}.md`,
    `${resolved}.mdx`,
    `${resolved}/index.md`,
    `${resolved}/index.mdx`,
  ];
  const match = candidates.find((candidate) => state.files.some((file) => file.path === candidate));
  return match ? { path: match, anchor } : { path: "", anchor };
}

function resolveRepoRelativePath(target, fromPath) {
  const decoded = decodeMarkdownHref(target).replace(/^\/+/, "");
  if (!decoded || decoded.startsWith("#")) {
    return "";
  }

  if (!fromPath || target.startsWith("/")) {
    return normalizePath(decoded);
  }

  const baseParts = fromPath.includes("/") ? fromPath.split("/").slice(0, -1) : [];
  const parts = [...baseParts, ...decoded.split("/")];
  const stack = [];

  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }

  return stack.join("/");
}

function decodeMarkdownHref(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function splitFrontMatter(markdown) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) {
    return { frontMatter: [], body: source };
  }

  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    return { frontMatter: [], body: source };
  }

  const raw = source.slice(4, end).trim();
  const bodyStart = source.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : source.slice(bodyStart + 1);
  return {
    frontMatter: parseFrontMatter(raw),
    body,
  };
}

function parseFrontMatter(raw) {
  const entries = [];
  let current = null;

  for (const line of raw.split("\n")) {
    const pair = line.match(/^([A-Za-z0-9_.-]+):\s*(.*)$/);
    const listItem = line.match(/^\s*-\s+(.+)$/);

    if (pair) {
      current = { key: pair[1], value: pair[2] || "" };
      entries.push(current);
      continue;
    }

    if (listItem && current) {
      current.value = current.value ? `${current.value}, ${listItem[1]}` : listItem[1];
    }
  }

  return entries;
}

function selectedFrontMatterEntries() {
  if (!state.selectedPath || !state.editor || !isMarkdownPath(state.selectedPath)) {
    return [];
  }
  return splitFrontMatter(state.editor.content || "").frontMatter;
}

function renderFrontMatterPanel(entries) {
  if (!entries.length) {
    return "";
  }

  return `
    <div class="frontmatter-panel">
      <dl>
        ${entries
          .map((entry) => `<div><dt>${escapeHtml(entry.key)}</dt><dd>${renderMarkdownInline(entry.value)}</dd></div>`)
          .join("")}
      </dl>
    </div>
  `;
}

function isMarkdownTableSeparator(line) {
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function renderMarkdownTable(lines) {
  const rows = lines.map(splitMarkdownTableRow);
  const [head, ...body] = rows;
  return `
    <table>
      <thead><tr>${head.map((cell) => `<th>${renderMarkdownInline(cell)}</th>`).join("")}</tr></thead>
      <tbody>${body.map((row) => `<tr>${row.map((cell) => `<td>${renderMarkdownInline(cell)}</td>`).join("")}</tr>`).join("")}</tbody>
    </table>
  `;
}

function splitMarkdownTableRow(line) {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
}

function renderChangesTab() {
  if (state.branch === state.defaultBranch) {
    return `<p class="banner info">${t("changes.defaultBranchInfo", { branch: state.defaultBranch })}</p>`;
  }

  const files = changedFilesForBranch();
  const externalFiles = state.externalCompare?.files || [];
  return `
    ${renderBranchCompareBanner()}
    <section class="panel">
      <div class="panel-header">
        <h2>${t("changes.changedFiles")}</h2>
        <span class="tag">${t("changes.fileCount", { count: files.length })}</span>
      </div>
      <div class="panel-body">${renderChangedFiles(files)}</div>
    </section>
    ${
      externalFiles.length
        ? `<p class="banner warn" style="margin-top: 10px;">${t("changes.changedAfterLastCommit")}</p>
          <section class="panel" style="margin-top: 10px;">
            <div class="panel-header">
              <h2>${t("changes.changesAfterLastCommit")}</h2>
              <span class="tag warn">${t("changes.fileCount", { count: externalFiles.length })}</span>
            </div>
            <div class="panel-body">${renderChangedFiles(externalFiles)}</div>
          </section>`
        : ""
    }
  `;
}

function renderCommitsTab() {
  if (state.branch === state.defaultBranch) {
    return `<p class="banner info">${t("commits.defaultBranchInfo")}</p>`;
  }

  return `
    ${renderBranchCompareBanner()}
    <section class="panel">
      <div class="panel-header">
        <h2>${t("commits.branchCommits")}</h2>
        <span class="tag">${t("commits.commitCount", { count: commitCount() })}</span>
      </div>
      <div class="panel-body">${renderCommitList()}</div>
    </section>
  `;
}

function renderBranchCompareBanner() {
  if (!state.compare) {
    return `<p class="banner info">${t("changes.branchDataMissing")}</p>`;
  }
  const detail = state.pullRequest
    ? t("changes.prOpen", { number: state.pullRequest.number })
    : changedFileCount()
      ? t("changes.prCanCreate")
      : t("changes.noPrNeeded");

  return `
    <p class="banner info">
      ${t("changes.branchCompare", { ahead: state.compare.ahead_by || 0, behind: state.compare.behind_by || 0, branch: state.defaultBranch, detail })}
    </p>
  `;
}

function renderChangedFiles(files) {
  if (!files.length) {
    return `<div class="empty">${t("changes.noChangedFiles")}</div>`;
  }

  return `
    <div class="list" style="margin-top: 10px;">
      ${files
        .map((file) => {
          const canPreview = file.status !== "removed";
          const statusClass = `status-${normalizeFileStatus(file.status)}`;
          const iconClass = fileIconClass(file.filename);
          const title = changedFileFrontMatterTitle(file);
          const fileTitle = canPreview
            ? `<p class="row-title path"><button class="changed-file-link" type="button" data-action="preview-file" data-path="${escapeHtml(file.filename)}">${escapeHtml(file.filename)}</button>${title ? ` <span class="changed-file-title-muted">(${escapeHtml(title)})</span>` : ""}</p>`
            : `<p class="row-title path">${escapeHtml(file.filename)}${title ? ` <span class="changed-file-title-muted">(${escapeHtml(title)})</span>` : ""}</p>`;
          return `
            <div class="row changed-file-row">
              <span class="tree-icon tree-icon-lucide tree-icon-file changed-file-icon ${escapeHtml(iconClass)}" aria-hidden="true">${treeIconSvg(iconClass)}</span>
              <div class="row-main">
                ${fileTitle}
                <div class="row-meta">
                  <span class="tag ${escapeHtml(statusClass)}">${escapeHtml(formatFileStatusLabel(file.status))}</span>
                  <span class="tag ok">+${file.additions || 0}</span>
                  <span class="tag danger">-${file.deletions || 0}</span>
                </div>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function changedFileFrontMatterTitle(file) {
  const entry = state.files.find((candidate) => candidate.path === file.filename);
  return normalizeFrontMatterTitle(entry?.frontMatterTitle || "");
}

function renderCommitList() {
  const commits = state.pullCommits.length ? state.pullCommits : state.compare?.commits || [];
  if (!commits.length) {
    return `<div class="empty">${t("commits.notLoaded")}</div>`;
  }

  return `
    <div class="commit-list">
      ${commits
        .map((commit) => {
          const action = isActionAuthor(commit);
          const message = commit.commit?.message?.split("\n")[0] || commit.sha;
          const author = commit.author?.login || commit.commit?.author?.name || "";
          return `
            <div class="commit ${action ? "action" : ""}">
              <p class="row-title">${escapeHtml(message)}</p>
              <div class="row-meta">
                <span class="tag">${escapeHtml(shortSha(commit.sha))}</span>
                <span class="tag">${escapeHtml(author)}</span>
                ${action ? `<span class="tag warn">${t("commits.automation")}</span>` : ""}
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderActionsTab() {
  return `
    ${renderActionsOverview()}
    <section class="panel">
      <div class="panel-header">
        <h2>${t("actions.branchRuns")}</h2>
        <button type="button" data-action="refresh-actions">${t("common.refresh")}</button>
      </div>
      <div class="panel-body">${renderWorkflowRuns()}</div>
    </section>
  `;
}

function renderActionsOverview() {
  if (!state.lastSave) {
    return `<p class="banner info">${t("actions.firstCommitInfo")}</p>`;
  }

  const statusItems = actionStatusItems();
  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger");
  const running = statusItems.filter((run) => run.status && run.status !== "completed");
  const actionCommits = (state.pullCommits.length ? state.pullCommits : state.compare?.commits || []).filter(isActionAuthor);

  if (failing.length) {
    return `<p class="banner danger">${t("actions.required", { count: failing.length, source: actionStatusSource() })}</p>`;
  }

  if (running.length) {
    return `<p class="banner warn">${t("actions.stillRunning", { count: running.length, source: actionStatusSource() })}</p>`;
  }

  if (state.externalCompare || actionCommits.length) {
    return `<p class="banner warn">${t("actions.automationChanged")}</p>`;
  }

  if (statusItems.length) {
    return `<p class="banner info">${t("actions.done")}</p>`;
  }

  return "";
}

function actionStatusSource() {
  return currentHeadCheckRuns().length ? t("actions.sourceChecks") : t("actions.sourceWorkflowRuns");
}

function renderCheckRuns() {
  if (state.checkRunsError) {
    return `
      <p class="banner warn">${t("actions.checksUnavailable")}</p>
      <p class="help">${escapeHtml(state.checkRunsError)}</p>
    `;
  }

  if (!state.checkRuns.length) {
    return `<div class="empty">${t("actions.noCheckRuns")}</div>`;
  }

  return `
    <div class="list">
      ${state.checkRuns
        .map((run) => {
          const tone = classifyConclusion(run.conclusion, run.status);
          const annotations = state.annotations[run.id] || [];
          return `
            <div class="row">
              <div class="row-main">
                <p class="row-title">${escapeHtml(run.name)}</p>
                <div class="row-meta">
                  <span class="tag ${tone}">${escapeHtml(formatRunStatusLabel(run.conclusion || run.status))}</span>
                  <span class="tag">${escapeHtml(formatDate(run.completed_at || run.started_at))}</span>
                </div>
                ${run.output?.summary ? `<p class="help">${escapeHtml(run.output.summary).slice(0, 400)}</p>` : ""}
                ${annotations.length ? renderAnnotations(annotations) : ""}
              </div>
              <div class="button-row">
                <button type="button" data-action="load-annotations" data-check-id="${run.id}">${t("actions.annotations")}</button>
                <button class="external-link-button" type="button" data-action="open-link" data-url="${escapeHtml(run.html_url)}">${t("common.github")}</button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderWorkflowRuns() {
  if (!state.workflowRuns.length) {
    return `<div class="empty">${t("actions.noWorkflowRuns")}</div>`;
  }

  return `
    <div class="list">
      ${state.workflowRuns
        .map((run) => {
          const tone = classifyConclusion(run.conclusion, run.status);
          return `
            <div class="row">
              <div class="row-main">
                <p class="row-title">${escapeHtml(run.name || run.display_title)}</p>
                <div class="row-meta">
                  <span class="tag ${tone}">${escapeHtml(formatRunStatusLabel(run.conclusion || run.status))}</span>
                  <span class="tag">${escapeHtml(shortSha(run.head_sha))}</span>
                  <span class="tag">${escapeHtml(formatDate(run.updated_at || run.created_at))}</span>
                </div>
              </div>
              <div class="button-row">
                <button type="button" data-action="rerun-workflow" data-run-id="${run.id}">${t("actions.rerun")}</button>
                <button class="external-link-button" type="button" data-action="open-link" data-url="${escapeHtml(run.html_url)}">${t("common.github")}</button>
              </div>
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderAnnotations(annotations) {
  return `
    <div class="annotations">
      ${annotations
        .map((annotation) => {
          const place = [annotation.path, annotation.start_line].filter(Boolean).join(":");
          return `<div class="annotation">${escapeHtml(place)}\n${escapeHtml(annotation.annotation_level || "")}: ${escapeHtml(annotation.message || "")}</div>`;
        })
        .join("")}
    </div>
  `;
}

function renderModal() {
  if (!state.modal) {
    return "";
  }

  const body = {
    auth: renderAuthModal,
    "create-text-file": renderCreateTextFileModal,
    "create-folder": renderCreateFolderModal,
    "create-pr": renderCreatePrModal,
    "image-preview": renderImagePreviewModal,
  }[state.modal.type]?.();

  if (!body) {
    return "";
  }

  return `<div class="modal-backdrop">${body}</div>`;
}

function renderAuthModal() {
  const tokenHint = state.token ? t("auth.tokenStoredHint") : t("auth.tokenHint");
  return `
    <form class="modal" data-form="auth">
      <div class="modal-header"><h2>${t("auth.title")}</h2></div>
      <div class="modal-body form-grid">
        ${renderLanguageSelect("auth")}
        <p class="help">${t("auth.fixedRepo", { repo: `<span class="path">${escapeHtml(FIXED_REPOSITORY)}</span>`, branch: `<span class="path">${escapeHtml(FIXED_DEFAULT_BRANCH)}</span>` })}</p>
        <div class="auth-token-only">
          <div class="field">
            <label for="token">${t("auth.tokenLabel")}</label>
            <input id="token" name="token" type="password" autocomplete="off" placeholder="${escapeHtml(tokenHint)}" autofocus />
          </div>
          <p class="help">${t("auth.minimumPermissions")}</p>
          <p class="help">${t("auth.tokenRepoScope")}</p>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">${t("common.cancel")}</button>
        <button class="primary" type="submit">${t("auth.saveToken")}</button>
      </div>
    </form>
  `;
}

function renderImagePreviewModal() {
  if (!state.modal?.imageSrc) {
    return "";
  }

  return `
    <div class="modal modal-image-preview" role="dialog" aria-modal="true" aria-label="${escapeHtml(t("auth.permissionsExampleTitle"))}">
      <div class="modal-header">
        <h2>${t("auth.permissionsExampleTitle")}</h2>
      </div>
      <div class="modal-body image-preview-body">
        <img src="${escapeHtml(state.modal.imageSrc)}" alt="${escapeHtml(state.modal.imageAlt || t("auth.permissionsExampleBody"))}" />
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">${t("common.close")}</button>
      </div>
    </div>
  `;
}

function renderCreateTextFileModal() {
  const dir = currentDirectoryPath();
  const placeholderName = t("files.placeholderNewFile");
  const placeholderPath = joinPath(dir, placeholderName);
  return `
    <form class="modal" data-form="create-text-file">
      <div class="modal-header"><h2>${t("files.createFileTitle")}</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="new-file-name">${t("files.name")}</label>
          <input id="new-file-name" name="name" placeholder="${escapeHtml(placeholderName)}" autofocus />
          <p class="help">${t("files.currentFolder", { dir: "" })}<span class="path">${escapeHtml(dir || "/")}</span></p>
        </div>
        <div class="field">
          <label for="new-file-content">${t("files.content")}</label>
          <textarea id="new-file-content" name="content" spellcheck="false"></textarea>
        </div>
        <div class="field">
          <label for="new-file-message">${t("files.commitMessage")}</label>
          <input id="new-file-message" name="message" placeholder="CMS: create ${escapeHtml(placeholderPath)}" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">${t("common.cancel")}</button>
        <button class="primary" type="submit">${t("common.create")}</button>
      </div>
    </form>
  `;
}

function renderCreateFolderModal() {
  const dir = currentDirectoryPath();
  const placeholderName = t("files.placeholderNewFolder");
  return `
    <form class="modal" data-form="create-folder">
      <div class="modal-header"><h2>${t("files.createFolderTitle")}</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="new-folder-name">${t("files.name")}</label>
          <input id="new-folder-name" name="name" placeholder="${escapeHtml(placeholderName)}" autofocus />
          <p class="help">${t("files.currentFolder", { dir: "" })}<span class="path">${escapeHtml(dir || "/")}</span></p>
        </div>
        <div class="field">
          <label for="new-folder-message">${t("files.commitMessage")}</label>
          <input id="new-folder-message" name="message" placeholder="CMS: create folder ${escapeHtml(joinPath(dir, placeholderName))}" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">${t("common.cancel")}</button>
        <button class="primary" type="submit">${t("common.create")}</button>
      </div>
    </form>
  `;
}

function renderCreatePrModal() {
  const title = `CMS: ${state.branch}`;
  const body = t("pr.defaultBody", { branch: state.branch, base: state.defaultBranch, head: shortSha(state.headSha) });
  return `
    <form class="modal" data-form="create-pr">
      <div class="modal-header"><h2>${t("pr.title")}</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="pr-title">${t("pr.titleLabel")}</label>
          <input id="pr-title" name="title" value="${escapeHtml(title)}" />
        </div>
        <div class="field">
          <label for="pr-body">${t("pr.bodyLabel")}</label>
          <textarea id="pr-body" name="body">${escapeHtml(body)}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">${t("common.cancel")}</button>
        <button class="primary" type="submit">${t("common.createPr")}</button>
      </div>
    </form>
  `;
}

function renderToast(toastItem) {
  return `
    <div class="toast ${escapeHtml(toastItem.tone)}">
      <span>${escapeHtml(toastItem.message)}</span>
      <button class="dismiss-button" type="button" data-action="dismiss-toast" data-toast-id="${escapeHtml(toastItem.id)}" aria-label="${t("common.closeNotification")}">×</button>
    </div>
  `;
}

function summarizeChecks() {
  const statusItems = actionStatusItems();
  if (!statusItems.length) {
    return state.actionPolling ? `<span class="status-pill warn">${t("actions.waiting")}</span>` : "";
  }

  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger").length;
  const running = statusItems.filter((run) => run.status && run.status !== "completed").length;
  const polling = state.actionPolling ? `<span class="status-pill">${t("actions.autoRefresh")}</span>` : "";
  if (failing) {
    return `<span class="status-pill danger">${t("actions.failing", { count: failing })}</span>${polling}`;
  }
  if (running) {
    return `<span class="status-pill warn">${t("actions.running", { count: running })}</span>${polling}`;
  }
  return `<span class="status-pill ok">${t("actions.ok")}</span>`;
}

function actionStatusItems() {
  const headCheckRuns = currentHeadCheckRuns();
  if (headCheckRuns.length) {
    return headCheckRuns;
  }

  const headRuns = state.headSha
    ? state.workflowRuns.filter((run) => run.head_sha === state.headSha)
    : [];
  return headRuns.length ? headRuns : [];
}

function currentHeadCheckRuns() {
  return state.headSha
    ? state.checkRuns.filter((run) => run.head_sha === state.headSha)
    : state.checkRuns;
}

function hasRunningActionStatus() {
  return actionStatusItems().some((run) => run.status && run.status !== "completed");
}

function shouldKeepWaitingForActionStatus() {
  if (!state.actionPolling || actionStatusItems().length || !state.actionPollStartedAt) {
    return false;
  }

  return Date.now() - new Date(state.actionPollStartedAt).getTime() < 90000;
}

function filteredFiles() {
  const rawFilter = normalizeSearchText(state.pathFilter);
  const hints = [...(state.publicConfig.editablePathHints || []), ...(state.publicConfig.previewPathHints || [])]
    .filter(Boolean)
    .map((hint) => String(hint).toLowerCase());

  let files = state.files;
  if (rawFilter) {
    files = files.filter((file) => fileMatchesSearch(file, rawFilter));
  } else if (hints.length) {
    const hinted = files.filter((file) => hints.some((hint) => file.path.toLowerCase().startsWith(hint)));
    files = hinted.length ? hinted : files;
  }

  return files;
}

function fileMatchesSearch(file, query) {
  if (!query) {
    return true;
  }

  return Boolean(searchMatchForFile(file, query));
}

function selectedDiscussionContext() {
  const title = state.selectedPath || t("discussion.title");
  const discourseUrl = normalizeDiscourseUrl(state.publicConfig.discourseUrl || state.publicConfig.discussion?.discourseUrl || "");
  const markdownSelected = Boolean(state.selectedPath && isMarkdownPath(state.selectedPath));
  const context = {
    supported: false,
    title,
    discourseUrl,
    message: "",
    topicTitle: "",
    composerUrl: "",
    searchUrl: "",
    markdownSelected,
  };

  if (!state.selectedPath) {
    context.message = t("discussion.selectFile");
    return context;
  }

  const selectedFile = state.files.find((file) => file.path === state.selectedPath);
  context.title = markdownSelected ? markdownDisplayTitle(selectedFile) || state.selectedPath : state.selectedPath;

  if (!discourseUrl) {
    context.message = t("discussion.needsDiscourseUrl");
    return context;
  }

  context.topicTitle = discussionTopicTitleForSelection();
  context.composerUrl = discourseComposerUrl(context);
  context.searchUrl = discourseSearchUrl(context);

  context.supported = true;
  return context;
}

function discussionTopicTitleForSelection() {
  if (isMarkdownPath(state.selectedPath) && state.editor?.content) {
    const explicit = extractFrontMatterValue(state.editor.content, ["discussion_title", "discussionTitle"]);
    if (explicit) {
      return explicit;
    }
  }
  const file = state.files.find((item) => item.path === state.selectedPath);
  const displayTitle = isMarkdownPath(state.selectedPath) ? markdownDisplayTitle(file) : "";
  return displayTitle ? `Diskuse: ${displayTitle}` : `Diskuse: ${state.selectedPath}`;
}

function discourseComposerUrl(context = selectedDiscussionContext()) {
  if (!context.discourseUrl) {
    return "";
  }

  const url = new URL("/new-topic", context.discourseUrl);
  const category = discussionCategoryForSelection();
  const tags = state.publicConfig.discourseTags || state.publicConfig.discussion?.tags || [];
  url.searchParams.set("title", context.topicTitle);
  url.searchParams.set("body", discussionTopicBody(context));
  if (category) {
    url.searchParams.set("category", String(category));
  }
  if (Array.isArray(tags) && tags.length) {
    url.searchParams.set("tags", tags.join(","));
  }
  return url.toString();
}

function discussionTopicBody(context = selectedDiscussionContext()) {
  const quoteBlock = discussionQuoteBlock();
  const githubUrl = githubFileUrlForSelection();
  const githubLine = quoteBlock ? `GitHub Location: ${githubUrl}` : githubUrl;
  const cmsLine = `This discussion is based on [this document](${cmsDocumentUrlForSelection()}) in Adaptivio CMS.`;
  const lookupLine = `Adaptivio CMS lookup key: ${discussionLookupKeyForSelection()}`;

  if (quoteBlock) {
    return `${quoteBlock}\n\n${githubLine}\n${cmsLine}\n${lookupLine}`;
  }

  return `${githubLine}\n${cmsLine}\n${lookupLine}`;
}

function githubFileUrlForSelection() {
  if (!state.owner || !state.repo || !state.selectedPath) {
    return "";
  }
  const branch = encodeURIComponent(state.branch || state.defaultBranch || "master");
  const path = state.selectedPath
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
  return `https://github.com/${encodeURIComponent(state.owner)}/${encodeURIComponent(state.repo)}/blob/${branch}/${path}`;
}

function cmsDocumentUrlForSelection() {
  const url = new URL(window.location.href);
  if (state.branch) {
    url.searchParams.set("branch", state.branch);
  }
  if (state.selectedPath) {
    url.searchParams.set("path", state.selectedPath);
    url.searchParams.delete("dir");
  }
  url.hash = "";
  return `${url.origin}${url.pathname}${url.search}`;
}

function discussionLookupKeyForSelection() {
  const input = cmsDocumentUrlForSelection();
  if (!input) {
    return "";
  }
  return `avdsref${fnv1aHash(input)}`;
}

function fnv1aHash(value) {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function discussionQuoteBlock() {
  const selection = window.getSelection?.();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return "";
  }

  const preview = document.querySelector(".markdown-preview");
  if (!(preview instanceof HTMLElement)) {
    return "";
  }

  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const container = common instanceof Element ? common : common.parentElement;
  if (!container || !preview.contains(container)) {
    return "";
  }

  const fragment = range.cloneContents();
  const markdown = normalizeQuotedMarkdown(serializeSelectionFragment(fragment));
  if (!markdown) {
    return "";
  }

  return markdown
    .split("\n")
    .map((line) => `> ${line}`)
    .join("\n");
}

function serializeSelectionFragment(fragment) {
  const blocks = [];
  for (const node of fragment.childNodes) {
    const value = serializeSelectionNode(node, { mode: "block" });
    if (value) {
      blocks.push(value);
    }
  }
  return blocks.join("\n\n");
}

function serializeSelectionNode(node, context = { mode: "inline" }) {
  if (node.nodeType === Node.TEXT_NODE) {
    return normalizeSelectionWhitespace(node.nodeValue || "", context.mode);
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return "";
  }

  const element = /** @type {HTMLElement} */ (node);
  const tag = element.tagName.toLowerCase();

  if (tag === "br") {
    return "\n";
  }

  if (tag === "strong" || tag === "b") {
    const content = serializeChildrenInline(element);
    return content ? `**${content}**` : "";
  }

  if (tag === "em" || tag === "i") {
    const content = serializeChildrenInline(element);
    return content ? `*${content}*` : "";
  }

  if (tag === "code" && element.parentElement?.tagName.toLowerCase() !== "pre") {
    const content = serializeChildrenInline(element).replace(/`/g, "\\`");
    return content ? `\`${content}\`` : "";
  }

  if (tag === "a") {
    const content = serializeChildrenInline(element) || element.getAttribute("href") || "";
    const href = absoluteSelectionHref(element);
    return href ? `[${content}](${href})` : content;
  }

  if (tag === "pre") {
    const text = element.textContent?.replace(/\r\n/g, "\n").trim() || "";
    return text ? `\`\`\`\n${text}\n\`\`\`` : "";
  }

  if (tag === "blockquote") {
    const content = normalizeQuotedMarkdown(serializeChildrenBlock(element));
    return content
      .split("\n")
      .filter(Boolean)
      .map((line) => `> ${line}`)
      .join("\n");
  }

  if (tag === "table") {
    return serializeTable(element);
  }

  if (tag === "ul") {
    return serializeList(element, false);
  }

  if (tag === "ol") {
    return serializeList(element, true);
  }

  if (tag === "li") {
    return hasBlockSelectionChild(element)
      ? normalizeQuotedMarkdown(serializeChildrenBlock(element))
      : normalizeQuotedMarkdown(serializeChildrenInline(element));
  }

  if (["p", "div"].includes(tag)) {
    return hasBlockSelectionChild(element)
      ? normalizeQuotedMarkdown(serializeChildrenBlock(element))
      : normalizeQuotedMarkdown(serializeChildrenInline(element));
  }

  if (/^h[1-6]$/.test(tag)) {
    const level = Number(tag.slice(1));
    const content = normalizeQuotedMarkdown(serializeChildrenInline(element));
    return content ? `${"#".repeat(level)} ${content}` : "";
  }

  if (tag === "tr") {
    return serializeTableRow(element);
  }

  if (tag === "th" || tag === "td") {
    return serializeTableCell(element);
  }

  return context.mode === "block"
    ? normalizeQuotedMarkdown(serializeChildrenBlock(element))
    : serializeChildrenInline(element);
}

function serializeChildrenInline(element) {
  let output = "";
  for (const child of element.childNodes) {
    output += serializeSelectionNode(child, { mode: "inline" });
  }
  return normalizeInlineMarkdown(output);
}

function serializeChildrenBlock(element) {
  const parts = [];
  let inlineBuffer = "";
  for (const child of element.childNodes) {
    const isBlockChild = child.nodeType === Node.ELEMENT_NODE && isSelectionBlockElement(child);
    const value = serializeSelectionNode(child, { mode: isBlockChild ? "block" : "inline" });
    if (value) {
      if (isBlockChild) {
        if (inlineBuffer) {
          parts.push(normalizeInlineMarkdown(inlineBuffer));
          inlineBuffer = "";
        }
        parts.push(value);
      } else {
        inlineBuffer += value;
      }
    }
  }
  if (inlineBuffer) {
    parts.push(normalizeInlineMarkdown(inlineBuffer));
  }
  return parts.join("\n\n");
}

function hasBlockSelectionChild(element) {
  return [...element.childNodes].some((child) => {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      return false;
    }
    return isSelectionBlockElement(child);
  });
}

function isSelectionBlockElement(element) {
  const tag = element.tagName.toLowerCase();
  return ["p", "div", "ul", "ol", "li", "pre", "blockquote", "table", "hr"].includes(tag);
}

function absoluteSelectionHref(element) {
  const rawHref = element.getAttribute("href") || "";
  if (!rawHref) {
    return "";
  }

  const resolvedHref = element.href || rawHref;
  return normalizeMarkdownHref(resolvedHref) || rawHref;
}

function serializeList(element, ordered) {
  const items = [...element.children]
    .filter((child) => child.tagName.toLowerCase() === "li")
    .map((item, index) => {
      const content = normalizeQuotedMarkdown(serializeChildrenBlock(item));
      if (!content) {
        return "";
      }
      const lines = content.split("\n");
      const marker = ordered ? `${index + 1}. ` : "- ";
      return lines
        .map((line, lineIndex) => (lineIndex === 0 ? `${marker}${line}` : `  ${line}`))
        .join("\n");
    })
    .filter(Boolean);
  return items.join("\n");
}

function serializeTable(element) {
  const rows = collectTableRows(element);
  if (!rows.length) {
    return "";
  }

  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  if (!width) {
    return "";
  }

  const normalizedRows = rows.map((row) => normalizeTableRowCells(row, width));
  const head = normalizedRows[0];
  const separator = new Array(width).fill("---");
  const body = normalizedRows.slice(1);

  return [formatMarkdownTableRow(head), formatMarkdownTableRow(separator), ...body.map(formatMarkdownTableRow)].join("\n");
}

function collectTableRows(element) {
  if (element.tagName?.toLowerCase() === "tr") {
    const row = collectTableRowCells(element);
    return row.length ? [row] : [];
  }

  const rows = [];
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (tag === "tr") {
      const row = collectTableRowCells(child);
      if (row.length) {
        rows.push(row);
      }
      continue;
    }
    if (["thead", "tbody", "tfoot"].includes(tag)) {
      rows.push(...collectTableRows(child));
    }
  }
  return rows;
}

function collectTableRowCells(element) {
  const cells = [];
  for (const child of element.childNodes) {
    if (child.nodeType !== Node.ELEMENT_NODE) {
      continue;
    }
    const tag = child.tagName.toLowerCase();
    if (tag === "th" || tag === "td") {
      const value = serializeTableCell(child);
      if (value || value === "") {
        cells.push(value);
      }
    }
  }
  return cells;
}

function serializeTableRow(element) {
  const cells = collectTableRowCells(element);
  return cells.length ? formatMarkdownTableRow(cells) : "";
}

function serializeTableCell(element) {
  return escapeMarkdownTableCell(normalizeQuotedMarkdown(serializeChildrenBlock(element)));
}

function normalizeTableRowCells(row, width) {
  return Array.from({ length: width }, (_, index) => row[index] || "");
}

function formatMarkdownTableRow(cells) {
  return `| ${cells.join(" | ")} |`;
}

function escapeMarkdownTableCell(value) {
  return String(value || "")
    .replace(/\n+/g, "<br>")
    .replace(/\|/g, "\\|");
}

function normalizeSelectionWhitespace(value, mode) {
  const text = String(value || "").replace(/\u00a0/g, " ");
  if (mode === "block") {
    return text.replace(/[ \t]+\n/g, "\n").trim();
  }
  return text.replace(/\s+/g, " ");
}

function normalizeInlineMarkdown(value) {
  return String(value || "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeQuotedMarkdown(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .split("\n")
    .map((line) => line.replace(/[ \t]+$/g, ""))
    .join("\n")
    .trim();
}

function discussionCategoryForSelection() {
  const frontMatterOwner = isMarkdownPath(state.selectedPath)
    ? extractFrontMatterValue(state.editor?.content || "", ["owner"])
    : "";
  const baseName = frontMatterOwner || "AVDS";
  return `${normalizeDiscussionCategoryName(baseName)}-RUN`;
}

function normalizeDiscussionCategoryName(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/[^A-Za-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toUpperCase() || "AVDS";
}

function openDiscourseComposer() {
  const context = selectedDiscussionContext();
  if (!context.composerUrl) {
    toast(t("discussion.needsDiscourseUrl"), "warn");
    return;
  }
  window.open(context.composerUrl, "_blank", "noopener,noreferrer");
}

function discourseSearchUrl(context = selectedDiscussionContext()) {
  if (!context.discourseUrl) {
    return "";
  }
  const url = new URL("/search", context.discourseUrl);
  const lookupKey = discussionLookupKeyForSelection();
  url.searchParams.set("q", lookupKey || cmsDocumentUrlForSelection());
  return url.toString();
}

function openDiscourseSearch() {
  const context = selectedDiscussionContext();
  if (!context.searchUrl) {
    toast(t("discussion.needsDiscourseUrl"), "warn");
    return;
  }
  window.open(context.searchUrl, "_blank", "noopener,noreferrer");
}

function searchResults() {
  const query = normalizeSearchText(state.pathFilter);
  if (!query) {
    return [];
  }

  return state.files
    .filter((file) => isSearchVisibleFile(file))
    .map((file) => searchMatchForFile(file, query))
    .filter(Boolean)
    .sort(compareSearchResults);
}

function searchMatchForFile(file, query) {
  const path = normalizeSearchText(file.path);
  const name = normalizeSearchText(file.name || "");
  const title = normalizeSearchText(file.frontMatterTitle || "");
  const dirs = directorySearchText(file.path);
  const content = state.searchTextBySha.get(file.sha) || "";
  const exactRank = title === query || name === query ? 0 : 1;

  if (title.includes(query)) {
    return { file, query, kind: "title", exactRank, rank: 0 };
  }
  if (name.includes(query)) {
    return { file, query, kind: "file", exactRank, rank: 1 };
  }
  if (path.includes(query)) {
    return { file, query, kind: dirs.includes(query) ? "folder" : "path", exactRank, rank: dirs.includes(query) ? 2 : 3 };
  }
  if (content.includes(query)) {
    return { file, query, kind: "content", exactRank, rank: 4, snippet: searchSnippet(file, query) };
  }

  return null;
}

function compareSearchResults(a, b) {
  const exactDiff = a.exactRank - b.exactRank;
  if (exactDiff) {
    return exactDiff;
  }
  const depthDiff = pathDepth(a.file.path) - pathDepth(b.file.path);
  if (depthDiff) {
    return depthDiff;
  }
  const rankDiff = a.rank - b.rank;
  if (rankDiff) {
    return rankDiff;
  }
  return a.file.path.localeCompare(b.file.path, undefined, { sensitivity: "base" });
}

function pathDepth(path) {
  return String(path || "").split("/").filter(Boolean).length;
}

function searchSnippet(file, query) {
  const raw = state.searchContentBySha.get(file.sha) || "";
  if (!raw) {
    return "";
  }
  const normalized = normalizeSearchText(raw);
  const index = normalized.indexOf(query);
  if (index < 0) {
    return "";
  }
  const start = Math.max(0, index - 48);
  const end = Math.min(raw.length, index + query.length + 64);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < raw.length ? "..." : "";
  return `${prefix}${highlightText(raw.slice(start, end).replace(/\s+/g, " ").trim(), query)}${suffix}`;
}

function highlightText(value, normalizedQuery) {
  const text = String(value || "");
  if (!normalizedQuery) {
    return escapeHtml(text);
  }
  const normalized = normalizeSearchText(text);
  let index = normalized.indexOf(normalizedQuery);
  if (index < 0) {
    return escapeHtml(text);
  }

  let html = "";
  let cursor = 0;
  while (index >= 0) {
    html += escapeHtml(text.slice(cursor, index));
    const end = index + normalizedQuery.length;
    html += `<mark>${escapeHtml(text.slice(index, end))}</mark>`;
    cursor = end;
    index = normalized.indexOf(normalizedQuery, cursor);
  }
  html += escapeHtml(text.slice(cursor));
  return html;
}

function searchHighlightQuery() {
  const query = normalizeSearchText(state.pathFilter);
  if (!query || !state.selectedPath) {
    return "";
  }
  const file = state.files.find((item) => item.path === state.selectedPath);
  if (!file || !state.searchTextBySha.get(file.sha)?.includes(query)) {
    return "";
  }
  return query;
}

function highlightSearchMatches() {
  const query = searchHighlightQuery();
  if (!query) {
    return;
  }
  window.requestAnimationFrame(() => {
    const container = document.querySelector(".markdown-preview, .preview-code");
    if (!(container instanceof HTMLElement)) {
      return;
    }
    wrapTextMatches(container, query);
    container.querySelector(".search-highlight")?.scrollIntoView({ block: "center", behavior: "smooth" });
  });
}

function wrapTextMatches(root, normalizedQuery) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement;
      if (!parent || ["SCRIPT", "STYLE", "TEXTAREA", "MARK"].includes(parent.tagName)) {
        return NodeFilter.FILTER_REJECT;
      }
      return normalizeSearchText(node.nodeValue || "").includes(normalizedQuery)
        ? NodeFilter.FILTER_ACCEPT
        : NodeFilter.FILTER_REJECT;
    },
  });
  const matches = [];
  while (matches.length < 80) {
    const node = walker.nextNode();
    if (!node) {
      break;
    }
    matches.push(node);
  }
  for (const node of matches) {
    replaceTextNodeWithHighlights(node, normalizedQuery);
  }
}

function replaceTextNodeWithHighlights(node, normalizedQuery) {
  const text = node.nodeValue || "";
  const normalized = normalizeSearchText(text);
  let index = normalized.indexOf(normalizedQuery);
  if (index < 0) {
    return;
  }
  const fragment = document.createDocumentFragment();
  let cursor = 0;
  while (index >= 0) {
    fragment.append(document.createTextNode(text.slice(cursor, index)));
    const mark = document.createElement("mark");
    mark.className = "search-highlight";
    const end = index + normalizedQuery.length;
    mark.textContent = text.slice(index, end);
    fragment.append(mark);
    cursor = end;
    index = normalized.indexOf(normalizedQuery, cursor);
  }
  fragment.append(document.createTextNode(text.slice(cursor)));
  node.parentNode?.replaceChild(fragment, node);
}

function directorySearchText(path) {
  return normalizeSearchText(
    String(path || "")
      .split("/")
      .slice(0, -1)
      .join(" "),
  );
}

function normalizeSearchText(value) {
  return String(value || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

function buildFileTree(files) {
  const root = createTreeDir("", "");

  for (const file of files) {
    const parts = file.path.split("/");
    let current = root;

    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index];
      const dirPath = parts.slice(0, index + 1).join("/");
      if (!current.dirs.has(name)) {
        current.dirs.set(name, createTreeDir(name, dirPath));
      }
      current = current.dirs.get(name);
    }

    current.files.push({
      ...file,
      type: "file",
      name: parts[parts.length - 1],
    });
  }

  sortTree(root);
  return root;
}

function createTreeDir(name, path) {
  return {
    type: "dir",
    name,
    path,
    dirs: new Map(),
    files: [],
  };
}

function sortTree(node) {
  node.files.sort(compareTreeFiles);
  const sortedDirs = [...node.dirs.entries()].sort(([, a], [, b]) => compareTreeDirs(a, b));
  node.dirs = new Map(sortedDirs);
  node.count = node.files.length;
  for (const child of node.dirs.values()) {
    sortTree(child);
    node.count += child.count || 0;
  }
}

function compareTreeFiles(a, b) {
  const specialRankDiff = treeSpecialFileRank(a) - treeSpecialFileRank(b);
  if (specialRankDiff) {
    return specialRankDiff;
  }
  const rankDiff = treeFileRank(a) - treeFileRank(b);
  if (rankDiff) {
    return rankDiff;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareTreeDirs(a, b) {
  const rankDiff = treeDirRank(a) - treeDirRank(b);
  if (rankDiff) {
    return rankDiff;
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function compareTreeChildren(a, b) {
  const rankDiff = treeChildRank(a) - treeChildRank(b);
  if (rankDiff) {
    return rankDiff;
  }
  if (a.type === "dir" && b.type === "dir") {
    return compareTreeDirs(a, b);
  }
  if (a.type === "file" && b.type === "file") {
    return compareTreeFiles(a, b);
  }
  return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
}

function treeFileRank(file) {
  if (isReadmePath(file.path)) {
    return 0;
  }
  const lowEmphasisRank = isLowEmphasisTreeFile(file.path) ? 1 : 0;
  const hiddenRank = file.name.startsWith(".") ? 1 : 0;
  return 1 + lowEmphasisRank + hiddenRank;
}

function treeSpecialFileRank(file) {
  if (isReadmePath(file.path)) {
    return 0;
  }
  if (isRozcestnikPath(file.path)) {
    return 1;
  }
  return 2;
}

function treeDirRank(dir) {
  return dir.name.startsWith(".") ? 1 : 0;
}

function treeChildRank(child) {
  if (child.type === "file" && isLowEmphasisTreeFile(child.path)) {
    return 2;
  }
  return child.type === "dir" ? 1 : 0;
}

function isHiddenRootTreeChild(child, depth) {
  if (depth !== 0) {
    return false;
  }
  if (child.type === "dir") {
    return isLowEmphasisRootDirectory(child, depth);
  }
  return child.type === "file" && isHiddenRootTechnicalFilePath(child.path);
}

function isSearchVisibleFile(file) {
  return isStartupContentVisiblePath(file.path);
}

function isStartupContentVisiblePath(path) {
  return !isPathInsideHiddenRootDirectory(path) && !isHiddenRootTechnicalFilePath(path);
}

function isPathInsideHiddenRootDirectory(path) {
  const rootSegment = String(path || "").split("/").filter(Boolean)[0] || "";
  if (!rootSegment || rootSegment === String(path || "")) {
    return false;
  }
  return isLowEmphasisRootDirectory({ name: rootSegment }, 0);
}

function isHiddenRootTechnicalFilePath(path) {
  const normalized = String(path || "");
  if (!normalized || normalized.includes("/")) {
    return false;
  }
  return isLowEmphasisTreeFile(normalized) && !isAgentsPath(normalized);
}

function isReadmePath(path) {
  const name = String(path || "").split("/").pop() || "";
  return /^readme\.md$/i.test(name);
}

function isAgentsPath(path) {
  return String(path || "").toLowerCase() === "agents.md";
}

function isSearchIndexablePath(path) {
  const ext = extensionOf(path);
  return ["md", "mdx", "html", "htm"].includes(ext);
}

function applyFrontMatterTitleToFile(sha, title) {
  const result = applyFrontMatterTitleToSha(state.files, sha, title, state.frontMatterTitleDraftByPath);
  state.files = result.files;
  return result.changed;
}

function applyFrontMatterTitleToPath(path, title) {
  const result = applyFrontMatterTitleToPathState(state.files, path, title);
  state.files = result.files;
  return result.changed;
}

function syncEditorFrontMatterTitle() {
  if (!state.editor || !isMarkdownPath(state.editor.path)) {
    return false;
  }

  const title = extractFrontMatterTitle(state.editor.content || "");
  setFrontMatterTitleDraft(state.editor.path, title);
  return applyFrontMatterTitleToPath(state.editor.path, title);
}

function extractFrontMatterTitle(markdown) {
  return extractFrontMatterValue(markdown, ["title"]);
}

function extractFrontMatterValue(markdown, keys = []) {
  const wanted = new Set(keys.map((key) => String(key).toLowerCase()));
  const entry = splitFrontMatter(markdown).frontMatter.find((item) => wanted.has(String(item.key || "").toLowerCase()));
  return normalizeFrontMatterTitle(entry?.value || "");
}

function normalizeFrontMatterTitle(value) {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .trim();
}

function normalizeDiscourseUrl(url) {
  const value = String(url || "").trim();
  if (!value) {
    return "";
  }
  return value.endsWith("/") ? value : `${value}/`;
}

function syncDiscussionEmbed() {
  // The MVP uses plain Discourse links only.
}

function navigationFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    branch: params.get("branch") || "",
    path: normalizePath(params.get("path") || ""),
    dir: normalizePath(params.get("dir") || ""),
  };
}

async function selectDefaultRootReadme({ keepBusy = false } = {}) {
  const navigation = navigationFromLocation();
  if (navigation.path || navigation.dir || state.selectedPath || state.selectedDir) {
    return;
  }

  const readme = state.files.find((file) => /^readme\.md$/i.test(file.path));
  if (!readme) {
    return;
  }

  await loadFile(readme.path, { keepBusy, revealInTree: true });
}

function updateBrowserNavigation({ mode = "replace" } = {}) {
  if (!state.owner || !state.repo || restoringBrowserNavigation) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.delete("repo");
  if (state.branch) {
    url.searchParams.set("branch", state.branch);
  } else {
    url.searchParams.delete("branch");
  }

  if (state.selectedPath) {
    url.searchParams.set("path", state.selectedPath);
    url.searchParams.delete("dir");
  } else if (state.selectedDir) {
    url.searchParams.set("dir", state.selectedDir);
    url.searchParams.delete("path");
  } else {
    url.searchParams.delete("path");
    url.searchParams.delete("dir");
  }

  const next = `${url.pathname}${url.search}${url.hash}`;
  const current = `${window.location.pathname}${window.location.search}${window.location.hash}`;
  if (next === current) {
    return;
  }

  const method = mode === "push" ? "pushState" : "replaceState";
  window.history[method]({ branch: state.branch, path: state.selectedPath, dir: state.selectedDir }, "", url);
}

async function restoreSelectionFromLocation({ keepBusy = false } = {}) {
  if (!state.client || !state.owner || !state.repo) {
    return;
  }

  const navigation = navigationFromLocation();
  const nextBranch = navigation.branch || state.branch;
  const nextPath = navigation.path;
  const nextDir = nextPath ? "" : navigation.dir;
  const changed =
    nextBranch !== state.branch ||
    nextPath !== state.selectedPath ||
    nextDir !== (state.selectedPath ? "" : state.selectedDir);

  if (!changed) {
    return;
  }

  if (state.editor?.dirty && !window.confirm(t("files.historyConfirm"))) {
    updateBrowserNavigation({ mode: "push" });
    return;
  }

  const run = async () => {
    restoringBrowserNavigation = true;
    try {
      assertConnected();

      if (nextBranch !== state.branch) {
        const knownBranch = state.branches.some((branch) => branch.name === nextBranch);
        const branchAvailable = knownBranch || (await branchExistsOnGitHub(nextBranch));
        if (!branchAvailable) {
          throw new Error(t("errors.historyBranchMissing", { branch: nextBranch }));
        }

        state.editMode = false;
        state.branch = nextBranch;
        state.selectedPath = "";
        state.selectedDir = "";
        state.editor = null;
        state.preview = null;
        upsertBranchOption(nextBranch);
        persistSettings();
        await refreshRepositoryData({ keepBusy: true });
      }

      if (nextPath) {
        await loadFile(nextPath, { keepBusy: true, revealInTree: true });
        return;
      }

      revokePreviewUrls();
      state.selectedPath = "";
      state.editor = null;
      state.preview = null;
      if (nextDir && directoryExists(nextDir)) {
        state.selectedDir = nextDir;
        expandPathToDir(nextDir);
      } else {
        state.selectedDir = "";
      }
      persistSettings();
      render();
    } finally {
      restoringBrowserNavigation = false;
    }
  };

  if (keepBusy) {
    try {
      await run();
    } catch (error) {
      state.connectionError = formatError(error);
      toast(state.connectionError, "danger");
    }
    return;
  }

  await withBusy(t("repo.checkingHistory"), run);
}

function toggleDirectory(path, { navigation = "" } = {}) {
  state.selectedPath = "";
  state.selectedDir = path;
  state.editor = null;
  state.preview = null;
  if (state.expandedDirs.has(path)) {
    state.expandedDirs.delete(path);
  } else {
    state.expandedDirs.add(path);
  }
  persistSettings();
  if (navigation) {
    updateBrowserNavigation({ mode: navigation });
  }
  render();
}

function selectDirectory(path, { navigation = "", revealInTree = false } = {}) {
  state.selectedPath = "";
  state.selectedDir = path;
  state.editor = null;
  state.preview = null;
  expandPathToDir(path);
  state.revealSelectedInTree = state.revealSelectedInTree || revealInTree;
  persistSettings();
  if (navigation) {
    updateBrowserNavigation({ mode: navigation });
  }
  render();
}

function expandPathToFile(path) {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    state.expandedDirs.add(parts.slice(0, index).join("/"));
  }
  persistSettings();
}

function expandPathToDir(path) {
  const parts = String(path || "").split("/").filter(Boolean);
  for (let index = 1; index <= parts.length; index += 1) {
    state.expandedDirs.add(parts.slice(0, index).join("/"));
  }
  persistSettings();
}

function captureTreeScroll() {
  state.treeScrollTop = currentTreeScrollTop();
}

function restoreTreeScroll() {
  window.requestAnimationFrame(() => {
    const list = document.querySelector(".file-list");
    if (list instanceof HTMLElement) {
      list.scrollTop = state.treeScrollTop;
    }
  });
}

function revealSelectedTreeRow() {
  if (!state.revealSelectedInTree || (!state.selectedPath && !state.selectedDir)) {
    return;
  }

  window.requestAnimationFrame(() => {
    const list = document.querySelector(".file-list");
    const active = list?.querySelector(state.selectedPath ? ".tree-file.active" : ".tree-dir.active-dir");
    if (!(list instanceof HTMLElement) || !(active instanceof HTMLElement)) {
      state.revealSelectedInTree = false;
      return;
    }

    const listRect = list.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    const padding = 12;
    if (activeRect.top < listRect.top + padding) {
      list.scrollTop -= listRect.top + padding - activeRect.top;
    } else if (activeRect.bottom > listRect.bottom - padding) {
      list.scrollTop += activeRect.bottom - (listRect.bottom - padding);
    }
    state.treeScrollTop = list.scrollTop;
    state.revealSelectedInTree = false;
  });
}

function currentTreeScrollTop() {
  const list = document.querySelector(".file-list");
  return list instanceof HTMLElement ? list.scrollTop : state.treeScrollTop;
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)) {
    return null;
  }

  return {
    id: active.id,
    value: "value" in active ? active.value : "",
    selectionStart: "selectionStart" in active ? active.selectionStart : null,
    selectionEnd: "selectionEnd" in active ? active.selectionEnd : null,
  };
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot?.id) {
    return;
  }

  focusRestoreToken += 1;
  const token = focusRestoreToken;
  window.requestAnimationFrame(() => {
    if (token !== focusRestoreToken) {
      return;
    }

    const target = document.getElementById(snapshot.id);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    target.focus({ preventScroll: true });
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      target.value === snapshot.value &&
      snapshot.selectionStart !== null &&
      snapshot.selectionEnd !== null
    ) {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  });
}

function assertConnected() {
  if (!state.client || !state.owner || !state.repo) {
    throw new Error(t("repo.notConnected"));
  }
}

function assertCanWrite() {
  assertConnected();
  if (!state.editMode) {
    throw new Error(t("edit.startFirst"));
  }
  if (state.branch === state.defaultBranch && !state.allowDefaultBranchEdits) {
    throw new Error(t("edit.defaultWriteDisabled"));
  }
}

async function withBusy(label, task) {
  const preservedTreeScrollTop = currentTreeScrollTop();
  state.treeScrollTop = preservedTreeScrollTop;
  state.busy = true;
  state.busyLabel = label;
  state.busyProgress = null;
  render({ treeScrollTop: preservedTreeScrollTop });
  try {
    await task();
  } catch (error) {
    state.connectionError = formatError(error);
    toast(state.connectionError, "danger");
  } finally {
    state.busy = false;
    state.busyLabel = "";
    state.busyProgress = null;
    if (state.revealSelectedInTree) {
      render();
    } else {
      state.treeScrollTop = preservedTreeScrollTop;
      render({ treeScrollTop: preservedTreeScrollTop });
    }
  }
}

function setBusyProgress(progress) {
  state.busyProgress = progress;
  if (!state.busy) {
    return;
  }
  render({ treeScrollTop: state.treeScrollTop });
}

function toast(message, tone = "") {
  const id = crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random());
  state.toasts.push({ id, message, tone });
  if (!state.busy) {
    render();
  }
  window.setTimeout(() => {
    dismissToast(id);
  }, 5200);
}

function dismissToast(id) {
  const before = state.toasts.length;
  state.toasts = state.toasts.filter((item) => item.id !== id);
  if (state.toasts.length !== before) {
    render();
  }
}

function captureTokenFromAuthForm() {
  const tokenInput = document.querySelector("#token");
  if (!(tokenInput instanceof HTMLInputElement)) {
    return;
  }

  const token = tokenInput.value.trim();
  if (!token) {
    return;
  }
  state.token = token;
  state.tokenPersistence = "local";
  state.client = new GitHubClient(token);
  resetChecksApiState();
  saveToken(token, "local");
}

function resetChecksApiState() {
  state.checkRuns = [];
  state.checkRunsError = "";
  state.checksApiUnavailable = false;
}

export const __testing = {
  state,
  saveCurrentFile,
  serializeSelectionFragment,
};

function summarizeTokenProbeError(error) {
  if (error instanceof GitHubError) {
    const required = formatPermissionMeta(error.meta);
    return [
      `GitHub ${error.status || ""}: ${error.message}`,
      required ? t("errors.githubRequires", { required }) : "",
      error.payload?.documentation_url ? t("errors.docs", { url: error.payload.documentation_url }) : "",
    ]
      .filter(Boolean)
      .join(" · ");
  }
  return error?.message || String(error);
}

function formatRequestMeta(meta) {
  if (!meta?.path) {
    return "";
  }
  return `${meta.method || "GET"} ${stripGitHubApiBase(meta.path)}`;
}

function stripGitHubApiBase(value) {
  return String(value || "").replace(/^https:\/\/api\.github\.com/, "");
}

function formatPermissionMeta(meta) {
  if (!meta) {
    return "";
  }

  const githubPermissions = formatAcceptedGithubPermissions(meta.acceptedGithubPermissions);
  if (githubPermissions) {
    return githubPermissions;
  }

  const acceptedScopes = meta.acceptedOauthScopes ? t("errors.acceptedOauthScopes", { scopes: meta.acceptedOauthScopes }) : "";
  const tokenScopes = meta.oauthScopes ? t("errors.tokenScopes", { scopes: meta.oauthScopes }) : "";
  return [acceptedScopes, tokenScopes].filter(Boolean).join("; ");
}

function formatAcceptedGithubPermissions(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }

  return raw
    .split(";")
    .map((group) => group.trim())
    .filter(Boolean)
    .map((group) =>
      group
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .join(", "),
    )
    .join(` ${t("errors.or")} `);
}

function formatError(error) {
  if (error instanceof GitHubError) {
    const request = formatRequestMeta(error.meta);
    const requestDetail = request ? ` ${t("errors.request", { request })}` : "";
    const permissionDetail = formatPermissionMeta(error.meta);
    const permissions = permissionDetail ? ` ${t("errors.endpointRequires", { permissions: permissionDetail })}` : "";
    const docs = error.payload?.documentation_url ? ` ${t("errors.docs", { url: error.payload.documentation_url })}.` : "";
    const requestId = error.meta?.requestId ? ` ${t("errors.requestId", { requestId: error.meta.requestId })}` : "";
    if (error.status === 401) {
      return t("errors.tokenInvalid", { requestDetail, docs });
    }
    if (error.status === 403) {
      return t("errors.forbidden", { requestDetail, permissions, message: error.message, docs, requestId });
    }
    if (error.status === 404) {
      return t("errors.notFound", { requestDetail, docs });
    }
    return t("errors.genericGithub", { status: error.status || "", message: error.message, requestDetail, permissions, docs });
  }
  return error?.message || String(error);
}

function persistSettings() {
  saveSettings({
    repository: state.owner && state.repo ? `${state.owner}/${state.repo}` : state.repositoryInput,
    defaultBranch: state.defaultBranch,
    branch: state.branch,
    tab: state.tab,
    treePaneWidth: state.treePaneWidth,
    expandedDirs: [...state.expandedDirs],
    allowDefaultBranchEdits: state.allowDefaultBranchEdits,
    language: state.language,
    theme: state.theme,
  });
}

function normalizeTheme(value) {
  return THEME_MODES.includes(value) ? value : "auto";
}

function applyTheme() {
  const resolved = state.theme === "dark" || (state.theme === "auto" && systemDarkQuery?.matches) ? "dark" : "light";
  const root = document.documentElement;
  if (!root) {
    return;
  }
  root.dataset.theme = resolved;
  root.dataset.themeMode = state.theme;
  root.style.colorScheme = resolved;
  syncThemeColor();
}

function normalizeTreePaneWidth(value) {
  return clamp(Number(value) || DEFAULT_TREE_PANE_WIDTH, MIN_TREE_PANE_WIDTH, 760);
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function parseRepository(value) {
  const clean = String(value || "")
    .replace(/^https:\/\/github\.com\//, "")
    .replace(/\.git$/, "")
    .replace(/^\/+|\/+$/g, "");
  const [owner = "", repo = ""] = clean.split("/");
  return { owner, repo };
}

function normalizePath(path) {
  return String(path || "")
    .trim()
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

function normalizePathPart(value) {
  const clean = String(value || "")
    .trim()
    .replace(/^\/+|\/+$/g, "");
  if (!clean || clean.includes("/") || clean.includes("\\") || clean === "." || clean === "..") {
    return "";
  }
  return clean;
}

function normalizeMarkdownFileName(value) {
  const name = normalizePathPart(value);
  if (!name) {
    return "";
  }
  return extensionOf(name) ? name : `${name}.md`;
}

function joinPath(...parts) {
  return normalizePath(parts.filter(Boolean).join("/"));
}

function directoryOfPath(path) {
  const clean = normalizePath(path);
  if (!clean.includes("/")) {
    return "";
  }
  const parts = clean.split("/");
  parts.pop();
  return parts.join("/");
}

function parentDirectoryOfDir(path) {
  return directoryOfPath(normalizePath(path));
}

function currentDirectoryPath() {
  return normalizePath(state.selectedDir || directoryOfPath(state.selectedPath));
}

function directoryExists(path) {
  const dir = normalizePath(path);
  return Boolean(dir) && state.files.some((file) => file.path === `${dir}/.gitkeep` || file.path.startsWith(`${dir}/`));
}

function filesInDirectory(path) {
  const dir = normalizePath(path);
  return dir ? state.files.filter((file) => file.path.startsWith(`${dir}/`)) : [];
}

function removeFilesFromState(paths) {
  const deleted = new Set(paths);
  if (!deleted.size) {
    return;
  }
  state.files = state.files.filter((file) => !deleted.has(file.path));
}

function normalizeBranchName(value) {
  const raw = String(value || "").trim();
  if (!raw) {
    return "";
  }
  const withPrefix = raw.includes("/") ? raw : `${state.branchPrefix}${raw}`;
  return withPrefix
    .replace(/\s+/g, "-")
    .replace(/[^A-Za-z0-9._/-]/g, "-")
    .replace(/\/{2,}/g, "/")
    .replace(/^-+|-+$/g, "");
}

function trackPreviewUrl(url) {
  state.previewUrls.push(url);
  return url;
}

function revokePreviewUrls() {
  for (const url of state.previewUrls) {
    URL.revokeObjectURL(url);
  }
  state.previewUrls = [];
}
