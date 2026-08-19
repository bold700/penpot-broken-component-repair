/**
 * Runs dist/plugin.js against a fake Penpot API.
 *
 * Penpot plugins cannot be driven from CI, so this harness covers the parts
 * that do not need the real editor: broken-link detection, the library index,
 * ambiguity handling, the undo block and the swap calls.
 *
 * Usage: npm run build && node test/mock-run.mjs
 */
import assert from "node:assert/strict";

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`  FAIL ${name}\n       ${error.message}`);
  }
}

// ---------------------------------------------------------------- fixtures

const component = (libraryId, id, path, name) => ({ id, libraryId, path, name });

const localLib = {
  id: "lib-local",
  name: "Local library",
  components: [component("lib-local", "c-local-1", "", "Logo")],
};

const dsLib = {
  id: "lib-ds",
  name: "Design System",
  components: [
    component("lib-ds", "c-ds-1", "Actions", "Button"),
    component("lib-ds", "c-ds-2", "Forms", "Input"),
    component("lib-ds", "c-ds-3", "Icons", "Search"),
  ],
};

const mobileLib = {
  id: "lib-mobile",
  name: "Mobile UI",
  components: [component("lib-mobile", "c-mob-1", "Icons", "Search")],
};

const swapped = [];
const historyBlocks = [];

function makeShape(config) {
  return {
    id: config.id,
    name: config.name,
    isComponentMainInstance: () => Boolean(config.main),
    isComponentCopyInstance: () => Boolean(config.copy),
    component: () => {
      if (config.componentThrows) throw new Error("broken reference");
      return config.component ?? null;
    },
    swapComponent(target) {
      if (config.swapThrows) throw new Error("swap refused");
      swapped.push({ shape: config.id, component: target.id, library: target.libraryId });
    },
  };
}

const shapes = {
  healthy: makeShape({ id: "s-healthy", name: "Button", copy: true, component: dsLib.components[0] }),
  main: makeShape({ id: "s-main", name: "Button", main: true }),
  plain: makeShape({ id: "s-plain", name: "Rectangle" }),
  throwing: makeShape({ id: "s-throw", name: "Button", copy: true, componentThrows: true }),
  nullRef: makeShape({ id: "s-null", name: "Search", copy: true, component: null }),
  unknown: makeShape({ id: "s-unknown", name: "ProductCard", copy: true, component: null }),
  dangling: makeShape({
    id: "s-dangling",
    name: "renamed by a designer",
    copy: true,
    component: component("lib-removed", "c-gone", "Forms", "Input"),
  }),
  failing: makeShape({ id: "s-failing", name: "Logo", copy: true, component: null, swapThrows: true }),
};

const pageOne = {
  id: "p1",
  name: "Page 1",
  findShapes: () => [shapes.healthy, shapes.main, shapes.plain, shapes.throwing, shapes.nullRef],
};

const pageTwo = {
  id: "p2",
  name: "Page 2",
  findShapes: () => [shapes.unknown, shapes.dangling, shapes.failing],
};

const sent = [];
let onMessage = () => {};

globalThis.penpot = {
  theme: "dark",
  selection: [],
  currentPage: pageOne,
  currentFile: { id: "f1", pages: [pageOne, pageTwo] },
  library: { local: localLib, connected: [dsLib, mobileLib] },
  history: {
    undoBlockBegin() {
      const id = Symbol("block");
      historyBlocks.push({ id, open: true });
      return id;
    },
    undoBlockFinish(id) {
      const block = historyBlocks.find((entry) => entry.id === id);
      if (block) block.open = false;
    },
  },
  viewport: { zoomIntoView: () => {} },
  on: () => {},
  closePlugin: () => {},
  ui: {
    open: () => {},
    sendMessage: (message) => sent.push(message),
    onMessage: (callback) => { onMessage = callback; },
  },
};

// ------------------------------------------------------------------- run

await import("../dist/plugin.js");

const last = (type) => [...sent].reverse().find((message) => message.type === type);
const byId = (scan, id) => scan.items.find((item) => item.id === id);

