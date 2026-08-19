/**
 * Runs plugin.js against a fake Penpot API.
 *
 * Penpot plugins cannot be driven from CI, so this harness covers the parts
 * that do not need the real editor: broken-link detection, the library index,
 * ambiguity handling, the undo block and the swap calls.
 *
 * Usage: node test/mock-run.mjs
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "plugin.js"), "utf8");

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

new Function(source)();

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

console.log("\nhandshake");
{
  const before = sent.length;
  onMessage({ type: "ready" });
  const hello = sent.slice(before).find((message) => message.type === "hello");
  check("ready gets answered with a probe", () => {
    assert.ok(hello);
    assert.equal(hello.probe.currentFile, true);
    assert.equal(hello.probe.pages, 2);
    assert.equal(hello.probe.connectedLibraries, 2);
    assert.equal(hello.probe.swapComponent, true);
    assert.equal(hello.probe.history, true);
  });
}

console.log("\nresilience");
{
  const exploding = makeShape({ id: "s-boom", name: "Boom", copy: true });
  exploding.isComponentCopyInstance = () => { throw new Error("shape exploded"); };
  const originalFind = pageTwo.findShapes;
  pageTwo.findShapes = () => [exploding, shapes.unknown];

  onMessage({ type: "scan", scope: "file" });
  const result = last("scan-result");
  check("a shape that throws is skipped, the rest still scans", () => {
    assert.ok(result.diagnostics.errors.some((e) => e.includes("shape exploded")));
    assert.ok(result.items.some((item) => item.id === "s-unknown"));
  });
  pageTwo.findShapes = originalFind;
}

console.log("\nerror handling");
globalThis.penpot.currentFile = null;
globalThis.penpot.currentPage = { id: "boom", name: "Boom", findShapes: () => { throw new Error("page exploded"); } };
onMessage({ type: "scan", scope: "file" });
check("a page that cannot be read is reported, not crashed on", () => {
  const result = last("scan-result");
  assert.deepEqual(result.diagnostics.errors, ['findShapes on "Boom": page exploded']);
  assert.equal(result.items.length, 0);
});

// ------------------------------------------------- variants and overrides

console.log("\nvariants and overrides");
{
  const switched = [];

  const variantComponent = (id, value) => ({
    id,
    libraryId: "lib-var",
    path: "Chip",
    name: `Size=${value}`,
    variantProps: { Size: value },
    __variant: true,
    variants: { id: "v-chip", properties: ["Size"] },
  });

  const variantLib = {
    id: "lib-var",
    name: "Variant Library",
    components: [variantComponent("c-small", "Small"), variantComponent("c-large", "Large")],
  };

  for (const component of variantLib.components) {
    component.variants.currentValues = (property) => (property === "Size" ? ["Small", "Large"] : []);
  }

  // A copy that points at a variant component in a library that is gone. Its
  // component still reports which variant it was on.
  const goneVariant = {
    id: "c-gone-variant",
    libraryId: "lib-removed",
    path: "",
    name: "Chip",
    variantProps: { Size: "Large" },
    __variant: true,
    variants: { id: "v-gone", properties: ["Size"] },
  };

  const broken = {
    id: "s-chip",
    name: "Mijn eigen chipnaam",
    x: 10,
    y: 20,
    width: 120,
    height: 32,
    rotation: 0,
    flipX: false,
    flipY: false,
    hidden: false,
    blocked: false,
    proportionLock: false,
    constraintsHorizontal: "left",
    constraintsVertical: "top",
    isComponentMainInstance: () => false,
    isComponentCopyInstance: () => true,
    component: () => goneVariant,
    // A real swap renames the layer and resizes it to the component default.
    swapComponent(component) {
      this.name = component.name;
      this.width = 64;
      this.height = 24;
    },
    switchVariant(pos, value) {
      switched.push({ pos, value });
      this.name = `Size=${value}`;
    },
    resize(width, height) {
      this.width = width;
      this.height = height;
    },
  };

  const page = { id: "vp", name: "Variants", findShapes: () => [broken] };
  const messages = [];
  let handler = () => {};

  globalThis.penpot = {
    theme: "light",
    selection: [],
    currentPage: page,
    currentFile: { id: "vf", pages: [page] },
    library: { local: { id: "lib-local", name: "Local", components: [] }, connected: [variantLib] },
    isVariantComponent: (component) => !!component.__variant,
    history: { undoBlockBegin: () => Symbol("b"), undoBlockFinish: () => {} },
    viewport: { zoomIntoView: () => {} },
    on: () => {},
    closePlugin: () => {},
    ui: {
      open: () => {},
      sendMessage: (message) => messages.push(message),
      onMessage: (callback) => { handler = callback; },
    },
  };

  new Function(source)();
  handler({ type: "scan", scope: "file" });
  const varScan = [...messages].reverse().find((m) => m.type === "scan-result");
  const item = varScan.items[0];

  check("a variant container counts once, not once per variant", () => {
    assert.equal(varScan.diagnostics.variants, 1);
    assert.equal(varScan.diagnostics.components, 2);
    assert.equal(item.matches.length, 1);
    assert.equal(item.status, "repairable");
  });

  check("the variant the copy was on is recorded", () => {
    assert.deepEqual(item.variantProps, { Size: "Large" });
  });

  check("every variant value is offered so the user can pick", () => {
    assert.deepEqual(item.matches[0].variantProperties, [
      { name: "Size", values: ["Small", "Large"] },
    ]);
  });

  handler({ type: "repair", scope: "file", choices: { "s-chip": item.matches[0].key } });
  const repairResult = [...messages].reverse().find((m) => m.type === "repair-result");
  const detail = repairResult.details[0];

  check("switchVariant puts it back on the same variant", () => {
    assert.deepEqual(switched, [{ pos: 0, value: "Large" }]);
    assert.deepEqual(detail.variant, ["Size=Large"]);
  });

  check("the layer name the user gave it survives the swap", () => {
    assert.equal(broken.name, "Mijn eigen chipnaam");
    assert.ok(detail.restored.includes("name"));
  });

  check("the size the user gave it survives the swap", () => {
    assert.equal(broken.width, 120);
    assert.equal(broken.height, 32);
    assert.ok(detail.restored.includes("size"));
  });

  check("nothing failed", () => assert.deepEqual(detail.failed, []));
}

console.log("\nan explicit variant choice");
{
  const switched = [];

  const variantComponent = (id, value) => ({
    id,
    libraryId: "lib-var",
    path: "banken",
    name: `Type=${value}`,
    variantProps: { Type: value },
    __variant: true,
    variants: {
      id: "v-banken",
      properties: ["Type"],
      currentValues: () => ["A", "B", "C", "D"],
    },
  });

  const lib = {
    id: "lib-var",
    name: "Meubels",
    components: ["A", "B", "C", "D"].map((value) => variantComponent("c-" + value, value)),
  };

  // The link is fully broken: component() gives nothing, so nothing about the
  // variant can be read off the copy. Only the user knows it was D.
  const broken = {
    id: "s-bank",
    name: "banken",
    x: 0, y: 0, width: 200, height: 100,
    isComponentMainInstance: () => false,
    isComponentCopyInstance: () => true,
    component: () => null,
    swapComponent(component) { this.name = component.name; },
    switchVariant(pos, value) { switched.push({ pos, value }); },
    resize() {},
  };

  const page = { id: "bp", name: "Banken", findShapes: () => [broken] };
  const messages = [];
  let handler = () => {};

  globalThis.penpot = {
    theme: "light",
    selection: [],
    currentPage: page,
    currentFile: { id: "bf", pages: [page] },
    library: { local: { id: "lib-local", name: "Local", components: [] }, connected: [lib] },
    isVariantComponent: (component) => !!component.__variant,
    history: { undoBlockBegin: () => Symbol("b"), undoBlockFinish: () => {} },
    viewport: { zoomIntoView: () => {} },
    on: () => {},
    closePlugin: () => {},
    ui: {
      open: () => {},
      sendMessage: (message) => messages.push(message),
      onMessage: (callback) => { handler = callback; },
    },
  };

  new Function(source)();
  handler({ type: "scan", scope: "file" });
  const bankScan = [...messages].reverse().find((m) => m.type === "scan-result");
  const bankItem = bankScan.items[0];

  check("four variants of one container are one entry, not four", () => {
    assert.equal(bankItem.matches.length, 1);
    assert.equal(bankItem.status, "repairable");
  });

  check("the variant cannot be detected, and is not guessed", () => {
    assert.equal(bankItem.variantProps, null);
  });

  check("all four values are offered", () => {
    assert.deepEqual(bankItem.matches[0].variantProperties, [
      { name: "Type", values: ["A", "B", "C", "D"] },
    ]);
  });

  handler({
    type: "repair",
    scope: "file",
    choices: { "s-bank": bankItem.matches[0].key },
    variants: { "s-bank": { Type: "D" } },
  });
  const bankRepair = [...messages].reverse().find((m) => m.type === "repair-result");

  check("the chosen variant is applied instead of the first one", () => {
    assert.deepEqual(switched, [{ pos: 0, value: "D" }]);
    assert.deepEqual(bankRepair.details[0].variant, ["Type=D"]);
  });
}

console.log(failures === 0 ? "\nAll checks passed.\n" : `\n${failures} check(s) failed.\n`);
process.exit(failures === 0 ? 0 : 1);
