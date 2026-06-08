import assert from "node:assert/strict";
import test from "node:test";

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
  globalThis.Node = {
    ELEMENT_NODE: 1,
    TEXT_NODE: 3,
  };
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

function text(value) {
  return {
    nodeType: Node.TEXT_NODE,
    nodeValue: value,
    parentElement: null,
  };
}

function element(tagName, ...children) {
  const node = {
    nodeType: Node.ELEMENT_NODE,
    tagName: String(tagName).toUpperCase(),
    childNodes: [],
    children: [],
    parentElement: null,
    getAttribute() {
      return null;
    },
  };
  for (const child of children.flat()) {
    if (!child) {
      continue;
    }
    child.parentElement = node;
    node.childNodes.push(child);
    if (child.nodeType === Node.ELEMENT_NODE) {
      node.children.push(child);
    }
  }
  return node;
}

test("discussion quote serializer converts selected table rows into markdown table", async () => {
  installBrowserGlobals();
  const { __testing } = await import(`../src/app.js?discussion-table=${Date.now()}`);

  const fragment = {
    childNodes: [
      element(
        "table",
        element(
          "tbody",
          element("tr", element("th", text("Produkt")), element("th", text("Status"))),
          element("tr", element("td", text("Web")), element("td", text("Hotovo"))),
          element("tr", element("td", text("API")), element("td", text("Probíhá"))),
        ),
      ),
    ],
  };

  assert.equal(
    __testing.serializeSelectionFragment(fragment),
    ["| Produkt | Status |", "| --- | --- |", "| Web | Hotovo |", "| API | Probíhá |"].join("\n"),
  );
});

test("discussion quote serializer keeps partial cell selections as a reduced markdown table", async () => {
  installBrowserGlobals();
  const { __testing } = await import(`../src/app.js?discussion-partial=${Date.now()}`);

  const fragment = {
    childNodes: [
      element(
        "table",
        element(
          "tbody",
          element("tr", element("th", text("Status"))),
          element("tr", element("td", text("In progress | blocked")), element("td", text("ignored"))),
        ),
      ),
    ],
  };

  assert.equal(
    __testing.serializeSelectionFragment(fragment),
    ["| Status |  |", "| --- | --- |", "| In progress \\| blocked | ignored |"].join("\n"),
  );
});
