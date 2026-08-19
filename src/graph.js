// Library graph model for the graph tab.
//
// Pure data layer: turns the hydrated repository file list into a document
// graph (nodes = Markdown docs, edges = resolved Markdown links) plus the
// health metrics shown next to the canvas. No DOM access so it can be unit
// tested with node --test.
//
// Link extraction mirrors the Markdown renderer in app.js (inline links,
// angle-bracket hrefs, fenced code blocks ignored). Orphan detection mirrors
// scripts/validate_navigation.py in the avds repository: a document is an
// orphan when no README.md or rozcestnik.md links to it by its exact path.

import { extensionOf, isMarkdownPath } from "./utils.js";

const NAVIGATION_FILENAMES = new Set(["readme.md", "rozcestnik.md"]);
const NAVIGATION_EXEMPT_PATHS = new Set(["AGENTS.md", ".github/pull_request_template.md"]);
const EXTERNAL_SCHEMES = new Set(["http", "https", "mailto", "tel"]);
const VISIBLE_ROOT_DIRECTORIES = new Set(["capabilities", "content"]);

// Mid-luminance palette that stays readable on the light and dark CMS themes.
const UNIT_PALETTE = [
  "#e4572e",
  "#17a398",
  "#3f88c5",
  "#f0a202",
  "#a3586e",
  "#5c946e",
  "#7c5cd6",
  "#c78f3c",
  "#4f9dad",
  "#d1603d",
  "#8a8f3c",
  "#c25b78",
];

export function stripCodeBlocks(text) {
  const source = String(text || "").replace(/\r\n/g, "\n");
  const lines = source.split("\n");
  let inCode = false;
  return lines
    .map((line) => {
      if (line.trim().startsWith("```")) {
        inCode = !inCode;
        return "";
      }
      return inCode ? "" : line;
    })
    .join("\n");
}

export function splitFrontMatter(markdown) {
  const source = String(markdown || "").replace(/\r\n/g, "\n");
  if (!source.startsWith("---\n")) {
    return { entries: [], body: source };
  }
  const end = source.indexOf("\n---", 4);
  if (end === -1) {
    return { entries: [], body: source };
  }
  const raw = source.slice(4, end).trim();
  const bodyStart = source.indexOf("\n", end + 1);
  const body = bodyStart === -1 ? "" : source.slice(bodyStart + 1);
  return { entries: parseFrontMatter(raw), body };
}

