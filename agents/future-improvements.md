# Voyager AI — Future Improvements (agent backlog)

This is the agent-facing improvement backlog for Voyager AI. Items were collected from the
MVP build-out: the README's "Known limitations / v2 backlog", TODO-style code comments, and
the milestone implementation reports. Each item is written as a self-contained work order:
**why** it matters, **where** the relevant code lives, and **done-when** acceptance criteria.

The **Current product roadmap** section below is the active, prioritized queue — work those
items top-to-bottom. Everything under **Backlog** is unscheduled and picked up as capacity
allows.

Working conventions for any agent picking up an item:

- The typed IPC contract lives in `src/shared/ipc.ts`; extend it (plus `src/preload/api.ts`
  and `src/preload/index.ts`) rather than adding ad-hoc channels.
- Main-process modules take injected paths/spawners so they stay unit-testable without
  Electron (see `EnvManager`, `ProjectStore`, `AgentSession`, `ClaudeChecker` for the pattern).
- Quality gate before any commit: `npm run typecheck && npm run build && npm test` — all green.
- Keep this file updated: check an item off (or delete it) in the same commit that lands it.

---

## Current product roadmap (prioritized)

The near-term priorities, in order. Each is a self-contained work order.

### R1. Render markdown in the chat transcript
- **Why:** assistant replies come back as markdown (bold, headings, bulleted/numbered lists,
  tables, inline + fenced code), but the chat renders the raw string, so `**bold**` shows
  literally and tables render as unreadable pipe soup. This is the most visible polish gap in
  the app.
- **Where:** `src/renderer/src/components/ChatPanel.tsx` — the `chat-message-text` div
  currently renders `{message.text}` verbatim (plus the streaming cursor `|`); swap in a
  markdown renderer. No markdown dependency exists in `package.json` yet — add a lightweight,
  sanitized one (e.g. `react-markdown` + `remark-gfm` for GitHub-flavored tables/strikethrough),
  and render **HTML-sanitized** output only (never `dangerouslySetInnerHTML` on model text).
  Add table/code/list styling in `src/renderer/src/styles.css`. Must degrade gracefully on the
  partial markdown that arrives mid-stream (unterminated `**`, half-written table) and keep the
  streaming cursor working.
- **Done-when:** bold/italic/headings/lists/tables/inline + fenced code all render correctly
  for both completed and mid-stream assistant messages; no literal `**`/`|` artifacts; code
  blocks are monospaced and scroll rather than overflow; raw HTML in model output is neutralized.

### R2. Stop / cancel an in-flight turn
- **Why:** a long generation can't be interrupted; the input stays locked (`agentBusy`) until
  message-complete. The SDK's `Query` exposes `interrupt()`.
- **Where:** `src/main/agent/session.ts` — add an `interrupt()` that calls
  `this.activeQuery?.interrupt()` and clears `busy`; new `agent:interrupt` channel in
  `src/shared/ipc.ts` wired through `src/main/ipc.ts`, `src/preload/api.ts` (`agent.interrupt`),
  and `src/preload/index.ts`; a **Stop** button in `ChatPanel.tsx` shown in place of/next to
  **Send** while `agentBusy`; a "stopped" `system-status` line and `agentBusy` cleared in
  `src/renderer/src/state/appStore.ts`.
- **Done-when:** clicking Stop ends the turn promptly, the chat shows a "stopped" status, the
  input re-enables, and the next message works normally against the resumed session; covered by
  a session test asserting `interrupt()` is invoked and `busy` resets.

### R3. Multiple models, each in its own chat (project switcher)
- **Why:** the MVP hard-codes a single `'default'` project (documented in
  `src/main/projects/store.ts`), so there is exactly one chat and one model. Users want several
  parts, each with its own conversation, model, and history — displayed in a **right-hand menu**,
  with the **chat moved to the left**. Includes **R3.1: persist each chat and its STLs to disk**
  so switching and relaunching restore the full conversation and model (today the SDK session
  resumes via `sessionId` in `project.json`, but the chat panel starts empty and the transcript
  is lost).
