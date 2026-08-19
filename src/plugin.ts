import type { LibraryComponent, Page, Shape } from "@penpot/plugin-types";

/**
 * Runs inside the Penpot plugin sandbox. No DOM here.
 *
 * A component copy is treated as broken when it is a copy instance and either
 * `component()` does not resolve, or it resolves to a component that no longer
 * exists in the local or any connected library.
 */

type MatchKey = string;
type Scope = "file" | "page";
type BrokenReason = "no-component" | "missing-library";
type ItemStatus = "repairable" | "ambiguous" | "unresolved";

type RepairMatch = {
  key: MatchKey;
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
  reason: BrokenReason;
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

const shapeCache = new Map<string, Shape>();
const componentCache = new Map<MatchKey, LibraryComponent>();

function pagesInScope(scope: Scope): Page[] {
  if (scope === "page") {
    return penpot.currentPage ? [penpot.currentPage] : [];
  }

  const file = penpot.currentFile;
  if (file && file.pages.length > 0) return file.pages;
  return penpot.currentPage ? [penpot.currentPage] : [];
}

function joinPath(path: string, name: string): string {
  const clean = (path ?? "").replace(/^\/+|\/+$/g, "");
  return clean ? clean + "/" + name : name;
}

function pushMatch(index: Map<string, RepairMatch[]>, key: string, match: RepairMatch) {
  if (!key) return;
  const list = index.get(key);
  if (list) list.push(match);
  else index.set(key, [match]);
}

function buildLibraryIndex() {
  componentCache.clear();

  const byName = new Map<string, RepairMatch[]>();
  const byFullName = new Map<string, RepairMatch[]>();
  const local = penpot.library.local;
  const libraries = [local, ...penpot.library.connected];
  let components = 0;

  for (const library of libraries) {
    for (const component of library.components) {
      const key = library.id + ":" + component.id;
      const match: RepairMatch = {
        key,
        libraryId: library.id,
        libraryName: library.name,
        isLocal: library.id === local.id,
        path: component.path ?? "",
        name: component.name,
        fullName: joinPath(component.path ?? "", component.name),
      };

      componentCache.set(key, component);
      pushMatch(byName, component.name.trim(), match);
      pushMatch(byFullName, match.fullName.trim(), match);
      components++;
    }
  }

  return { byName, byFullName, libraryCount: libraries.length, components };
}

/** Reads the linked component without letting a broken reference throw. */
function resolveComponent(shape: Shape): LibraryComponent | null {
  try {
    return shape.component();
  } catch {
    return null;
  }
}

/** Reads a property of a possibly dangling component without throwing. */
function safeRead<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

function scan(scope: Scope) {
  const index = buildLibraryIndex();
  const pages = pagesInScope(scope);
  const items: BrokenItem[] = [];
  const diagnostics: Diagnostics = {
    pages: pages.length,
    shapes: 0,
    copyInstances: 0,
    mainInstances: 0,
    libraries: index.libraryCount,
    components: index.components,
  };

  shapeCache.clear();

  for (const page of pages) {
    for (const shape of page.findShapes()) {
      diagnostics.shapes++;

      if (shape.isComponentMainInstance()) {
        diagnostics.mainInstances++;
        continue;
      }

      if (!shape.isComponentCopyInstance()) continue;
      diagnostics.copyInstances++;

      const component = resolveComponent(shape);
      let reason: BrokenReason;
      let lookupName: string;

      if (!component) {
        reason = "no-component";
        lookupName = shape.name.trim();
      } else {
        // The reference resolves, but points at a library that is gone.
        const libraryId = safeRead(() => component.libraryId);
        const componentId = safeRead(() => component.id);
        const known = libraryId && componentId
          ? componentCache.has(libraryId + ":" + componentId)
          : false;

        if (known) continue;

        reason = "missing-library";
        lookupName = (safeRead(() => component.name) ?? shape.name).trim();
      }

      const matches =
        index.byFullName.get(lookupName) ??
        index.byName.get(lookupName) ??
        [];

      const status: ItemStatus =
        matches.length === 1 ? "repairable" : matches.length > 1 ? "ambiguous" : "unresolved";

      shapeCache.set(shape.id, shape);
      items.push({
        id: shape.id,
        shapeName: shape.name,
        lookupName,
        pageId: page.id,
        pageName: page.name,
        reason,
        status,
        matches: matches.slice(),
      });
    }
  }

  return { items, diagnostics };
}

function scanPayload(scope: Scope) {
  const { items, diagnostics } = scan(scope);

  return {
    type: "scan-result" as const,
    scope,
    items,
    diagnostics,
    counts: {
      broken: items.length,
      repairable: items.filter((item) => item.status === "repairable").length,
      ambiguous: items.filter((item) => item.status === "ambiguous").length,
      unresolved: items.filter((item) => item.status === "unresolved").length,
    },
  };
}

type RepairRequest = {
  type: "repair";
  scope: Scope;
  /** shape id -> chosen match key */
  choices: Record<string, MatchKey>;
};

function repair(request: RepairRequest) {
  const entries = Object.entries(request.choices ?? {});
  const failures: { id: string; message: string }[] = [];
  let fixed = 0;

  const blockId = penpot.history.undoBlockBegin();
  try {
    for (const [shapeId, matchKey] of entries) {
      const shape = shapeCache.get(shapeId);
      const component = componentCache.get(matchKey);

      if (!shape) {
        failures.push({ id: shapeId, message: "Shape is no longer in the last scan result." });
        continue;
      }

      if (!component) {
        failures.push({ id: shapeId, message: "Chosen library component is no longer available." });
        continue;
      }

      try {
        shape.swapComponent(component);
        fixed++;
      } catch (error) {
        failures.push({
          id: shapeId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  } finally {
    penpot.history.undoBlockFinish(blockId);
  }

  penpot.ui.sendMessage({
    type: "repair-result",
    fixed,
    failed: failures.length,
    failures,
    scan: scanPayload(request.scope),
  });
}

function select(shapeId: string) {
  const shape = shapeCache.get(shapeId);
  if (!shape) return;

  penpot.selection = [shape];
  penpot.viewport.zoomIntoView([shape]);
}

penpot.ui.open("Broken Component Repair", `?theme=${penpot.theme}`, {
  width: 560,
  height: 700,
});

penpot.on("themechange", (theme) => {
  penpot.ui.sendMessage({ type: "theme", theme });
});

type IncomingMessage =
  | { type: "ready" }
  | { type: "scan"; scope: Scope }
  | RepairRequest
  | { type: "select"; id: string }
  | { type: "close" };

penpot.ui.onMessage<IncomingMessage>((message) => {
  try {
    switch (message?.type) {
      case "ready":
        penpot.ui.sendMessage({ type: "theme", theme: penpot.theme });
        return;

      case "scan":
        penpot.ui.sendMessage(scanPayload(message.scope ?? "file"));
        return;

      case "repair":
        repair(message);
        return;

      case "select":
        select(message.id);
        return;

      case "close":
        penpot.closePlugin();
        return;
    }
  } catch (error) {
    penpot.ui.sendMessage({
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});
