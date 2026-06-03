import assert from "node:assert/strict";
import test from "node:test";
import {
  applyFrontMatterTitleToPath,
  applyFrontMatterTitleToSha,
  decodeContentApiText,
  frontMatterTitleForEntry,
  prepareEditorForSave,
  readSaveFileFormData,
  upsertFileMetadata,
} from "../src/editorWorkflow.js";

function contentApiText(text) {
  return Buffer.from(text, "utf8").toString("base64").replace(/(.{8})/g, "$1\n");
}

test("save form data carries the current editor content", () => {
  const data = new FormData();
  data.set("message", " CMS: rename title ");
  data.set("content", "---\ntitle: New title\n---\n\nBody");

  assert.deepEqual(readSaveFileFormData(data), {
    message: "CMS: rename title",
    content: "---\ntitle: New title\n---\n\nBody",
  });
});

test("draft front matter title overrides blob-SHA cache, including an empty title", () => {
  const entry = { path: "content/page.md", sha: "old-sha" };
  const titleBySha = new Map([["old-sha", "Old title"]]);
  const draftByPath = new Map([["content/page.md", ""]]);

  assert.equal(frontMatterTitleForEntry(entry, { draftByPath, titleBySha }), "");
});

test("background title scans do not overwrite a path draft title", () => {
  const files = [{ path: "content/page.md", sha: "old-sha", frontMatterTitle: "Draft title" }];
  const draftByPath = new Map([["content/page.md", "Draft title"]]);

  const result = applyFrontMatterTitleToSha(files, "old-sha", "Old title", draftByPath);

  assert.equal(result.changed, false);
  assert.equal(result.files[0].frontMatterTitle, "Draft title");
});

test("path title updates only the matching file", () => {
  const result = applyFrontMatterTitleToPath(
    [
      { path: "content/page.md", sha: "a", frontMatterTitle: "Old" },
      { path: "content/other.md", sha: "b", frontMatterTitle: "Other" },
    ],
    "content/page.md",
    "New",
  );

  assert.equal(result.changed, true);
  assert.equal(result.files[0].frontMatterTitle, "New");
  assert.equal(result.files[1].frontMatterTitle, "Other");
});

test("prepareEditorForSave refreshes stale SHA when remote content matches base content", async () => {
  const editor = {
    path: "content/page.md",
    sha: "old-sha",
    baseContent: "Original",
    content: "Edited",
  };
  const client = {
    async getContent(owner, repo, path, branch) {
      assert.equal(owner, "owner");
      assert.equal(repo, "repo");
      assert.equal(path, editor.path);
      assert.equal(branch, "cms/test");
      return {
        type: "file",
        sha: "new-sha",
        content: contentApiText("Original"),
      };
    },
  };

  const result = await prepareEditorForSave({
    client,
    owner: "owner",
    repo: "repo",
    branch: "cms/test",
    editor,
    conflictMessage: "conflict",
  });

  assert.equal(result.changed, true);
  assert.equal(result.editor.sha, "new-sha");
  assert.equal(result.editor.baseContent, "Original");
  assert.equal(result.editor.content, "Edited");
});

test("prepareEditorForSave keeps current SHA without reading content when it already matches", async () => {
  const editor = {
    path: "content/page.md",
    sha: "same-sha",
    baseContent: "Original",
    content: "Edited",
  };
  const client = {
    async getContent() {
      return {
        type: "file",
        sha: "same-sha",
        content: contentApiText("Different remote text should not matter"),
      };
    },
  };

  const result = await prepareEditorForSave({
    client,
    owner: "owner",
    repo: "repo",
    branch: "cms/test",
    editor,
    conflictMessage: "conflict",
  });

  assert.equal(result.changed, false);
  assert.equal(result.editor, editor);
});

test("prepareEditorForSave blocks overwrite when remote content changed after opening", async () => {
  const editor = {
    path: "content/page.md",
    sha: "old-sha",
    baseContent: "Original",
    content: "Edited",
  };
  const client = {
    async getContent() {
      return {
        type: "file",
        sha: "new-sha",
        content: contentApiText("Externally changed"),
      };
    },
  };

  await assert.rejects(
    () =>
      prepareEditorForSave({
        client,
        owner: "owner",
        repo: "repo",
        branch: "cms/test",
        editor,
        conflictMessage: "conflict",
      }),
    /conflict/,
  );
});

test("content API decoding tolerates wrapped base64", () => {
  assert.equal(decodeContentApiText(contentApiText("Hello\nworld")), "Hello\nworld");
});

test("upsertFileMetadata replaces by path and keeps sorted order", () => {
  const files = upsertFileMetadata(
    [
      { path: "z.md", sha: "z" },
      { path: "a.md", sha: "old" },
    ],
    { path: "a.md", sha: "new", size: 12 },
  );

  assert.deepEqual(files, [
    { path: "a.md", sha: "new", size: 12 },
    { path: "z.md", sha: "z" },
  ]);
});
