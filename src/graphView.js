// Canvas viewer for the library graph tab.
//
// The graph tab is a self-contained surface: app.js only provides the tab
// shell HTML (graphTabHtml), calls mountGraphView after every render while
// the tab is active, and unmountGraphView when it is not. All interaction
// state (node positions, camera, selection, hidden units) lives here in a
// module-level cache keyed by the repository head, so app re-renders and
// tab switches do not restart the layout from scratch.
//
// Ported from the standalone AVDS graph viewer: force layout with alpha
// decay, drag/pan/wheel/pinch navigation, screen-space collision-aware
// labels, neighborhood highlighting, legend unit toggles. Colors follow the
// CMS theme tokens; unit colors come from the graph model palette.

import { diffGraphModels, largestComponentPct } from "./graph.js";

const GRAPH_CONTAINER_ID = "graph-canvas-host";
const GRAPH_TOOLBAR_SEARCH_ID = "graph-search-input";

const persist = {
  key: "",
  positions: new Map(), // node id -> {x, y}
  camera: { scale: 1, x: 0, y: 0 },
  hiddenUnits: new Set(),
  metric: "indeg",
  statusFilter: "",
  authorityFilter: "",
  typeFilter: "",
  search: "",
  selectedId: "",
  localFocusId: "",
  diffWithMaster: false,
  minimized: new Set(),
};

let view = null;

export function graphTabHtml() {
  return `
    <div class="graph-tab">
      <div class="graph-toolbar">
        <input id="${GRAPH_TOOLBAR_SEARCH_ID}" class="graph-search" type="search" autocomplete="off" spellcheck="false" />
        <div class="graph-toolbar-group" data-graph-role="metric"></div>
        <div class="graph-toolbar-group" data-graph-role="filters"></div>
        <div class="graph-toolbar-group">
          <button type="button" class="button-quiet graph-units-toggle" data-graph-role="units"></button>
          <button type="button" class="button-quiet" data-graph-role="diff" hidden></button>
        </div>
        <div class="graph-toolbar-spacer"></div>
        <button type="button" class="button-quiet" data-graph-role="health"></button>
        <button type="button" class="button-quiet" data-graph-role="reset"></button>
      </div>
      <div class="graph-body">
        <div id="${GRAPH_CONTAINER_ID}" class="graph-canvas-host"></div>
        <div class="graph-overlay graph-legend" data-graph-role="legend"></div>
        <div class="graph-overlay graph-stats" data-graph-role="stats"></div>
        <div class="graph-overlay graph-hint" data-graph-role="hint"></div>
        <div class="graph-overlay graph-info" data-graph-role="info" hidden></div>
        <div class="graph-overlay graph-health" data-graph-role="health-panel" hidden></div>
        <div class="graph-overlay graph-diff" data-graph-role="diff-panel" hidden></div>
        <div class="graph-overlay graph-edge-tip" data-graph-role="edge-tip" hidden></div>
        <div class="graph-overlay graph-local-chip" data-graph-role="local-chip" hidden></div>
      </div>
    </div>
  `;
}

function resetPersist(key) {
  persist.key = key;
  persist.positions = new Map();
  persist.camera = { scale: 1, x: 0, y: 0 };
  persist.hiddenUnits = new Set();
  persist.selectedId = "";
  persist.localFocusId = "";
  persist.diffWithMaster = false;
  persist.minimized = new Set();
}

function escapeHtml(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function normalizeSearchText(value) {
  return String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "");
}

function themePalette() {
  const styles = getComputedStyle(document.documentElement);
  const read = (name, fallback) => styles.getPropertyValue(name).trim() || fallback;
  return {
    surface: read("--surface-alt", "#f1f3f5"),
    line: read("--line-strong", "#aeb7c2"),
    text: read("--text", "#111111"),
    muted: read("--muted", "#59636e"),
    accent: read("--accent", "#17758a"),
    ok: read("--ok", "#12662e"),
    warn: read("--warn", "#8a3d00"),
    danger: read("--danger", "#9f241d"),
  };
}

function hexToRgba(hex, alpha) {
  const clean = String(hex || "").replace("#", "");
  if (clean.length !== 6) {
    return `rgba(120, 120, 120, ${alpha})`;
  }
  const r = parseInt(clean.slice(0, 2), 16);
  const g = parseInt(clean.slice(2, 4), 16);
  const b = parseInt(clean.slice(4, 6), 16);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

export function unmountGraphView() {
  if (!view) {
    return;
  }
  view.alive = false;
  if (view.raf) {
    cancelAnimationFrame(view.raf);
  }
  for (const dispose of view.disposers) {
    try {
      dispose();
    } catch {
      // ignore teardown errors during re-renders
    }
    view.running = false;
  }
  view.raf = 0;
  view = null;
}

export function mountGraphView({ model, modelKey, t, branchLabel, openFile, canDiff = false, diffContext = null, loadDiffContext = null, compareUrl = "", compareBehindUrl = "", onStateChange = null }) {
  const host = document.getElementById(GRAPH_CONTAINER_ID);
  if (!host) {
    unmountGraphView();
    return;
  }

  unmountGraphView();

  if (persist.key !== modelKey) {
    resetPersist(modelKey);
  }

  const disposers = [];
  const canvas = document.createElement("canvas");
  canvas.className = "graph-canvas";
  host.replaceChildren(canvas);

  const nodes = model.nodes.map((node, index) => {
    const cached = persist.positions.get(node.id);
    if (cached) {
      return { ...node, x: cached.x, y: cached.y, vx: 0, vy: 0, fx: 0, fy: 0, placed: true };
    }
    // Deterministic golden-angle spiral seed: nodes stacked at exactly the
    // same coordinates can never separate (repulsion direction degenerates).
    const angle = index * 2.399963;
    const radius = 24 + 11 * Math.sqrt(index);
    return {
      ...node,
      x: Math.cos(angle) * radius,
      y: Math.sin(angle) * radius,
      vx: 0,
      vy: 0,
      fx: 0,
      fy: 0,
      placed: false,
    };
  });
  const nodeIndexById = new Map(nodes.map((node, index) => [node.id, index]));
  if (persist.selectedId && !nodeIndexById.has(persist.selectedId)) {
    persist.selectedId = "";
  }
  view = {
    alive: true,
    raf: 0,
    disposers,
    model,
    nodes,
    nodeIndexById,
    edges: model.edges,
    canvas,
    ctx: canvas.getContext("2d"),
    width: 0,
    height: 0,
    dpr: 1,
    alpha: nodes.some((node) => !node.placed) ? 1 : 0.02,
    hoverArea: null,
    hoverIndex: -1,
    hoverEdgeIndex: -1,
    spotlightIndex: -1,
    dragNode: -1,
    panning: false,
    pointers: new Map(),
    pinchDistance: 0,
    downX: 0,
    downY: 0,
    moved: 0,
    openFile,
    t,
    branchLabel: String(branchLabel || ""),
    localIds: null,
    canDiff,
    loadingDiff: false,
    loadDiffContext,
    diff: diffContext?.model ? diffGraphModels(model, diffContext.model) : null,
    diffMeta: diffContext?.meta || null,
    compareUrl: String(compareUrl || ""),
    compareBehindUrl: String(compareBehindUrl || ""),
    onStateChange,
  };
  applyUrlState();
  rebuildLocalIds();

  const searchInput = document.getElementById(GRAPH_TOOLBAR_SEARCH_ID);
  if (searchInput instanceof HTMLInputElement) {
    searchInput.value = persist.search;
    searchInput.placeholder = t("graph.searchPlaceholder");
    searchInput.title = t("graph.searchEnter");
    searchInput.setAttribute("aria-label", t("graph.searchPlaceholder"));
    const onSearchInput = () => {
      persist.search = searchInput.value;
      draw();
    };
    const onSearchKey = (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        focusNextSearchMatch();
      }
    };
    searchInput.addEventListener("input", onSearchInput);
    searchInput.addEventListener("keydown", onSearchKey);
    disposers.push(() => {
      searchInput.removeEventListener("input", onSearchInput);
      searchInput.removeEventListener("keydown", onSearchKey);
    });
  }

  buildToolbar(t);
  renderLegend();
  renderStats();
  renderInfo();
  renderHealthPanel();
  renderDiffPanel();
  renderLocalChip();
  const hint = overlay("hint");
  if (hint) {
    hint.textContent = t("graph.hint");
  }

  // Materialize the graph URL params right away (tab switch into graph,
  // initial load) instead of waiting for the first interaction.
  syncUrl();

  const onResize = () => resize();
  const resizeObserver = new ResizeObserver(onResize);
  resizeObserver.observe(host);
  disposers.push(() => resizeObserver.disconnect());
  resize();

  bindCanvasEvents(t);

  view.fitPending = !nodes.some((node) => node.placed);
  if (view.fitPending) {
    // Fresh layout: the camera follows the expanding layout every frame
    // until it settles, so the graph is always fully visible without a
    // visible end-of-layout camera jump. First user input cancels the follow.
    persist.camera = { scale: 1, x: view.width / 2, y: view.height / 2 };
  }

  view.running = false;
  ensureLoop();

  const onKeyDown = (event) => {
    if (event.key !== "Escape") {
      return;
    }
    // Esc dismisses the topmost overlay first: diff, then health, then the
    // node selection.
    if (diffOpen()) {
      setDiffOpen(false);
      return;
    }
    if (healthOpen()) {
      setHealthOpen(false);
      return;
    }
    if (persist.selectedId) {
      selectNode("");
    }
  };
  window.addEventListener("keydown", onKeyDown);
  disposers.push(() => window.removeEventListener("keydown", onKeyDown));

  frame();
}

