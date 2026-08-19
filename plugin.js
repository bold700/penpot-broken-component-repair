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
  const byVariantContainer = new Map();
  const seenVariants = new Set();
  const local = penpot.library.local;
  const libraries = [local, ...penpot.library.connected];
  let components = 0;
  let variants = 0;

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

      const variant = variantInfo(component);
      match.isVariant = !!variant;
      match.variantProps = variant ? variant.props : null;
      match.variantProperties = variant ? readVariantProperties(component) : null;
      match.containerName = variant ? lastPathSegment(component.path || '') : '';

      componentCache.set(key, component);
      pushMatch(byName, component.name.trim(), match);
      pushMatch(byFullName, match.fullName.trim(), match);

      // A variant container shows up once, not once per variant, otherwise
      // every "Button" would look ambiguous. The exact variant is restored
      // afterwards with switchVariant.
      if (variant && match.containerName) {
        const variantKey = (variant.id || match.containerName) + '@' + library.id;
        if (!seenVariants.has(variantKey)) {
          seenVariants.add(variantKey);
          pushMatch(byVariantContainer, match.containerName, match);
          variants++;
        }
      }

      components++;
    }
  }

  return { byName, byFullName, byVariantContainer, libraryCount: libraries.length, components, variants };
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
    variants: index.variants,
    errors: [],
  };

  shapeCache.clear();

  for (const page of pages) {
    let shapes = [];
    try {
      shapes = page.findShapes();
    } catch (e) {
      diagnostics.errors.push('findShapes on "' + page.name + '": ' + e.message);
      continue;
    }

    for (const shape of shapes) {
      diagnostics.shapes++;

      // A single odd shape must not take the whole scan down with it.
      let isMain = false;
      let isCopy = false;
      try {
        isMain = shape.isComponentMainInstance();
        isCopy = shape.isComponentCopyInstance();
      } catch (e) {
        diagnostics.errors.push('shape "' + shape.name + '": ' + e.message);
        continue;
      }

      if (isMain) {
        diagnostics.mainInstances++;
        continue;
      }

      if (!isCopy) continue;
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
        index.byVariantContainer.get(lookupName) ||
        [];

      const status = matches.length === 1
        ? 'repairable'
        : matches.length > 1 ? 'ambiguous' : 'unresolved';

      shapeCache.set(shape.id, shape);
      items.push({
        id: shape.id,
        shapeName: shape.name,
        lookupName,
        variantProps: readVariantProps(shape, component),
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

// ---------------------------------------------------------------- variants
//
// Penpot names a variant component after its properties: "Size=Large, State=Hover".
// The container name (the thing a designer calls "Button") is the last segment
// of the component path.

function parseVariantProps(name) {
  const props = {};
  for (const part of String(name || '').split(',')) {
    const match = part.trim().match(/^([^=]+)=(.+)$/);
    if (match) props[match[1].trim()] = match[2].trim();
  }
  return Object.keys(props).length ? props : null;
}

function variantInfo(component) {
  try {
    if (!penpot.isVariantComponent || !penpot.isVariantComponent(component)) return null;
    return {
      id: component.variants ? component.variants.id : null,
      props: component.variantProps || parseVariantProps(component.name),
    };
  } catch (e) {
    return null;
  }
}

/** Every variant property with all values it can take, e.g. Type: [A, B, C, D]. */
function readVariantProperties(component) {
  try {
    const variants = component.variants;
    if (!variants) return null;

    const names = variants.properties || [];
    const properties = names.map(name => ({
      name,
      values: variants.currentValues(name) || [],
    }));
    return properties.length ? properties : null;
  } catch (e) {
    return null;
  }
}

function lastPathSegment(path) {
  const parts = String(path || '').split('/').filter(Boolean);
  return parts.length ? parts[parts.length - 1] : '';
}

/** The variant properties this copy had before it broke, if we can tell. */
function readVariantProps(shape, component) {
  if (component) {
    const info = variantInfo(component);
    if (info && info.props) return info.props;
  }
  return parseVariantProps(shape.name);
}

/**
 * Puts the copy back on the variant it was on. swapComponent lands on whichever
 * variant we matched, switchVariant walks it to the right one per property.
 */
function restoreVariant(shape, component, wanted) {
  if (!wanted || Object.keys(wanted).length === 0) return null;

  const info = variantInfo(component);
  if (!info) return null;

  let names = [];
  try {
    names = (component.variants && component.variants.properties) || [];
  } catch (e) {
    return null;
  }
  if (names.length === 0) return null;

  const current = info.props || {};
  const applied = [];
  const failed = [];

  for (const property of Object.keys(wanted)) {
    const pos = names.indexOf(property);
    if (pos < 0) {
      failed.push(property + ': onbekende variant-eigenschap');
      continue;
    }
    // Already on it after the swap, nothing to do.
    if (current[property] === wanted[property]) {
      applied.push(property + '=' + wanted[property]);
      continue;
    }

    try {
      shape.switchVariant(pos, wanted[property]);
      applied.push(property + '=' + wanted[property]);
    } catch (e) {
      failed.push(property + ': ' + e.message);
    }
  }

  return { applied, failed };
}

// ---------------------------------------------------------------- overrides
//
// A swap can rewrite the layer name and the size. Those belong to the user, not
// to the component, so they are put back. Fills and text are left to Penpot's
// own override preservation: with the old main component gone there is no way to
// tell an override apart from something that was simply inherited.

const CAPTURED = [
  'name', 'x', 'y', 'width', 'height', 'rotation', 'flipX', 'flipY',
  'hidden', 'blocked', 'proportionLock', 'constraintsHorizontal', 'constraintsVertical',
];

function captureShape(shape) {
  const props = {};
  for (const key of CAPTURED) {
    try {
      props[key] = shape[key];
    } catch (e) {
      // not readable on this shape type, skip it
    }
  }
  return props;
}

function restoreShape(shape, before) {
  const restored = [];
  const failed = [];

  const put = (key, apply) => {
    if (!(key in before)) return;
    try {
      if (apply(before[key])) restored.push(key);
    } catch (e) {
      failed.push(key + ': ' + e.message);
    }
  };

  // Size first: resizing can move things, position is corrected right after.
  if ('width' in before && 'height' in before) {
    try {
      if (shape.width !== before.width || shape.height !== before.height) {
        shape.resize(before.width, before.height);
        restored.push('size');
      }
    } catch (e) {
      failed.push('size: ' + e.message);
    }
  }

  put('x', value => shape.x !== value && ((shape.x = value), true));
  put('y', value => shape.y !== value && ((shape.y = value), true));
  put('name', value => shape.name !== value && ((shape.name = value), true));
  put('rotation', value => shape.rotation !== value && ((shape.rotation = value), true));
  put('flipX', value => shape.flipX !== value && ((shape.flipX = value), true));
  put('flipY', value => shape.flipY !== value && ((shape.flipY = value), true));
  put('hidden', value => shape.hidden !== value && ((shape.hidden = value), true));
  put('blocked', value => shape.blocked !== value && ((shape.blocked = value), true));
  put('proportionLock', value => shape.proportionLock !== value && ((shape.proportionLock = value), true));
  put('constraintsHorizontal', value => shape.constraintsHorizontal !== value && ((shape.constraintsHorizontal = value), true));
  put('constraintsVertical', value => shape.constraintsVertical !== value && ((shape.constraintsVertical = value), true));

  return { restored, failed };
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
  const details = [];
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
        // Everything the user owns is read before the swap and put back after,
        // because a swap rewrites the layer name and can resize the copy.
        const before = captureShape(shape);
        // What the user picked in the panel wins. Only when nothing was picked
        // do we fall back to what could be read off the broken copy.
        const chosenVariant = (request.variants || {})[shapeId];
        const wantedVariant = (chosenVariant && Object.keys(chosenVariant).length)
          ? chosenVariant
          : readVariantProps(shape, resolveComponent(shape));

        shape.swapComponent(component);

        const variant = restoreVariant(shape, component, wantedVariant);
        const shapeRestore = restoreShape(shape, before);

        fixed++;
        details.push({
          id: shapeId,
          name: before.name,
          restored: shapeRestore.restored,
          variant: variant ? variant.applied : [],
          failed: shapeRestore.failed.concat(variant ? variant.failed : []),
        });
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
    details,
    scan: scanPayload(request.scope),
  });
}

function selectShape(shapeId) {
  const shape = shapeCache.get(shapeId);
  if (!shape) return;

  penpot.selection = [shape];
  penpot.viewport.zoomIntoView([shape]);
}

penpot.ui.open('Broken Component Repair', `?theme=${penpot.theme}`, {
  width: 560,
  height: 700,
});

try {
  penpot.on('themechange', theme => {
    penpot.ui.sendMessage({ type: 'theme', theme });
  });
} catch (e) {
  // Older Penpot builds may not know this event. Not worth failing over.
}

/** Tells the UI the sandbox is alive and what this Penpot can do. */
function hello() {
  const probe = {
    currentPage: !!penpot.currentPage,
    currentFile: !!penpot.currentFile,
    pages: 0,
    localComponents: 0,
    connectedLibraries: 0,
    findShapes: false,
    isComponentCopyInstance: false,
    swapComponent: false,
    history: !!(penpot.history && typeof penpot.history.undoBlockBegin === 'function'),
  };
  const notes = [];

  try {
    probe.pages = penpot.currentFile ? penpot.currentFile.pages.length : 0;
  } catch (e) { notes.push('pages: ' + e.message); }

  try {
    probe.localComponents = penpot.library.local.components.length;
    probe.connectedLibraries = penpot.library.connected.length;
  } catch (e) { notes.push('library: ' + e.message); }

  try {
    const shapes = penpot.currentPage ? penpot.currentPage.findShapes() : [];
    probe.findShapes = true;
    const sample = shapes[0];
    if (sample) {
      probe.isComponentCopyInstance = typeof sample.isComponentCopyInstance === 'function';
      probe.swapComponent = typeof sample.swapComponent === 'function';
    }
  } catch (e) { notes.push('findShapes: ' + e.message); }

  penpot.ui.sendMessage({ type: 'hello', theme: penpot.theme, probe, notes });
}

penpot.ui.onMessage(msg => {
  try {
    if (!msg || !msg.type) return;

    if (msg.type === 'ready') {
      hello();
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
