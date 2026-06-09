import assert from "node:assert/strict";
import test from "node:test";
import { GitHubError } from "../src/github.js";
import { textToBase64 } from "../src/utils.js";

function createStorage() {
  const data = new Map();
  return {
    getItem(key) {
      return data.has(key) ? data.get(key) : null;
    },
    setItem(key, value) {
      data.set(key, String(value));
    },
    removeItem(key) {
      data.delete(key);
    },
  };
}

function installBrowserGlobals(renderedHtml) {
  const app = {
    _html: "",
    set innerHTML(value) {
      this._html = String(value);
      renderedHtml.push(this._html);
    },
    get innerHTML() {
      return this._html;
    },
    addEventListener() {},
  };

  globalThis.localStorage = createStorage();
  globalThis.sessionStorage = createStorage();
  Object.defineProperty(globalThis, "crypto", {
    configurable: true,
    value: { randomUUID: () => "test-toast-id" },
  });
  globalThis.HTMLElement = class HTMLElement {};
  globalThis.HTMLInputElement = class HTMLInputElement extends HTMLElement {};
  globalThis.HTMLTextAreaElement = class HTMLTextAreaElement extends HTMLElement {};
  globalThis.HTMLSelectElement = class HTMLSelectElement extends HTMLElement {};
  globalThis.Blob = class Blob {};
  globalThis.URL = { createObjectURL: () => "blob:test", revokeObjectURL() {} };
  globalThis.fetch = async () => ({ ok: false });
  globalThis.window = {
    location: { search: "", href: "http://localhost/", pathname: "/", hash: "" },
    history: { pushState() {}, replaceState() {} },
    addEventListener() {},
    clearTimeout() {},
    setTimeout() {
      return 0;
    },
    requestAnimationFrame(callback) {
      callback();
    },
    confirm: () => true,
    open() {},
  };
  globalThis.document = {
    activeElement: null,
    querySelector(selector) {
      return selector === "#app" ? app : null;
    },
    getElementById() {
      return null;
    },
  };
}

test("save workflow renders submitted editor content before async refreshes", async () => {
  const renderedHtml = [];
  installBrowserGlobals(renderedHtml);
  const { __testing } = await import(`../src/app.js?test=${Date.now()}`);
  const { state } = __testing;
  const original = "---\ntitle: Old\n---\n\nOriginal";
  const edited = "---\ntitle: New\n---\n\nEdited";

  state.token = "token";
  state.client = {
    async getContent() {
      return {
        type: "file",
        sha: "old-sha",
        size: edited.length,
        content: textToBase64(original),
      };
    },
    async putFile() {
      return {
        content: { sha: "new-sha" },
        commit: { sha: "commit-sha" },
      };
    },
    async listTree() {
      return {
        headSha: "commit-sha",
        truncated: false,
        tree: [{ path: "content/page.md", name: "page.md", type: "blob", sha: "new-sha", size: edited.length }],
      };
    },
    async getCheckRuns() {
      return { check_runs: [] };
    },
    async getWorkflowRuns() {
      return { workflow_runs: [] };
    },
    async listPullRequests() {
      return [];
    },
    async compare() {
      return { files: [], commits: [], ahead_by: 1, behind_by: 0 };
    },
  };
  state.owner = "owner";
  state.repo = "repo";
  state.branch = "cms/test";
  state.defaultBranch = "master";
  state.headSha = "head-sha";
  state.editMode = true;
  state.tab = "files";
  state.files = [{ path: "content/page.md", name: "page.md", type: "blob", sha: "old-sha", size: original.length, frontMatterTitle: "Old" }];
  state.selectedPath = "content/page.md";
  state.selectedDir = "content";
  state.editor = {
    path: "content/page.md",
    sha: "old-sha",
    size: original.length,
    content: original,
    baseContent: original,
    binary: false,
    dirty: true,
  };

  await __testing.saveCurrentFile({ message: "CMS: update page", content: edited });

  const firstBusyRender = renderedHtml.find((html) => html.includes('class="busy-overlay"'));
  assert.ok(firstBusyRender, "expected busy render");
  assert.match(firstBusyRender, /title: New/);
  assert.match(firstBusyRender, /Edited/);
  assert.doesNotMatch(firstBusyRender, /title: Old[\s\S]*Original/);
});