// Graph URL parameters: the URL is the permalink for the graph view. Every
// persist mutation calls onStateChange so the app can replaceState, and every
// mount applies the URL back into persist, which makes shared links, tab
// round-trips, and back/forward all restore the same view.
export const GRAPH_URL_PARAMS = ["local", "hide", "status", "authority", "type", "metric"];

const METRIC_VALUES = ["indeg", "outdeg", "words"];

function applyUrlState() {
  const params = new URLSearchParams(window.location.search);
  // No graph parameters in the URL means a plain tab visit: keep the
  // in-memory view state.
  if (!GRAPH_URL_PARAMS.some((name) => params.has(name))) {
    return;
  }
  const read = (name) => (params.get(name) || "").trim();

  const local = read("local");
  persist.localFocusId = local && view.nodeIndexById.has(local) ? local : "";

  const hide = read("hide");
  const knownUnits = new Set(view.model.units.map((unit) => unit.id));
  persist.hiddenUnits = new Set(hide ? hide.split(",").filter((id) => knownUnits.has(id)) : []);

  persist.statusFilter = read("status");
  persist.authorityFilter = read("authority");
  persist.typeFilter = read("type");

  const metric = read("metric");
  persist.metric = METRIC_VALUES.includes(metric) ? metric : "indeg";
  view.metricMax = 0;
}

export function graphUrlState() {
  // null = graph view not mounted (yet); the app then leaves the URL params
  // alone instead of wiping them before the view could apply them.
  if (!view || !view.alive) {
    return null;
  }
  const params = {};
  if (persist.localFocusId) {
    params.local = persist.localFocusId;
  }
  if (persist.hiddenUnits.size) {
    params.hide = [...persist.hiddenUnits].join(",");
  }
  if (persist.statusFilter) {
    params.status = persist.statusFilter;
  }
  if (persist.authorityFilter) {
    params.authority = persist.authorityFilter;
  }
  if (persist.typeFilter) {
    params.type = persist.typeFilter;
  }
  if (persist.metric !== "indeg") {
    params.metric = persist.metric;
  }
  return params;
}

function syncUrl() {
  if (view?.onStateChange) {
    view.onStateChange();
  }
}

function panelMinButton(role) {
  const minimized = persist.minimized.has(role);
  return `<button type="button" class="graph-panel-min" data-graph-min="${role}" aria-label="${escapeHtml(view.t(minimized ? "graph.expand" : "graph.minimize"))}" title="${escapeHtml(view.t(minimized ? "graph.expand" : "graph.minimize"))}">${minimized ? "+" : "–"}</button>`;
}

function bindPanelMinButtons(scope = document) {
  for (const button of scope.querySelectorAll("[data-graph-min]")) {
    button.onclick = () => {
      const role = button.dataset.graphMin || "";
      if (persist.minimized.has(role)) {
        persist.minimized.delete(role);
      } else {
        persist.minimized.add(role);
      }
      // Re-render the owning panel so the collapsed state is consistent.
      if (role === "legend") {
        renderLegend();
      } else if (role === "stats") {
        renderStats();
      } else if (role === "info") {
        renderInfo();
      } else if (role === "health") {
        renderHealthPanel();
      } else if (role === "diff") {
        renderDiffPanel();
      }
    };
  }
}

function overlay(role) {
  return document.querySelector(`[data-graph-role="${role}"]`);
}

function buildToolbar(t) {
  const metricGroup = overlay("metric");
  if (metricGroup) {
    const options = [
      ["indeg", t("graph.metricIndegree")],
      ["outdeg", t("graph.metricOutdegree")],
      ["words", t("graph.metricWords")],
    ];
    metricGroup.innerHTML = `
      <label class="graph-select">
        <span>${escapeHtml(t("graph.metric"))}</span>
        <select data-graph-select="metric">
          ${options.map(([value, label]) => `<option value="${value}" ${persist.metric === value ? "selected" : ""}>${escapeHtml(label)}</option>`).join("")}
        </select>
      </label>
    `;
  }

  const filtersGroup = overlay("filters");
  if (filtersGroup) {
    const statusValues = uniqueValues(view.nodes.map((node) => node.frontMatter.status));
    const authorityValues = uniqueValues(view.nodes.map((node) => node.frontMatter.authority));
    const typeValues = uniqueValues(view.nodes.map((node) => node.frontMatter.type));
    filtersGroup.innerHTML = `
      ${selectHtml("status", t("graph.filterStatus"), statusValues, persist.statusFilter, t)}
      ${selectHtml("authority", t("graph.filterAuthority"), authorityValues, persist.authorityFilter, t)}
      ${selectHtml("type", t("graph.filterType"), typeValues, persist.typeFilter, t)}
    `;
  }

  const healthButton = overlay("health");
  if (healthButton) {
    healthButton.textContent = healthOpen() ? t("graph.healthHide") : t("graph.healthShow");
    healthButton.onclick = () => setHealthOpen(!healthOpen());
  }

  const fitButton = overlay("reset");
  if (fitButton) {
    fitButton.textContent = t("graph.fitView");
    fitButton.title = t("graph.fitViewTitle");
    fitButton.onclick = () => {
      fitView();
      draw();
    };
  }

  const unitsButton = overlay("units");
  if (unitsButton) {
    unitsButton.textContent = t("graph.legendUnits");
    unitsButton.title = t("graph.unitsShowAll");
    unitsButton.onclick = () => {
      const legend = overlay("legend");
      if (legend) {
        legend.classList.toggle("mobile-open");
        unitsButton.setAttribute("aria-expanded", legend.classList.contains("mobile-open") ? "true" : "false");
      }
    };
  }

  const diffButton = overlay("diff");
  if (diffButton) {
    diffButton.hidden = !view.canDiff;
    diffButton.textContent = t(persist.diffWithMaster ? "graph.diffExit" : "graph.diff");
    diffButton.title = t("graph.diffTitle");
    diffButton.onclick = async () => {
      if (view.loadingDiff) {
        return;
      }
      if (!persist.diffWithMaster && !view.diff && view.loadDiffContext) {
        view.loadingDiff = true;
        diffButton.disabled = true;
        try {
          const context = await view.loadDiffContext();
          // The busy overlay re-renders the tab while loading, which replaces
          // the view; only trust the result when it arrived intact.
          if (context?.model && view) {
            view.diff = diffGraphModels(view.model, context.model);
            view.diffMeta = context.meta || null;
          }
          if (!view?.diff) {
            // Loading failed: the app already surfaced the error.
            const liveButton = overlay("diff");
            if (liveButton) {
              liveButton.disabled = false;
            }
            return;
          }
        } finally {
          diffButton.disabled = false;
          if (view) {
            view.loadingDiff = false;
          }
        }
      }
      persist.diffWithMaster = !persist.diffWithMaster;
      const liveButton = overlay("diff");
      if (liveButton) {
        liveButton.textContent = t(persist.diffWithMaster ? "graph.diffExit" : "graph.diff");
      }
      renderDiffPanel();
      setDiffOpen(persist.diffWithMaster);
      renderStats();
      draw();
    };
  }

  for (const select of document.querySelectorAll("[data-graph-select]")) {
    select.addEventListener("change", () => {
      const kind = select.dataset.graphSelect;
      if (kind === "metric") {
        persist.metric = select.value;
        view.metricMax = 0;
      } else if (kind === "status") {
        persist.statusFilter = select.value;
      } else if (kind === "authority") {
        persist.authorityFilter = select.value;
      } else if (kind === "type") {
        persist.typeFilter = select.value;
      }
      renderStats();
      renderHealthPanel();
      draw();
      syncUrl();
    });
  }
}

