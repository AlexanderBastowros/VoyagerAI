# Voyager AI

Voyager AI is an AI-first 3D modeling desktop app for 3D-printing hobbyists. You describe
the part you want in a chat panel; Claude asks the clarifying questions a good CAD
engineer would (printer nozzle, bed size, dimensions, tolerances), then writes a
parametric [build123d](https://github.com/gumyr/build123d) Python script and exports it
to STL/STEP. The STL renders live in a built-in three.js viewport - no slicer, no CAD
software, no separate viewer window required to see your part.

## Requirements

- **macOS** (packaging and testing currently target macOS first; see "Known limitations").
- **Node.js 22+** and npm.
- **Claude Code CLI** installed and signed in: `npm install -g @anthropic-ai/claude-code`,
  then run `claude` once and complete `/login` with your Claude account. Voyager AI runs
  on your **Claude subscription** through this CLI session - **no separate API key is
  needed**, and no API usage is billed.
- **Internet access** for the first run: Voyager AI provisions a managed Python
  environment (via `uv`, falling back to a system `python3 >= 3.10`) with build123d,
  trimesh, and numpy, which requires downloading packages once. After that first-run
  install, modeling itself works fully offline aside from the Claude API calls the CLI
  session makes.

## Getting started

```bash
npm install
npm run dev
```

On first launch, a **Setup** overlay walks through three checks - Claude CLI found,
signed in, and the Python environment ready - and provisions the Python environment
automatically if it's missing. This can take a few minutes the first time; subsequent
launches are instant. If a check fails, fix the underlying issue (e.g. run `claude` and
sign in) and press **Retry**.

## Using it

1. **Describe the part** in the chat panel - dimensions, purpose, any hardware it needs
   to fit. Claude will ask about your printer's nozzle diameter and bed size up front
   (these drive minimum wall thickness and the maximum part envelope), then close any
   remaining ambiguity (hole purpose, orientation, tolerances) before writing code.
2. **Confirm the design contract.** Claude restates the full spec as a compact table and
   asks for an explicit go-ahead before generating - this is the cheap moment to catch a
   misunderstanding.
3. **The model appears.** Claude generates the parametric script, exports STL + STEP,
   validates the mesh (watertight, fits the bed, overhang analysis), and displays it in
   the viewport automatically.
4. **Refine by region.** Toggle **Select region** in the toolbar, drag a marquee over
   part of the model, then describe the change ("make this hole 5mm") - the highlighted
   region's bounding box/centroid/size is sent to Claude alongside your message so it can
   identify which feature you mean. A new version is generated and displayed; nothing is
   overwritten (`part_v1`, `part_v2`, ... in the project's `outputs/` directory).
5. **Export STL/STEP** from the toolbar once a model is displayed, to save a copy
   anywhere on disk (e.g. to hand to a slicer). STEP is only available once the current
   iteration has one.

## How it works

- **Electron** shell: a main process (Node) and a renderer (Chromium) talking over a
  small typed IPC contract (`src/shared/ipc.ts`).
- **Claude Agent SDK** session, one per project, running the Claude Code CLI you already
  authenticated (`pathToClaudeCodeExecutable`) with its working directory set to the
  project folder.
- **Bundled `printable-cad` skill**, copied into each project's
  `.claude/skills/printable-cad/` so Claude always follows the same phased,
  design-for-FDM-printing workflow (nozzle/bed constraints, clarify-until-unambiguous,
  confirm-the-contract, generate, validate, display).
- **In-process MCP server** (`voyager`) exposing `display_model` and `set_status` tools
  Claude calls directly - no subprocess, no separate MCP transport. `display_model`
  validates the exported STL, records a versioned iteration in the project's
  `project.json`, and pushes the STL bytes to the renderer over IPC so the viewport
  updates immediately.
- **Managed Python environment**: a `uv`-provisioned (or `venv`-provisioned, as a
  fallback) virtualenv with `build123d`, `trimesh`, and `numpy`, whose `python` Claude
  invokes directly to run the generated script and the STL validator.

## Manual end-to-end test script

There's no automated UI test harness yet (no display in CI), so verify a real change by
hand with this flow - the box-with-holes example from the project plan:

1. Run `npm run dev` and wait for the Setup overlay to clear (all three checks ready).
2. In chat, type: `"I need a 40x20x15mm mounting box with two M3 clearance holes on the
   top face."`
3. When asked, answer **nozzle: 0.4mm**, **bed size: 256x256x256mm**.
4. Claude restates the design contract (dimensions, hole sizes/positions, DFM rules it
   will apply) - reply **"yes, generate it"**.
5. Confirm model **v1** renders in the viewport, and that the project's `outputs/`
   directory (under the app's userData/projects/default, printed in chat or found via
   your OS's Electron userData path) now has `..._v1.py`, `..._v1.stl`, `..._v1.step`,
   and that the chat shows the validator result as **PASS** (watertight, fits the bed).
6. Toggle **Select region**, drag a marquee over one of the two holes, then send
   `"make this hole 5mm"`.
7. Confirm model **v2** renders, and `outputs/` now also has `..._v2.py/.stl/.step`.
8. Click **Export STL** in the toolbar, save it somewhere, and open it in a slicer
   (e.g. PrusaSlicer/Cura) to confirm it's a valid, printable mesh with the resized hole.

## Packaging

```bash
npm run package:mac   # builds dmg + zip, both arm64 and x64
npm run package:dir   # unpacked app dir only - faster, useful for local testing
```

Both are **unsigned dev builds** (`identity: null` in `electron-builder.yml`) - macOS
Gatekeeper will require right-click > Open on first launch. Code signing and
notarization are v2 backlog (see below).

`npm run package:mac` **must be run on a real macOS machine** - it was not possible to
validate the packaged app in this development environment (no network access to
electron-builder's Electron binary mirror; download attempts return HTTP 403 through the
sandboxed proxy). Only the config itself was validated here (YAML parses, electron-builder
loads it and gets through dependency rebuild + packaging metadata before failing on the
Electron download). **Before shipping a build, a real Mac run should confirm:**

- The packaged `.app` launches and the Setup overlay's three checks all pass.
- A full chat -> model -> export round-trip works from the packaged app (not just `npm
  run dev`) - this specifically exercises the `asarUnpack` config below, since a packaged
  app is the only place the Claude Agent SDK's bundled-CLI spawn path can actually be
  exercised from inside `app.asar`.
- Export STL/STEP's native save dialog and file copy work from the packaged app's
  sandboxed file access.

## Known limitations / v2 backlog

- **Auth**: subscription-only via the Claude Code CLI (`claude login`). No API-key mode
  yet.
- **Single project**: no project browser or multi-project switching - one implicit
  "default" project per machine.
- **Unsigned builds**: no code signing or notarization; Gatekeeper right-click-to-open
  required on macOS.
- **No parametric sliders UI**: refining a dimension is done through chat / region
  selection, not a live numeric slider bound to the script's named constants.
- **macOS only**: no Windows or Linux packaged builds yet (the win/nsis and
  linux/AppImage electron-builder targets exist but are untested and out of scope for
  this milestone).
- **No screenshot-in-prompt for selections**: region selection sends geometric metadata
  (bounding box, centroid, size, triangle count), not a rendered image of the selection,
  to Claude.