test("save workflow keeps submitted editor content after the full async chain", async () => {
  const renderedHtml = [];
  installBrowserGlobals(renderedHtml);
  const { __testing } = await import(`../src/app.js?test=full-${Date.now()}`);
  const { state } = __testing;
  const original = "---\ntitle: Old\n---\n\nOriginal";
  const edited = "---\ntitle: New\n---\n\nEdited";
  const calls = [];

  state.token = "token";
  state.client = {
    async getContent() {
      calls.push("getContent");
      return {
        type: "file",
        sha: calls.length === 1 ? "old-sha" : "new-sha",
        size: edited.length,
        content: textToBase64(calls.length === 1 ? original : edited),
      };
    },
    async putFile(owner, repo, path, payload) {
      calls.push("putFile");
      assert.equal(Buffer.from(payload.contentBase64, "base64").toString("utf8"), edited);
      return {
        content: { sha: "new-sha" },
        commit: { sha: "commit-sha" },
      };
    },
    async listTree() {
      calls.push("listTree");
      return {
        headSha: "commit-sha",
        truncated: false,
        tree: [{ path: "content/page.md", name: "page.md", type: "blob", sha: "new-sha", size: edited.length }],
      };
    },
    async getCheckRuns() {
      calls.push("getCheckRuns");
      return { check_runs: [] };
    },
    async getWorkflowRuns() {
      calls.push("getWorkflowRuns");
      return { workflow_runs: [] };
    },
    async listPullRequests() {
      calls.push("listPullRequests");
      return [];
    },
    async compare() {
      calls.push("compare");
      return { files: [], commits: [], ahead_by: 1, behind_by: 0 };
    },
  };
  state.owner = "owner";
  state.repo = "repo";
  state.branch = "cms/test";
  state.defaultBranch = "master";
  state.headSha = "head-sha";
  state.editMode = true;
  state.tab = "files";
  state.files = [{ path: "content/page.md", name: "page.md", type: "blob", sha: "old-sha", size: original.length, frontMatterTitle: "Old" }];
  state.selectedPath = "content/page.md";
  state.selectedDir = "content";
  state.editor = {
    path: "content/page.md",
    sha: "old-sha",
    size: original.length,
    content: original,
    baseContent: original,
    binary: false,
    dirty: true,
  };

  await __testing.saveCurrentFile({ message: "CMS: update page", content: edited });

  assert.equal(state.connectionError, "");
  assert.equal(state.editor.content, edited);
  assert.equal(state.editor.baseContent, edited);
  assert.equal(state.editor.sha, "new-sha");
  assert.equal(state.files.find((file) => file.path === "content/page.md")?.frontMatterTitle, "New");
  assert.equal(state.headSha, "commit-sha");
  assert.ok(renderedHtml.at(-1).includes("title: New"));
  assert.ok(renderedHtml.at(-1).includes("Edited"));
  assert.deepEqual(calls, [
    "getContent",
    "putFile",
    "listTree",
    "getContent",
    "getContent",
    "getCheckRuns",
    "getWorkflowRuns",
    "listPullRequests",
    "compare",
  ]);
});

