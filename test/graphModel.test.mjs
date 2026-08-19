import assert from "node:assert/strict";
import test from "node:test";
import {
  buildGraphModel,
  diffGraphModels,
  extractMarkdownLinks,
  isExternalHref,
  isGraphVisiblePath,
  normalizeLinkPath,
  resolveLinkTarget,
  splitFrontMatter,
  unitOfPath,
} from "../src/graph.js";

function file(path, content, extra = {}) {
  return { path, sha: `sha-${path}`, size: content?.length || 0, content, ...extra };
}

test("extractMarkdownLinks finds inline, angle-bracket, and titled links", () => {
  const text = [
    "# Heading",
    "",
    "See [one](a.md) and [two](<b c.md> \"title\").",
    "![image](pic.png)",
    "",
    "```",
    "[in code](ignored.md)",
    "```",
    "",
    "[three](dir/c.md#anchor)",
  ].join("\n");
  const links = extractMarkdownLinks(text);
  assert.deepEqual(
    links.map((link) => link.href),
    ["a.md", "b c.md", "dir/c.md#anchor"],
  );
  assert.equal(links[0].label, "one");
  assert.equal(links[0].line, 3);
  assert.equal(links[2].line, 10);
});

test("extractMarkdownLinks decodes entities in hrefs", () => {
  const links = extractMarkdownLinks("[x](a&amp;b.md)");
  assert.deepEqual(links.map((link) => link.href), ["a&b.md"]);
});

test("splitFrontMatter separates front matter and body", () => {
  const parsed = splitFrontMatter("---\ntitle: Test\nowner: p-platform\n---\n\nBody text");
  assert.equal(parsed.body.trim(), "Body text");
});

test("isExternalHref detects schemes", () => {
  assert.equal(isExternalHref("https://example.com"), true);
  assert.equal(isExternalHref("mailto:x@y.cz"), true);
  assert.equal(isExternalHref("relative.md"), false);
  assert.equal(isExternalHref("#anchor"), false);
});

test("normalizeLinkPath resolves relative, parent, and absolute targets", () => {
  assert.equal(normalizeLinkPath("a/b/doc.md", "c.md"), "a/b/c.md");
  assert.equal(normalizeLinkPath("a/b/doc.md", "../d.md"), "a/d.md");
  assert.equal(normalizeLinkPath("a/b/doc.md", "/e/f.md"), "e/f.md");
  assert.equal(normalizeLinkPath("a/b/doc.md", "c.md#sec"), "a/b/c.md");
  assert.equal(normalizeLinkPath("a/b/doc.md", "#sec"), "");
  assert.equal(normalizeLinkPath("a/b/doc.md", "https://x.cz"), "");
  assert.equal(normalizeLinkPath("a/b/doc.md", "javascript:alert(1)"), "");
  assert.equal(normalizeLinkPath("a/b/doc.md", "c%20d.md"), "a/b/c d.md");
});

test("resolveLinkTarget mirrors the CMS candidate order", () => {
  const filePathSet = new Set(["doc.md", "dir/index.md", "plain"]);
  const dirPathSet = new Set(["dir"]);
  assert.deepEqual(resolveLinkTarget("doc", filePathSet, dirPathSet), { kind: "file", path: "doc.md" });
  assert.deepEqual(resolveLinkTarget("dir", filePathSet, dirPathSet), { kind: "dir", path: "dir" });
  assert.deepEqual(resolveLinkTarget("dir/2", filePathSet, dirPathSet), { kind: "missing", path: "dir/2" });
  assert.deepEqual(resolveLinkTarget("plain", filePathSet, dirPathSet), { kind: "file", path: "plain" });
});

test("unitOfPath extracts the owning unit", () => {
  assert.equal(unitOfPath("README.md"), "root");
  assert.equal(unitOfPath("capabilities/platforms/p-platform/rozcestnik.md"), "p-platform");
  assert.equal(unitOfPath("capabilities/streams/area/s-stream/README.md"), "s-stream");
  assert.equal(unitOfPath("capabilities/platforms/p-platform"), "p-platform");
  assert.equal(unitOfPath("schemas/thing.schema.json"), "schemas");
});

test("isGraphVisiblePath mirrors the search visibility rules", () => {
  assert.equal(isGraphVisiblePath("README.md"), true);
  assert.equal(isGraphVisiblePath("AGENTS.md"), true);
  assert.equal(isGraphVisiblePath("requirements.txt"), false);
  assert.equal(isGraphVisiblePath("scripts/validate.py"), false);
  assert.equal(isGraphVisiblePath("capabilities/platforms/p-platform/x.md"), true);
});

test("buildGraphModel builds nodes, edges, and health metrics", () => {
  const files = [
    file(
      "README.md",
      "---\ntitle: Library\nowner: root\n---\nSee [p-platform](capabilities/platforms/p-platform/README.md) and [broken](missing.md).",
    ),
    file(
      "capabilities/platforms/p-platform/README.md",
      "---\ntitle: Platform unit\nowner: p-platform\nstatus: draft\n---\nBack to [root](/README.md).",
    ),
    file("capabilities/platforms/p-platform/orphan.md", "Nothing links here."),
    file("schemas/thing.schema.json", "{}"),
  ];
  const model = buildGraphModel(files);

  assert.equal(model.stats.docs, 3);
  assert.equal(model.stats.edges, 2);
  assert.equal(model.stats.largestComponentPct, 67);

  const root = model.nodes.find((node) => node.id === "README.md");
  assert.equal(root.name, "Library");
  assert.equal(root.frontMatter.owner, "root");
  assert.equal(root.outdeg, 1);
  assert.equal(root.indeg, 1);

  const pavds = model.nodes.find((node) => node.id === "capabilities/platforms/p-platform/README.md");
  assert.equal(pavds.unit, "p-platform");
  assert.equal(pavds.isNavigationFile, true);

  assert.deepEqual(
    model.health.deadLinks.map((link) => link.href),
    ["missing.md"],
  );
  assert.deepEqual(model.health.orphans, ["capabilities/platforms/p-platform/orphan.md"]);
  assert.deepEqual(model.health.isolates, ["capabilities/platforms/p-platform/orphan.md"]);
  assert.equal(model.health.hubs.length, 2);
  for (const hub of model.health.hubs) {
    assert.equal(hub.indeg, 1);
  }
  assert.equal(model.health.frontMatter.missingOwner.length, 1);
  assert.equal(model.health.frontMatter.statusCounts.draft, 1);
});

