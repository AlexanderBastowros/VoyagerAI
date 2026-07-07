# Voyager AI — Future Improvements (agent backlog)

This is the agent-facing improvement backlog for Voyager AI. Items were collected from the
MVP build-out: the README's "Known limitations / v2 backlog", TODO-style code comments, and
the milestone implementation reports. Each item is written as a self-contained work order:
**why** it matters, **where** the relevant code lives, and **done-when** acceptance criteria.

Working conventions for any agent picking up an item:

- The typed IPC contract lives in `src/shared/ipc.ts`; extend it (plus `src/preload/api.ts`
  and `src/preload/index.ts`) rather than adding ad-hoc channels.
- Main-process modules take injected paths/spawners so they stay unit-testable without
  Electron (see `EnvManager`, `ProjectStore`, `AgentSession`, `ClaudeChecker` for the pattern).
- Quality gate before any commit: `npm run typecheck && npm run build && npm test` — all green.
- Keep this file updated: check an item off (or delete it) in the same commit that lands it.

---

## Security / permissions

### 1. Bash sandboxing
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

### 2. "Always allow" on the approval card
- **Why:** the card currently offers Allow once / Deny; repeated legitimate out-of-policy
  actions (e.g. exporting to a chosen work folder) re-prompt every time. The SDK's
  `canUseTool` callback already receives `suggestions?: PermissionUpdate[]` for exactly this.
- **Where:** `src/main/agent/session.ts` (return `updatedPermissions` on allow),
  `src/shared/ipc.ts` + `src/renderer/src/components/ChatPanel.tsx` (third button),
  `src/main/ipc.ts` (`askUser` / respond handler carry the choice).
- **Done-when:** "Always allow" persists for the session (or project) and the same action no
  longer prompts; covered by a session test asserting `updatedPermissions` round-trip.

### 3. TTL / cleanup for `pendingApprovals`
- **Why:** `src/main/ipc.ts` keeps unanswered approval resolvers in a Map forever; the
  session's own 120s race unblocks Claude, but a stale card answered later still returns
  `{acknowledged: true}` even though the decision no longer matters (flagged during the
  permission-fix implementation).
- **Where:** `src/main/ipc.ts` (`pendingApprovals`, `askUser`), optionally a
  `agent:permissionExpired` push so the renderer dismisses stale cards.
- **Done-when:** entries expire in lockstep with the session timeout, late responses get
  `{acknowledged: false}`, and the renderer auto-dismisses an expired card.

## Product / UX

### 4. Persisted printer profile
- **Why:** the printable-cad skill (correctly) asks for nozzle diameter and bed size before
  every first model — but per app, not per conversation, this is stable hardware info. Asking
  once and injecting it would remove the most repetitive friction in the flow.
- **Where:** new settings storage in main (userData JSON, mirror `pyenv.json`'s marker
  pattern), surfaced in `src/main/agent/prompts.ts` (`systemPromptAppend`), small settings UI
  (toolbar or SetupScreen follow-on).
- **Done-when:** after the profile is saved, a new project's first prompt skips the
  nozzle/bed questions (Claude states the profile and proceeds); profile is editable.

### 5. Chat transcript persistence + rehydration
- **Why:** the SDK session resumes across app restarts (sessionId in `project.json`), but the
  chat panel starts empty — the user loses the visible conversation even though Claude still
  has it.
- **Where:** `src/main/projects/store.ts` (persist messages alongside iterations),
  `src/renderer/src/state/appStore.ts` (hydrate), possibly a `project:getState` IPC channel;
  on rehydrate also reload the latest iteration's STL into the viewport.
- **Done-when:** quit + relaunch shows the prior conversation and the latest model, and a
  follow-up refinement works against the resumed session.

### 6. Stop / cancel an in-flight turn
- **Why:** a long generation can't be interrupted; the input is locked until
  message-complete. The SDK's `Query` supports interruption.
- **Where:** `src/main/agent/session.ts` (expose `interrupt()`), new IPC channel, a Stop
  button in `ChatPanel.tsx` shown while `agentBusy`.
- **Done-when:** clicking Stop ends the turn promptly, chat shows a "stopped" status, and the
  next message works normally.

### 7. Project browser / multi-project
- **Why:** MVP hard-codes a single `'default'` project (documented in
  `src/main/projects/store.ts`); users will want separate parts with separate histories.
- **Where:** `ProjectStore` (real ids, active-project pointer), `AgentSession` (one session
  per project), renderer project list/switcher UI.
- **Done-when:** create/switch/rename projects; each keeps its own chat, iterations, and
  resumable session; existing `'default'` data migrates.