test("save workflow reloads saved file from the commit SHA instead of a stale branch ref", async () => {
  installBrowserGlobals([]);
  const { __testing } = await import(`../src/app.js?test=commit-ref-${Date.now()}`);
  const { state } = __testing;
  const original = "---\ntitle: Old\n---\n\nOriginal";
  const edited = "---\ntitle: New\n---\n\nEdited";
  const contentRefs = [];

  state.token = "token";
  state.client = {
    async getContent(owner, repo, path, ref) {
      contentRefs.push(ref);
      const committed = ref === "commit-sha";
      return {
        type: "file",
        sha: committed ? "new-sha" : "old-sha",
        size: committed ? edited.length : original.length,
        content: textToBase64(committed ? edited : original),
      };
    },
    async putFile(owner, repo, path, payload) {
      assert.equal(Buffer.from(payload.contentBase64, "base64").toString("utf8"), edited);
      return {
        content: { sha: "new-sha" },
        commit: { sha: "commit-sha" },
      };
    },
    async listTree() {
      return {
        headSha: "commit-sha",
        truncated: false,
        tree: [{ path: "content/page.md", name: "page.md", type: "blob", sha: "new-sha", size: edited.length }],
      };
    },
    async getCheckRuns() {
      return { check_runs: [] };
    },
    async getWorkflowRuns() {
      return { workflow_runs: [] };
    },
    async listPullRequests() {
      return [];
    },
    async compare() {
      return { files: [], commits: [], ahead_by: 1, behind_by: 0 };
    },
  };
  state.owner = "owner";
  state.repo = "repo";
  state.branch = "cms/test";
  state.defaultBranch = "master";
  state.headSha = "head-sha";
  state.editMode = true;
  state.tab = "files";
  state.files = [{ path: "content/page.md", name: "page.md", type: "blob", sha: "old-sha", size: original.length, frontMatterTitle: "Old" }];
  state.selectedPath = "content/page.md";
  state.selectedDir = "content";
  state.editor = {
    path: "content/page.md",
    sha: "old-sha",
    size: original.length,
    content: original,
    baseContent: original,
    binary: false,
    dirty: true,
  };

  await __testing.saveCurrentFile({ message: "CMS: update page", content: edited });

  assert.deepEqual(contentRefs, ["cms/test", "commit-sha", "commit-sha"]);
  assert.equal(state.editor.content, edited);
  assert.equal(state.editor.baseContent, edited);
  assert.equal(state.editor.sha, "new-sha");
  assert.equal(state.files.find((file) => file.path === "content/page.md")?.frontMatterTitle, "New");
});

test("save workflow retries 409 with cache-busted content SHA", async () => {
  installBrowserGlobals([]);
  const { __testing } = await import(`../src/app.js?test=retry-${Date.now()}`);
  const { state } = __testing;
  const original = "---\ntitle: Old\n---\n\nOriginal";
  const edited = "---\ntitle: New\n---\n\nEdited";
  const contentOptions = [];
  const putShas = [];
  let saved = false;

  state.token = "token";
  state.client = {
    async getContent(owner, repo, path, branch, options = {}) {
      contentOptions.push(options);
      const fresh = Boolean(options.cacheBust);
      return {
        type: "file",
        sha: saved ? "saved-sha" : fresh ? "fresh-sha" : "stale-sha",
        size: edited.length,
        content: textToBase64(saved ? edited : original),
      };
    },
    async putFile(owner, repo, path, payload) {
      putShas.push(payload.sha);
      if (payload.sha === "stale-sha") {
        throw new GitHubError("does not match stale-sha", { status: 409 }, {}, {});
      }
      saved = true;
      return {
        content: { sha: "saved-sha" },
        commit: { sha: "commit-sha" },
      };
    },
    async listTree() {
      return {
        headSha: "commit-sha",
        truncated: false,
        tree: [{ path: "rozcestnik.md", name: "rozcestnik.md", type: "blob", sha: "saved-sha", size: edited.length }],
      };
    },
    async getCheckRuns() {
      return { check_runs: [] };
    },
    async getWorkflowRuns() {
      return { workflow_runs: [] };
    },
    async listPullRequests() {
      return [];
    },
    async compare() {
      return { files: [], commits: [], ahead_by: 1, behind_by: 0 };
    },
  };
  state.owner = "owner";
  state.repo = "repo";
  state.branch = "cms/test";
  state.defaultBranch = "master";
  state.headSha = "head-sha";
  state.editMode = true;
  state.tab = "files";
  state.connectionError = "";
  state.files = [{ path: "rozcestnik.md", name: "rozcestnik.md", type: "blob", sha: "stale-sha", size: original.length, frontMatterTitle: "Old" }];
  state.selectedPath = "rozcestnik.md";
  state.selectedDir = "";
  state.editor = {
    path: "rozcestnik.md",
    sha: "stale-sha",
    size: original.length,
    content: original,
    baseContent: original,
    binary: false,
    dirty: true,
  };

  await __testing.saveCurrentFile({ message: "CMS: update rozcestnik", content: edited });

  assert.equal(state.connectionError, "");
  assert.deepEqual(putShas, ["stale-sha", "fresh-sha"]);
  assert.deepEqual(contentOptions.map((options) => Boolean(options.cacheBust)), [false, true, false, true]);
  assert.equal(state.editor.content, edited);
  assert.equal(state.editor.sha, "saved-sha");
});
