# Penpot Broken Component Repair

Finds component copies whose library link is broken and relinks them to a
same-named component from the local library or a connected library, using
Penpot's own component swap so overrides survive where Penpot can keep them.

## What it does

1. Walks every page of the current file (or only the current page) with `Page.findShapes()`.
2. Flags a shape as broken when `isComponentCopyInstance()` is true and either
   `component()` cannot be read, or it resolves to a component that no longer
   exists in the local or any connected library.
3. Indexes every component in the local and connected libraries by full path
   (`Icons/Search`) and by bare name (`Search`).
4. Looks the broken copy up by the dangling component's own name when that can
   still be read, and by the layer name otherwise.
5. Preselects a match only when exactly one exists. Two matches means you pick
   the library yourself in a dropdown.
6. Repairs with `Shape.swapComponent(component)`, wrapped in a single
   `penpot.history` undo block, so one undo reverts the whole batch.

Clicking a result name selects that shape on the canvas and zooms to it.

## Install locally

```bash
npm install
npm start          # builds to dist/ and serves it on port 7782
```

Then in Penpot's plugin manager install:

```
http://localhost:7782/manifest.json
```

While developing, run the build in watch mode next to the server:

```bash
npm run watch      # terminal 1
npm run serve      # terminal 2
```

For a hosted deployment, change `host` in `public/manifest.json` to the public
origin and serve `dist/`.

## Checks

```bash
npm run typecheck  # tsc against @penpot/plugin-types
npm test           # runs dist/plugin.js against a fake Penpot API
```

`test/mock-run.mjs` loads the built sandbox bundle with a `penpot` global that
mimics the real API: three libraries, two pages, healthy copies, main
instances, a copy whose `component()` throws, a copy that returns null, a copy
pointing at a removed library, and a swap that fails. It asserts the detection,
the ambiguity rule, the undo block and the swap calls. Run `npm run build`
first, since it tests the bundle rather than the sources.

## Known limitation

The Plugin API has no `isBroken` flag on a shape. Broken is therefore inferred
from `isComponentCopyInstance()` plus an unresolvable or unknown `component()`.
That inference is covered by the mock test, but the exact behaviour of a real
broken link depends on the Penpot version and how the link broke, so verify
against a real file before trusting a bulk repair. The scan diagnostics panel
exists for this: it shows how many shapes and component copies were inspected,
so you can tell "nothing is broken" apart from "nothing was detected".

Repairs on pages other than the current one rely on `swapComponent()` working
off-page. If that ever fails, the failure is reported per shape rather than
swallowed, and switching to the page and rescanning is the workaround.

## Layout

```
index.html            plugin UI (iframe)
src/plugin.ts         sandbox code, becomes dist/plugin.js
src/ui.ts             iframe logic
public/manifest.json  Penpot plugin manifest
public/icon.svg       plugin icon
serve.py              static server for dist/ with CORS headers
test/mock-run.mjs     mock Penpot API harness
```

Penpot messaging note: the sandbox and the iframe exchange plain objects.
Post the message itself and read `event.data`. The Figma-style
`{ pluginMessage: ... }` wrapper does not work here.