test("buildGraphModel dedupes repeated links into counted edges", () => {
  const files = [
    file("README.md", "[a](a.md) [a again](a.md)"),
    file("a.md", "doc"),
  ];
  const model = buildGraphModel(files);
  assert.equal(model.edges.length, 1);
  assert.equal(model.edges[0].count, 2);
  assert.equal(model.edges[0].label, "a");
});

test("buildGraphModel navigation links need exact paths like validate_navigation.py", () => {
  const files = [
    file("capabilities/platforms/p-platform/README.md", "[candidate](candidate.md)"),
    file("capabilities/platforms/p-platform/candidate.md", "doc"),
    file("capabilities/platforms/p-platform/extensionless.md", "doc"),
    file("capabilities/platforms/p-platform/README2.md", "---\ntitle: X\n---\n[ext](extensionless)"),
  ];
  const model = buildGraphModel(files);
  // candidate.md is linked by exact path from a navigation file.
  // extensionless.md is linked only without the .md extension, which the
  // navigation validator does not count.
  assert.ok(!model.health.orphans.includes("capabilities/platforms/p-platform/candidate.md"));
  assert.ok(model.health.orphans.includes("capabilities/platforms/p-platform/extensionless.md"));
  // README2.md itself is a content file that nothing links to.
  assert.ok(model.health.orphans.includes("capabilities/platforms/p-platform/README2.md"));
  // The extensionless link still resolves as a graph edge via candidates.
  assert.equal(model.edges.length, 2);
});

test("buildGraphModel skips links inside code fences", () => {
  const files = [
    file("README.md", "```\n[a](a.md)\n```"),
    file("a.md", "doc"),
  ];
  const model = buildGraphModel(files);
  assert.equal(model.edges.length, 0);
  assert.equal(model.health.deadLinks.length, 0);
});

test("buildGraphModel counts nodes without content", () => {
  const files = [file("README.md", null), file("a.md", null)];
  const model = buildGraphModel(files);
  assert.equal(model.stats.docs, 2);
  assert.equal(model.stats.edges, 0);
  assert.equal(model.health.frontMatter.missingOwner.length, 2);
});

test("diffGraphModels reports added, removed, and changed documents and links", () => {
  const master = buildGraphModel([
    file("README.md", "[kept](kept.md) [gone](gone.md)"),
    file("kept.md", "old text"),
    file("gone.md", "doc"),
  ]);
  const branch = buildGraphModel([
    file("README.md", "[kept](kept.md) [fresh](fresh.md)", { sha: "changed-sha" }),
    file("kept.md", "new text"),
    file("fresh.md", "doc"),
  ]);
  const diff = diffGraphModels(branch, master);

  assert.deepEqual(diff.addedDocs.map((doc) => doc.path), ["fresh.md"]);
  assert.deepEqual(diff.removedDocs.map((doc) => doc.path), ["gone.md"]);
  assert.deepEqual(diff.changedDocs.map((doc) => doc.path), ["README.md"]);
  assert.deepEqual(diff.addedEdges, [{ from: "README.md", to: "fresh.md" }]);
  assert.deepEqual(diff.removedEdges, [{ from: "README.md", to: "gone.md" }]);
});

test("diffGraphModels skips SHA-less documents for change detection", () => {
  const master = buildGraphModel([file("README.md", "old text", { sha: "" })]);
  const branch = buildGraphModel([file("README.md", "new text", { sha: "" })]);
  const diff = diffGraphModels(branch, master);
  assert.deepEqual(diff.changedDocs, []);
});

test("largestComponentPct handles empty, connected, and disconnected graphs", async () => {
  const { largestComponentPct } = await import("../src/graph.js");
  assert.equal(largestComponentPct(0, []), 0);
  assert.equal(
    largestComponentPct(3, [
      { source: 0, target: 1 },
      { source: 1, target: 2 },
    ]),
    100,
  );
  assert.equal(
    largestComponentPct(4, [
      { source: 0, target: 1 },
      { source: 2, target: 3 },
    ]),
    50,
  );
  assert.equal(largestComponentPct(3, [{ source: 0, target: 1 }]), 67);
});

test("normalizeLinkPath rejects links escaping the repository root", () => {
  assert.equal(normalizeLinkPath("README.md", "../outside.md"), "");
  assert.equal(normalizeLinkPath("a/b.md", "../../../x.md"), "");
  assert.equal(normalizeLinkPath("a/b.md", "../c.md"), "c.md");
});

test("frontMatterMap returns first value per key", async () => {
  const { frontMatterMap } = await import("../src/graph.js");
  const map = frontMatterMap("---\ntitle: One\ntitle: Two\nowner: x\n---\nbody");
  assert.equal(map.title, "One");
  assert.equal(map.owner, "x");
});
