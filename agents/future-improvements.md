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

> **Done:** R1 (markdown chat rendering — `Markdown.tsx` via `react-markdown` + `remark-gfm`,
> raw HTML neutralized, mid-stream-safe) and R2 (stop/cancel — `AgentSession.interrupt()`, a
> `stopped` terminal `AgentEvent`, `agent:interrupt` IPC, Stop button in `ChatPanel.tsx`)
> landed together, plus a persona rebrand of user-visible "Claude" strings to "Voyager"
> (setup/CLI-dependency strings intentionally still say Claude). R9 (image attachment support —
> `ChatAttachment` in `src/shared/ipc.ts`, paperclip-icon attach button + paste/drag-and-drop in
> `ChatPanel.tsx`, `buildUserMessage` in `prompts.ts` builds image content blocks) also landed;
> attachments show as `📎 filename` chips rather than thumbnails. R8 (model + effort selectors —
> two dropdowns in `ChatPanel.tsx`'s header, `AgentSettings` persisted per project in
> `store.ts`/`session.ts`, applied on the next turn) landed too. R3 (multi-project switcher —
> `ProjectStore` manifest + list/create/switch/rename in `src/main/projects/store.ts`, a
> right-hand `ProjectSidebar.tsx`, and R3.1's chat-transcript persistence via
> `AgentSession.flushAssistantBuffer`/`appendMessage`) has also landed; a pre-R3 single-project
> install migrates automatically (its `default` project is discovered, not recreated).

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

---

## Possible ideas

Unscheduled, less-defined ideas — bigger architectural bets than the roadmap items above, worth
scoping properly before committing to a design.

- **Anthropic API key as an alternative to the CLI.** Today the app depends on the Claude CLI
  being installed and on the machine's own auth (`ClaudeChecker` in
  `src/main/setup/claudeChecks.ts`, `cliPath` threaded into `session.ts`). Let the user choose,
  as a setting, between "use the Claude CLI" (current behavior) and "use an Anthropic API key"
  entered directly in the app — the SDK's `query()` can likely be pointed at an API key instead
  of a CLI binary. Needs a settings surface for entering/storing the key (securely — not plain
  JSON) and a code path in `session.ts` that skips the CLI preflight when a key is configured.
- **Support for other LLM APIs and Ollama.** Beyond Anthropic, let users plug in other providers
  (OpenAI, Gemini, etc.) or a local Ollama endpoint. This is a bigger bet than it sounds since
  the whole agent loop (`src/main/agent/session.ts`) is built around the Claude Agent SDK's tool
  calling, permission model, and streaming events — a different provider likely means either an
  adapter layer that normalizes to the SDK's event shape, or accepting reduced functionality
  (no custom tools/MCP) for non-Anthropic providers. Worth a design spike before implementation.