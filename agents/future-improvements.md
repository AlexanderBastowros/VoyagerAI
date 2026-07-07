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

---

## Backlog (unscheduled)

### Security / permissions

#### 1. Bash sandboxing
- **Why:** `Bash` is auto-allowed by the permission policy because Claude must run Python to
  build models — but a shell command can read/write outside the project directory, so the
  "writes only inside the project folder" guarantee currently applies to the Write/Edit tools
  only. This is the biggest remaining trust gap.
- **Where:** `src/main/agent/permissions.ts` (`decideToolPermission`, has the v2 comment),
  `src/main/agent/session.ts` (canUseTool wiring).
- **Done-when:** shell commands are constrained to the project dir + managed python env
  (options: command classification with ask-fallback for anything touching paths outside the
  project; or an OS-level sandbox wrapper), with tests covering allowed (python/validator
  runs) and asked/denied (e.g. `rm -rf ~`, writes to $HOME) commands.

#### 2. "Always allow" on the approval card
- **Why:** the card currently offers Allow once / Deny; repeated legitimate out-of-policy
  actions (e.g. exporting to a chosen work folder) re-prompt every time. The SDK's
  `canUseTool` callback already receives `suggestions?: PermissionUpdate[]` for exactly this.
- **Where:** `src/main/agent/session.ts` (return `updatedPermissions` on allow),
  `src/shared/ipc.ts` + `src/renderer/src/components/ChatPanel.tsx` (third button),
  `src/main/ipc.ts` (`askUser` / respond handler carry the choice).
- **Done-when:** "Always allow" persists for the session (or project) and the same action no
  longer prompts; covered by a session test asserting `updatedPermissions` round-trip.

#### 3. TTL / cleanup for `pendingApprovals`
- **Why:** `src/main/ipc.ts` keeps unanswered approval resolvers in a Map forever; the
  session's own 120s race unblocks Claude, but a stale card answered later still returns
  `{acknowledged: true}` even though the decision no longer matters (flagged during the
  permission-fix implementation).
- **Where:** `src/main/ipc.ts` (`pendingApprovals`, `askUser`), optionally a
  `agent:permissionExpired` push so the renderer dismisses stale cards.
- **Done-when:** entries expire in lockstep with the session timeout, late responses get
  `{acknowledged: false}`, and the renderer auto-dismisses an expired card.

### Product / UX

#### 4. Persisted printer profile
- **Why:** the printable-cad skill (correctly) asks for nozzle diameter and bed size before
  every first model — but per app, not per conversation, this is stable hardware info. Asking
  once and injecting it would remove the most repetitive friction in the flow.
- **Where:** new settings storage in main (userData JSON, mirror `pyenv.json`'s marker
  pattern), surfaced in `src/main/agent/prompts.ts` (`systemPromptAppend`), small settings UI
  (toolbar or SetupScreen follow-on).
- **Done-when:** after the profile is saved, a new project's first prompt skips the
  nozzle/bed questions (Claude states the profile and proceeds); profile is editable.

#### 5. Parametric sliders bound to script constants
- **Why:** the generated scripts intentionally hoist all dimensions as named constants —
  a slider UI over those constants gives instant tweak-and-regenerate without a chat round.
- **Where:** parse constants from the latest `outputs/*_vN.py` (main process), new IPC +
  side-panel UI, regeneration path that runs the venv python directly (reuse
  `EnvManager.pythonPath()`), recording a new iteration via `ProjectStore`.
- **Done-when:** editing a constant regenerates and displays a new version without invoking
  Claude, and the change is recorded as a normal iteration.

#### 6. Print-bed overlay in the viewer
- **Why:** hobbyists sanity-check printability visually; a bed outline sized from the printer
  profile shows whether a part fits before slicing. (The axes gizmo, dimensions panel,
  section plane, measurement tool, and wireframe mode from the old "viewer upgrades" item have
  graduated to roadmap R5–R7.)
