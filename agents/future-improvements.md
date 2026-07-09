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
> R5 (orientation axes + dimensions panel — `ModelViewer.setAxesVisible`/`getDimensions` in
> `viewer.ts`, `showAxes` toggle + dimensions chip in `ViewportControls.tsx`), R6
> (point-to-point measurement — `src/renderer/src/three/measurement.ts` (raycasting math +
> `MeasurementOverlay`) and `measurementController.ts` (DOM glue, mirrors
> `selectionController.ts`), `ModelViewer.setMeasurementObject`, `measureMode`/`measurement` in
> `appStore.ts`, a Measure toggle + distance chip in `ViewportControls.tsx`), and R7 (wireframe
> view mode — `ModelViewer.setWireframe` applied on load and persisted across model swaps,
> `wireframe` toggle in `appStore.ts`/`ViewportControls.tsx`) have also landed. `ProjectSidebar.tsx`
> and `Toolbar.tsx` were removed in a later refactor; the viewer toolbar now lives in
> `ViewportControls.tsx` and the project switcher in `ProjectsDrawer.tsx`. R4 (STL version history
> with revert — an explicit `activeIteration` pointer on `ProjectRecord` in `store.ts`, rather than
> always assuming the latest iteration; `revertTo`/`listIterations`/`activeIterationRecord` on
> `ProjectStore`; `project:listIterations`/`project:revertTo` IPC returning the renderer-safe
> `IterationInfo` shape and a full `ProjectStateSnapshot`; `iterations`/`activeIteration` state in
> `appStore.ts`; a version-history list under the project list in `ProjectsDrawer.tsx` with the
> current version highlighted) has also landed — no STL is ever deleted, and `model:export`
> resolves the active iteration rather than always the latest. Print settings recommendation —
> `recommend_print_settings` MCP tool in `mcpTools.ts`, `PrintSettings` + `printSettings:updated`
> IPC, on-demand via a button in the new `PrintSettingsPanel.tsx` (collapsible, above the chat),
> settings tagged to the active iteration and cleared on model change. ViewCube orientation
> gizmo — `src/renderer/src/three/viewCube.ts` (pure `regionFromHitPoint`/`upForDirection` +
> `ViewCubeGizmo` overlay), `ModelViewer.setViewDirection` animated snap, top-right corner of
> the viewport; click faces/edges/corners to snap the camera, and it tracks orbit.

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