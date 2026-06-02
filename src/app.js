import { GitHubClient, GitHubError } from "./github.js";
import {
  clearToken,
  loadLastSave,
  loadSettings,
  loadToken,
  saveLastSave,
  saveSettings,
  saveToken,
} from "./storage.js";
import {
  base64ToText,
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
} from "./utils.js";

const app = document.querySelector("#app");
const settings = loadSettings();
const tokenInfo = loadToken();
const query = new URLSearchParams(window.location.search);

const state = {
  publicConfig: {},
  client: tokenInfo.token ? new GitHubClient(tokenInfo.token) : null,
  token: tokenInfo.token,
  tokenPersistence: tokenInfo.persistence,
  user: null,
  owner: "",
  repo: "",
  repositoryInput: "",
  defaultBranch: settings.defaultBranch || "main",
  branch: settings.branch || "",
  branchPrefix: "cms/",
  branches: [],
  files: [],
  treeTruncated: false,
  headSha: "",
  tab: settings.tab || "files",
  editMode: false,
  pathFilter: "",
  selectedPath: "",
  selectedDir: "",
  expandedDirs: new Set(settings.expandedDirs || [""]),
  treeScrollTop: 0,
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
  workflowRuns: [],
  annotations: {},
  modal: null,
  busy: false,
  busyLabel: "",
  connectionError: "",
  toasts: [],
  permissionCheck: null,
  actionPolling: false,
  actionPollStartedAt: null,
  allowDefaultBranchEdits: Boolean(settings.allowDefaultBranchEdits),
};

const ACTION_POLL_INTERVAL_MS = 12000;

let actionPollTimer = null;
let actionPollInFlight = false;
let restoringBrowserNavigation = false;

const TOKEN_PERMISSION_REQUIREMENTS = [
  {
    label: "Repository access",
    value: "Only selected repository",
    detail: "Fine-grained token musí mít přístup ke konkrétnímu private repo.",
  },
  {
    label: "Metadata",
    value: "read",
    detail: "Základní informace o repozitáři a branche.",
  },
  {
    label: "Contents",
    value: "read/write",
    detail: "Čtení stromu, blobů a commitování souborů.",
  },
  {
    label: "Pull requests",
    value: "read/write",
    detail: "Diff větve, soubory PR, commity PR a vytvoření PR.",
  },
  {
    label: "Actions",
    value: "read",
    detail: "Seznam workflow runs pro větev.",
  },
  {
    label: "Checks",
    value: "volitelné",
    detail: "Jen detailní check runs a anotace. Fine-grained PAT ho nemusí nabízet; CMS potom použije Actions.",
  },
  {
    label: "Actions",
    value: "write, volitelné",
    detail: "Jen pokud chceš z CMS znovu spouštět workflow runs.",
  },
];

const scheduleFilterRender = debounce(() => render(), 160);

void init();

app.addEventListener("submit", (event) => {
  const form = event.target.closest("form[data-form]");
  if (!form) {
    return;
  }
  event.preventDefault();
  void handleForm(form);
});