export function parseFrontMatter(raw) {
  const entries = [];
  let current = null;
  for (const line of String(raw || "").split("\n")) {
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

export function frontMatterMap(markdown) {
  const { entries } = splitFrontMatter(markdown);
  const map = {};
  for (const entry of entries) {
    if (!(entry.key in map)) {
      map[entry.key] = entry.value.trim();
    }
  }
  return map;
}

export function decodeMarkdownHrefEntities(value) {
  return String(value || "")
    .replace(/&amp;/g, "&")
    .replace(/&#039;/g, "'")
    .replace(/&quot;/g, '"');
}

// Mirrors the inline link pattern of the Markdown renderer, including the
// angle-bracket form. Returns [{ href, label, line }] with line numbers
// counted from the start of the passed text.
export function extractMarkdownLinks(text) {
  const source = stripCodeBlocks(text);
  const links = [];
  const pattern = /(?<!!)\[([^\]]+)\]\(([^)]+)\)/g;
  let match;
  while ((match = pattern.exec(source))) {
    let href = decodeMarkdownHrefEntities(match[2]).trim();
    if (!href) {
      continue;
    }
    if (href.startsWith("<")) {
      const closing = href.indexOf(">");
      href = closing > 0 ? href.slice(1, closing) : href.slice(1);
    } else if (href.includes(" ")) {
      href = href.split(/\s+/)[0];
    }
    if (!href) {
      continue;
    }
    const line = source.slice(0, match.index).split("\n").length;
    links.push({ href, label: match[1], line });
  }
  return links;
}

export function hrefScheme(href) {
  const match = String(href || "").match(/^([A-Za-z][A-Za-z0-9+.-]*):/);
  return match ? match[1].toLowerCase() : "";
}

export function isExternalHref(href) {
  return EXTERNAL_SCHEMES.has(hrefScheme(href));
}

// Repo-relative normalization of a link target as written from sourcePath.
// Resolves ./ ../ and absolute / paths. Returns "" when the href has no
// usable path component (anchors, external URLs, javascript:, ...).
export function normalizeLinkPath(sourcePath, href) {
  const clean = String(href || "").trim();
  if (!clean || clean.startsWith("#")) {
    return "";
  }
  const scheme = hrefScheme(clean);
  if (scheme) {
    // External URL or pseudo-scheme (javascript:, data:, mailto:, ...):
    // no repository path component.
    return "";
  }
  let rawPath = clean.split("#")[0].split("?")[0];
  if (!rawPath) {
    return "";
  }
  let decoded = rawPath;
  try {
    decoded = decodeURIComponent(rawPath);
  } catch {
    decoded = rawPath;
  }
  const isAbsolute = decoded.startsWith("/");
  const parts = decoded.replace(/^\/+/, "").split("/");
  if (!isAbsolute && sourcePath) {
    const base = sourcePath.includes("/") ? sourcePath.split("/").slice(0, -1) : [];
    parts.unshift(...base);
  }
  const stack = [];
  for (const part of parts) {
    if (!part || part === ".") {
      continue;
    }
    if (part === "..") {
      // Like the avds navigation validator, links escaping the repository
      // root are invalid, not clamped to the root.
      if (!stack.length) {
        return "";
      }
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/").replace(/\/+$/g, "");
}

// Resolves a normalized link target against the repository file/dir sets the
// same way the CMS Markdown preview does: exact file, then directory, then
// extension/index candidates. Returns { kind, path }.
export function resolveLinkTarget(normalizedPath, filePathSet, dirPathSet) {
  if (!normalizedPath) {
    return { kind: "missing", path: "" };
  }
  if (filePathSet.has(normalizedPath)) {
    return { kind: "file", path: normalizedPath };
  }
  if (dirPathSet.has(normalizedPath)) {
    return { kind: "dir", path: normalizedPath };
  }
  const candidates = [
    `${normalizedPath}.md`,
    `${normalizedPath}.mdx`,
    `${normalizedPath}/index.md`,
    `${normalizedPath}/index.mdx`,
  ];
  const match = candidates.find((candidate) => filePathSet.has(candidate));
  return match ? { kind: "file", path: match } : { kind: "missing", path: normalizedPath };
}

// Unit id used for node coloring: the AVDS long-lived unit that owns the
// document (capabilities/platforms/<id>, capabilities/streams/<area>/<id>),
// the first path segment for other trees, or "root" for root-level files.
export function unitOfPath(path) {
  const segments = String(path || "").split("/");
  if (segments.length <= 1) {
    return "root";
  }
  if (segments[0] === "capabilities") {
    if (segments[1] === "platforms" && segments.length >= 3) {
      return segments[2];
    }
    if (segments[1] === "streams" && segments.length >= 4) {
      return segments[3];
    }
    return segments[1];
  }
  return segments[0];
}

export function isGraphVisiblePath(path) {
  const clean = String(path || "");
  const segments = clean.split("/");
  if (segments.length === 1) {
    if (clean.toLowerCase() === "agents.md") {
      return true;
    }
    return ["md", "mdx"].includes(extensionOf(clean));
  }
  return VISIBLE_ROOT_DIRECTORIES.has(segments[0]);
}

export function countWords(body) {
  return String(body || "")
    .split(/\s+/)
    .filter(Boolean).length;
}

export function excerptOf(body) {
  const lines = String(body || "").split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("|") || trimmed.startsWith("```")) {
      continue;
    }
    const clean = trimmed.replace(/[*_`>]/g, "");
    return clean.length > 150 ? `${clean.slice(0, 150)}…` : clean;
  }
  return "";
}

function basename(path) {
  return String(path || "").split("/").pop() || "";
}

export function largestComponentPct(nodeCount, edgeList) {
  if (nodeCount === 0) {
    return 0;
  }
  const adjacency = new Map(Array.from({ length: nodeCount }, (_, index) => [index, []]));
  for (const edge of edgeList) {
    adjacency.get(edge.source)?.push(edge.target);
    adjacency.get(edge.target)?.push(edge.source);
  }
  const visited = new Uint8Array(nodeCount);
  let largest = 0;
  for (let start = 0; start < nodeCount; start += 1) {
    if (visited[start]) {
      continue;
    }
    let size = 0;
    const queue = [start];
    visited[start] = 1;
    while (queue.length) {
      const current = queue.pop();
      size += 1;
      for (const neighbor of adjacency.get(current) || []) {
        if (!visited[neighbor]) {
          visited[neighbor] = 1;
          queue.push(neighbor);
        }
      }
    }
    largest = Math.max(largest, size);
  }
  return Math.round((largest / nodeCount) * 100);
}

// Structural diff between the branch model and the default-branch model:
// which documents and links the branch adds, removes, or rewrites.
// Changed documents are detected by blob SHA; documents without a SHA
// (never hydrated) are never reported as changed.
export function diffGraphModels(branchModel, masterModel) {
  const branchByPath = new Map(branchModel.nodes.map((node) => [node.id, node]));
  const masterByPath = new Map(masterModel.nodes.map((node) => [node.id, node]));

  const addedDocs = [];
  const removedDocs = [];
  const changedDocs = [];
  for (const node of branchModel.nodes) {
    const masterNode = masterByPath.get(node.id);
    if (!masterNode) {
      addedDocs.push({ path: node.id, title: node.name });
    } else if (node.sha && masterNode.sha && node.sha !== masterNode.sha) {
      changedDocs.push({ path: node.id, title: node.name });
    }
  }
  for (const node of masterModel.nodes) {
    if (!branchByPath.has(node.id)) {
      removedDocs.push({ path: node.id, title: node.name });
    }
  }

  const edgeKey = (model, edge) => `${model.nodes[edge.source].id}\u0000${model.nodes[edge.target].id}`;
  const masterEdgeKeys = new Set(masterModel.edges.map((edge) => edgeKey(masterModel, edge)));
  const branchEdgeKeys = new Set(branchModel.edges.map((edge) => edgeKey(branchModel, edge)));
  const addedEdges = [...branchEdgeKeys].filter((key) => !masterEdgeKeys.has(key));
  const removedEdges = [...masterEdgeKeys].filter((key) => !branchEdgeKeys.has(key));

  const summarize = (keys) =>
    keys.map((key) => {
      const [from, to] = key.split("\u0000");
      return { from, to };
    });

  return {
    addedDocs,
    removedDocs,
    changedDocs,
    addedEdges: summarize(addedEdges),
    removedEdges: summarize(removedEdges),
  };
}

// Builds the full graph model from repository file entries
// ({ path, sha, size, content? }). Files without content still become nodes
// (front matter, words, and outgoing links are simply unknown for them).
export function buildGraphModel(files) {
  const mdFiles = files
    .filter((file) => isMarkdownPath(file.path) && isGraphVisiblePath(file.path))
    .sort((a, b) => a.path.localeCompare(b.path));

  const filePathSet = new Set(files.map((file) => file.path));
  const dirPathSet = new Set();
  for (const file of files) {
    const segments = file.path.split("/");
    segments.pop();
    let dir = segments.join("/");
    while (dir) {
      dirPathSet.add(dir);
      const parts = dir.split("/");
      parts.pop();
      dir = parts.join("/");
    }
  }

  const nodes = mdFiles.map((file) => {
    const content = typeof file.content === "string" ? file.content : null;
    const frontMatter = content ? frontMatterMap(content) : {};
    const body = content ? splitFrontMatter(content).body : "";
    const fileName = basename(file.path);
    const words = content ? countWords(body) : 0;
    return {
      id: file.path,
      sha: file.sha || "",
      name: frontMatter.title || fileName.replace(/\.(md|mdx)$/i, ""),
      title: frontMatter.title || "",
      unit: unitOfPath(file.path),
      words,
      readMin: words ? Math.max(1, Math.round(words / 200)) : 0,
      excerpt: content ? excerptOf(body) : "",
      frontMatter: {
        id: frontMatter.id || "",
        status: frontMatter.status || "",
        owner: frontMatter.owner || "",
        authority: frontMatter.authority || "",
        type: frontMatter.type || "",
        rhythm: frontMatter.rhythm || "",
      },
      isNavigationFile: NAVIGATION_FILENAMES.has(fileName.toLowerCase()),
      indeg: 0,
      outdeg: 0,
    };
  });

  const nodeIndexByPath = new Map(nodes.map((node, index) => [node.id, index]));
  const contentByPath = new Map(
    mdFiles
      .filter((file) => typeof file.content === "string")
      .map((file) => [file.path, file.content]),
  );

  const edges = [];
  const edgeIndexByKey = new Map();
  const deadLinks = [];
  const navigationLinked = new Set();

  for (const node of nodes) {
    const content = contentByPath.get(node.id);
    if (typeof content !== "string") {
      continue;
    }
    const sourceIndex = nodeIndexByPath.get(node.id);
    const body = splitFrontMatter(content).body;
    for (const link of extractMarkdownLinks(body)) {
      if (isExternalHref(link.href)) {
        continue;
      }
      const normalizedPath = normalizeLinkPath(node.id, link.href);
      // Navigation rule mirrors validate_navigation.py: only exact paths
      // written from a README/rozcestnik count as navigation links.
      if (node.isNavigationFile && normalizedPath && filePathSet.has(normalizedPath)) {
        navigationLinked.add(normalizedPath);
      }
      if (!normalizedPath) {
        continue;
      }
      const target = resolveLinkTarget(normalizedPath, filePathSet, dirPathSet);
      if (target.kind === "file" && nodeIndexByPath.has(target.path)) {
        const targetIndex = nodeIndexByPath.get(target.path);
        if (targetIndex !== sourceIndex) {
          const key = `${sourceIndex}->${targetIndex}`;
          const existing = edgeIndexByKey.get(key);
          if (existing) {
            existing.count += 1;
          } else {
            const edge = {
              source: sourceIndex,
              target: targetIndex,
              count: 1,
              label: link.label,
              line: link.line,
            };
            edgeIndexByKey.set(key, edge);
            edges.push(edge);
          }
        }
        continue;
      }
      if (target.kind === "missing") {
        deadLinks.push({ source: node.id, href: link.href, label: link.label, line: link.line });
      }
    }
  }

  for (const edge of edges) {
    nodes[edge.target].indeg += 1;
    nodes[edge.source].outdeg += 1;
  }

  // Orphans: not a navigation file, not exempt, and no navigation file links
  // to the exact path. Mirrors scripts/validate_navigation.py.
  const orphans = nodes
    .filter((node) => !node.isNavigationFile)
    .filter((node) => !NAVIGATION_EXEMPT_PATHS.has(node.id))
    .filter((node) => !navigationLinked.has(node.id))
    .map((node) => node.id);

  const isolates = nodes.filter((node) => node.indeg === 0 && node.outdeg === 0).map((node) => node.id);

  const hubs = [...nodes]
    .filter((node) => node.indeg > 0)
    .sort((a, b) => b.indeg - a.indeg || a.id.localeCompare(b.id))
    .slice(0, 10)
    .map((node) => ({ path: node.id, name: node.name, indeg: node.indeg }));

  const statusCounts = {};
  const authorityCounts = {};
  const missingOwner = [];
  for (const node of nodes) {
    const { status, authority, owner } = node.frontMatter;
    if (status) {
      statusCounts[status] = (statusCounts[status] || 0) + 1;
    }
    if (authority) {
      authorityCounts[authority] = (authorityCounts[authority] || 0) + 1;
    }
    if (!owner) {
      missingOwner.push(node.id);
    }
  }

  const unitMap = new Map();
  for (const node of nodes) {
    const entry = unitMap.get(node.unit) || { id: node.unit, docs: 0, words: 0 };
    entry.docs += 1;
    entry.words += node.words;
    unitMap.set(node.unit, entry);
  }
  const units = [...unitMap.values()]
    .sort((a, b) => b.docs - a.docs || a.id.localeCompare(b.id))
    .map((unit, index) => ({ ...unit, color: UNIT_PALETTE[index % UNIT_PALETTE.length] }));

  return {
    nodes,
    edges,
    units,
    unitColor: new Map(units.map((unit) => [unit.id, unit.color])),
    health: {
      deadLinks: deadLinks.sort((a, b) => a.source.localeCompare(b.source)),
      orphans,
      isolates,
      hubs,
      frontMatter: { statusCounts, authorityCounts, missingOwner },
    },
    stats: {
      docs: nodes.length,
      words: nodes.reduce((sum, node) => sum + node.words, 0),
      edges: edges.length,
      largestComponentPct: largestComponentPct(nodes.length, edges),
    },
  };
}
