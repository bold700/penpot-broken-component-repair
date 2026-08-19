/**
 * Runs in the plugin iframe. Penpot exchanges plain messages with the sandbox,
 * so there is no wrapper object: post the message itself and read `event.data`.
 */

export {};

type Scope = "file" | "page";
type ItemStatus = "repairable" | "ambiguous" | "unresolved";

type RepairMatch = {
  key: string;
  libraryId: string;
  libraryName: string;
  isLocal: boolean;
  path: string;
  name: string;
  fullName: string;
};

type BrokenItem = {
  id: string;
  shapeName: string;
  lookupName: string;
  pageId: string;
  pageName: string;
  reason: "no-component" | "missing-library";
  status: ItemStatus;
  matches: RepairMatch[];
};

type Diagnostics = {
  pages: number;
  shapes: number;
  copyInstances: number;
  mainInstances: number;
  libraries: number;
  components: number;
};

type ScanResult = {
  type: "scan-result";
  scope: Scope;
  items: BrokenItem[];
  diagnostics: Diagnostics;
  counts: { broken: number; repairable: number; ambiguous: number; unresolved: number };
};

type PluginMessage =
  | ScanResult
  | { type: "repair-result"; fixed: number; failed: number; failures: { id: string; message: string }[]; scan: ScanResult }
  | { type: "theme"; theme: "light" | "dark" }
  | { type: "error"; message: string };

const el = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const scanButton = el<HTMLButtonElement>("scan");
const repairButton = el<HTMLButtonElement>("repair");
const closeButton = el<HTMLButtonElement>("close");
const scopeSelect = el<HTMLSelectElement>("scope");
const statusLine = el<HTMLDivElement>("status");
const resultsBox = el<HTMLDivElement>("results");
const diagnosticsList = el<HTMLDListElement>("diagnostics");

const counters = {
  broken: el<HTMLElement>("brokenCount"),
  repairable: el<HTMLElement>("repairableCount"),
  ambiguous: el<HTMLElement>("ambiguousCount"),
  unresolved: el<HTMLElement>("unresolvedCount"),
};

/** shape id -> chosen library component key */
const choices = new Map<string, string>();
let lastScan: ScanResult | null = null;

function send(message: unknown) {
  window.parent.postMessage(message, "*");
}

function setStatus(text: string, tone: "" | "ok" | "error" = "", busy = false) {
  statusLine.dataset.tone = tone;
  statusLine.innerHTML = "";
  if (busy) {
    const spinner = document.createElement("span");
    spinner.className = "spinner";
    statusLine.append(spinner);
  }
  statusLine.append(document.createTextNode(text));
}

function applyTheme(theme: string) {
  document.documentElement.dataset.theme = theme === "dark" ? "dark" : "light";
}

function label(match: RepairMatch) {
  const library = match.isLocal ? "Local library" : match.libraryName;
  return `${library} · ${match.fullName}`;
}

function reasonText(item: BrokenItem) {
  return item.reason === "no-component"
    ? "No component reference could be read"
    : "References a component that is not in any connected library";
}

function updateRepairButton() {
  repairButton.disabled = choices.size === 0;
  repairButton.textContent = choices.size
    ? `Repair ${choices.size} selected`
    : "Repair selected";
}

function buildItem(item: BrokenItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "item";

  const head = document.createElement("div");
  head.className = "item-head";

  const name = document.createElement("button");
  name.type = "button";
  name.className = "item-name";
  name.textContent = item.shapeName || "(unnamed)";
  name.title = "Select this shape on the canvas";
  name.addEventListener("click", () => send({ type: "select", id: item.id }));

  const badge = document.createElement("span");
  badge.className = `badge ${item.status}`;
  badge.textContent =
    item.status === "repairable" ? "match found"
    : item.status === "ambiguous" ? `${item.matches.length} matches`
    : "no match";

  head.append(name, badge);

  const meta = document.createElement("div");
  meta.className = "meta";
  meta.textContent = `${item.pageName} · looked up as "${item.lookupName}" · ${reasonText(item)}`;

  row.append(head, meta);

  if (item.matches.length === 0) {
    const hint = document.createElement("div");
    hint.className = "meta";
    hint.textContent = "No component with this name exists in the local or connected libraries.";
    row.append(hint);
    return row;
  }

  const choice = document.createElement("div");
  choice.className = "choice";

  const select = document.createElement("select");
  select.id = `choice-${item.id}`;

  const skip = document.createElement("option");
  skip.value = "";
  skip.textContent = "Leave untouched";
  select.append(skip);

  for (const match of item.matches) {
    const option = document.createElement("option");
    option.value = match.key;
    option.textContent = label(match);
    select.append(option);
  }

  // Only an unambiguous match is preselected. A name that exists in more than
  // one library is always a human decision.
  if (item.matches.length === 1) {
    select.value = item.matches[0].key;
    choices.set(item.id, item.matches[0].key);
  }

  select.addEventListener("change", () => {
    if (select.value) choices.set(item.id, select.value);
    else choices.delete(item.id);
    updateRepairButton();
  });

  const selectLabel = document.createElement("label");
  selectLabel.className = "meta";
  selectLabel.htmlFor = select.id;
  selectLabel.textContent = "Relink to";

  choice.append(selectLabel, select);
  row.append(choice);
  return row;
}