- **Where:** `src/renderer/src/three/viewer.ts` (new overlay module), sized from the persisted
  printer profile (item 4).
- **Done-when:** a print-bed overlay sized from the printer profile is drawn on the grid and
  updates when the profile changes.

#### 7. Selection v2
- **Why:** selection context is geometric metadata only; accuracy and expressiveness have
  known, documented limits.
- **Where:** `src/renderer/src/three/selection.ts` (centroid-in-rect, no back-face culling,
  simple-average centroid — all noted in its header), `SelectionHighlight` (single-region by
  design, extend rather than re-instantiate), `src/main/agent/prompts.ts` +
  `src/main/agent/session.ts` (the SDK accepts image content blocks for screenshot-in-prompt).
- **Done-when:** any subset of: viewport screenshot with highlighted selection attached to
  the refine prompt; multiple simultaneous selection regions; back-face culling and
  area-weighted centroid with updated tests.

### Platform / auth / packaging

#### 8. API-key auth mode
- **Why:** v1 is subscription-only via the Claude Code CLI login; an API key option serves
  users without a subscription (original plan's v2 item).
- **Where:** `src/main/agent/session.ts` (env/apiKey options on `query()`),
  `src/main/setup/claudeChecks.ts` + `preflight.ts` (auth check branches), SetupScreen UI for
  entering/storing the key (Keychain via Electron `safeStorage`).
- **Done-when:** user can pick subscription-CLI or API-key mode in setup; both pass
  preflight and complete a generation; key stored encrypted, never in plaintext config.

#### 9. Code signing, notarization, Windows/Linux builds
- **Why:** current macOS packaging is unsigned (`identity: null` — Gatekeeper right-click
  dance); `win`/`linux` targets exist in `electron-builder.yml` but are untested.
- **Where:** `electron-builder.yml`, `package.json` scripts, CI.
- **Done-when:** signed + notarized macOS dmg installs cleanly; Windows/Linux builds launch
  and pass the manual e2e script (each needs its own CLI-discovery + uv-path testing —
  `src/main/setup/claudeChecks.ts` and `src/main/python/envManager.ts` have the
  platform-specific branches).

#### 10. Verify the packaged .app on real macOS
- **Why:** the container build couldn't run electron-builder to completion (Electron binary
  download blocked), so the asarUnpack config for the Agent SDK's spawned CLI — the thing
  that only breaks in packaged builds — has never been exercised (README "Packaging" has the
  full checklist).
- **Where:** run `npm run package:mac` on a Mac; fixes, if any, land in
  `electron-builder.yml`.
- **Done-when:** packaged app passes setup checks and a full chat → model → export round
  trip; checklist removed from README or marked verified.

### Engineering health

#### 11. Renderer bundle chunking
- **Why:** the renderer builds as a single ~1.7 MB chunk (mostly three.js), flagged since M1.
- **Where:** `electron.vite.config.ts` (manualChunks / dynamic import of the viewer).
- **Done-when:** three.js splits into its own chunk and the build emits no size warnings.

#### 12. Component-level tests
- **Why:** vitest runs node-env only; ChatPanel/SetupScreen/Toolbar logic (approval card,
  disabled states, export buttons) is tested only via extracted pure functions.
- **Where:** `vitest.config.ts` (jsdom environment per-file), add `@testing-library/react`;
  start with ChatPanel (send flow, approval card) and SetupScreen (retry).
- **Done-when:** rendering tests cover the approval card and chat disabled-state derivations
  in the actual components.

#### 13. Automated UI / e2e harness
- **Why:** the end-to-end flow is verified by a manual script in the README; regressions in
  IPC wiring or the viewer only surface by hand.
- **Where:** Playwright (Chromium is fine for the renderer; Electron-level e2e via
  `playwright _electron` on a machine with the Electron binary), CI workflow.
- **Done-when:** CI runs at least a mocked-agent e2e (fake `queryFn` behind a test flag,
  scripted events → model renders → export path) on every push.
