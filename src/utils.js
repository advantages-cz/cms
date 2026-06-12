export const TEXT_EXTENSIONS = new Set([
  "astro",
  "css",
  "csv",
  "env",
  "graphql",
  "htm",
  "html",
  "js",
  "json",
  "jsx",
  "liquid",
  "md",
  "mdx",
  "mjs",
  "scss",
  "toml",
  "ts",
  "tsx",
  "txt",
  "xml",
  "yaml",
  "yml",
]);

const IMAGE_EXTENSIONS = new Set(["avif", "gif", "jpeg", "jpg", "png", "svg", "webp"]);
const DOCUMENT_EXTENSIONS = new Set(["pdf"]);

export function escapeHtml(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function extensionOf(path) {
  const clean = String(path || "").split("?")[0].split("#")[0];
  const last = clean.split("/").pop() || "";
  const index = last.lastIndexOf(".");
  return index >= 0 ? last.slice(index + 1).toLowerCase() : "";
}

export function isTextPath(path) {
  return TEXT_EXTENSIONS.has(extensionOf(path)) || !extensionOf(path);
}

export function isHtmlPath(path) {
  return ["html", "htm"].includes(extensionOf(path));
}

export function isMarkdownPath(path) {
  return ["md", "mdx"].includes(extensionOf(path));
}

export function isImagePath(path) {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

export function isPdfPath(path) {
  return DOCUMENT_EXTENSIONS.has(extensionOf(path));
}

export function mimeForPath(path) {
  const ext = extensionOf(path);
  const mimes = {
    avif: "image/avif",
    css: "text/css",
    gif: "image/gif",
    html: "text/html",
    htm: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    js: "text/javascript",
    json: "application/json",
    md: "text/markdown",
    pdf: "application/pdf",
    png: "image/png",
    svg: "image/svg+xml",
    txt: "text/plain",
    webp: "image/webp",
    xml: "application/xml",
  };
  return mimes[ext] || "application/octet-stream";
}

export function humanBytes(size) {
  if (!Number.isFinite(size)) {
    return "";
  }
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(1)} KB`;
  }
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

export function shortSha(sha) {
  return sha ? sha.slice(0, 7) : "";
}

export function formatDate(value) {
  if (!value) {
    return "";
  }
  return new Intl.DateTimeFormat("cs-CZ", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function classifyConclusion(conclusion, status) {
  if (["success", "neutral", "skipped"].includes(conclusion)) {
    return "ok";
  }
  if (["failure", "timed_out", "cancelled", "action_required"].includes(conclusion)) {
    return "danger";
  }
  if (status && status !== "completed") {
    return "warn";
  }
  return "";
}

export function isActionAuthor(commit) {
  const login = commit?.author?.login || commit?.committer?.login || "";
  const name = commit?.commit?.committer?.name || commit?.commit?.author?.name || "";
  return /github-actions|bot/i.test(`${login} ${name}`);
}

export function fromBase64(base64) {
  const clean = String(base64 || "").replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

export function base64ToText(base64) {
  return new TextDecoder().decode(fromBase64(base64));
}

export function textToBase64(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const chunk = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...chunk);
  }
  return btoa(binary);
}

export function blobFromBase64(base64, mime) {
  return new Blob([fromBase64(base64)], { type: mime });
}

export function debounce(fn, delay) {
  let timer = null;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), delay);
  };
}

export function fnv1aHash(value) {
  const input = String(value || "");
  let hash = 0x811c9dc5;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

export function buildLineDiff(before, after) {
  const beforeLines = String(before || "").replace(/\r\n/g, "\n").split("\n");
  const afterLines = String(after || "").replace(/\r\n/g, "\n").split("\n");
  const rows = [];
  const matrix = Array.from({ length: beforeLines.length + 1 }, () => new Array(afterLines.length + 1).fill(0));

  for (let beforeIndex = beforeLines.length - 1; beforeIndex >= 0; beforeIndex -= 1) {
    for (let afterIndex = afterLines.length - 1; afterIndex >= 0; afterIndex -= 1) {
      matrix[beforeIndex][afterIndex] =
        beforeLines[beforeIndex] === afterLines[afterIndex]
          ? matrix[beforeIndex + 1][afterIndex + 1] + 1
          : Math.max(matrix[beforeIndex + 1][afterIndex], matrix[beforeIndex][afterIndex + 1]);
    }
  }

  let beforeIndex = 0;
  let afterIndex = 0;
  while (beforeIndex < beforeLines.length && afterIndex < afterLines.length) {
    if (beforeLines[beforeIndex] === afterLines[afterIndex]) {
      rows.push({ type: "context", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
      afterIndex += 1;
    } else if (matrix[beforeIndex + 1][afterIndex] >= matrix[beforeIndex][afterIndex + 1]) {
      rows.push({ type: "removed", text: beforeLines[beforeIndex] });
      beforeIndex += 1;
    } else {
      rows.push({ type: "added", text: afterLines[afterIndex] });
      afterIndex += 1;
    }
  }

  while (beforeIndex < beforeLines.length) {
    rows.push({ type: "removed", text: beforeLines[beforeIndex] });
    beforeIndex += 1;
  }

  while (afterIndex < afterLines.length) {
    rows.push({ type: "added", text: afterLines[afterIndex] });
    afterIndex += 1;
  }

  return rows;
}