function renderEmpty(scan: ScanResult) {
  const empty = document.createElement("div");
  empty.className = "empty";

  const title = document.createElement("h2");
  title.textContent = "No broken component links found";

  const body = document.createElement("p");
  body.textContent = scan.diagnostics.copyInstances === 0
    ? `Scanned ${scan.diagnostics.shapes} shapes across ${scan.diagnostics.pages} page(s) and found no component copies at all. Check the scope, or open the diagnostics below.`
    : `All ${scan.diagnostics.copyInstances} component copies resolve to a component in the local or a connected library.`;

  const again = document.createElement("button");
  again.type = "button";
  again.className = "secondary";
  again.textContent = "Scan again";
  again.addEventListener("click", () => startScan());

  empty.append(title, body, again);
  resultsBox.append(empty);
}

function renderDiagnostics(diagnostics: Diagnostics, scope: Scope) {
  const rows: [string, string][] = [
    ["Scope", scope === "file" ? "Whole file" : "Current page"],
    ["Pages scanned", String(diagnostics.pages)],
    ["Shapes inspected", String(diagnostics.shapes)],
    ["Component copies", String(diagnostics.copyInstances)],
    ["Main components on canvas", String(diagnostics.mainInstances)],
    ["Libraries indexed", String(diagnostics.libraries)],
    ["Library components indexed", String(diagnostics.components)],
  ];

  diagnosticsList.innerHTML = "";
  for (const [term, value] of rows) {
    const dt = document.createElement("dt");
    dt.textContent = term;
    const dd = document.createElement("dd");
    dd.textContent = value;
    diagnosticsList.append(dt, dd);
  }
}

function render(scan: ScanResult) {
  lastScan = scan;
  choices.clear();

  counters.broken.textContent = String(scan.counts.broken);
  counters.repairable.textContent = String(scan.counts.repairable);
  counters.ambiguous.textContent = String(scan.counts.ambiguous);
  counters.unresolved.textContent = String(scan.counts.unresolved);

  resultsBox.innerHTML = "";
  if (scan.items.length === 0) renderEmpty(scan);
  else for (const item of scan.items) resultsBox.append(buildItem(item));

  renderDiagnostics(scan.diagnostics, scan.scope);
  updateRepairButton();
}

function startScan() {
  scanButton.disabled = true;
  repairButton.disabled = true;
  setStatus("Scanning…", "", true);
  send({ type: "scan", scope: scopeSelect.value as Scope });
}

scanButton.addEventListener("click", startScan);

repairButton.addEventListener("click", () => {
  if (choices.size === 0) return;
  scanButton.disabled = true;
  repairButton.disabled = true;
  setStatus(`Relinking ${choices.size} component(s)…`, "", true);
  send({
    type: "repair",
    scope: (lastScan?.scope ?? scopeSelect.value) as Scope,
    choices: Object.fromEntries(choices),
  });
});

closeButton.addEventListener("click", () => send({ type: "close" }));

scopeSelect.addEventListener("change", () => {
  setStatus("Scope changed. Scan again to refresh the list.");
});

window.addEventListener("message", (event: MessageEvent<PluginMessage>) => {
  const message = event.data;
  if (!message || typeof message !== "object" || !("type" in message)) return;

  switch (message.type) {
    case "theme":
      applyTheme(message.theme);
      return;

    case "scan-result":
      scanButton.disabled = false;
      render(message);
      setStatus(
        message.counts.broken === 0
          ? "Scan complete. Nothing broken."
          : `Scan complete: ${message.counts.broken} broken copy/copies, ${message.counts.repairable} with a single match.`,
        message.counts.broken === 0 ? "ok" : "",
      );
      return;

    case "repair-result": {
      scanButton.disabled = false;
      render(message.scan);
      const tone = message.failed > 0 ? "error" : "ok";
      const detail = message.failures.length ? ` First error: ${message.failures[0].message}` : "";
      setStatus(`Repaired ${message.fixed}, failed ${message.failed}.${detail}`, tone);
      return;
    }

    case "error":
      scanButton.disabled = false;
      setStatus(`Error: ${message.message}`, "error");
      return;
  }
});

applyTheme(new URLSearchParams(window.location.search).get("theme") ?? "light");
send({ type: "ready" });
setStatus("Ready. Press Scan to look for broken component links.");