- **Where:**
  - Main — `src/main/projects/store.ts`: replace the fixed `activeProjectId = 'default'` with
    real ids + an active-project pointer file; add list/create/rename/switch; persist the chat
    transcript alongside iterations (extend `ProjectRecord` with a `messages` array — STLs are
    already saved as `outputs/*_vN.stl` by `recordIteration`, so persisting the transcript and
    isolating projects is the actual gap); migrate the existing `default` data. `AgentSession`
    (`src/main/agent/session.ts`): one session per project (or re-`ensureStarted` on switch with
    that project's `resume` id + `cwd`).
  - IPC — new `project:*` channels in `src/shared/ipc.ts` (`list`/`create`/`switch`/`rename`
    plus `project:getState` to hydrate messages + latest STL), wired via `src/main/ipc.ts` and
    `src/preload/api.ts`.
  - Renderer — `src/renderer/src/App.tsx` layout: move `ChatPanel` to the left column and add a
    right-hand projects sidebar; `src/renderer/src/state/appStore.ts` gains active-project state
    and per-project messages with hydrate-on-switch; `src/renderer/src/styles.css` for the new
    three-column shell.
- **Done-when:** create/switch/rename projects from the right-hand menu; each keeps its own
  chat, iterations, resumable session, and STLs; switching swaps both the chat and the viewport;
  quit + relaunch restores the last active project's conversation and latest model; existing
  `default` data migrates cleanly.

### R4. STL version history with revert
- **Why:** every `display_model` call already writes a versioned STL and records a
  `ProjectIteration` (`src/main/projects/store.ts` `recordIteration`, `outputs/*_vN.stl`), but
  there is no way to browse past versions or roll back — the viewport only ever shows the latest.
  Users want to revert to a previous state.
- **Where:** new `project:listIterations` / `project:revertTo` IPC (read `ProjectRecord.iterations`,
  load a chosen iteration's `stlPath` into the viewport through the existing
  `model:displayed` / `setModel` path); a version-history list in the UI (right-hand panel under
  the active project, or a viewport strip); reverting sets the active model and marks it current
  so a follow-up refinement branches from the reverted state — `AgentSession` must know which
  version is active (add an `activeIteration` pointer in `store.ts` rather than assuming
  `latestIteration`). Touches `store.ts`, `src/renderer/src/state/appStore.ts` (`ModelInfo`),
  and a new history component / `Toolbar.tsx`.
- **Done-when:** the user sees the list of generated versions with summaries + timestamps;
  clicking one loads that STL into the viewport; continuing the chat refines from the reverted
  version; no STL is deleted (old versions stay on disk and remain reachable).

### R5. Orientation axes + model dimensions panel
- **Why:** hobbyists need to read orientation and overall size at a glance; the viewer is
  orbit/zoom over a plain grid with no axes indicator and no dimension readout.
- **Where:** `src/renderer/src/three/viewer.ts` — add an XYZ axes gizmo (e.g. a corner
  `AxesHelper`/overlay) alongside `createGrid()`; compute `geometry.boundingBox` in `loadSTL`
  and expose the bounding-box size (X/Y/Z in mm); optional section/clipping-plane view via the
  renderer/material `clippingPlanes`. Surface the dimensions in a small panel —
  `src/renderer/src/components/Viewport.tsx` / `Toolbar.tsx` + `appStore.ts` `ModelInfo`
  (add `dims`), styled in `styles.css`.
- **Done-when:** an XYZ axes indicator is visible and tracks orbit; a dimensions readout shows
  the current model's bounding-box X/Y/Z in mm and updates on every new/reverted model;
  (optional) a section-plane toggle cuts through the model.

### R6. Point-to-point measurement tool
- **Why:** users sanity-check printability by measuring features; there's no way to measure the
  distance between two points on the model.
- **Where:** `src/renderer/src/three/viewer.ts` plus a new measurement module that reuses the
  raycasting/picking pattern in `src/renderer/src/three/selectionController.ts`; the user clicks
  two points on the mesh surface and the tool draws a line + a distance label (mm), overlaid via
  the `setHighlightObject` attach pattern or a dedicated overlay object. Toggle in `Toolbar.tsx`
  (mirrors the existing "Select region" toggle), with state in `appStore.ts`.
- **Done-when:** enabling the tool lets the user click two surface points and see the
  straight-line distance in mm with a visible measurement line; clearing/toggling removes it;
  orbit still works while the tool is active.

### R7. Wireframe view mode
- **Why:** wireframe exposes topology and faceting that a shaded surface hides — handy for
  spotting non-manifold edges or over/under-tessellation before printing.
- **Where:** `src/renderer/src/three/viewer.ts` — a `setWireframe(enabled)` that toggles
  `material.wireframe` on the current mesh and applies to any model loaded while the mode is on;
  a Wireframe toggle in `Toolbar.tsx` with state in `appStore.ts`.
- **Done-when:** a Wireframe toggle switches the displayed model between shaded and wireframe
  without reloading, and the setting persists across model swaps within the session.

### R8. Model selector + effort selector
- **Why:** the SDK options are hard-coded — `effort: 'xhigh'` and the default (Opus) model in
  `src/main/agent/session.ts`'s `ensureStarted`. Users should be able to trade speed vs. depth
  (pick a faster/cheaper model, or lower effort for quick tweaks) without editing code.
- **Where:** `src/main/agent/session.ts` — surface `model` and `effort` on the `query()`
  `Options` (both already accepted there; `effort` is set to `'xhigh'` today, `model` is unset →
  defaults to Opus); pass the current choices into `ensureStarted` and apply them on the next
  turn (a new session/`resume` may be needed to change model mid-conversation). New IPC to set
  the choices (or fold into the `project:*` state so each project remembers its model/effort),
  wired via `src/shared/ipc.ts`, `src/main/ipc.ts`, `src/preload/api.ts`. Two dropdowns in the
  UI — `Toolbar.tsx` or a chat header — backed by `src/renderer/src/state/appStore.ts`.
- **Done-when:** the user picks a model and an effort level from the UI; subsequent turns run
  with those settings; the selection persists (per project, or app-wide) across relaunch; the
  default remains today's Opus + `xhigh` behavior when untouched.