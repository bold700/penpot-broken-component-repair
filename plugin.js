// plugin.js — runs inside the Penpot sandbox. No DOM here.
//
// A component copy counts as broken when it is a copy instance and either
// component() does not resolve, or it resolves to a component that no longer
// exists in the local or any connected library.

/** shape id -> Shape, filled during a scan so repair does not rescan */
const shapeCache = new Map();
/** "libraryId:componentId" -> LibraryComponent */
const componentCache = new Map();

function pagesInScope(scope) {
  if (scope === 'page') {
    return penpot.currentPage ? [penpot.currentPage] : [];
  }

  const file = penpot.currentFile;
  if (file && file.pages.length > 0) return file.pages;
  return penpot.currentPage ? [penpot.currentPage] : [];
}

function joinPath(path, name) {
  const clean = (path || '').replace(/^\/+|\/+$/g, '');
  return clean ? clean + '/' + name : name;
}

function pushMatch(index, key, match) {
  if (!key) return;
  const list = index.get(key);
  if (list) list.push(match);
  else index.set(key, [match]);
}

function buildLibraryIndex() {
  componentCache.clear();

  const byName = new Map();
  const byFullName = new Map();
  const local = penpot.library.local;
  const libraries = [local, ...penpot.library.connected];
  let components = 0;

  for (const library of libraries) {
    for (const component of library.components) {
      const key = library.id + ':' + component.id;
      const match = {
        key,
        libraryId: library.id,
        libraryName: library.name,
        isLocal: library.id === local.id,
        path: component.path || '',
        name: component.name,
        fullName: joinPath(component.path || '', component.name),
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
function resolveComponent(shape) {
  try {
    return shape.component();
  } catch (e) {
    return null;
  }
}

/** Reads a property of a possibly dangling component without throwing. */
function safeRead(read) {
  try {
    return read();
  } catch (e) {
    return null;
  }
}

function scan(scope) {
  const index = buildLibraryIndex();
  const pages = pagesInScope(scope);
  const items = [];
  const diagnostics = {
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
      let reason;
      let lookupName;

      if (!component) {
        reason = 'no-component';
        lookupName = shape.name.trim();
      } else {
        // The reference resolves, but points at a library that is gone.
        const libraryId = safeRead(() => component.libraryId);
        const componentId = safeRead(() => component.id);
        const known = libraryId && componentId
          ? componentCache.has(libraryId + ':' + componentId)
          : false;

        if (known) continue;

        reason = 'missing-library';
        lookupName = (safeRead(() => component.name) || shape.name).trim();
      }

      const matches =
        index.byFullName.get(lookupName) ||
        index.byName.get(lookupName) ||
        [];

      const status = matches.length === 1
        ? 'repairable'
        : matches.length > 1 ? 'ambiguous' : 'unresolved';

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

function scanPayload(scope) {
  const { items, diagnostics } = scan(scope);

  return {
    type: 'scan-result',
    scope,
    items,
    diagnostics,
    counts: {
      broken: items.length,
      repairable: items.filter(item => item.status === 'repairable').length,
      ambiguous: items.filter(item => item.status === 'ambiguous').length,
      unresolved: items.filter(item => item.status === 'unresolved').length,
    },
  };
}

function repair(request) {
  const entries = Object.entries(request.choices || {});
  const failures = [];
  let fixed = 0;

  const blockId = penpot.history.undoBlockBegin();
  try {
    for (const [shapeId, matchKey] of entries) {
      const shape = shapeCache.get(shapeId);
      const component = componentCache.get(matchKey);

      if (!shape) {
        failures.push({ id: shapeId, message: 'Shape is no longer in the last scan result.' });
        continue;
      }

      if (!component) {
        failures.push({ id: shapeId, message: 'Chosen library component is no longer available.' });
        continue;
      }

      try {
        shape.swapComponent(component);
        fixed++;
      } catch (e) {
        failures.push({ id: shapeId, message: e.message });
      }
    }
  } finally {
    penpot.history.undoBlockFinish(blockId);
  }

  penpot.ui.sendMessage({
    type: 'repair-result',
    fixed,
    failed: failures.length,
    failures,
    scan: scanPayload(request.scope),
  });
}

function selectShape(shapeId) {
  const shape = shapeCache.get(shapeId);
  if (!shape) return;

  penpot.selection = [shape];
  penpot.viewport.zoomIntoView([shape]);
}

// Relative to the manifest location, so the same files run on localhost and on
// any host, in a subfolder or at the domain root.
penpot.ui.open('Broken Component Repair', `index.html?theme=${penpot.theme}`, {
  width: 560,
  height: 700,
});

penpot.on('themechange', theme => {
  penpot.ui.sendMessage({ type: 'theme', theme });
});

penpot.ui.onMessage(msg => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === 'ready') {
      penpot.ui.sendMessage({ type: 'theme', theme: penpot.theme });
      return;
    }

    if (msg.type === 'scan') {
      penpot.ui.sendMessage(scanPayload(msg.scope || 'file'));
      return;
    }

    if (msg.type === 'repair') {
      repair(msg);
      return;
    }

    if (msg.type === 'select') {
      selectShape(msg.id);
      return;
    }

    if (msg.type === 'close') {
      penpot.closePlugin();
    }
  } catch (e) {
    penpot.ui.sendMessage({ type: 'error', message: e.message });
  }
});