function selectHtml(kind, label, values, current, t) {
  if (!values.length) {
    return "";
  }
  return `
    <label class="graph-select">
      <span>${escapeHtml(label)}</span>
      <select data-graph-select="${kind}">
        <option value="">${escapeHtml(t("graph.filterAll"))}</option>
        ${values.map((value) => `<option value="${escapeHtml(value)}" ${current === value ? "selected" : ""}>${escapeHtml(value)}</option>`).join("")}
        <option value="${FILTER_NONE_VALUE}" ${current === FILTER_NONE_VALUE ? "selected" : ""}>${escapeHtml(t("graph.filterNone"))}</option>
      </select>
    </label>
  `;
}

function uniqueValues(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function healthOpen() {
  const panel = overlay("health-panel");
  return Boolean(panel && !panel.hidden);
}

const FILTER_NONE_VALUE = "__none__";

function filterMatches(filterValue, nodeValue) {
  if (!filterValue) {
    return true;
  }
  if (filterValue === FILTER_NONE_VALUE) {
    return !nodeValue;
  }
  return nodeValue === filterValue;
}

function rebuildLocalIds() {
  view.localIds = null;
  if (!persist.localFocusId) {
    return;
  }
  const focusIndex = view.nodeIndexById.get(persist.localFocusId);
  if (focusIndex === undefined) {
    persist.localFocusId = "";
    return;
  }
  view.localIds = new Set(
    [...neighborhood(focusIndex)].map((index) => view.nodes[index].id),
  );
}

function setLocalFocus(id) {
  persist.localFocusId = id;
  rebuildLocalIds();
  if (id) {
    kickAlpha(0.25);
    view.fitPending = true;
    view.frameCount = 0;
  }
  renderLegend();
  renderStats();
  renderHealthPanel();
  renderInfo();
  renderLocalChip();
  draw();
  syncUrl();
}

function renderLocalChip() {
  const chip = overlay("local-chip");
  if (!chip) {
    return;
  }
  if (!persist.localFocusId) {
    chip.hidden = true;
    chip.innerHTML = "";
    return;
  }
  chip.hidden = false;
  const focusNode = view.nodes[view.nodeIndexById.get(persist.localFocusId)];
  const focusName = focusNode?.name || shortName(persist.localFocusId);
  chip.innerHTML = `
    <span>${escapeHtml(view.t("graph.localViewActive", { name: focusName }))}</span>
    <button type="button" data-graph-action="clear-local" aria-label="${escapeHtml(view.t("graph.localViewExit"))}">×</button>
  `;
  const clear = chip.querySelector('[data-graph-action="clear-local"]');
  if (clear) {
    clear.onclick = () => setLocalFocus("");
  }
}

function isNodeVisible(node) {
  if (view.localIds && !view.localIds.has(node.id)) {
    return false;
  }
  if (persist.hiddenUnits.has(node.unit)) {
    return false;
  }
  if (!filterMatches(persist.statusFilter, node.frontMatter.status)) {
    return false;
  }
  if (!filterMatches(persist.authorityFilter, node.frontMatter.authority)) {
    return false;
  }
  if (!filterMatches(persist.typeFilter, node.frontMatter.type)) {
    return false;
  }
  return true;
}

// Scoped view data: the stats strip and the health panel diagnose what is
// currently visible (unit toggles, front-matter filters, local focus), not
// the whole repository. Dead links belong to their source document's unit.
function scopedViewData() {
  const visibleNodes = view.nodes.filter(isNodeVisible);
  const visibleIndexSet = new Set(visibleNodes.map((node) => view.nodeIndexById.get(node.id)));
  const visibleEdges = view.edges.filter(
    (edge) => visibleIndexSet.has(edge.source) && visibleIndexSet.has(edge.target),
  );
  const visiblePathSet = new Set(visibleNodes.map((node) => node.id));
  const statusCounts = {};
  const authorityCounts = {};
  let missingOwner = 0;
  for (const node of visibleNodes) {
    const { status, authority, owner } = node.frontMatter;
    if (status) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    if (authority) {
      authorityCounts[authority] = (authorityCounts[authority] || 0) + 1;
    }
    if (!owner) {
      missingOwner += 1;
    }
  }
  return {
    nodes: visibleNodes,
    edges: visibleEdges,
    stats: {
      docs: visibleNodes.length,
      words: visibleNodes.reduce((sum, node) => sum + node.words, 0),
      edges: visibleEdges.length,
      largestComponentPct: largestComponentPct(visibleNodes.length, remapEdges(visibleNodes, visibleEdges)),
    },
    health: {
      deadLinks: view.model.health.deadLinks.filter((link) => visiblePathSet.has(link.source)),
      orphans: view.model.health.orphans.filter((path) => visiblePathSet.has(path)),
      isolates: view.model.health.isolates.filter((path) => visiblePathSet.has(path)),
      hubs: visibleNodes
        .filter((node) => node.indeg > 0)
        .sort((a, b) => b.indeg - a.indeg || a.id.localeCompare(b.id))
        .slice(0, 10)
        .map((node) => ({ path: node.id, name: node.name, indeg: node.indeg })),
      frontMatter: {
        statusCounts,
        authorityCounts,
        missingOwner: { length: missingOwner },
      },
    },
  };
}

// Map visible edges to a compact node-index space for largestComponentPct.
function remapEdges(visibleNodes, visibleEdges) {
  const indexByPath = new Map(visibleNodes.map((node, index) => [node.id, index]));
  return visibleEdges
    .map((edge) => ({
      source: indexByPath.get(view.nodes[edge.source].id),
      target: indexByPath.get(view.nodes[edge.target].id),
    }))
    .filter((edge) => edge.source !== undefined && edge.target !== undefined);
}

function searchMatches() {
  if (!persist.search.trim()) {
    return [];
  }
  const query = normalizeSearchText(persist.search.trim());
  return view.nodes.filter((node) => {
    const haystack = normalizeSearchText(`${node.name} ${node.id} ${node.unit}`);
    return haystack.includes(query);
  });
}

function focusNextSearchMatch() {
  const matches = searchMatches();
  if (!matches.length) {
    return;
  }
  const currentIndex = matches.findIndex((node) => node.id === persist.selectedId);
  const next = matches[(currentIndex + 1) % matches.length];
  selectNode(next.id, { center: true });
}

function renderLegend() {
  const legend = overlay("legend");
  if (!legend) {
    return;
  }
  legend.innerHTML = `
    <div class="graph-legend-head">
      <strong>${escapeHtml(view.t("graph.legendUnits"))}</strong>
      <span class="graph-legend-actions">
        ${panelMinButton("legend")}
        <button type="button" data-graph-units="show" title="${escapeHtml(view.t("graph.unitsShowAll"))}">${escapeHtml(view.t("graph.unitsAll"))}</button>
        <button type="button" data-graph-units="hide" title="${escapeHtml(view.t("graph.unitsHideAll"))}">${escapeHtml(view.t("graph.unitsNone"))}</button>
      </span>
    </div>
    <div class="graph-panel-body ${persist.minimized.has("legend") ? "hidden-body" : ""}">
    ${view.model.units
      .map(
        (unit) => `
      <button type="button" class="graph-legend-row ${persist.hiddenUnits.has(unit.id) ? "off" : ""}" data-graph-unit="${escapeHtml(unit.id)}" title="${escapeHtml(unit.id)}">
        <span class="graph-legend-dot" style="background:${unit.color}"></span>
        <span class="graph-legend-name">${escapeHtml(unit.id)}</span>
        <span class="graph-legend-count">${unit.docs}</span>
      </button>
    `,
      )
      .join("")}
    </div>
  `;
  bindPanelMinButtons(legend);
  for (const row of legend.querySelectorAll("[data-graph-unit]")) {
    const unitId = row.dataset.graphUnit;
    row.addEventListener("mouseenter", () => {
      view.hoverArea = unitId;
      draw();
    });
    row.addEventListener("mouseleave", () => {
      view.hoverArea = null;
      draw();
    });
    row.addEventListener("click", () => {
      if (persist.hiddenUnits.has(unitId)) {
        persist.hiddenUnits.delete(unitId);
      } else {
        persist.hiddenUnits.add(unitId);
      }
      row.classList.toggle("off", persist.hiddenUnits.has(unitId));
      renderStats();
      renderHealthPanel();
      draw();
      syncUrl();
    });
  }
  for (const action of legend.querySelectorAll("[data-graph-units]")) {
    const mode = action.dataset.graphUnits;
    action.addEventListener("click", () => {
      if (mode === "hide") {
        for (const unit of view.model.units) {
          persist.hiddenUnits.add(unit.id);
        }
      } else {
        persist.hiddenUnits.clear();
      }
      renderLegend();
      renderStats();
      renderHealthPanel();
      draw();
      syncUrl();
    });
  }
}

function renderStats() {
  const stats = overlay("stats");
  if (!stats) {
    return;
  }
  const { docs, edges, words, largestComponentPct: pct } = scopedViewData().stats;
  const diffSummary =
    persist.diffWithMaster && view.diff
      ? `<span class="graph-stats-diff">${escapeHtml(
          view.t("graph.diffSummary", {
            addedDocs: view.diff.addedDocs.length,
            removedDocs: view.diff.removedDocs.length,
            addedLinks: view.diff.addedEdges.length,
            removedLinks: view.diff.removedEdges.length,
          }),
        )}</span>`
      : "";
  stats.innerHTML = `
    ${panelMinButton("stats")}
    <div class="graph-panel-body stats-body ${persist.minimized.has("stats") ? "hidden-body" : ""}">
    ${diffSummary}
    <span>${view.t("graph.statsDocs", { count: docs })}</span>
    <span>${view.t("graph.statsEdges", { count: edges })}</span>
    <span>${view.t("graph.statsConnected", { percent: pct })}</span>
    <span>${words.toLocaleString()} ${escapeHtml(view.t("graph.words")).toLowerCase()}</span>
    ${view.branchLabel ? `<span class="graph-stats-branch">${escapeHtml(view.branchLabel)}</span>` : ""}
    </div>
  `;
  bindPanelMinButtons(stats);
}

function setHealthOpen(open) {
  const panel = overlay("health-panel");
  const button = overlay("health");
  if (!panel || !button) {
    return;
  }
  panel.hidden = !open;
  button.textContent = open ? view.t("graph.healthHide") : view.t("graph.healthShow");
  if (open) {
    setDiffOpen(false);
    if (persist.selectedId) {
      // The right side hosts one panel at a time; health wins.
      persist.selectedId = "";
      renderInfo();
      if (view.onSelectionChange) {
        view.onSelectionChange("");
      }
    }
  }
}

function diffOpen() {
  const panel = overlay("diff-panel");
  return Boolean(panel && !panel.hidden);
}

function setDiffOpen(open) {
  const panel = overlay("diff-panel");
  if (!panel) {
    return;
  }
  if (open && !view.diff) {
    return;
  }
  panel.hidden = !open;
  const button = overlay("diff");
  if (button) {
    button.textContent = open ? view.t("graph.diffExit") : view.t("graph.diff");
  }
  if (open) {
    setHealthOpen(false);
    if (persist.selectedId) {
      persist.selectedId = "";
      renderInfo();
      if (view.onSelectionChange) {
        view.onSelectionChange("");
      }
    }
  }
  renderStats();
}

function renderDiffPanel() {
  const panel = overlay("diff-panel");
  if (!panel) {
    return;
  }
  if (!persist.diffWithMaster || !view.diff) {
    panel.hidden = true;
    return;
  }
  const { t } = view;
  const diff = view.diff;
  const section = (title, rows) => `
    <section class="graph-health-section">
      <h3>${escapeHtml(title)} <span class="graph-health-count">${rows.length}</span></h3>
      ${rows.length ? rows.join("") : `<p class="graph-health-empty">${escapeHtml(t("graph.diffNone"))}</p>`}
    </section>
  `;

  const addedRows = diff.addedDocs.map((doc) =>
    fileLinkRow({ attr: "data-graph-path", path: doc.path, title: doc.title, sub: doc.path, status: "added" }),
  );
  const removedRows = diff.removedDocs.map(
    (doc) => `
      <div class="graph-file-link removed" title="${escapeHtml(doc.title)}">
        <span class="graph-file-dot"></span>
        <span class="graph-file-main">
          <span class="graph-file-title">${escapeHtml(doc.title)}</span>
          <span class="graph-file-sub">${escapeHtml(doc.path)}</span>
        </span>
      </div>`,
  );
  const changedRows = diff.changedDocs.map((doc) =>
    fileLinkRow({ attr: "data-graph-path", path: doc.path, title: doc.title, sub: doc.path, status: "changed" }),
  );

  const hasCounts = view.diffMeta && (view.diffMeta.aheadBy !== null || view.diffMeta.behindBy !== null);
  const countLink = (url, key, params) =>
    url
      ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t(key, params))}</a>`
      : escapeHtml(t(key, params));

  panel.innerHTML = `
    <header class="graph-health-header">
      <h2>${escapeHtml(t("graph.diffPanel"))}</h2>
      ${!hasCounts && view.compareUrl ? `<a class="graph-diff-full" href="${escapeHtml(view.compareUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t("graph.diffOpenFull"))} ↗</a>` : ""}
      ${panelMinButton("diff")}
      <button type="button" class="graph-info-close graph-health-close" data-graph-action="close-diff" aria-label="${escapeHtml(t("common.close"))}">×</button>
    </header>
    <div class="graph-health-body graph-panel-body ${persist.minimized.has("diff") ? "hidden-body" : ""}">
      ${
        hasCounts
          ? `<p class="graph-diff-position">${countLink(view.compareUrl, "graph.diffAhead", {
              count: view.diffMeta.aheadBy ?? 0,
            })} · ${countLink(view.compareBehindUrl, "graph.diffBehind", {
              count: view.diffMeta.behindBy ?? 0,
            })}</p>`
          : ""
      }
      <p class="graph-diff-summary">${escapeHtml(
        t("graph.diffSummary", {
          addedDocs: diff.addedDocs.length,
          removedDocs: diff.removedDocs.length,
          addedLinks: diff.addedEdges.length,
          removedLinks: diff.removedEdges.length,
        }),
      )}</p>
      ${section(t("graph.diffAdded"), addedRows)}
      ${section(t("graph.diffRemoved"), removedRows)}
      ${section(t("graph.diffChanged"), changedRows)}
    </div>
  `;

  for (const button of panel.querySelectorAll("[data-graph-path]")) {
    bindRowHighlight(button, button.dataset.graphPath || "");
    button.addEventListener("click", () => {
      selectNode(button.dataset.graphPath || "", { center: true });
    });
  }
  const closeButton = panel.querySelector('[data-graph-action="close-diff"]');
  if (closeButton) {
    closeButton.onclick = () => {
      persist.diffWithMaster = false;
      setDiffOpen(false);
      draw();
    };
  }
  bindPanelMinButtons(panel);
}

function renderHealthPanel() {
  const panel = overlay("health-panel");
  if (!panel) {
    return;
  }
  const { t } = view;
  const health = scopedViewData().health;
  const nodeName = (path) => {
    const index = view.nodeIndexById.get(path);
    return index !== undefined ? view.nodes[index].name : shortName(path);
  };
  const item = (path, extra = "") =>
    fileLinkRow({ attr: "data-graph-path", path, title: nodeName(path), sub: path, badge: extra });
  const deadLinkItems = health.deadLinks
    .map(
      (link) =>
        fileLinkRow({
          attr: "data-graph-path",
          path: link.source,
          title: nodeName(link.source),
          sub: `→ ${link.href}`,
        }),
    )
    .join("");
  const section = (title, body) => `
    <section class="graph-health-section">
      <h3>${escapeHtml(title)}</h3>
      ${body || `<p class="graph-health-empty">${escapeHtml(t("graph.healthNothing"))}</p>`}
    </section>
  `;

  const statusEntries = Object.entries(health.frontMatter.statusCounts);
  const authorityEntries = Object.entries(health.frontMatter.authorityCounts);
  // Front-matter counts drill straight into the matching toolbar filter.
  const factRow = (kind, label, value, count) => `
    <button type="button" class="graph-health-fact" data-filter-kind="${kind}" data-filter-value="${escapeHtml(value)}" title="${escapeHtml(t("graph.healthFilterHint"))}">
      <span>${escapeHtml(label)}: ${escapeHtml(value)}</span>
      <span class="graph-health-fact-count">${count}</span>
    </button>`;
  const frontMatterSummary = `
    <div class="graph-health-facts">
      ${statusEntries.map(([status, count]) => factRow("status", t("graph.status"), status, count)).join("")}
      ${authorityEntries.map(([authority, count]) => factRow("authority", t("graph.authority"), authority, count)).join("")}
      <div class="graph-health-fact static"><span>${escapeHtml(t("graph.healthMissingOwner"))}</span><span class="graph-health-fact-count">${health.frontMatter.missingOwner.length}</span></div>
    </div>
  `;

  panel.innerHTML = `
    <header class="graph-health-header">
      <h2>${escapeHtml(t("graph.health"))}</h2>
      <button type="button" class="graph-info-close graph-health-close" data-graph-action="close-health" aria-label="${escapeHtml(t("common.close"))}">×</button>
    </header>
    <div class="graph-health-body graph-panel-body ${persist.minimized.has("health") ? "hidden-body" : ""}">
      ${section(t("graph.healthDeadLinks"), deadLinkItems)}
      ${section(t("graph.healthOrphans"), health.orphans.map((path) => item(path)).join(""))}
      ${section(t("graph.healthIsolates"), health.isolates.map((path) => item(path)).join(""))}
      ${section(t("graph.healthHubs"), health.hubs.map((hub) => item(hub.path, String(hub.indeg))).join(""))}
      ${section(t("graph.healthFrontMatter"), frontMatterSummary)}
    </div>
  `;

  for (const button of panel.querySelectorAll("[data-graph-path]")) {
    bindRowHighlight(button, button.dataset.graphPath || "");
    button.addEventListener("click", () => {
      setHealthOpen(false);
      selectNode(button.dataset.graphPath || "", { center: true });
    });
  }
  const closeButton = panel.querySelector('[data-graph-action="close-health"]');
  if (closeButton) {
    closeButton.onclick = () => setHealthOpen(false);
  }
  bindPanelMinButtons(panel);
  for (const fact of panel.querySelectorAll(".graph-health-fact")) {
    fact.onclick = () => {
      const kind = fact.dataset.filterKind;
      const value = fact.dataset.filterValue || "";
      const prop = `${kind}Filter`;
      persist[prop] = persist[prop] === value ? "" : value;
      buildToolbar(view.t);
      renderStats();
      renderHealthPanel();
      draw();
      syncUrl();
    };
  }
}

function shortName(path) {
  const segments = String(path || "").split("/");
  const name = segments.pop() || String(path || "");
  // Navigation file names repeat in every unit; keep the parent for context.
  if (/^(readme|rozcestnik)\.md$/i.test(name) && segments.length) {
    return `${segments[segments.length - 1]}/${name}`;
  }
  return name;
}

function renderInfo() {
  const info = overlay("info");
  if (!info) {
    return;
  }
  const { t } = view;
  if (!persist.selectedId || !view.nodeIndexById.has(persist.selectedId)) {
    info.hidden = true;
    info.innerHTML = "";
    return;
  }
  const node = view.nodes[view.nodeIndexById.get(persist.selectedId)];
  const nodeIndex = view.nodeIndexById.get(persist.selectedId);
  const color = view.model.unitColor.get(node.unit) || "#888888";
  const row = (label, value) => (value ? `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>` : "");
  const front = node.frontMatter;

  const linkList = (title, edges, key, cap = 8) => {
    if (!edges.length) {
      return "";
    }
    const item = (edge) => {
      const other = view.nodes[edge[key]];
      const sub = edge.label ? `${other.id} · „${edge.label}“` : other.id;
      return fileLinkRow({ attr: "data-graph-link", path: other.id, title: other.name, sub });
    };
    return `
      <div class="graph-info-links">
        <h3>${escapeHtml(title)} <span class="graph-health-count">${edges.length}</span></h3>
        ${edges.slice(0, cap).map(item).join("")}
        ${edges.length > cap ? `<span class="graph-health-count">+${edges.length - cap}</span>` : ""}
      </div>
    `;
  };
  const incoming = view.edges.filter((edge) => edge.target === nodeIndex);
  const outgoing = view.edges.filter((edge) => edge.source === nodeIndex);
  const localActive = persist.localFocusId === node.id;

  info.hidden = false;
  info.innerHTML = `
    <button type="button" class="graph-info-close" data-graph-action="close" aria-label="${escapeHtml(t("common.close"))}">×</button>
    ${panelMinButton("info")}
    <h2 class="graph-info-name">${escapeHtml(node.name)}</h2>
    <div class="graph-panel-body info-body ${persist.minimized.has("info") ? "hidden-body" : ""}">
    <p class="graph-info-path">${escapeHtml(node.id)}</p>
    <p class="graph-info-unit"><span class="graph-legend-dot" style="background:${color}"></span>${escapeHtml(node.unit)}</p>
    <table class="graph-info-facts">
      ${row(t("graph.incoming"), String(node.indeg))}
      ${row(t("graph.outgoing"), String(node.outdeg))}
      ${node.words ? row(t("graph.words"), node.words.toLocaleString()) : ""}
      ${node.readMin ? row(t("graph.readingTime"), t("graph.readingMinutes", { minutes: node.readMin })) : ""}
      ${row(t("graph.status"), front.status)}
      ${row(t("graph.owner"), front.owner)}
      ${row(t("graph.authority"), front.authority)}
      ${row(t("graph.type"), front.type)}
    </table>
    ${linkList(t("graph.linkedFrom"), incoming, "source")}
    ${linkList(t("graph.linksTo"), outgoing, "target")}
    ${node.excerpt ? `<p class="graph-info-excerpt">${escapeHtml(node.excerpt)}</p>` : ""}
    <div class="graph-info-actions">
      <button type="button" class="graph-info-open" data-graph-action="open">${escapeHtml(t("graph.open"))}</button>
      <button type="button" data-graph-action="local">${escapeHtml(localActive ? t("graph.localViewExit") : t("graph.localView"))}</button>
    </div>
    </div>
  `;
  bindPanelMinButtons(info);
  const closeButton = info.querySelector('[data-graph-action="close"]');
  if (closeButton) {
    closeButton.onclick = () => selectNode("");
  }
  const openButton = info.querySelector('[data-graph-action="open"]');
  if (openButton) {
    openButton.onclick = () => view.openFile(node.id);
  }
  const localButton = info.querySelector('[data-graph-action="local"]');
  if (localButton) {
    localButton.onclick = () => setLocalFocus(localActive ? "" : node.id);
  }
  for (const link of info.querySelectorAll("[data-graph-link]")) {
    bindRowHighlight(link, link.dataset.graphLink || "");
    link.onclick = () => selectNode(link.dataset.graphLink || "", { center: true });
  }
}

function selectNode(id, { center = false } = {}) {
  persist.selectedId = id;
  if (id && healthOpen()) {
    // Selecting a node from the canvas opens the info panel; health yields.
    setHealthOpen(false);
  }
  if (id && diffOpen()) {
    setDiffOpen(false);
  }
  if (center && id && view.nodeIndexById.has(id)) {
    const node = view.nodes[view.nodeIndexById.get(id)];
    persist.camera.x = view.width / 2 - node.x * persist.camera.scale;
    persist.camera.y = view.height / 2 - node.y * persist.camera.scale;
    if (persist.camera.scale < 1.1) {
      zoomAt(view.width / 2, view.height / 2, 1.6 / persist.camera.scale);
    }
  }
  renderInfo();
  draw();
  syncUrl();
}

function kickAlpha(value) {
  view.alpha = Math.max(view.alpha, value);
  ensureLoop();
}

// The frame loop runs only while something moves: the simulation has energy,
// the camera is following the initial layout, or a pointer interaction is in
// progress. When everything settles it stops; interactions restart it, and
// pointermove redraws directly so hover highlighting stays responsive
// without the loop.
function ensureLoop() {
  if (!view || !view.alive || view.running) {
    return;
  }
  view.running = true;
  view.raf = requestAnimationFrame(frame);
}

function frame() {
  if (!view || !view.alive) {
    return;
  }
  view.frameCount = (view.frameCount || 0) + 1;
  step();
  draw();
  for (const node of view.nodes) {
    persist.positions.set(node.id, { x: node.x, y: node.y });
  }
  if (view.fitPending) {
    if (view.alpha < 0.02 || view.frameCount > 240) {
      view.fitPending = false;
    }
    const target = fitViewTarget();
    if (target) {
      persist.camera = target;
    }
  }
  const settled =
    view.alpha <= 0.006 && !view.fitPending && view.dragNode < 0 && !view.panning && view.pointers.size === 0;
  if (settled) {
    view.running = false;
    return;
  }
  view.raf = requestAnimationFrame(frame);
}

function resize() {
  if (!view || !view.alive) {
    return;
  }
  const host = view.canvas.parentElement;
  if (!host) {
    return;
  }
  const rect = host.getBoundingClientRect();
  view.dpr = window.devicePixelRatio || 1;
  view.width = Math.max(1, Math.round(rect.width));
  view.height = Math.max(1, Math.round(rect.height));
  view.canvas.width = Math.round(view.width * view.dpr);
  view.canvas.height = Math.round(view.height * view.dpr);
  view.canvas.style.width = `${view.width}px`;
  view.canvas.style.height = `${view.height}px`;
  // Resizing resets the canvas bitmap; repaint immediately so a settled
  // (loop-stopped) graph does not go blank.
  draw();
}

function fitView() {
  const target = fitViewTarget();
  if (!target) {
    return;
  }
  persist.camera = target;
}

function fitViewTarget() {
  const visible = view.nodes.filter(isNodeVisible);
  if (!visible.length) {
    return null;
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of visible) {
    minX = Math.min(minX, node.x);
    minY = Math.min(minY, node.y);
    maxX = Math.max(maxX, node.x);
    maxY = Math.max(maxY, node.y);
  }
  const padding = 60;
  const width = Math.max(1, maxX - minX);
  const height = Math.max(1, maxY - minY);
  const scale = Math.min(
    1.5,
    Math.max(0.2, Math.min((view.width - padding * 2) / width, (view.height - padding * 2) / height)),
  );
  return {
    scale,
    x: view.width / 2 - ((minX + maxX) / 2) * scale,
    y: view.height / 2 - ((minY + maxY) / 2) * scale,
  };
}

function zoomAt(screenX, screenY, factor) {
  const nextScale = Math.min(8, Math.max(0.2, persist.camera.scale * factor));
  const ratio = nextScale / persist.camera.scale;
  persist.camera.x = screenX - (screenX - persist.camera.x) * ratio;
  persist.camera.y = screenY - (screenY - persist.camera.y) * ratio;
  persist.camera.scale = nextScale;
}

function toWorld(screenX, screenY) {
  const { scale, x, y } = persist.camera;
  return [(screenX - x) / scale, (screenY - y) / scale];
}

function metricValue(node) {
  if (persist.metric === "words") {
    return node.words;
  }
  return persist.metric === "outdeg" ? node.outdeg : node.indeg;
}

function metricMax() {
  if (!view.metricMax) {
    view.metricMax = Math.max(1, ...view.nodes.map(metricValue));
  }
  return view.metricMax;
}

function nodeRadius(node) {
  return 2.5 + 6 * Math.sqrt(metricValue(node) / metricMax());
}

function hitNode(screenX, screenY) {
  const [worldX, worldY] = toWorld(screenX, screenY);
  let best = -1;
  let bestDistance = Infinity;
  for (let index = 0; index < view.nodes.length; index += 1) {
    const node = view.nodes[index];
    if (!isNodeVisible(node)) {
      continue;
    }
    const radius = nodeRadius(node) + 3;
    const dx = node.x - worldX;
    const dy = node.y - worldY;
    const distance = dx * dx + dy * dy;
    if (distance < radius * radius && distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function hitEdge(screenX, screenY) {
  const [worldX, worldY] = toWorld(screenX, screenY);
  const threshold = 6 / persist.camera.scale;
  let best = -1;
  let bestDistance = threshold * threshold;
  for (let index = 0; index < view.edges.length; index += 1) {
    const edge = view.edges[index];
    const u = view.nodes[edge.source];
    const v = view.nodes[edge.target];
    if (!isNodeVisible(u) || !isNodeVisible(v)) {
      continue;
    }
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const length2 = dx * dx + dy * dy || 1;
    let t = ((worldX - u.x) * dx + (worldY - u.y) * dy) / length2;
    t = Math.max(0, Math.min(1, t));
    const px = u.x + t * dx;
    const py = u.y + t * dy;
    const distance = (worldX - px) ** 2 + (worldY - py) ** 2;
    if (distance < bestDistance) {
      bestDistance = distance;
      best = index;
    }
  }
  return best;
}

function docTooltip(path) {
  const index = view.nodeIndexById.get(path);
  if (index === undefined) {
    return String(path || "");
  }
  const node = view.nodes[index];
  return node.name && node.name !== node.id ? `${node.name} — ${node.id}` : node.id;
}

// Shared two-line document row used by the info panel and health panel:
// unit dot + document title + muted path/link line. The tooltip keeps the
// full "name — path" form for rows whose text still ellipsises.
function fileLinkRow({ attr, path, title, sub = "", badge = "", status = "" }) {
  const index = view.nodeIndexById.get(path);
  const unit = index !== undefined ? view.nodes[index].unit : "";
  const color = view.model.unitColor.get(unit) || "#888888";
  return `<button type="button" class="graph-file-link ${status ? `is-${status}` : ""}" ${attr}="${escapeHtml(path)}" title="${escapeHtml(docTooltip(path))}">
    <span class="graph-file-dot" style="background:${color}"></span>
    <span class="graph-file-main">
      <span class="graph-file-title">${escapeHtml(title)}</span>
      ${sub ? `<span class="graph-file-sub">${escapeHtml(sub)}</span>` : ""}
    </span>
    ${badge ? `<span class="graph-file-badge">${escapeHtml(badge)}</span>` : ""}
  </button>`;
}

// Panel rows spotlight their single document in the canvas on hover —
// accent ring and label on that node only, no neighborhood dimming.
function bindRowHighlight(button, path) {
  button.addEventListener("mouseenter", () => {
    const index = view.nodeIndexById.get(path);
    if (index !== undefined) {
      view.spotlightIndex = index;
      draw();
    }
  });
  button.addEventListener("mouseleave", () => {
    view.spotlightIndex = -1;
    draw();
  });
}

function updateEdgeHover(x, y, hoverNodeIndex) {
  const tip = overlay("edge-tip");
  if (!tip) {
    return;
  }
  let content = "";
  if (hoverNodeIndex >= 0) {
    const node = view.nodes[hoverNodeIndex];
    const unitColor = view.model.unitColor.get(node.unit) || "#888888";
    content = `<span class="graph-tip-dot" style="background:${unitColor}"></span><strong>${escapeHtml(node.name)}</strong><span class="graph-tip-path">${escapeHtml(node.id)}</span>`;
    view.hoverEdgeIndex = -1;
  } else if (view.dragNode >= 0 || view.panning) {
    view.hoverEdgeIndex = -1;
  } else {
    const edgeIndex = hitEdge(x, y);
    view.hoverEdgeIndex = edgeIndex;
    if (edgeIndex >= 0) {
      const edge = view.edges[edgeIndex];
      const from = view.nodes[edge.source];
      const to = view.nodes[edge.target];
      const label = edge.label ? ` <span class="graph-tip-label">„${escapeHtml(edge.label)}“</span>` : "";
      const count = edge.count > 1 ? ` ×${edge.count}` : "";
      content = `<strong>${escapeHtml(from.name)}</strong> → <strong>${escapeHtml(to.name)}</strong>${label}${count}<span class="graph-tip-path">${escapeHtml(from.id)} → ${escapeHtml(to.id)}</span>`;
    }
  }
  if (!content) {
    tip.hidden = true;
    return;
  }
  tip.hidden = false;
  tip.innerHTML = content;
  let left = x + 14;
  let top = y + 14;
  if (left + tip.offsetWidth + 8 > view.width) {
    left = x - tip.offsetWidth - 14;
  }
  if (top + tip.offsetHeight + 8 > view.height) {
    top = y - tip.offsetHeight - 14;
  }
  tip.style.left = `${Math.max(4, left)}px`;
  tip.style.top = `${Math.max(4, top)}px`;
}

function neighborhood(index) {
  const set = new Set([index]);
  for (const edge of view.edges) {
    if (edge.source === index) {
      set.add(edge.target);
    } else if (edge.target === index) {
      set.add(edge.source);
    }
  }
  return set;
}

function canvasPoint(event) {
  const rect = view.canvas.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}

function bindCanvasEvents() {
  const canvas = view.canvas;
  canvas.addEventListener("pointerdown", (event) => {
    view.fitPending = false;
    ensureLoop();
    view.hoverEdgeIndex = -1;
    const tip = overlay("edge-tip");
    if (tip) {
      tip.hidden = true;
    }
    canvas.setPointerCapture(event.pointerId);
    const [x, y] = canvasPoint(event);
    view.pointers.set(event.pointerId, { x, y });
    view.downX = x;
    view.downY = y;
    view.moved = 0;
    if (view.pointers.size === 2) {
      view.dragNode = -1;
      view.panning = false;
      const [first, second] = [...view.pointers.values()];
      view.pinchDistance = Math.hypot(second.x - first.x, second.y - first.y);
      return;
    }
    const hit = hitNode(x, y);
    if (hit >= 0) {
      view.dragNode = hit;
      kickAlpha(0.25);
    } else {
      view.panning = true;
      view.panStart = { x, y, cameraX: persist.camera.x, cameraY: persist.camera.y };
    }
  });

  canvas.addEventListener("pointermove", (event) => {
    const [x, y] = canvasPoint(event);
    if (view.pointers.has(event.pointerId)) {
      view.pointers.set(event.pointerId, { x, y });
    }
    if (view.pointers.size === 2) {
      const [first, second] = [...view.pointers.values()];
      const distance = Math.hypot(second.x - first.x, second.y - first.y);
      if (view.pinchDistance > 0 && distance > 0) {
        zoomAt((first.x + second.x) / 2, (first.y + second.y) / 2, distance / view.pinchDistance);
      }
      view.pinchDistance = distance;
      return;
    }
    view.moved += Math.abs(x - view.downX) + Math.abs(y - view.downY);
    view.downX = x;
    view.downY = y;
    if (view.dragNode >= 0) {
      const [worldX, worldY] = toWorld(x, y);
      const node = view.nodes[view.dragNode];
      node.x = worldX;
      node.y = worldY;
    } else if (view.panning && view.panStart) {
      persist.camera.x = view.panStart.cameraX + (x - view.panStart.x);
      persist.camera.y = view.panStart.cameraY + (y - view.panStart.y);
    }
    const busy = view.dragNode >= 0 || view.panning;
    const hoverNodeIndex = busy ? -1 : hitNode(x, y);
    const hoverChanged = hoverNodeIndex !== view.hoverIndex;
    view.hoverIndex = hoverNodeIndex;
    canvas.style.cursor = busy ? "grabbing" : hoverNodeIndex >= 0 ? "pointer" : "grab";
    updateEdgeHover(x, y, hoverNodeIndex);
    if (hoverChanged && !view.running) {
      draw();
    }
    ensureLoop();
  });

  const endPointer = (event) => {
    view.pointers.delete(event.pointerId);
    if (view.pointers.size < 2) {
      view.pinchDistance = 0;
    }
    if (view.dragNode >= 0 && view.moved < 5) {
      selectNode(view.nodes[view.dragNode].id);
    } else if (view.moved < 5 && view.pointers.size === 0) {
      const [x, y] = canvasPoint(event);
      const hit = hitNode(x, y);
      if (hit < 0) {
        selectNode("");
      }
    }
    view.dragNode = -1;
    view.panning = false;
    canvas.style.cursor = "grab";
  };
  canvas.addEventListener("pointerup", endPointer);
  canvas.addEventListener("pointercancel", endPointer);
  canvas.addEventListener("pointerleave", () => {
    canvas.style.cursor = "grab";
    view.hoverIndex = -1;
    view.hoverEdgeIndex = -1;
    const tip = overlay("edge-tip");
    if (tip) {
      tip.hidden = true;
    }
    draw();
  });

  canvas.addEventListener("wheel", (event) => {
    event.preventDefault();
    view.fitPending = false;
    ensureLoop();
    const [x, y] = canvasPoint(event);
    zoomAt(x, y, event.deltaY > 0 ? 0.88 : 1.12);
  }, { passive: false });
}

const REPULSION = 1600;
const SPRING = 0.022;
const SPRING_REST = 95;
const DAMPING = 0.58;
const GRAVITY = 0.0035;

function step() {
  const { nodes, edges, width, height } = view;
  const active = nodes.filter(isNodeVisible);
  const force = view.alpha * view.alpha;

  for (const node of nodes) {
    node.fx = (width / 2 - node.x) * GRAVITY * force;
    node.fy = (height / 2 - node.y) * GRAVITY * force;
  }

  for (let i = 0; i < active.length; i += 1) {
    const a = active[i];
    for (let j = i + 1; j < active.length; j += 1) {
      const b = active[j];
      const dx = b.x - a.x;
      const dy = b.y - a.y;
      let d2 = dx * dx + dy * dy;
      if (d2 < 1) {
        d2 = 1;
      }
      const d = Math.sqrt(d2);
      const repulsion = (REPULSION / d2) * force;
      const ux = dx / d;
      const uy = dy / d;
      a.fx -= ux * repulsion;
      a.fy -= uy * repulsion;
      b.fx += ux * repulsion;
      b.fy += uy * repulsion;
    }
  }

  for (const edge of edges) {
    const u = nodes[edge.source];
    const v = nodes[edge.target];
    if (!isNodeVisible(u) || !isNodeVisible(v)) {
      continue;
    }
    const dx = v.x - u.x;
    const dy = v.y - u.y;
    const d = Math.hypot(dx, dy) || 1;
    const k = (d - SPRING_REST) * SPRING * force;
    const ux = dx / d;
    const uy = dy / d;
    u.fx += ux * k;
    u.fy += uy * k;
    v.fx -= ux * k;
    v.fy -= uy * k;
  }

  for (const node of nodes) {
    if (view.dragNode >= 0 && nodes[view.dragNode] === node) {
      continue;
    }
    node.vx = (node.vx + node.fx) * DAMPING;
    node.vy = (node.vy + node.fy) * DAMPING;
    node.x += node.vx;
    node.y += node.vy;
  }

  if (view.alpha > 0.006) {
    view.alpha *= 0.99;
  }
}

function draw() {
  if (!view || !view.alive) {
    return;
  }
  const { ctx, width, height, dpr, nodes, edges } = view;
  const palette = themePalette();
  const search = normalizeSearchText(persist.search.trim());
  const matches = search ? new Set(searchMatches().map((node) => node.id)) : null;

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, width, height);

  const selectedIndex = persist.selectedId ? view.nodeIndexById.get(persist.selectedId) ?? -1 : -1;
  const focusIndex = view.hoverIndex >= 0 ? view.hoverIndex : selectedIndex;
  const near = focusIndex >= 0 ? neighborhood(focusIndex) : null;
  const areaNodes = view.hoverArea
    ? new Set(view.nodes.filter((node) => node.unit === view.hoverArea).map((node) => view.nodeIndexById.get(node.id)))
    : null;

  const camera = persist.camera;
  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.scale, camera.scale);

  for (let edgeIndex = 0; edgeIndex < edges.length; edgeIndex += 1) {
    const edge = edges[edgeIndex];
    const u = nodes[edge.source];
    const v = nodes[edge.target];
    if (!isNodeVisible(u) || !isNodeVisible(v)) {
      continue;
    }
    const hovered = edgeIndex === view.hoverEdgeIndex;
    const highlighted = hovered
      || (areaNodes
        ? areaNodes.has(edge.source) && areaNodes.has(edge.target)
        : near && (near.has(edge.source) || near.has(edge.target)));
    ctx.lineWidth = hovered ? Math.max(1.2, 1.6 / camera.scale) : 0.5;
    ctx.strokeStyle = hovered
      ? palette.accent
      : highlighted
        ? hexToRgba(palette.line, 0.95)
        : hexToRgba(palette.line, 0.28);
    ctx.beginPath();
    ctx.moveTo(u.x, u.y);
    ctx.lineTo(v.x, v.y);
    ctx.stroke();
  }
  ctx.lineWidth = 0.5;

  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isNodeVisible(node)) {
      continue;
    }
    const inNeighborhood = near ? near.has(index) : false;
    const inArea = areaNodes ? areaNodes.has(index) : false;
    const isMatch = matches ? matches.has(node.id) : false;
    const highlighted = inNeighborhood || inArea || index === selectedIndex || isMatch;
    const dimmed = (near || areaNodes) && !highlighted;
    ctx.globalAlpha = dimmed ? 0.12 : 1;
    ctx.fillStyle = view.model.unitColor.get(node.unit) || "#888888";
    ctx.beginPath();
    ctx.arc(node.x, node.y, nodeRadius(node), 0, Math.PI * 2);
    ctx.fill();
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = palette.line;
    ctx.stroke();
    if (index === selectedIndex || isMatch) {
      ctx.lineWidth = isMatch && index !== selectedIndex ? 1.6 : 1.8;
      ctx.strokeStyle = isMatch && index !== selectedIndex ? palette.accent : palette.text;
      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeRadius(node) + 2.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (index === view.spotlightIndex) {
      ctx.lineWidth = 2;
      ctx.strokeStyle = palette.accent;
      ctx.beginPath();
      ctx.arc(node.x, node.y, nodeRadius(node) + 3.5, 0, Math.PI * 2);
      ctx.stroke();
    }
    if (persist.diffWithMaster && view.diff) {
      const path = node.id;
      const isAdded = view.diff.addedDocs.some((doc) => doc.path === path);
      const isChanged = !isAdded && view.diff.changedDocs.some((doc) => doc.path === path);
      if (isAdded || isChanged) {
        ctx.lineWidth = 2;
        ctx.strokeStyle = isAdded ? palette.ok : palette.warn;
        ctx.beginPath();
        ctx.arc(node.x, node.y, nodeRadius(node) + 4.5, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
  }
  ctx.restore();

  drawLabels(ctx, palette, { near, selectedIndex, font: labelFont() });
  ctx.globalAlpha = 1;
}

function labelFont() {
  return getComputedStyle(document.body).fontFamily || "sans-serif";
}

function drawLabels(ctx, palette, { near, selectedIndex, font }) {
  const { nodes } = view;
  const camera = persist.camera;
  const showHubLabels = camera.scale > 1.4;
  const showAllLabels = camera.scale > 2.6;

  const placed = [];
  const collides = (x, y, w, h) => placed.some((p) => x < p.x + p.w && x + w > p.x && y < p.y + p.h && y + h > p.y);

  const order = [];
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    if (!isNodeVisible(node)) {
      continue;
    }
    const highlighted = near ? near.has(index) : index === selectedIndex;
    const spotlight = index === view.spotlightIndex;
    if (highlighted || spotlight || index === view.hoverIndex || showAllLabels || (showHubLabels && node.indeg >= 6)) {
      order.push([highlighted || spotlight || index === view.hoverIndex ? 0 : 1, index]);
    }
  }
  order.sort((a, b) => a[0] - b[0]);

  for (const [priority, index] of order) {
    const node = nodes[index];
    const highlighted = priority === 0;
    const fontSize = highlighted ? 12 : 11;
    ctx.font = `${highlighted ? "600 " : ""}${fontSize}px ${font}`;
    ctx.textAlign = "center";
    ctx.fillStyle = highlighted ? palette.text : palette.muted;
    ctx.globalAlpha = highlighted ? 0.98 : 0.85;

    const screenX = node.x * camera.scale + camera.x;
    const screenY = node.y * camera.scale + camera.y;
    const radiusPx = nodeRadius(node) * camera.scale;
    const text = node.name;
    const textWidth = ctx.measureText(text).width;

    let position = null;
    for (let attempt = 0; attempt < 4 && !position; attempt += 1) {
      const offset = 6 + attempt * (fontSize + 3);
      const candidates = [
        [0, -(radiusPx + offset)],
        [0, radiusPx + offset + 14],
        [-(radiusPx + offset + 14), -(radiusPx + offset)],
        [radiusPx + offset + 14, -(radiusPx + offset)],
      ];
      for (const [dx, dy] of candidates) {
        const px = screenX + dx;
        const py = screenY + dy;
        if (!collides(px - textWidth / 2, py - fontSize, textWidth, fontSize + 3)) {
          position = [px, py];
          break;
        }
      }
    }
    if (position) {
      ctx.fillText(text, position[0], position[1]);
      placed.push({ x: position[0] - textWidth / 2, y: position[1] - fontSize, w: textWidth, h: fontSize + 3 });
    }
  }
  ctx.globalAlpha = 1;
}


