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
7. Puts the copy back on the variant it was on with `switchVariant()`, and
   restores what the swap overwrote.

## What survives a repair

A swap rewrites the layer name and can resize the copy, so everything that
belongs to the user rather than to the component is read before the swap and
put back after:

- the layer name
- position and size
- rotation, flips, constraints, visibility, lock, proportion lock
- the variant it was on, per variant property

Variant components are named after their properties (`Size=Large, State=Hover`),
so a variant container is indexed once under its container name instead of once
per variant. Otherwise every `Button` would come back as ambiguous. The exact
variant is restored afterwards.

Fills, strokes and text are left to Penpot's own override preservation. With the
old main component gone there is no way to tell an override apart from something
that was simply inherited, so forcing them back would make the relink pointless.

The panel lists per repaired copy what was preserved, and says so when something
could not be put back.

Clicking a result name selects that shape on the canvas and zooms to it.

## Run locally

No build step, no dependencies. Python is enough:

```bash
git clone https://github.com/bold700/penpot-broken-component-repair.git
cd penpot-broken-component-repair
python3 serve.py
```

Add to Penpot via `http://localhost:7782/manifest.json`.

## Hosting it

`manifest.json` carries a `host` field, the same pattern as the other plugins in
this account. Upload these four files to a web host:

```
manifest.json
plugin.js
index.html
icon.svg
```

Then set `host` in the uploaded `manifest.json` to that origin, and install
`https://your-host/path/manifest.json`. The host has to send
`Access-Control-Allow-Origin: *` (or the Penpot origin), which is what
`serve.py` does locally.

## Checks

```bash
npm test   # or: node test/mock-run.mjs
```

`test/mock-run.mjs` loads `plugin.js` with a fake `penpot` global that mimics
the real API: three libraries, two pages, healthy copies, main instances, a copy
whose `component()` throws, a copy that returns null, a copy pointing at a
removed library, and a swap that fails. It asserts the detection, the ambiguity
rule, the undo block and the swap calls. Node only, nothing to install.

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
manifest.json      Penpot plugin manifest
plugin.js          sandbox code
index.html         plugin UI, logic inlined
icon.svg           plugin icon
serve.py           static server with CORS headers
test/mock-run.mjs  mock Penpot API harness
```

Penpot messaging note: the sandbox and the iframe exchange plain objects.
Post the message itself and read `event.data`. The Figma-style
`{ pluginMessage: ... }` wrapper does not work here.