app.addEventListener("click", (event) => {
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

window.addEventListener("popstate", () => {
  void restoreSelectionFromLocation();
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
  const queryRepo = query.get("repo");
  const queryBranch = query.get("branch");
  const configuredRepo = queryRepo || settings.repository || state.publicConfig.defaultRepository || "";
  const parsed = parseRepository(configuredRepo);
  state.owner = parsed.owner;
  state.repo = parsed.repo;
  state.repositoryInput = configuredRepo;
  state.defaultBranch = settings.defaultBranch || state.publicConfig.defaultBranch || "main";
  state.branch = queryBranch || settings.branch || state.defaultBranch;
  state.branchPrefix = state.publicConfig.branchPrefix || "cms/";
}

async function handleForm(form) {
  const formName = form.dataset.form;
  const data = new FormData(form);

  if (formName === "auth") {
    const token = String(data.get("token") || "").trim();
    const persistence = String(data.get("persistence") || "session");
    let shouldCheckToken = Boolean(state.token && state.client);
    state.tokenPersistence = persistence;
    if (token) {
      state.token = token;
      state.client = new GitHubClient(token);
      state.permissionCheck = null;
      saveToken(token, persistence);
      toast("Token je uložený pro tento prohlížeč.", "ok");
      shouldCheckToken = true;
    } else if (state.token) {
      saveToken(state.token, persistence);
      toast("Změnil jsem způsob uložení tokenu.", "ok");
      shouldCheckToken = true;
    }
    if (shouldCheckToken) {
      await checkTokenAccess();
    } else {
      render();
    }
    return;
  }

  if (formName === "repository") {
    captureTokenFromAuthForm();
    const repository = String(data.get("repository") || "").trim();
    const parsed = parseRepository(repository);
    state.owner = parsed.owner;
    state.repo = parsed.repo;
    state.repositoryInput = repository;
    state.defaultBranch = String(data.get("defaultBranch") || "main").trim() || "main";
    state.branch = state.branch || state.defaultBranch;
    persistSettings();
    await connectRepository();
    return;
  }

  if (formName === "save-file") {
    await saveCurrentFile(String(data.get("message") || "").trim());
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
    state.permissionCheck = null;
    clearToken();
    toast("Token je odstraněný z localStorage i sessionStorage.", "ok");
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

  if (action === "tab") {
    state.tab = button.dataset.tab || "files";
    persistSettings();
    render();
    return;
  }

  if (action === "refresh") {
    await refreshRepositoryData({ preserveSelection: true });
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

  if (action === "select-file") {
    const path = button.dataset.path || "";
    await loadFile(path, { syncLatest: path === state.selectedPath, navigation: "push" });
    return;
  }

  if (action === "open-markdown-link") {
    await openMarkdownLink(button.dataset.path || "", button.dataset.anchor || "");
    return;
  }

  if (action === "missing-markdown-link") {
    toast(`Odkaz neodpovídá žádnému souboru v aktuální větvi: ${button.dataset.href || ""}`, "warn");
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
    await loadFile(button.dataset.path || "", { syncLatest: true, navigation: "push" });
    return;
  }

  if (action === "create-branch") {
    const input = document.querySelector("#new-branch-name");
    await createBranch(String(input?.value || "").trim());
    return;
  }

  if (action === "open-modal") {
    if (["create-text-file", "create-folder"].includes(button.dataset.modal || "") && !state.editMode) {
      toast("Nejdřív klikni na Edit. CMS založí pracovní větev a odemkne změny.", "warn");
      return;
    }
    state.modal = { type: button.dataset.modal };
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

  if (action === "start-oauth") {
    await startDeviceFlow();
    return;
  }

  if (action === "poll-oauth") {
    await pollDeviceFlow();
    return;
  }

  if (action === "copy-code") {
    const code = button.dataset.code;
    if (code && navigator.clipboard) {
      await navigator.clipboard.writeText(code);
      toast("Kód je zkopírovaný.", "ok");
    }
  }
}

async function handleChange(target) {
  if (target.id === "branch-select" && target instanceof HTMLSelectElement) {
    if (state.editor?.dirty && !window.confirm("Soubor má neuložené změny. Přepnout větev?")) {
      target.value = state.branch;
      return;
    }
    state.editMode = false;
    state.branch = target.value;
    state.selectedPath = "";
    state.selectedDir = "";
    state.editor = null;
    persistSettings();
    await refreshRepositoryData();
    updateBrowserNavigation({ mode: "push" });
    return;
  }

  if (target.id === "allow-default-edits" && target instanceof HTMLInputElement) {
    state.allowDefaultBranchEdits = target.checked;
    persistSettings();
    render();
  }
}

function handleInput(target) {
  if (target.id === "path-filter" && target instanceof HTMLInputElement) {
    state.pathFilter = target.value;
    scheduleFilterRender();
    return;
  }

  if (target.id === "editor-content" && target instanceof HTMLTextAreaElement && state.editor) {
    state.editor.content = target.value;
    state.editor.dirty = true;
  }
}

async function connectRepository({ silent = false } = {}) {
  captureTokenFromAuthForm();

  if (!state.token || !state.client) {
    toast("Nejdřív vlož GitHub token.", "warn");
    return;
  }

  if (!state.owner || !state.repo) {
    toast("Doplň repozitář ve formátu owner/repo.", "warn");
    return;
  }

  await withBusy("Připojuji GitHub repo", async () => {
    state.connectionError = "";
    state.user = null;
    const repo = await state.client.getRepository(state.owner, state.repo);
    const userResult = await state.client.getAuthenticatedUser().catch(() => null);
    state.user = userResult;
    state.defaultBranch = repo.default_branch || state.defaultBranch || "main";
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
    await refreshRepositoryData({ keepBusy: true });
    await restoreSelectionFromLocation({ keepBusy: true });
    updateBrowserNavigation({ mode: "replace" });
    await checkTokenAccess({ keepBusy: true });
    if (!silent) {
      toast("Repo je připojené.", "ok");
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
      label: "GitHub login",
      required: "validní token",
      run: () => state.client.requestWithMeta("/user"),
    });

    if (userProbe?.payload) {
      state.user = userProbe.payload;
    }

    const repoReady = Boolean(state.owner && state.repo);
    if (!repoReady) {
      addManualTokenChecks(items, "Doplň owner/repo a spusť kontrolu znovu.");
      state.permissionCheck = {
        status: userProbe ? "warn" : "danger",
        checkedAt,
        message: "Bez vybraného repozitáře jde ověřit jen platnost tokenu.",
        items,
      };
      return;
    }

    const owner = encodeURIComponent(state.owner);
    const repo = encodeURIComponent(state.repo);
    const branch = encodeURIComponent(state.branch || state.defaultBranch || "main");
    const repoPath = `/repos/${owner}/${repo}`;
    const branchPath = `${repoPath}/branches/${branch}`;
    let branchPayload = null;

    await probeTokenEndpoint(items, {
      label: "Repo metadata",
      required: "Metadata: read a repository access",
      run: () => state.client.requestWithMeta(repoPath),
    });

    const contentsReadProbe = await probeTokenEndpoint(items, {
      label: "Contents read",
      required: "Contents: read",
      run: async () => {
        const branchResult = await state.client.requestWithMeta(branchPath);
        branchPayload = branchResult.payload;
        const commitSha = branchPayload?.commit?.sha;
        const commitResult = await state.client.requestWithMeta(`${repoPath}/git/commits/${commitSha}`);
        const treeSha = commitResult.payload?.tree?.sha;
        return state.client.requestWithMeta(`${repoPath}/git/trees/${treeSha}?recursive=1`);
      },
    });

    await probeTokenEndpoint(items, {
      label: "Pull requests read",
      required: "Pull requests: read",
      run: () => state.client.requestWithMeta(`${repoPath}/pulls?state=open&per_page=1`),
    });

    const ref = branchPayload?.commit?.sha || state.headSha || state.branch || state.defaultBranch || "main";
    await probeTokenEndpoint(items, {
      label: "Checks detail",
      required: "Checks: volitelné",
      optional: true,
      run: () => state.client.requestWithMeta(`${repoPath}/commits/${encodeURIComponent(ref)}/check-runs?per_page=1`),
    });

    await probeTokenEndpoint(items, {
      label: "Actions read",
      required: "Actions: read",
      run: () => state.client.requestWithMeta(`${repoPath}/actions/runs?branch=${branch}&per_page=1`),
    });

    addManualTokenChecks(items, contentsReadProbe ? "Write práva se bezpečně netestují bez změny repozitáře." : "");
    const failed = items.filter((item) => item.status === "danger" && !item.optional).length;
    state.permissionCheck = {
      status: failed ? "danger" : "warn",
      checkedAt,
      message: failed
        ? `${failed} kontrol neprošlo. Uprav repository access nebo permissions tokenu.`
        : "Read endpointy prošly. Write permissions zkontroluj ručně podle checklistu.",
      items,
    };
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy("Kontroluji token", run);
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
      label: "Contents write",
      required: "Contents: write",
      status: "warn",
      endpoint: "PUT /repos/{owner}/{repo}/contents/{path}",
      detail: detail || "Nutné pro ukládání souborů. Bezpečně netestováno bez commitu.",
    },
    {
      label: "Pull requests write",
      required: "Pull requests: write",
      status: "warn",
      endpoint: "POST /repos/{owner}/{repo}/pulls",
      detail: "Nutné pro vytvoření PR. Bezpečně netestováno bez založení PR.",
    },
    {
      label: "Actions write",
      required: "Actions: write, volitelné",
      status: "warn",
      endpoint: "POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun",
      detail: "Pouze pro tlačítko Spustit znovu. Jinak stačí Actions: read.",
    },
  );
}

async function refreshRepositoryData({ keepBusy = false, preserveSelection = false } = {}) {
  const run = async () => {
    assertConnected();
    const previousPath = preserveSelection && !state.editor?.dirty ? state.selectedPath : "";
    const previousDir = preserveSelection ? state.selectedDir : "";
    const tree = await state.client.listTree(state.owner, state.repo, state.branch);
    revokePreviewUrls();
    state.editor = null;
    state.preview = null;
    state.selectedPath = "";
    state.selectedDir = "";
    applyRepositoryTree(tree);
    state.lastSave = loadLastSave(state.owner, state.repo, state.branch);
    await Promise.allSettled([
      refreshReviewData({ keepBusy: true }),
      refreshActions({ keepBusy: true, syncBranch: false }),
    ]);

    if (previousPath && state.files.some((file) => file.path === previousPath)) {
      await loadFile(previousPath, { keepBusy: true });
    } else if (previousDir && directoryExists(previousDir)) {
      state.selectedDir = previousDir;
    }
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy("Načítám větev", run);
  }
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
    await withBusy("Načítám review data", run);
  }
}

async function refreshActions({ keepBusy = false, syncBranch = true } = {}) {
  let headChanged = false;
  const run = async () => {
    assertConnected();
    if (syncBranch) {
      headChanged = await syncRepositoryHead({ notify: false });
    }
    const [checkRunsResult, workflowRunsResult] = await Promise.allSettled([
      state.client.getCheckRuns(state.owner, state.repo, state.headSha || state.branch),
      state.client.getWorkflowRuns(state.owner, state.repo, state.branch),
    ]);
    if (checkRunsResult.status === "fulfilled") {
      state.checkRuns = checkRunsResult.value.check_runs || [];
      state.checkRunsError = "";
    } else {
      state.checkRuns = [];
      state.checkRunsError = formatError(checkRunsResult.reason);
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
    await withBusy("Načítám GitHub Actions", run);
  }

  return { headChanged };
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
      stopActionPolling();
      await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
      if (hasRunningActionStatus()) {
        startActionPolling();
      }
      toast("Actions posunuly větev. Head a preview jsou obnovené.", "ok");
      render();
      return;
    }

    if (hasRunningActionStatus() || shouldKeepWaitingForActionStatus()) {
      render();
      startActionPolling();
      return;
    }

    stopActionPolling();
    if (!actionStatusItems().length) {
      render();
      return;
    }

    await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
    toast("Actions doběhly. Větev a preview jsou obnovené.", "ok");
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
  const tree = await state.client.listTree(state.owner, state.repo, state.branch);
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
    toast(`Větev se posunula na ${shortSha(state.headSha)}. Preview jsem obnovil z nového headu.`, "ok");
  }
  return true;
}

function applyRepositoryTree(tree) {
  state.headSha = tree.headSha;
  state.treeTruncated = tree.truncated;
  state.files = tree.tree
    .filter((entry) => entry.type === "blob")
    .sort((a, b) => a.path.localeCompare(b.path));
}

async function startEditSession({ forceNewBranch = false } = {}) {
  if (state.editor?.dirty) {
    toast("Aktuální soubor už má rozepsané změny.", "warn");
    return;
  }

  if (state.selectedPath && !isMarkdownPath(state.selectedPath)) {
    toast("Editace je dostupná jen pro Markdown soubory .md a .mdx.", "warn");
    return;
  }

  await withBusy("Připravuji editaci", async () => {
    assertConnected();
    const previousPath = state.selectedPath;

    if (forceNewBranch || state.branch === state.defaultBranch) {
      const branchName = await createAutomaticEditBranch();
      state.branch = branchName;
      state.branches = await state.client.listBranches(state.owner, state.repo);
      upsertBranchOption(branchName);
      toast(`Vytvořil jsem pracovní větev ${branchName}.`, "ok");
    } else {
      upsertBranchOption(state.branch);
      toast(`Pokračuji v editaci větve ${state.branch}.`, "ok");
    }

    state.editMode = true;
    persistSettings();
    await refreshRepositoryData({ keepBusy: true });

    if (previousPath && state.files.some((file) => file.path === previousPath)) {
      await loadFile(previousPath);
    }
  });
}

function leaveEditSession() {
  if (state.editor?.dirty && !window.confirm("Soubor má neuložené změny. Ukončit editaci?")) {
    return;
  }

  state.editMode = false;
  persistSettings();
  render();
}

async function loadFile(path, { keepBusy = false, syncLatest = false, navigation = "" } = {}) {
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
      throw new Error("Soubor není v aktuálním stromu větve.");
    }

    state.selectedPath = path;
    state.selectedDir = directoryOfPath(path);
    expandPathToFile(path);
    state.editor = {
      path,
      sha: entry.sha,
      size: entry.size,
      content: "",
      binary: !isTextPath(path),
      dirty: false,
    };

    if (isTextPath(path)) {
      const blob = await state.client.getBlob(state.owner, state.repo, entry.sha);
      state.editor.content = base64ToText(blob.content || "");
    }

    await buildPreview(entry, state.editor.content);
    if (navigation) {
      updateBrowserNavigation({ mode: navigation });
    }
  };

  if (keepBusy) {
    await run();
  } else {
    await withBusy("Načítám soubor", run);
  }
}

async function openMarkdownLink(path, anchor) {
  if (path) {
    await loadFile(path, { navigation: "push" });
  }

  if (anchor) {
    window.setTimeout(() => scrollMarkdownAnchor(anchor), 0);
  }
}

function scrollMarkdownAnchor(anchor) {
  const preview = document.querySelector(".markdown-preview");
  const byId = document.getElementById(anchor);
  const byName = preview?.querySelector(`[name="${attrEscape(anchor)}"]`);
  const target = byId && preview?.contains(byId) ? byId : byName;

  if (target instanceof HTMLElement) {
    target.scrollIntoView({ block: "start", behavior: "smooth" });
  } else {
    toast(`Kotva v dokumentu nebyla nalezena: #${anchor}`, "warn");
  }
}

function attrEscape(value) {
  return String(value).replace(/["\\]/g, "\\$&");
}

async function refreshSelectedPreview() {
  if (!state.selectedPath) {
    return;
  }

  await withBusy("Aktualizuji preview", async () => {
    if (state.editor?.dirty) {
      const entry = state.files.find((file) => file.path === state.selectedPath);
      if (!entry) {
        throw new Error("Vybraný soubor už není v aktuálním stromu.");
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
    text: `Preview pro typ ${mime} zatím není podporované.`,
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

async function saveCurrentFile(message) {
  if (!state.editor || state.editor.binary) {
    toast("Vyber Markdown soubor k editaci.", "warn");
    return;
  }

  if (!isMarkdownPath(state.editor.path)) {
    toast("Editace je povolená jen pro Markdown soubory .md a .mdx.", "warn");
    return;
  }

  const textarea = document.querySelector("#editor-content");
  if (textarea instanceof HTMLTextAreaElement) {
    state.editor.content = textarea.value;
  }

  await withBusy("Ukládám commit", async () => {
    assertCanWrite();
    const savedPath = state.editor.path;
    const commitMessage = message || `CMS: update ${state.editor.path}`;
    const response = await state.client.putFile(state.owner, state.repo, state.editor.path, {
      branch: state.branch,
      message: commitMessage,
      contentBase64: textToBase64(state.editor.content),
      sha: state.editor.sha,
    });

    state.editor.sha = response.content?.sha || state.editor.sha;
    state.editor.dirty = false;
    state.headSha = response.commit?.sha || state.headSha;
    saveLastSave(state.owner, state.repo, state.branch, {
      commitSha: state.headSha,
      path: state.editor.path,
      message: commitMessage,
      savedAt: new Date().toISOString(),
      actor: state.user?.login || "",
    });
    state.lastSave = loadLastSave(state.owner, state.repo, state.branch);
    await refreshRepositoryData({ keepBusy: true });
    await loadFile(savedPath);
    await refreshActions({ keepBusy: true });
    startActionPolling();
    persistSettings();
    toast("Commit je ve větvi. Actions sleduji nahoře v toolbaru.", "ok");
  });
}

async function createTextFile(form, data) {
  const name = normalizeMarkdownFileName(String(data.get("name") || ""));
  const dir = currentDirectoryPath();
  const path = joinPath(dir, name);
  const content = String(data.get("content") || "");
  const message = String(data.get("message") || "").trim() || `CMS: create ${path}`;

  if (!name) {
    toast("Doplň název nového Markdown souboru.", "warn");
    return;
  }

  if (!isMarkdownPath(path)) {
    toast("Nové soubory v CMS musí být Markdown: .md nebo .mdx.", "warn");
    return;
  }

  if (state.files.some((file) => file.path === path)) {
    toast("Soubor v aktuální složce už existuje.", "warn");
    return;
  }

  await withBusy("Vytvářím soubor", async () => {
    assertCanWrite();
    await state.client.putFile(state.owner, state.repo, path, {
      branch: state.branch,
      message,
      contentBase64: textToBase64(content),
    });
    state.modal = null;
    await refreshRepositoryData({ keepBusy: true });
    state.selectedDir = dir;
    await loadFile(path, { navigation: "push" });
    await refreshActions({ keepBusy: true });
    startActionPolling();
    toast("Nový soubor je vytvořený. Actions sleduji nahoře v toolbaru.", "ok");
  });
}

async function createFolder(data) {
  const name = normalizePathPart(String(data.get("name") || ""));
  const parentDir = currentDirectoryPath();
  const dirPath = joinPath(parentDir, name);
  const markerPath = joinPath(dirPath, ".gitkeep");
  const message = String(data.get("message") || "").trim() || `CMS: create folder ${dirPath || "/"}`;

  if (!name) {
    toast("Doplň název nové složky.", "warn");
    return;
  }

  if (state.files.some((file) => file.path === markerPath || file.path.startsWith(`${dirPath}/`))) {
    toast("Složka v aktuálním umístění už existuje.", "warn");
    return;
  }

  await withBusy("Vytvářím složku", async () => {
    assertCanWrite();
    await state.client.putFile(state.owner, state.repo, markerPath, {
      branch: state.branch,
      message,
      contentBase64: textToBase64(""),
    });
    state.modal = null;
    state.selectedDir = dirPath;
    expandPathToFile(markerPath);
    await refreshRepositoryData({ keepBusy: true });
    state.selectedDir = dirPath;
    state.expandedDirs.add(dirPath);
    persistSettings();
    await refreshActions({ keepBusy: true });
    startActionPolling();
    toast("Složka je vytvořená. Actions sleduji nahoře v toolbaru.", "ok");
  });
}

async function deleteSelectedFile() {
  if (!state.selectedPath || !state.editor) {
    toast("Vyber soubor ke smazání.", "warn");
    return;
  }

  const path = state.selectedPath;
  if (state.editor.dirty && !window.confirm("Soubor má neuložené změny. Opravdu ho smazat?")) {
    return;
  }

  if (!window.confirm(`Smazat soubor ${path}? Tahle akce vytvoří commit ve větvi ${state.branch}.`)) {
    return;
  }

  await withBusy("Mažu soubor", async () => {
    assertCanWrite();
    const entry = state.files.find((file) => file.path === path);
    const sha = entry?.sha || state.editor.sha;
    if (!sha) {
      throw new Error("Chybí SHA souboru pro smazání.");
    }

    const response = await state.client.deleteFile(state.owner, state.repo, path, {
      branch: state.branch,
      message: `CMS: delete ${path}`,
      sha,
    });

    state.headSha = response.commit?.sha || state.headSha;
    state.selectedPath = "";
    state.selectedDir = directoryOfPath(path);
    state.editor = null;
    state.preview = null;
    removeFilesFromState([path]);
    await refreshRepositoryData({ keepBusy: true, preserveSelection: true });
    removeFilesFromState([path]);
    state.selectedDir = directoryOfPath(path);
    await refreshActions({ keepBusy: true });
    removeFilesFromState([path]);
    updateBrowserNavigation({ mode: "replace" });
    startActionPolling();
    toast("Soubor je smazaný. Actions sleduji nahoře v toolbaru.", "ok");
  });
}

async function deleteSelectedFolder() {
  const dir = currentDirectoryPath();
  if (!dir) {
    toast("Vyber složku ke smazání.", "warn");
    return;
  }

  const files = filesInDirectory(dir);
  if (!files.length) {
    toast("Složka je prázdná nebo není v aktuálním stromu.", "warn");
    return;
  }

  if (
    !window.confirm(
      `Smazat složku ${dir} včetně ${files.length} souborů? Tahle akce vytvoří jeden commit ve větvi ${state.branch}.`,
    )
  ) {
    return;
  }

  await withBusy("Mažu složku", async () => {
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
    removeFilesFromState(files.map((file) => file.path));
    state.selectedDir = parentDirectoryOfDir(dir);
    updateBrowserNavigation({ mode: "replace" });
    startActionPolling();
    toast("Složka je smazaná. Actions sleduji nahoře v toolbaru.", "ok");
  });
}

async function createBranch(rawName) {
  const name = normalizeBranchName(rawName);
  if (!name) {
    toast("Doplň název větve.", "warn");
    return;
  }

  if (state.branches.some((branch) => branch.name === name)) {
    toast("Tahle větev už existuje.", "warn");
    return;
  }

  await withBusy("Vytvářím větev", async () => {
    assertConnected();
    await state.client.createBranch(state.owner, state.repo, name, state.headSha);
    state.branches = await state.client.listBranches(state.owner, state.repo);
    state.branch = name;
    upsertBranchOption(name);
    persistSettings();
    await refreshRepositoryData({ keepBusy: true });
    toast(`Větev ${name} je připravená.`, "ok");
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

  throw new Error("Nepodařilo se najít volný název pracovní větve.");
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
    toast("Pull request se vytváří z pracovní větve, ne z defaultní.", "warn");
    return;
  }

  await withBusy("Vytvářím pull request", async () => {
    assertConnected();
    const title = String(data.get("title") || "").trim() || `CMS: ${state.branch}`;
    const body =
      String(data.get("body") || "").trim() ||
      "Created from Adaptivio CMS. Please review generated artifacts and GitHub Actions before merge.";
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
    state.tab = "review";
    persistSettings();
    toast("Pull request je vytvořený.", "ok");
  });
}

async function loadAnnotations(checkRunId) {
  if (!checkRunId) {
    return;
  }

  await withBusy("Načítám anotace", async () => {
    assertConnected();
    state.annotations[checkRunId] = await state.client.getCheckRunAnnotations(state.owner, state.repo, checkRunId);
  });
}

async function rerunWorkflow(runId) {
  if (!runId) {
    return;
  }

  await withBusy("Spouštím workflow znovu", async () => {
    assertConnected();
    await state.client.rerunWorkflowRun(state.owner, state.repo, runId);
    await refreshActions({ keepBusy: true });
    startActionPolling();
    toast("Workflow bylo zařazené ke znovuspuštění.", "ok");
  });
}

async function startDeviceFlow() {
  const clientId = state.publicConfig.githubOAuthClientId;
  if (!clientId) {
    toast("V cms.config.json není nastavené githubOAuthClientId.", "warn");
    return;
  }

  await withBusy("Připravuji GitHub OAuth", async () => {
    const client = new GitHubClient("");
    const payload = await client.requestDeviceCode(clientId, "repo workflow read:user");
    state.modal = {
      type: "device-flow",
      clientId,
      payload,
      requestedAt: Date.now(),
    };
  });
}

async function pollDeviceFlow() {
  if (state.modal?.type !== "device-flow") {
    return;
  }

  await withBusy("Kontroluji GitHub autorizaci", async () => {
    const client = new GitHubClient("");
    const payload = await client.pollDeviceToken(state.modal.clientId, state.modal.payload.device_code);
    if (payload.access_token) {
      state.token = payload.access_token;
      state.tokenPersistence = "session";
      state.client = new GitHubClient(state.token);
      saveToken(state.token, "session");
      state.modal = null;
      toast("OAuth token je uložený pro aktuální relaci.", "ok");
      await checkTokenAccess({ keepBusy: true });
      return;
    }
    toast(payload.error_description || "Autorizace zatím není dokončená.", "warn");
  });
}

function render() {
  captureTreeScroll();
  const focusSnapshot = captureFocusSnapshot();
  app.innerHTML = `
    <div class="app-shell ${state.busy ? "loading" : ""}">
      ${renderTopbar()}
      <div class="layout">
        <aside class="sidebar">${renderSidebar()}</aside>
        <main class="content">${renderContent()}</main>
      </div>
    </div>
    ${renderModal()}
    <div class="toast-stack">${state.toasts.map(renderToast).join("")}</div>
  `;
  restoreTreeScroll();
  restoreFocusSnapshot(focusSnapshot);
}

function renderTopbar() {
  const repoLabel = state.owner && state.repo ? `${state.owner}/${state.repo}` : "repo zatím není připojené";
  const checkSummary = summarizeChecks();
  return `
    <header class="topbar">
      <div class="brand">
        <h1>Adaptivio CMS</h1>
        <span class="repo-label">${escapeHtml(repoLabel)}</span>
      </div>
      <div class="top-actions">
        ${renderTopbarWorkflowControls()}
        ${state.user ? `<span class="status-pill ok">${escapeHtml(state.user.login)}</span>` : `<span class="status-pill warn">nepřihlášeno</span>`}
        ${state.headSha ? `<span class="status-pill">${shortSha(state.headSha)}</span>` : ""}
        ${checkSummary}
      </div>
    </header>
  `;
}

function renderTopbarWorkflowControls() {
  if (!state.token || !state.owner || !state.repo || !state.headSha) {
    return "";
  }

  const branchOptions = state.branches
    .map((branch) => `<option value="${escapeHtml(branch.name)}" ${branch.name === state.branch ? "selected" : ""}>${escapeHtml(branch.name)}</option>`)
    .join("");
  const prButton = state.branch === state.defaultBranch
    ? ""
    : state.pullRequest
      ? `<button type="button" data-action="open-link" data-url="${escapeHtml(state.pullRequest.html_url)}">PR #${state.pullRequest.number}</button>`
      : `<button class="primary" type="button" data-action="prepare-pr">PR</button>`;
  const editButton = state.editMode
    ? `<button type="button" data-action="leave-edit-session">Browse</button>`
    : `<button class="primary" type="button" data-action="start-edit-session">Edit</button>`;
  const newBranchButton = state.branch === state.defaultBranch
    ? ""
    : `<button type="button" data-action="new-edit-branch" title="Create a new edit branch from current head">Nová větev</button>`;

  return `
    <select id="branch-select" class="top-branch-select" aria-label="Aktuální větev">${branchOptions}</select>
    <span class="status-pill ${state.editMode ? "warn" : ""}">${state.editMode ? "edit session" : "browse mode"}</span>
    ${editButton}
    ${newBranchButton}
    ${prButton}
    <button type="button" data-action="refresh">Obnovit</button>
  `;
}

function renderSidebar() {
  const tokenHint = state.token ? "Token je uložený. Vlož nový jen pokud ho chceš změnit." : "Fine-grained PAT nebo OAuth token.";
  return `
    <section class="section">
      <h2 class="section-title">Přístup</h2>
      <form class="form-grid" data-form="auth">
        <div class="field">
          <label for="token">GitHub token</label>
          <input id="token" name="token" type="password" autocomplete="off" placeholder="${escapeHtml(tokenHint)}" />
        </div>
        <div class="field">
          <label for="persistence">Uložení tokenu</label>
          <select id="persistence" name="persistence">
            <option value="session" ${state.tokenPersistence === "session" ? "selected" : ""}>jen aktuální relace</option>
            <option value="local" ${state.tokenPersistence === "local" ? "selected" : ""}>trvale v tomto prohlížeči</option>
          </select>
        </div>
        <div class="button-row">
          <button class="primary" type="submit">Uložit token</button>
          <button type="button" data-action="clear-token">Odstranit</button>
        </div>
        ${
          state.publicConfig.githubOAuthClientId
            ? `<button type="button" data-action="start-oauth">Přihlásit přes GitHub device flow</button>`
            : ""
        }
        <p class="help">Doporučené minimum: Contents read/write, Pull requests read/write, Actions read a Metadata read. Checks detail je volitelný.</p>
      </form>
    </section>

    ${renderTokenPermissionPanel()}

    <section class="section">
      <h2 class="section-title">Repozitář</h2>
      <form class="form-grid" data-form="repository">
        <div class="field">
          <label for="repository">Private repo</label>
          <input id="repository" name="repository" value="${escapeHtml(state.repositoryInput)}" placeholder="owner/repo" />
        </div>
        <div class="field">
          <label for="default-branch">Defaultní větev</label>
          <input id="default-branch" name="defaultBranch" value="${escapeHtml(state.defaultBranch)}" placeholder="main" />
        </div>
        <button class="primary" type="submit">Připojit repo</button>
      </form>
    </section>

    <section class="section">
      <h2 class="section-title">Approval workflow</h2>
      <p class="help">Výchozí režim je read-only browse. Edit založí pracovní větev jen z defaultní větve; na pracovní větvi pokračuje ve stejné větvi. Novou větev lze založit explicitně.</p>
    </section>
  `;
}

function renderTokenPermissionPanel() {
  const canCheck = Boolean(state.token && state.client);
  return `
    <section class="section">
      <h2 class="section-title">Token permissions</h2>
      <div class="form-grid">
        <p class="help">Fine-grained token nastav pro vybrané repo a povol tyto repository permissions:</p>
        ${renderTokenRequirements()}
        <div class="button-row">
          <button type="button" data-action="check-token-access" ${canCheck ? "" : "disabled"}>Zkontrolovat token</button>
        </div>
        ${renderTokenPermissionCheck()}
      </div>
    </section>
  `;
}

function renderTokenRequirements() {
  return `
    <div class="permission-list">
      ${TOKEN_PERMISSION_REQUIREMENTS.map(
        (item) => `
          <div class="permission-item">
            <span class="permission-name">${escapeHtml(item.label)}</span>
            <span class="tag">${escapeHtml(item.value)}</span>
            <span class="permission-detail">${escapeHtml(item.detail)}</span>
          </div>
        `,
      ).join("")}
    </div>
  `;
}

function renderTokenPermissionCheck() {
  const check = state.permissionCheck;
  if (!check) {
    return `<p class="help">Po uložení tokenu nebo připojení repa tady bude výsledek kontroly. Write práva CMS pouze vypíše, netestuje je bez změny repozitáře.</p>`;
  }

  return `
    <div class="permission-check ${escapeHtml(check.status)}">
      <div class="permission-check-header">
        <span class="tag ${escapeHtml(check.status)}">${escapeHtml(check.status)}</span>
        <span class="micro">${escapeHtml(formatDate(check.checkedAt))}</span>
      </div>
      <p class="help">${escapeHtml(check.message)}</p>
      <div class="permission-list permission-results">
        ${(check.items || [])
          .map(
            (item) => `
              <div class="permission-item">
                <span class="permission-name">${escapeHtml(item.label)}</span>
                <span class="tag ${escapeHtml(item.status)}">${escapeHtml(item.required)}</span>
                ${item.endpoint ? `<span class="path">${escapeHtml(item.endpoint)}</span>` : ""}
                <span class="permission-detail">${escapeHtml(item.detail)}</span>
              </div>
            `,
          )
          .join("")}
      </div>
    </div>
  `;
}

function renderContent() {
  if (!state.token) {
    return `${renderConnectionError()}${renderWelcome("Vlož GitHub token s minimálními právy a připoj private repo.")}`;
  }

  if (!state.owner || !state.repo || !state.headSha) {
    return `${renderConnectionError()}${renderWelcome("Připoj repozitář ve formátu owner/repo. Nastavení lze předvyplnit přes cms.config.json nebo query parametr ?repo=owner/repo.")}`;
  }

  return `
    ${renderConnectionError()}
    ${renderWorkflowBanners()}
    ${state.treeTruncated ? `<p class="banner warn">GitHub vrátil zkrácený strom. Pro velmi velké repo bude potřeba zpřesnit editablePathHints nebo doplnit stránkované načítání.</p>` : ""}
    ${renderTabs()}
    <div class="tab-content tab-content-${escapeHtml(state.tab)}">
      ${state.tab === "files" ? renderFilesTab() : ""}
      ${state.tab === "review" ? renderReviewTab() : ""}
      ${state.tab === "actions" ? renderActionsTab() : ""}
    </div>
  `;
}

function renderConnectionError() {
  return state.connectionError
    ? `
      <div class="banner danger dismissible">
        <span>${escapeHtml(state.connectionError)}</span>
        <button class="dismiss-button" type="button" data-action="dismiss-connection-error" aria-label="Close error">×</button>
      </div>
    `
    : "";
}

function renderWelcome(message) {
  return `
    <p class="banner info">${escapeHtml(message)}</p>
    <div class="split">
      <section class="panel">
        <div class="panel-header"><h2>Workflow</h2></div>
        <div class="panel-body">
          <div class="list">
            <div class="row"><div class="row-main"><p class="row-title">1. Připojit private repo</p><p class="help">Aplikace běží staticky na GitHub Pages a používá token konkrétního uživatele.</p></div></div>
            <div class="row"><div class="row-main"><p class="row-title">2. Vytvořit pracovní větev</p><p class="help">Defaultně se necommitují přímé změny do main/master.</p></div></div>
            <div class="row"><div class="row-main"><p class="row-title">3. Editovat, otevřít PR, sledovat Actions</p><p class="help">CMS ukáže diff, automatické commity i preview HTML/PDF/image artefaktů v sandboxu.</p></div></div>
          </div>
        </div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Oprávnění</h2></div>
        <div class="panel-body">
          <p class="help">Pro fine-grained token nastav jen cílové private repo. Potřebné permissions jsou Contents read/write, Pull requests read/write, Actions read a Metadata read. Checks API je jen volitelný detail.</p>
        </div>
      </section>
    </div>
  `;
}

function renderWorkflowBanners() {
  return `
    ${renderApprovalWorkflowBanner()}
    ${renderPostPushStatus()}
  `;
}

function renderApprovalWorkflowBanner() {
  if (state.editMode) {
    return "";
  }

  const editBehavior =
    state.branch === state.defaultBranch
      ? `založí pracovní větev z aktuálního headu ${escapeHtml(shortSha(state.headSha))}`
      : `odemkne editory ve stávající větvi ${escapeHtml(state.branch)}`;

  return `
      <p class="banner info">
      Browse mode: soubory jsou jen pro čtení a preview. Kliknutím na Edit CMS ${editBehavior}.
      </p>
  `;
}

function renderPostPushStatus() {
  if (!state.lastSave || state.branch === state.defaultBranch) {
    return "";
  }

  const statusItems = actionStatusItems();
  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger");
  const running = statusItems.filter((run) => run.status && run.status !== "completed");
  const source = currentHeadCheckRuns().length ? "checků" : "workflow runs";

  if (failing.length) {
    return `<p class="banner danger">Po posledním commitu selhává ${failing.length} ${source}. Otevři Actions a oprav větev dalším commitem.</p>`;
  }

  if (running.length) {
    return `<p class="banner warn">Po posledním commitu stále běží ${running.length} ${source}. Stav můžeš obnovit v záložce Actions.</p>`;
  }

  if (statusItems.length) {
    return `<p class="banner info">Poslední commit má hotové ${source}. Před PR zkontroluj ještě případné automatické commity a preview artefaktů.</p>`;
  }

  return "";
}

function renderTabs() {
  const tabs = [
    ["files", "Soubory"],
    ["review", "Review"],
    ["actions", "Actions"],
  ];
  return `
    <nav class="tabbar" aria-label="Sekce">
      ${tabs
        .map(([id, label]) => `<button type="button" class="${state.tab === id ? "active" : ""}" data-action="tab" data-tab="${id}">${label}${renderTabBadge(id)}</button>`)
        .join("")}
    </nav>
  `;
}

function renderTabBadge(tabId) {
  if (tabId !== "review") {
    return "";
  }

  const count = changedFileCount();
  return count ? `<span class="tab-badge">${escapeHtml(count)}</span>` : "";
}

function changedFileCount() {
  const files = state.compare?.files?.length ? state.compare.files : state.pullFiles;
  return files?.length || 0;
}

function renderFilesTab() {
  const currentDir = currentDirectoryPath();
  const canDeleteFolder = state.editMode && Boolean(currentDir) && !state.selectedPath && filesInDirectory(currentDir).length > 0;
  return `
    <div class="workbench files-workbench">
      <section class="panel">
        <div class="panel-header">
          <h2>Soubory</h2>
          <span class="tag">${state.files.length}</span>
        </div>
        <div class="panel-body">
          <div class="field">
            <label for="path-filter">Filtr cest</label>
            <input id="path-filter" value="${escapeHtml(state.pathFilter)}" placeholder="content/, .md, generated.html" />
          </div>
          ${
            state.editMode
              ? `<div class="tree-actions">
                  <div class="current-dir">Složka: <span class="path">${escapeHtml(currentDir || "/")}</span></div>
                  <div class="button-row">
                    <button type="button" data-action="open-modal" data-modal="create-text-file">New Markdown</button>
                    <button type="button" data-action="open-modal" data-modal="create-folder">New Folder</button>
                    ${
                      canDeleteFolder
                        ? `<button class="danger" type="button" data-action="delete-folder">Smazat složku</button>`
                        : ""
                    }
                  </div>
                </div>`
              : ""
          }
          ${renderFileList()}
        </div>
      </section>
      <section class="panel editor-panel">
        <div class="panel-header">
          <h2>${state.selectedPath ? escapeHtml(state.selectedPath) : "Editor"}</h2>
          <div class="button-row panel-actions">
            ${state.editor?.dirty ? `<span class="tag warn">neuloženo</span>` : ""}
            ${
              state.editMode && state.selectedPath
                ? `<button class="danger" type="button" data-action="delete-file">Smazat</button>`
                : ""
            }
          </div>
        </div>
        <div class="panel-body">${renderEditor()}</div>
      </section>
    </div>
  `;
}

function renderFileList() {
  const files = filteredFiles();
  if (!files.length) {
    return `<div class="empty">Žádné soubory neodpovídají filtru.</div>`;
  }

  const tree = buildFileTree(files);
  const filtering = Boolean(state.pathFilter.trim());

  return `
    <div class="file-list tree-browser" role="tree" aria-label="Repository files">
      ${renderTreeNodes(tree, 0, filtering)}
    </div>
  `;
}

function renderTreeNodes(node, depth, forceExpanded = false) {
  const children = [...node.dirs.values(), ...node.files];
  if (!children.length) {
    return "";
  }

  return children
    .map((child) => (child.type === "dir" ? renderTreeDirectory(child, depth, forceExpanded) : renderTreeFile(child, depth)))
    .join("");
}

function renderTreeDirectory(dir, depth, forceExpanded = false) {
  const expanded = forceExpanded || state.expandedDirs.has(dir.path);
  const fileCount = dir.count || 0;
  const isSelectedAncestor = Boolean(state.selectedPath) && state.selectedPath.startsWith(`${dir.path}/`);
  const isSelectedDir = state.selectedDir === dir.path && !state.selectedPath;
  return `
    <div class="tree-row tree-dir ${isSelectedAncestor ? "contains-active" : ""} ${isSelectedDir ? "active-dir" : ""}" role="treeitem" aria-expanded="${expanded}" style="--depth: ${depth};">
      <button class="tree-toggle" type="button" data-action="toggle-dir" data-path="${escapeHtml(dir.path)}" aria-label="${expanded ? "Sbalit" : "Rozbalit"} ${escapeHtml(dir.name)}">
        <span class="tree-caret" aria-hidden="true">${expanded ? "" : ""}</span>
        <span class="tree-icon tree-icon-dir" aria-hidden="true"></span>
        <span class="tree-label">
          <span class="path">${escapeHtml(dir.name)}</span>
          <span class="tree-meta">${fileCount} files</span>
        </span>
      </button>
    </div>
    ${expanded ? renderTreeNodes(dir, depth + 1, forceExpanded) : ""}
  `;
}

function renderTreeFile(file, depth) {
  const previewable = isTextPath(file.path) || isImagePath(file.path) || isPdfPath(file.path);
  const ext = extensionOf(file.path);
  return `
    <button class="tree-row tree-file ${state.selectedPath === file.path ? "active" : ""}" role="treeitem" type="button" data-action="select-file" data-path="${escapeHtml(file.path)}" title="${escapeHtml(file.path)}" style="--depth: ${depth};">
      <span class="tree-spacer"></span>
      <span class="tree-icon tree-icon-file ${escapeHtml(fileIconClass(file.path))}" aria-hidden="true"></span>
      <span class="tree-label">
        <span class="path">${escapeHtml(file.name)}</span>
        <span class="tree-meta">${escapeHtml(ext || "file")}</span>
      </span>
      <span class="tree-size ${previewable ? "" : "is-binary"}">${previewable ? escapeHtml(humanBytes(file.size)) : "binary"}</span>
    </button>
  `;
}

function fileIconClass(path) {
  const ext = extensionOf(path);
  if (["md", "mdx", "txt"].includes(ext)) {
    return "tree-icon-doc";
  }
  if (["json", "yaml", "yml", "toml", "csv"].includes(ext)) {
    return "tree-icon-data";
  }
  if (["html", "htm", "css", "js", "mjs", "ts", "tsx", "jsx", "astro"].includes(ext)) {
    return "tree-icon-code";
  }
  if (["png", "jpg", "jpeg", "gif", "webp", "avif", "svg"].includes(ext)) {
    return "tree-icon-image";
  }
  if (ext === "pdf") {
    return "tree-icon-pdf";
  }
  return "";
}

function renderEditor() {
  if (!state.editor) {
    return `<div class="empty">Vyber soubor vlevo. V browse mode uvidíš preview, v edit session se textové soubory změní na editor.</div>`;
  }

  if (!state.editMode) {
    return renderBrowsePreview();
  }

  if (!isMarkdownPath(state.editor.path)) {
    return `
      <div class="browse-preview">
        <p class="banner warn">Tento soubor je jen pro čtení. Edit session podporuje pouze Markdown soubory .md a .mdx.</p>
        ${renderPreviewPane("full")}
      </div>
    `;
  }

  return `
    <form data-form="save-file">
      <div>
        <textarea id="editor-content" class="editor-textarea editor-textarea-full" spellcheck="false">${escapeHtml(state.editor.content)}</textarea>
        <div class="field" style="margin-top: 10px;">
          <label for="message">Commit message</label>
          <input id="message" name="message" placeholder="CMS: update ${escapeHtml(state.editor.path)}" />
        </div>
        <div class="button-row" style="margin-top: 10px;">
          <button class="primary" type="submit">Save commit & check branch</button>
        </div>
        <p class="help" style="margin-top: 10px;">Markdown preview je záměrně vypnutý během editace. Ulož logický commit, CMS potom přepne na Actions a ukáže CI chyby, anotace nebo automatické změny.</p>
      </div>
    </form>
  `;
}

function renderBrowsePreview() {
  if (!state.preview) {
    return `<div class="empty">Preview není načtené.</div>`;
  }

  if (state.editor && isMarkdownPath(state.editor.path)) {
    return `
      <div class="browse-preview">
        <div class="browse-preview-header">
          <span class="status-pill">read-only preview</span>
          <button class="primary" type="button" data-action="start-edit-session">Edit</button>
        </div>
        <article class="markdown-preview">${renderMarkdown(state.editor.content)}</article>
      </div>
    `;
  }

  return `
    <div class="browse-preview">
      <div class="browse-preview-header">
        <span class="status-pill">read-only preview</span>
        <button class="primary" type="button" data-action="start-edit-session">Edit</button>
      </div>
      ${renderPreviewPane("full")}
    </div>
  `;
}

function renderPreviewPane(mode = "") {
  if (!state.preview) {
    return `<div class="empty">Preview není načtené.</div>`;
  }

  const fullClass = mode === "full" ? " preview-full" : "";

  if (state.preview.kind === "html") {
    return `<iframe class="preview-frame${fullClass}" title="HTML preview" sandbox="" srcdoc="${escapeHtml(state.preview.html || "")}"></iframe>`;
  }

  if (state.preview.kind === "image") {
    return `<img class="preview-image${fullClass}" alt="Preview ${escapeHtml(state.preview.path)}" src="${escapeHtml(state.preview.url)}" />`;
  }

  if (state.preview.kind === "pdf") {
    return `<object class="preview-object${fullClass}" data="${escapeHtml(state.preview.url)}" type="application/pdf"><a href="${escapeHtml(state.preview.url)}" download>Stáhnout PDF</a></object>`;
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

  return `${renderFrontMatter(parsed.frontMatter)}${html.join("")}`;
}

function renderMarkdownInline(value) {
  return escapeHtml(value)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/__([^_]+)__/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/_([^_]+)_/g, "<em>$1</em>")
    .replace(
      /\[([^\]]+)\]\(([^)\s]+)(?:\s+&quot;[^&]*&quot;)?\)/g,
      (match, label, href) => renderMarkdownLink(label, href) || match,
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
    return `<a href="#${escapeHtml(target.anchor)}" data-action="open-markdown-link" data-anchor="${escapeHtml(target.anchor)}">${label}</a>`;
  }

  if (target.path) {
    return `<a href="#${escapeHtml(target.anchor || "")}" data-action="open-markdown-link" data-path="${escapeHtml(target.path)}" data-anchor="${escapeHtml(target.anchor || "")}">${label}</a>`;
  }

  return `<a href="#" data-action="missing-markdown-link" data-href="${escapeHtml(safeHref)}">${label}</a>`;
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

  if (/^[A-Za-z0-9._~!$&'()*+,;=:@%/-]+(?:\?[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?(?:#[A-Za-z0-9._~!$&'()*+,;=:@%/?-]*)?$/.test(decoded)) {
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
  const resolved = resolveRepoRelativePath(cleanPath, state.editor?.path || "");
  const candidates = [
    resolved,
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

function renderFrontMatter(entries) {
  if (!entries.length) {
    return "";
  }

  return `
    <details class="frontmatter-preview">
      <summary>Front matter</summary>
      <dl>
        ${entries
          .map((entry) => `<div><dt>${escapeHtml(entry.key)}</dt><dd>${renderMarkdownInline(entry.value)}</dd></div>`)
          .join("")}
      </dl>
    </details>
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

function renderReviewTab() {
  if (state.branch === state.defaultBranch) {
    return `<p class="banner info">Review je dostupné pro pracovní větev. Vytvoř větev z ${escapeHtml(state.defaultBranch)} a CMS ukáže diff, PR a automatické commity.</p>`;
  }

  return `
    <div class="split">
      <section class="panel">
        <div class="panel-header">
          <h2>Pull request</h2>
          ${state.pullRequest ? `<span class="tag ok">#${state.pullRequest.number}</span>` : `<span class="tag warn">není vytvořený</span>`}
        </div>
        <div class="panel-body">${renderPullRequestSummary()}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Diff proti ${escapeHtml(state.defaultBranch)}</h2></div>
        <div class="panel-body">${renderCompareSummary(state.compare)}</div>
      </section>
    </div>
    <section class="panel" style="margin-top: 14px;">
      <div class="panel-header"><h2>Změny po posledním CMS commitu</h2></div>
      <div class="panel-body">${renderExternalCompare()}</div>
    </section>
    <section class="panel" style="margin-top: 14px;">
      <div class="panel-header"><h2>Commity v PR</h2></div>
      <div class="panel-body">${renderCommitList()}</div>
    </section>
  `;
}

function renderPullRequestSummary() {
  if (!state.pullRequest) {
    return `
      <p class="help">Pro větev ${escapeHtml(state.branch)} zatím není otevřený PR do ${escapeHtml(state.defaultBranch)}.</p>
      <div class="button-row" style="margin-top: 10px;">
        <button class="primary" type="button" data-action="prepare-pr">Vytvořit PR</button>
      </div>
    `;
  }

  return `
    <p class="row-title">${escapeHtml(state.pullRequest.title)}</p>
    <p class="help">${escapeHtml(state.pullRequest.user?.login || "")} otevřel ${escapeHtml(formatDate(state.pullRequest.created_at))}</p>
    <div class="button-row" style="margin-top: 10px;">
      <button type="button" data-action="open-link" data-url="${escapeHtml(state.pullRequest.html_url)}">Otevřít na GitHubu</button>
    </div>
  `;
}

function renderCompareSummary(compare) {
  if (!compare) {
    return `<div class="empty">Diff zatím není načtený.</div>`;
  }

  const files = compare.files || state.pullFiles || [];
  return `
    <p class="help">Ahead ${compare.ahead_by || 0}, behind ${compare.behind_by || 0}, souborů ${files.length}.</p>
    ${renderChangedFiles(files)}
  `;
}

function renderExternalCompare() {
  if (!state.lastSave) {
    return `<div class="empty">Po uložení z CMS se sem uloží poslední commit a následné změny z Actions nebo ruční práce půjdou porovnat.</div>`;
  }

  if (!state.externalCompare) {
    return `<p class="banner info">Od posledního CMS commitu ${escapeHtml(shortSha(state.lastSave.commitSha))} se head větve nezměnil.</p>`;
  }

  const files = state.externalCompare.files || [];
  return `
    <p class="banner warn">Větev se změnila po posledním CMS commitu ${escapeHtml(shortSha(state.lastSave.commitSha))}. Zkontroluj automatické nebo externí změny před dalším uložením.</p>
    ${renderChangedFiles(files)}
  `;
}

function renderChangedFiles(files) {
  if (!files.length) {
    return `<div class="empty">Žádné změněné soubory.</div>`;
  }

  return `
    <div class="list" style="margin-top: 10px;">
      ${files
        .map((file) => {
          const canPreview = file.status !== "removed" && (isTextPath(file.filename) || isImagePath(file.filename) || isPdfPath(file.filename));
          return `
            <div class="row">
              <div class="row-main">
                <p class="row-title path">${escapeHtml(file.filename)}</p>
                <div class="row-meta">
                  <span class="tag">${escapeHtml(file.status)}</span>
                  <span class="tag ok">+${file.additions || 0}</span>
                  <span class="tag danger">-${file.deletions || 0}</span>
                </div>
              </div>
              ${canPreview ? `<button type="button" data-action="preview-file" data-path="${escapeHtml(file.filename)}">Preview</button>` : ""}
            </div>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderCommitList() {
  const commits = state.pullCommits.length ? state.pullCommits : state.compare?.commits || [];
  if (!commits.length) {
    return `<div class="empty">Commity zatím nejsou načtené.</div>`;
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
                ${action ? `<span class="tag warn">automatizace</span>` : ""}
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
    <div class="split">
      <section class="panel">
        <div class="panel-header">
          <h2>Checks detail</h2>
          <button type="button" data-action="refresh-actions">Obnovit</button>
        </div>
        <div class="panel-body">${renderCheckRuns()}</div>
      </section>
      <section class="panel">
        <div class="panel-header"><h2>Workflow runs větve</h2></div>
        <div class="panel-body">${renderWorkflowRuns()}</div>
      </section>
    </div>
  `;
}

function renderActionsOverview() {
  if (!state.lastSave) {
    return `<p class="banner info">Po prvním commitu v edit session tady uvidíš, jestli GitHub Actions běží, selhaly, nebo přidaly další změny do větve.</p>`;
  }

  const statusItems = actionStatusItems();
  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger");
  const running = statusItems.filter((run) => run.status && run.status !== "completed");
  const actionCommits = (state.pullCommits.length ? state.pullCommits : state.compare?.commits || []).filter(isActionAuthor);

  if (failing.length) {
    return `<p class="banner danger">Action required: ${failing.length} ${currentHeadCheckRuns().length ? "checků" : "workflow runs"} selhává. Oprav soubory v edit session a ulož další commit do stejné větve.</p>`;
  }

  if (running.length) {
    return `<p class="banner warn">${running.length} ${currentHeadCheckRuns().length ? "checků" : "workflow runs"} stále běží. Obnov stav za chvíli; případné automatické commity se ukážou v Review.</p>`;
  }

  if (state.externalCompare || actionCommits.length) {
    return `<p class="banner warn">Automation changed the branch. Zkontroluj Review, diff po posledním CMS commitu a preview generovaných artefaktů před vytvořením PR.</p>`;
  }

  if (statusItems.length) {
    return `<p class="banner info">Actions jsou hotové. Další krok: zkontroluj preview a vytvoř nebo otevři PR.</p>`;
  }

  return "";
}

function renderCheckRuns() {
  if (state.checkRunsError) {
    return `
      <p class="banner warn">Detailní Checks API není dostupné pro aktuální token. To nevadí pro běžný workflow; stav sleduj vpravo přes Workflow runs.</p>
      <p class="help">${escapeHtml(state.checkRunsError)}</p>
    `;
  }

  if (!state.checkRuns.length) {
    return `<div class="empty">Na head commitu nejsou žádné check runs.</div>`;
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
                  <span class="tag ${tone}">${escapeHtml(run.conclusion || run.status)}</span>
                  <span class="tag">${escapeHtml(formatDate(run.completed_at || run.started_at))}</span>
                </div>
                ${run.output?.summary ? `<p class="help">${escapeHtml(run.output.summary).slice(0, 400)}</p>` : ""}
                ${annotations.length ? renderAnnotations(annotations) : ""}
              </div>
              <div class="button-row">
                <button type="button" data-action="load-annotations" data-check-id="${run.id}">Anotace</button>
                <button type="button" data-action="open-link" data-url="${escapeHtml(run.html_url)}">GitHub</button>
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
    return `<div class="empty">Pro tuhle větev nejsou workflow runs nebo token nemá Actions read.</div>`;
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
                  <span class="tag ${tone}">${escapeHtml(run.conclusion || run.status)}</span>
                  <span class="tag">${escapeHtml(shortSha(run.head_sha))}</span>
                  <span class="tag">${escapeHtml(formatDate(run.updated_at || run.created_at))}</span>
                </div>
              </div>
              <div class="button-row">
                <button type="button" data-action="rerun-workflow" data-run-id="${run.id}">Spustit znovu</button>
                <button type="button" data-action="open-link" data-url="${escapeHtml(run.html_url)}">GitHub</button>
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
    "create-text-file": renderCreateTextFileModal,
    "create-folder": renderCreateFolderModal,
    "create-pr": renderCreatePrModal,
    "device-flow": renderDeviceFlowModal,
  }[state.modal.type]?.();

  if (!body) {
    return "";
  }

  return `<div class="modal-backdrop">${body}</div>`;
}

function renderCreateTextFileModal() {
  const dir = currentDirectoryPath();
  const placeholderPath = joinPath(dir, "stranka.md");
  return `
    <form class="modal" data-form="create-text-file">
      <div class="modal-header"><h2>New Markdown file</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="new-file-name">Název</label>
          <input id="new-file-name" name="name" placeholder="stranka.md" autofocus />
          <p class="help">Složka: <span class="path">${escapeHtml(dir || "/")}</span></p>
        </div>
        <div class="field">
          <label for="new-file-content">Obsah</label>
          <textarea id="new-file-content" name="content" spellcheck="false"></textarea>
        </div>
        <div class="field">
          <label for="new-file-message">Commit message</label>
          <input id="new-file-message" name="message" placeholder="CMS: create ${escapeHtml(placeholderPath)}" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">Zrušit</button>
        <button class="primary" type="submit">Vytvořit</button>
      </div>
    </form>
  `;
}

function renderCreateFolderModal() {
  const dir = currentDirectoryPath();
  return `
    <form class="modal" data-form="create-folder">
      <div class="modal-header"><h2>New folder</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="new-folder-name">Název</label>
          <input id="new-folder-name" name="name" placeholder="sekce" autofocus />
          <p class="help">Složka: <span class="path">${escapeHtml(dir || "/")}</span></p>
        </div>
        <div class="field">
          <label for="new-folder-message">Commit message</label>
          <input id="new-folder-message" name="message" placeholder="CMS: create folder ${escapeHtml(joinPath(dir, "sekce"))}" />
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">Zrušit</button>
        <button class="primary" type="submit">Vytvořit</button>
      </div>
    </form>
  `;
}

function renderCreatePrModal() {
  const title = `CMS: ${state.branch}`;
  const body = `Změny připravené v Adaptivio CMS.\n\n- Branch: ${state.branch}\n- Base: ${state.defaultBranch}\n- Head: ${shortSha(state.headSha)}\n`;
  return `
    <form class="modal" data-form="create-pr">
      <div class="modal-header"><h2>Vytvořit pull request</h2></div>
      <div class="modal-body form-grid">
        <div class="field">
          <label for="pr-title">Titulek</label>
          <input id="pr-title" name="title" value="${escapeHtml(title)}" />
        </div>
        <div class="field">
          <label for="pr-body">Popis</label>
          <textarea id="pr-body" name="body">${escapeHtml(body)}</textarea>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">Zrušit</button>
        <button class="primary" type="submit">Vytvořit PR</button>
      </div>
    </form>
  `;
}

function renderDeviceFlowModal() {
  const payload = state.modal.payload;
  return `
    <div class="modal">
      <div class="modal-header"><h2>GitHub device flow</h2></div>
      <div class="modal-body form-grid">
        <p class="help">Otevři ověřovací stránku, vlož kód a potom tady potvrď dokončení. Pokud GitHub OAuth endpoint v prohlížeči blokuje CORS, použij fine-grained token.</p>
        <div class="row">
          <div class="row-main">
            <p class="row-title path">${escapeHtml(payload.user_code)}</p>
            <p class="help">${escapeHtml(payload.verification_uri)}</p>
          </div>
          <div class="button-row">
            <button type="button" data-action="copy-code" data-code="${escapeHtml(payload.user_code)}">Kopírovat</button>
            <button type="button" data-action="open-link" data-url="${escapeHtml(payload.verification_uri)}">Otevřít</button>
          </div>
        </div>
      </div>
      <div class="modal-footer">
        <button type="button" data-action="close-modal">Zrušit</button>
        <button class="primary" type="button" data-action="poll-oauth">Autorizováno</button>
      </div>
    </div>
  `;
}

function renderToast(toastItem) {
  return `
    <div class="toast ${escapeHtml(toastItem.tone)}">
      <span>${escapeHtml(toastItem.message)}</span>
      <button class="dismiss-button" type="button" data-action="dismiss-toast" data-toast-id="${escapeHtml(toastItem.id)}" aria-label="Close notification">×</button>
    </div>
  `;
}

function summarizeChecks() {
  const statusItems = actionStatusItems();
  if (!statusItems.length) {
    return state.actionPolling ? `<span class="status-pill warn">actions čekám</span>` : "";
  }

  const failing = statusItems.filter((run) => classifyConclusion(run.conclusion, run.status) === "danger").length;
  const running = statusItems.filter((run) => run.status && run.status !== "completed").length;
  const polling = state.actionPolling ? `<span class="status-pill">auto refresh</span>` : "";
  if (failing) {
    return `<span class="status-pill danger">${failing} failing</span>${polling}`;
  }
  if (running) {
    return `<span class="status-pill warn">${running} running</span>${polling}`;
  }
  return `<span class="status-pill ok">actions ok</span>`;
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
  const rawFilter = state.pathFilter.trim().toLowerCase();
  const hints = [...(state.publicConfig.editablePathHints || []), ...(state.publicConfig.previewPathHints || [])]
    .filter(Boolean)
    .map((hint) => String(hint).toLowerCase());

  let files = state.files;
  if (rawFilter) {
    files = files.filter((file) => file.path.toLowerCase().includes(rawFilter));
  } else if (hints.length) {
    const hinted = files.filter((file) => hints.some((hint) => file.path.toLowerCase().startsWith(hint)));
    files = hinted.length ? hinted : files;
  }

  return files;
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
  node.files.sort((a, b) => a.name.localeCompare(b.name));
  const sortedDirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b));
  node.dirs = new Map(sortedDirs);
  node.count = node.files.length;
  for (const child of node.dirs.values()) {
    sortTree(child);
    node.count += child.count || 0;
  }
}

function navigationFromLocation() {
  const params = new URLSearchParams(window.location.search);
  return {
    branch: params.get("branch") || "",
    path: normalizePath(params.get("path") || ""),
    dir: normalizePath(params.get("dir") || ""),
  };
}

function updateBrowserNavigation({ mode = "replace" } = {}) {
  if (!state.owner || !state.repo || restoringBrowserNavigation) {
    return;
  }

  const url = new URL(window.location.href);
  url.searchParams.set("repo", `${state.owner}/${state.repo}`);
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

  if (state.editor?.dirty && !window.confirm("Soubor má neuložené změny. Přejít na vybraný stav historie?")) {
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
          throw new Error(`Větev z historie neexistuje: ${nextBranch}`);
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
        await loadFile(nextPath, { keepBusy: true });
        return;
      }

      revokePreviewUrls();
      state.selectedPath = "";
      state.editor = null;
      state.preview = null;
      if (nextDir && directoryExists(nextDir)) {
        state.selectedDir = nextDir;
        state.expandedDirs.add(nextDir);
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

  await withBusy("Načítám stav z historie", run);
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

function expandPathToFile(path) {
  const parts = path.split("/");
  for (let index = 1; index < parts.length; index += 1) {
    state.expandedDirs.add(parts.slice(0, index).join("/"));
  }
  persistSettings();
}

function captureTreeScroll() {
  const list = document.querySelector(".file-list");
  if (list instanceof HTMLElement) {
    state.treeScrollTop = list.scrollTop;
  }
}

function restoreTreeScroll() {
  window.requestAnimationFrame(() => {
    const list = document.querySelector(".file-list");
    if (list instanceof HTMLElement) {
      list.scrollTop = state.treeScrollTop;
    }
  });
}

function captureFocusSnapshot() {
  const active = document.activeElement;
  if (!(active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement || active instanceof HTMLSelectElement)) {
    return null;
  }

  return {
    id: active.id,
    selectionStart: "selectionStart" in active ? active.selectionStart : null,
    selectionEnd: "selectionEnd" in active ? active.selectionEnd : null,
  };
}

function restoreFocusSnapshot(snapshot) {
  if (!snapshot?.id) {
    return;
  }

  window.requestAnimationFrame(() => {
    const target = document.getElementById(snapshot.id);
    if (!(target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement)) {
      return;
    }

    target.focus({ preventScroll: true });
    if (
      (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) &&
      snapshot.selectionStart !== null &&
      snapshot.selectionEnd !== null
    ) {
      target.setSelectionRange(snapshot.selectionStart, snapshot.selectionEnd);
    }
  });
}

function assertConnected() {
  if (!state.client || !state.owner || !state.repo) {
    throw new Error("Repo není připojené.");
  }
}

function assertCanWrite() {
  assertConnected();
  if (!state.editMode) {
    throw new Error("Nejdřív spusť edit session tlačítkem Edit.");
  }
  if (state.branch === state.defaultBranch && !state.allowDefaultBranchEdits) {
    throw new Error("Přímé ukládání do defaultní větve je vypnuté.");
  }
}

async function withBusy(label, task) {
  state.busy = true;
  state.busyLabel = label;
  render();
  try {
    await task();
  } catch (error) {
    state.connectionError = formatError(error);
    toast(state.connectionError, "danger");
  } finally {
    state.busy = false;
    state.busyLabel = "";
    render();
  }
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

  const persistenceInput = document.querySelector("#persistence");
  const persistence = persistenceInput instanceof HTMLSelectElement ? persistenceInput.value : state.tokenPersistence;
  state.token = token;
  state.tokenPersistence = persistence;
  state.client = new GitHubClient(token);
  saveToken(token, persistence);
}

function summarizeTokenProbeError(error) {
  if (error instanceof GitHubError) {
    const required = formatPermissionMeta(error.meta);
    return [
      `GitHub ${error.status || ""}: ${error.message}`,
      required ? `Vyžaduje: ${required}` : "",
      error.payload?.documentation_url ? `Docs: ${error.payload.documentation_url}` : "",
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

  const acceptedScopes = meta.acceptedOauthScopes ? `accepted OAuth scopes: ${meta.acceptedOauthScopes}` : "";
  const tokenScopes = meta.oauthScopes ? `token scopes: ${meta.oauthScopes}` : "";
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
    .join(" nebo ");
}

function formatError(error) {
  if (error instanceof GitHubError) {
    const request = formatRequestMeta(error.meta);
    const requestDetail = request ? ` Požadavek: ${request}.` : "";
    const permissionDetail = formatPermissionMeta(error.meta);
    const permissions = permissionDetail ? ` GitHub endpoint vyžaduje: ${permissionDetail}.` : "";
    const docs = error.payload?.documentation_url ? ` Docs: ${error.payload.documentation_url}.` : "";
    const requestId = error.meta?.requestId ? ` Request ID: ${error.meta.requestId}.` : "";
    if (error.status === 401) {
      return `GitHub 401: token není platný nebo vypršel.${requestDetail} Vytvoř nový fine-grained token pro cílové repo.${docs}`;
    }
    if (error.status === 403) {
      return `GitHub 403: token nemá potřebná oprávnění nebo narazil na limit.${requestDetail}${permissions} Detail: ${error.message}.${docs}${requestId}`;
    }
    if (error.status === 404) {
      return `GitHub 404: repo nebylo nalezeno nebo token nemá přístup k tomuto private repo.${requestDetail} Zkontroluj owner/repo a repository access u tokenu.${docs}`;
    }
    return `GitHub ${error.status || ""}: ${error.message}.${requestDetail}${permissions}${docs}`;
  }
  return error?.message || String(error);
}

function persistSettings() {
  saveSettings({
    repository: state.owner && state.repo ? `${state.owner}/${state.repo}` : state.repositoryInput,
    defaultBranch: state.defaultBranch,
    branch: state.branch,
    tab: state.tab,
    expandedDirs: [...state.expandedDirs],
    allowDefaultBranchEdits: state.allowDefaultBranchEdits,
  });
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
