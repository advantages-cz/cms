import { base64ToText } from "utils";

export function readSaveFileFormData(data) {
  return {
    message: String(data.get("message") || "").trim(),
    content: String(data.get("content") || ""),
  };
}

export function frontMatterTitleForEntry(entry, { draftByPath, titleBySha }) {
  return draftByPath.has(entry.path) ? draftByPath.get(entry.path) : titleBySha.get(entry.sha) || "";
}

export function applyFrontMatterTitleToPath(files, path, title) {
  let changed = false;
  const nextFiles = files.map((file) => {
    if (file.path !== path || file.frontMatterTitle === title) {
      return file;
    }
    changed = true;
    return { ...file, frontMatterTitle: title };
  });
  return { files: nextFiles, changed };
}

export function applyFrontMatterTitleToSha(files, sha, title, draftByPath) {
  let changed = false;
  const nextFiles = files.map((file) => {
    const nextTitle = draftByPath.has(file.path) ? draftByPath.get(file.path) : title;
    if (file.sha !== sha || file.frontMatterTitle === nextTitle) {
      return file;
    }
    changed = true;
    return { ...file, frontMatterTitle: nextTitle };
  });
  return { files: nextFiles, changed };
}

export function upsertFileMetadata(files, entry) {
  let found = false;
  return files
    .map((file) => {
      if (file.path !== entry.path) {
        return file;
      }
      found = true;
      return { ...file, ...entry };
    })
    .concat(found ? [] : [entry])
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function decodeContentApiText(content) {
  return base64ToText(String(content || "").replace(/\s/g, ""));
}

export async function prepareEditorForSave({ client, owner, repo, branch, editor, conflictMessage, cacheBust = false }) {
  const latest = await client.getContent(owner, repo, editor.path, branch, { cacheBust });
  if (Array.isArray(latest) || latest.type !== "file" || !latest.sha) {
    throw new Error("Selected file is missing.");
  }

  if (latest.sha === editor.sha) {
    return { editor, latest, changed: false };
  }

  const remoteContent = decodeContentApiText(latest.content || "");
  if (remoteContent !== (editor.baseContent || "")) {
    throw new Error(conflictMessage);
  }

  return {
    editor: {
      ...editor,
      sha: latest.sha,
      baseContent: remoteContent,
    },
    latest,
    changed: true,
  };
}