### 8. Parametric sliders bound to script constants
- **Why:** the generated scripts intentionally hoist all dimensions as named constants —
  a slider UI over those constants gives instant tweak-and-regenerate without a chat round.
- **Where:** parse constants from the latest `outputs/*_vN.py` (main process), new IPC +
  side-panel UI, regeneration path that runs the venv python directly (reuse
  `EnvManager.pythonPath()`), recording a new iteration via `ProjectStore`.
- **Done-when:** editing a constant regenerates and displays a new version without invoking
  Claude, and the change is recorded as a normal iteration.

### 9. Viewer upgrades
- **Why:** hobbyists sanity-check printability visually; the viewer is currently
  orbit/zoom only.
- **Where:** `src/renderer/src/three/viewer.ts` (+ new modules per feature).
- **Done-when (incremental, any subset):** print-bed overlay sized from the printer profile;
  point-to-point measurement tool; section/clipping plane view; orientation axes gizmo.

### 10. Selection v2
- **Why:** selection context is geometric metadata only; accuracy and expressiveness have
  known, documented limits.
- **Where:** `src/renderer/src/three/selection.ts` (centroid-in-rect, no back-face culling,
  simple-average centroid — all noted in its header), `SelectionHighlight` (single-region by
  design, extend rather than re-instantiate), `src/main/agent/prompts.ts` +
  `src/main/agent/session.ts` (the SDK accepts image content blocks for screenshot-in-prompt).
- **Done-when:** any subset of: viewport screenshot with highlighted selection attached to
  the refine prompt; multiple simultaneous selection regions; back-face culling and
  area-weighted centroid with updated tests.

## Platform / auth / packaging

### 11. API-key auth mode
- **Why:** v1 is subscription-only via the Claude Code CLI login; an API key option serves
  users without a subscription (original plan's v2 item).
- **Where:** `src/main/agent/session.ts` (env/apiKey options on `query()`),
  `src/main/setup/claudeChecks.ts` + `preflight.ts` (auth check branches), SetupScreen UI for
  entering/storing the key (Keychain via Electron `safeStorage`).
- **Done-when:** user can pick subscription-CLI or API-key mode in setup; both pass
  preflight and complete a generation; key stored encrypted, never in plaintext config.

### 12. Code signing, notarization, Windows/Linux builds
- **Why:** current macOS packaging is unsigned (`identity: null` — Gatekeeper right-click
  dance); `win`/`linux` targets exist in `electron-builder.yml` but are untested.
- **Where:** `electron-builder.yml`, `package.json` scripts, CI.
- **Done-when:** signed + notarized macOS dmg installs cleanly; Windows/Linux builds launch
  and pass the manual e2e script (each needs its own CLI-discovery + uv-path testing —
  `src/main/setup/claudeChecks.ts` and `src/main/python/envManager.ts` have the
  platform-specific branches).

### 13. Verify the packaged .app on real macOS
- **Why:** the container build couldn't run electron-builder to completion (Electron binary
  download blocked), so the asarUnpack config for the Agent SDK's spawned CLI — the thing
  that only breaks in packaged builds — has never been exercised (README "Packaging" has the
  full checklist).
- **Where:** run `npm run package:mac` on a Mac; fixes, if any, land in
  `electron-builder.yml`.
- **Done-when:** packaged app passes setup checks and a full chat → model → export round
  trip; checklist removed from README or marked verified.

## Engineering health

### 14. Renderer bundle chunking
- **Why:** the renderer builds as a single ~1.7 MB chunk (mostly three.js), flagged since M1.
- **Where:** `electron.vite.config.ts` (manualChunks / dynamic import of the viewer).
- **Done-when:** three.js splits into its own chunk and the build emits no size warnings.

### 15. Component-level tests
- **Why:** vitest runs node-env only; ChatPanel/SetupScreen/Toolbar logic (approval card,
  disabled states, export buttons) is tested only via extracted pure functions.
- **Where:** `vitest.config.ts` (jsdom environment per-file), add `@testing-library/react`;
  start with ChatPanel (send flow, approval card) and SetupScreen (retry).
- **Done-when:** rendering tests cover the approval card and chat disabled-state derivations
  in the actual components.

### 16. Automated UI / e2e harness
- **Why:** the end-to-end flow is verified by a manual script in the README; regressions in
  IPC wiring or the viewer only surface by hand.
- **Where:** Playwright (Chromium is fine for the renderer; Electron-level e2e via
  `playwright _electron` on a machine with the Electron binary), CI workflow.
- **Done-when:** CI runs at least a mocked-agent e2e (fake `queryFn` behind a test flag,
  scripted events → model renders → export path) on every push.