console.log("\nscan (whole file)");
onMessage({ type: "scan", scope: "file" });
const scan = last("scan-result");

check("reports every broken copy and nothing else", () => {
  assert.deepEqual(
    scan.items.map((item) => item.id).sort(),
    ["s-dangling", "s-failing", "s-null", "s-throw", "s-unknown"],
  );
});
check("skips a copy that resolves to a known component", () => {
  assert.equal(byId(scan, "s-healthy"), undefined);
});
check("skips main instances", () => assert.equal(byId(scan, "s-main"), undefined));
check("counts both pages", () => assert.equal(scan.diagnostics.pages, 2));
check("indexes all libraries", () => assert.equal(scan.diagnostics.libraries, 3));
check("indexes all library components", () => assert.equal(scan.diagnostics.components, 5));

check("a throwing component() is a broken link with one match", () => {
  const item = byId(scan, "s-throw");
  assert.equal(item.reason, "no-component");
  assert.equal(item.status, "repairable");
  assert.equal(item.matches.length, 1);
  assert.equal(item.matches[0].libraryName, "Design System");
});

check("a name in two libraries is ambiguous, never auto-picked", () => {
  const item = byId(scan, "s-null");
  assert.equal(item.status, "ambiguous");
  assert.equal(item.matches.length, 2);
});

check("a name that exists nowhere is unresolved", () => {
  const item = byId(scan, "s-unknown");
  assert.equal(item.status, "unresolved");
  assert.equal(item.matches.length, 0);
});

check("a dangling reference is matched on the component name, not the layer name", () => {
  const item = byId(scan, "s-dangling");
  assert.equal(item.reason, "missing-library");
  assert.equal(item.lookupName, "Input");
  assert.equal(item.status, "repairable");
  assert.equal(item.matches[0].fullName, "Forms/Input");
});

console.log("\nscan (current page only)");
onMessage({ type: "scan", scope: "page" });
const pageScan = last("scan-result");
check("page scope stays on the current page", () => {
  assert.equal(pageScan.diagnostics.pages, 1);
  assert.deepEqual(pageScan.items.map((item) => item.id).sort(), ["s-null", "s-throw"]);
});

console.log("\nrepair");
onMessage({ type: "scan", scope: "file" });
const fresh = last("scan-result");
const pick = (id, index = 0) => [id, byId(fresh, id).matches[index].key];

onMessage({
  type: "repair",
  scope: "file",
  choices: Object.fromEntries([
    pick("s-throw"),
    pick("s-null", 1),
    pick("s-dangling"),
    pick("s-failing"),
    ["s-ghost", "lib-ds:c-ds-1"],
  ]),
});
const repaired = last("repair-result");

check("swaps exactly the chosen components", () => {
  assert.deepEqual(swapped, [
    { shape: "s-throw", component: "c-ds-1", library: "lib-ds" },
    { shape: "s-null", component: "c-mob-1", library: "lib-mobile" },
    { shape: "s-dangling", component: "c-ds-2", library: "lib-ds" },
  ]);
});
check("counts three repaired", () => assert.equal(repaired.fixed, 3));
check("reports the failing swap and the unknown shape", () => {
  assert.equal(repaired.failed, 2);
  assert.deepEqual(repaired.failures.map((failure) => failure.id).sort(), ["s-failing", "s-ghost"]);
});
check("wraps the whole repair in one undo block", () => {
  assert.equal(historyBlocks.length, 1);
  assert.equal(historyBlocks[0].open, false);
});
check("returns a fresh scan with the result", () => {
  assert.equal(repaired.scan.type, "scan-result");
});

console.log("\nerror handling");
const before = sent.length;
globalThis.penpot.currentFile = null;
globalThis.penpot.currentPage = { id: "boom", name: "Boom", findShapes: () => { throw new Error("page exploded"); } };
onMessage({ type: "scan", scope: "file" });
check("an API error is reported instead of crashing the sandbox", () => {
  const error = sent.slice(before).find((message) => message.type === "error");
  assert.ok(error);
  assert.equal(error.message, "page exploded");
});

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
