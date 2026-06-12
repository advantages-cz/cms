import assert from "node:assert/strict";
import test from "node:test";
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

function installBrowserGlobals() {
  const app = {
    _html: "",
    set innerHTML(value) {
      this._html = String(value);
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
  globalThis.HTMLMetaElement = class HTMLMetaElement extends HTMLElement {};
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
    matchMedia() {
      return { matches: false, addEventListener() {} };
    },
    performance: { now: () => 0 },
    visualViewport: { height: 800, addEventListener() {} },
    navigator: { onLine: true, standalone: false },
  };
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: globalThis.window.navigator,
  });
  globalThis.document = {
    activeElement: null,
    documentElement: { dataset: {}, style: { setProperty() {}, colorScheme: "" }, scrollTop: 0, scrollLeft: 0 },
    body: { scrollTop: 0, scrollLeft: 0 },
    querySelector(selector) {
      if (selector === "#app") {
        return app;
      }
      if (selector === 'meta[name="theme-color"]') {
        return new (class extends HTMLMetaElement {
          setAttribute() {}
        })();
      }
      return null;
    },
    querySelectorAll() {
      return [];
    },
    getElementById() {
      return null;
    },
  };
}

test("line diff marks removed and added lines", async () => {
  installBrowserGlobals();
  const { __testing } = await import(`../src/app.js?test=read-diff-${Date.now()}`);
  const diff = __testing.buildLineDiff("one\ntwo\nthree", "one\nthree\nfour");

  assert.deepEqual(diff, [
    { type: "context", text: "one" },
    { type: "removed", text: "two" },
    { type: "context", text: "three" },
    { type: "added", text: "four" },
  ]);
});

test("read snapshot detects changes on repository refresh and can be updated to the current version", async () => {
  installBrowserGlobals();
  const { __testing } = await import(`../src/app.js?test=read-snapshot-${Date.now()}`);
  const { state } = __testing;

  state.owner = "owner";
  state.repo = "repo";
  state.branch = "main";
  state.selectedPath = "content/page.md";
  state.files = [{ path: "content/page.md", sha: "sha-1", size: 11, content: "hello\nworld" }];
  state.editor = { path: "content/page.md", content: "hello\nnew world" };
  state.client = {
    async getBlob() {
      return { content: textToBase64("hello\nworld") };
    },
  };

  __testing.syncReadSnapshot({ path: "content/page.md", sha: "sha-1", size: 11 }, "hello\nworld");
  assert.equal(state.readSnapshot.changed, false);
  assert.equal(state.readSnapshot.content, undefined);

  await __testing.refreshReadSnapshotStatuses(state.files, [{ path: "content/page.md", sha: "sha-2", size: 15 }]);
  state.files = [{ path: "content/page.md", sha: "sha-2", size: 15 }];
  __testing.syncReadSnapshot({ path: "content/page.md", sha: "sha-2", size: 15 }, "hello\nnew world");
  assert.equal(state.readSnapshot.changed, true);
  assert.equal(state.readSnapshot.sha, "sha-1");
  assert.equal(state.readSnapshot.content, "hello\nworld");

  __testing.markCurrentFileAsReadSnapshot();
  assert.equal(state.readSnapshot.changed, false);
  assert.equal(state.readSnapshot.sha, "sha-2");
  assert.equal(state.readSnapshot.content, "hello\nnew world");
});
