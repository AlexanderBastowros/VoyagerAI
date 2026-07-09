# Voyager AI — Production Roadmap (multi-agent work orders)

This is the **active work queue** for productionizing Voyager per the two design docs:
[`docs/PRODUCT_DESIGN.md`](../docs/PRODUCT_DESIGN.md) and
[`docs/TECHNICAL_ARCHITECTURE.md`](../docs/TECHNICAL_ARCHITECTURE.md). It is written so that
**multiple Claude agents can work on it in tandem** — each work order is self-contained
(why / scope / done-when), declares the files it owns, and has an explicit dependency gate.
The human maintainer is the dispatcher: they assign a work order to an agent session; the
roadmap is the shared brain.

**Backend sequencing (decided 2026-07):** everything in the CLI phase below runs on
**Mode A — the Claude CLI / Agent SDK on the maintainer's existing Claude subscription**, at
zero marginal inference cost. Bedrock/AWS (Mode B, architecture doc §§1–4) is adopted **on
trigger, not on schedule**. The triggers, in order of likelihood:

1. **First external user** — the hard trigger. A personal Claude subscription cannot serve
   other people's inference; the moment a design partner or beta user runs a design, Mode B
   (or at minimum API-key mode) is mandatory.
2. Need for the **multi-model verification layers** (independent vision critic,
   cross-family code review) — CLI mode covers designer self-inspection only.
3. A hosted **web client / cloud projects**.

Optional middle rung before full AWS: **Anthropic API-key mode** (pay-as-you-go, no AWS
infra) — useful for measuring real per-design token cost; tracked in
[`future-improvements.md`](./future-improvements.md).

---

## Ground rules for every agent

1. **Work one work order at a time, on its own branch:** `claude/<ws-id>-<slug>`
   (e.g. `claude/ws-b-param-panel`).
2. **Quality gate before any commit:** `npm run typecheck && npm run build && npm test` —
   all green. New code follows the repo's injected-dependencies pattern so it's
   unit-testable without Electron (see `AgentSession`, `ProjectStore`, `EnvManager`).
3. **Touch only the files your work order owns** (each work order lists them). If you need
   a change in a file another workstream owns, or in any shared contract, **stop and leave
   a note in the "Contract change requests" section at the bottom of this file** instead of
   editing it — the dispatcher routes it through WS-0b.
4. **Shared contracts are frozen** once WS-0b lands: everything under `src/shared/`, the
   preload API, `src/main/ipc.ts` channel wiring, `appStore` state slices, and panel mount
   points in `App.tsx`. Feature streams *consume* contracts and add their *own new files*.
5. **Update this file in the same commit that finishes a work order:** flip its Status,
   add one line saying what landed and where. Do not restructure other work orders.
6. **Never invent geometry/DFM numbers** — thresholds come from
   `resources/skills/printable-cad/references/design-for-printing.md`, the single source of
   truth for both generation and verification.

---

## Dependency graph

```
WS-0a (extract agent-core)          ── single agent, everything else waits
   └─► WS-0b (shared contracts + integration stubs)   ── single agent
          ├─► WS-A  Design Brief system        ┐
          ├─► WS-B  PARAMS + parameter panel   │
          ├─► WS-C  Verification layers 1–3    ├─ parallel, disjoint file footprints
          ├─► WS-D  Render rig + self-inspect  │
          ├─► WS-E  Printer profiles           │
          └─► WS-F  Graduation package export  ┘
                     └─► M1 integration pass (dispatcher-led)
M2+ (Bedrock, multi-model, plugins) — sketched only; decomposed when a trigger fires.
```

Notes on the two gates:
- **WS-0a is deliberately single-agent** — it moves most of `src/main/**`, so parallel work
  during it guarantees conflicts.
- **WS-0b exists so the parallel streams never touch the same file.** It pre-lands the
  schemas, IPC channels/events, preload methods, `appStore` slices, panel mount stubs, and
  a per-file MCP **tool registry** (splitting today's single `mcpTools.ts` so each stream
  adds its own tool file).

---

## Work orders — CLI phase (M0–M1)

### WS-0a — Extract `agent-core` and `verify` packages (M0) · **Status: DONE** · gate, single agent

- **Landed:** `packages/agent-core` (session/prompts/permissions/mcpTools/paths, projects, python,
  setup - moved verbatim as an npm workspace, `@voyager/agent-core` barrel at `src/index.ts`) and
  `packages/verify` (`python/validate_stl.py` + a thin injectable-exec TS wrapper,
  `validateStl.ts`). `src/main/` now holds only `index.ts` (window/app lifecycle) and `ipc.ts` (IPC
  glue) - no `electron` import anywhere under `packages/`. Cross-package access to
  `src/shared/ipc.ts` (which stays put per the Ground rules) goes through a `@shared` alias
  (`tsconfig.node.json`, `packages/agent-core/tsconfig.json`, `electron.vite.config.ts`,
  `vitest.config.ts`) instead of a `../../..` chain. `ProjectStore` gained a `verifyScriptPath`
  constructor option so each project's bundled skill copy still gets `scripts/validate_stl.py` at
  the same relative path the skill's Phase 5 documents, even though the file's source of truth
  moved out of `resources/skills/printable-cad/scripts/`; `electron-builder.yml` gained a matching
  `extraResources` entry so packaged builds still ship it. Root `package.json` is now an npm
  workspaces root (`workspaces: ["packages/*"]`) with per-package typecheck scripts folded into
  `npm run typecheck`. Zero behavior change: all 219 pre-existing tests pass from their new
  locations (+3 new ones for the verify wrapper), `npm run build` bundles `@voyager/agent-core`
  straight into `out/main/index.js` (confirmed no leftover `require('@voyager/...')`), and the
  full quality gate (`typecheck && build && test`) is green.

- **Why:** the seam that keeps Mode A (CLI) vs Mode B (Bedrock) a configuration swap, and
  the precondition for parallel work. Architecture doc §1, §11-M0.
- **Scope:** npm workspaces. Move into `packages/agent-core`: `src/main/agent/**`
  (session, prompts, permissions, mcpTools → split into `tools/` registry, paths),
  `src/main/projects/**`, `src/main/python/**`, and the bundled skill copy logic; move
  `resources/skills/printable-cad/scripts/validate_stl.py` into `packages/verify` (Python
  + a thin TS wrapper). `src/main/**` becomes a thin Electron host (window, dialogs, IPC
  glue). **Pure refactor — zero behavior change.**
- **Files owned:** everything it moves, plus root `package.json`, `tsconfig*.json`,
  `electron.vite.config.ts`, `vitest.config.ts`.
- **Done when:** app runs exactly as before (manual box-with-holes flow from README §
  "Manual end-to-end test script"); all existing vitest suites pass from their new
  locations; `src/main/` contains only Electron-host code.

### WS-0b — Shared contracts + integration stubs · **Status: DONE** · gate, single agent, after 0a

- **Landed:** `src/shared/brief.ts` (`DesignBrief` zod schema per arch doc §6 - `Dim` with
  `user`/`inferred` provenance, discriminated-union `Feature`, `PrinterProfileRef`,
  `emptyDesignBrief()`), `src/shared/manifest.ts` (`ScriptManifest` - `ParamEntry` mirroring the
  PARAMS convention, `FeatureBinding` for direct manipulation), `src/shared/verification.ts`
  (`VerificationReport` - layered findings, conformance table, badge), each with its own
  `*.test.ts`. `src/shared/ipc.ts` re-exports all three and adds `ExportFormat`'s `'3mf' |
  'package'`, `ExportPackageRequest/Response`, `Brief{Update,Lock}{Request,Response}`,
  `ParamUpdate{Request,Response}`, `ParamGetManifestResponse`, `VerificationGetResponse`,
  `PrinterProfile{Save,SetActive}Request`/`ListResponse`, and matching `IPC` channel constants
  (`brief:*`, `param:*`, `verification:*`, `printerProfile:*`, `model:exportPackage`).
  `src/main/ipc.ts` wires every new channel to an in-memory stub (brief echoes/locks a
  module-level `DesignBrief`; params/verification/profiles/package return "not implemented yet"
  or empty defaults) with matching `src/preload/api.ts` (`VoyagerApi.brief/param/verification/
  printerProfile/exportPackage`) and `src/preload/index.ts` bridges. `appStore.ts` gained
  `brief`/`manifest`/`verificationReport`/`printerProfiles`/`activePrinterProfileId` slices
  (empty defaults) and their setters. `App.tsx` mounts `BriefPanel`/`ParamPanel`/
  `VerificationPanel` - new placeholder components rendering a single "not yet available" row -
  above `PrintSettingsPanel`. The three existing MCP tools moved out of
  `packages/agent-core/src/agent/mcpTools.ts` into `packages/agent-core/tools/` (one file per
  tool - `displayModel.ts`, `recommendPrintSettings.ts`, `setStatus.ts` - plus shared
  `types.ts`/`helpers.ts` and an `index.ts` registry `createVoyagerMcpServer()`); `session.ts`
  imports from `../../tools`. Zero behavior change to any existing tool; tests split 1:1 into
  per-tool `*.test.ts` alongside a `testSupport.ts` (not itself a test file). Full quality gate
  green: 228 tests (219 prior + 9 new for the three brief/manifest/verification schema files),
  build, typecheck.
- **Why:** the coordination point that makes WS-A…WS-F conflict-free.
- **Files owned:** all of the above.
- **Done when:** quality gate green; each downstream work order can be started without
  editing any 0b-owned file.

### WS-A — Design Brief system · **Status: DONE** · depends: 0a, 0b

- **Landed:** `packages/agent-core/brief/` — `BriefStore` (`store.ts`, per-project on disk at
  `<projectDir>/brief/brief.json` + immutable `versions/v{n}.json` snapshots written on lock;
  `get`/`replace`/`lock`/`listVersions`/`applyAgentPatch`, all taking the project dir explicitly
  rather than tracking "the active project"), `completeness.ts` (required-field + per-feature
  checks, `computeBriefCompleteness`/`isBriefComplete`/`missingBriefFields`), `agentPatch.ts` (the
  `update_brief` tool's flattened zod input shape + `mergeAgentPatch`, which wraps every numeric
  field into the domain `Dim` shape and unconditionally stamps `provenance: 'inferred'`). New
  `packages/agent-core/tools/updateBrief.ts` (`update_brief` MCP tool, registered in `tools/index.ts`
  and `VoyagerMcpDeps.briefStore`/`brief-updated` emission in `tools/types.ts`); `displayModel.ts`
  now stamps the locked brief's version onto each iteration via a new optional
  `ProjectIteration.briefVersion` (`projects/store.ts`). `session.ts` wires a `BriefStore` into the
  MCP server (defaults to `new BriefStore()` if the (optional) dep is omitted, so no existing test
  harness needed touching), allow-lists `mcp__voyager__update_brief`, and forwards `brief-updated`
  emissions through a new optional `emitBriefUpdated` dep. `prompts.ts` teaches the designer to call
  `update_brief` live during Phase 2 and to wait for the panel's lock message before Phase 4.
  `src/main/ipc.ts`'s `brief:get`/`update`/`lock` handlers now run on a real `BriefStore` instead of
  the WS-0b module-level stub (`lock` throws naming missing fields when incomplete). `BriefPanel.tsx`
  is a full collapsible form (part identity, envelope with an "AI"-inferred badge per dim, materials,
  constraints, exclusions/acceptance, a read-only feature list) with a live completeness meter and a
  "Lock & generate" button that locks then sends the agent a chat message to proceed — the concrete
  mechanism behind "one click to lock and generate" and the prompt's Phase-4 gate. Renderer-side pure
  form/completeness helpers live in `src/renderer/src/state/briefSelectors.ts` (the renderer never
  imports `@voyager/agent-core`, so this intentionally duplicates the completeness logic). Quality
  gate green: typecheck/build/test all pass (228→275 tests, +47 new, 0 removed/changed).
- **Known gap (see Contract change requests below):** no version-history *browsing* in the panel —
  `BriefStore.listVersions()` is implemented and tested, but the frozen `brief:*` IPC contract has
  no channel to fetch it from the renderer. The panel shows only the current draft/locked version.
- **Why:** product doc §4.4/§5.2 — the co-authored, machine-checkable spec that gates
  generation and powers verification layer 3.
- **Scope:** brief store (per-project, versioned, lock semantics) in
  `packages/agent-core/brief/`; an `update_brief` MCP tool (agent proposes field values,
  provenance `inferred`); prompt additions in `packages/agent-core/prompts.ts` teaching the
  designer to fill the brief during Phase 2 and to require a locked brief before Phase 4;
  `BriefPanel.tsx` UI (fields, provenance styling, completeness meter, lock button, version
  history). Locked brief version stamped onto each iteration (`recordIteration` gains
  `briefVersion` — field already in the 0b schema).
- **Files owned:** `packages/agent-core/brief/**`, `packages/agent-core/prompts.ts`,
  `packages/agent-core/tools/updateBrief.ts`,
  `src/renderer/src/components/BriefPanel.tsx` (+ its tests).
- **Done when:** the README box-with-holes flow produces a locked brief whose fields match
  the conversation; direct panel edits round-trip into the next agent turn.

### WS-B — PARAMS convention + parameter panel (no-LLM re-run) · **Status: TODO** · depends: 0a, 0b

- **Why:** product doc §4.5 P0 — instant, free dimension tweaks; the biggest UX/cost win.
- **Scope:** skill updates (PARAMS block grammar + `manifest.json` emission required in
  Phase 4); param extraction (Python `ast` — no LLM) in `packages/agent-core/params/`;
  re-run path: overridden constants → script re-execution in the managed venv → export →
  record as new iteration (`createdBy: 'param'`); `ParamPanel.tsx` (sliders/inputs from
  manifest, debounced re-run).
- **Files owned:** `resources/skills/printable-cad/**` (except `scripts/validate_stl.py`,
  which moved to `packages/verify`), `packages/agent-core/params/**`,
  `src/renderer/src/components/ParamPanel.tsx`.
- **Done when:** dragging a slider produces a new iteration in seconds with no agent turn;
  version history/revert treats it identically to agent iterations.

### WS-C — Verification layers 1–3 · **Status: TODO** · depends: 0a (layers 1–2), 0b + WS-A landing (layer 3 end-to-end)

- **Why:** architecture doc §5 — the trust artifact. Layers 1–2 need no brief and can start
  immediately after 0a.
- **Scope:** grow `packages/verify`: layer 1 static script checks (parses, PARAMS block
  valid, import allowlist); layer 2 geometry (today's validator + bed-fit search against a
  printer profile, min-feature scan, multi-body interference); layer 3 brief conformance
  (bbox, hole Ø/position via STEP cylindrical-face detection, wall-thickness sampling →
  spec/measured/pass table). Emits `VerificationReport` (0b schema). Hook: run
  automatically on `recordIteration`; `VerificationPanel.tsx` renders the report + badge.
- **Files owned:** `packages/verify/**`,
  `src/renderer/src/components/VerificationPanel.tsx`,
  `packages/agent-core/tools/runVerification.ts`.
- **Done when:** every new iteration gets a report; a deliberately-wrong dimension in a
  test fixture is caught by layer 3 and shown as a red row.

### WS-D — Render rig + designer self-inspection · **Status: TODO** · depends: 0a, 0b

- **Why:** product doc §4.3 — deterministic canonical views; the designer looks at its own
  output before declaring success (works fully in CLI mode; the *independent* vision critic
  waits for Mode B).
- **Scope:** `packages/render-rig` (Python, trimesh/pyrender EGL or pinned fallback): 6
  ortho + 2 iso views, fixed lighting/material, mm scale reference; stored per iteration;
  `render_views` MCP tool so the agent can request them mid-turn; skill Phase 5 addition:
  inspect renders before `display_model`; thumbnails in the version history UI.
- **Files owned:** `packages/render-rig/**`, `packages/agent-core/tools/renderViews.ts`,
  the skill's Phase 5/6 render-inspection paragraphs (coordinate with WS-B's skill
  ownership via a contract-change note if both are in flight — or sequence D after B).
- **Done when:** every iteration has a canonical render set on disk; transcript shows the
  agent viewing renders before displaying; renders are pixel-stable across two runs on the
  same geometry.

### WS-E — Printer profiles · **Status: TODO** · depends: 0a, 0b

- **Why:** product doc §4.4 — bed/nozzle/materials are settings, not per-project questions;
  verification layer 2 and the future split planner read them.
- **Scope:** profile store (`packages/agent-core/projects/printerProfiles.ts`, persisted in
  app data); settings UI (`PrinterProfilesPanel.tsx`); prompt/skill hook so Phase 1 reads
  the active profile instead of asking (asks only if none exists, then offers to save).
- **Files owned:** `packages/agent-core/projects/printerProfiles.ts`,
  `src/renderer/src/components/PrinterProfilesPanel.tsx`.
- **Done when:** with a saved profile, a new project's first agent turn skips the
  nozzle/bed questions and the generated script's `BED_X/BED_Y/BED_Z/NOZZLE` constants
  match the profile.

### WS-F — Graduation package export · **Status: TODO** · depends: 0a, 0b

- **Why:** architecture doc §12.1 / product doc §5.5 — anti-lock-in bundle; only packages
  artifacts every iteration already produces.
- **Scope:** package builder (zip: STEP + 3MF + STL + script + locked brief JSON +
  manifest + generated README); extend the export flow (`exportResolver` generalized to an
  artifact set — keep its path-containment guard); "Export package" in `ViewportControls`'
  export menu; skill note ensuring 3MF is always produced.
- **Files owned:** `packages/agent-core/projects/exportResolver.ts`,
  `packages/agent-core/projects/exportPackage.ts`,
  `src/renderer/src/components/ViewportControls.tsx` (export menu only).
- **Done when:** exported zip opens: STEP imports into Fusion/Onshape, script re-runs with
  `pip install build123d`, README renders.

---

## M2+ — sketched only (decompose when a trigger fires)

| Phase | Contents | Pointer |
|---|---|---|
| M2 | Backend + Bedrock (model gateway, session runtime, WS transport), or API-key middle rung first | Arch. doc §§2–4 |
| M3 | Multi-model verification (vision critic, clarifier extraction), report completion, prompt caching | Arch. doc §5, §10 |
| M4 | Direct manipulation via manifest bindings, feature list, split planner | Arch. doc §7; product §5.3 |
| M5 | Web client, billing, Onshape integrated app + Fusion add-in | Arch. doc §12.2–12.3 |
| M6 | Native feature rebuild (demand-gated) | Arch. doc §12.4 |

---

## Contract change requests

*(Agents: append requests here instead of editing 0b-owned files. Dispatcher triages.)*

- **WS-A needs a `brief:listVersions` channel.** `BriefStore.listVersions(projectDir)`
  (`packages/agent-core/brief/store.ts`) reads back every locked version's full snapshot from
  `<projectDir>/brief/versions/v{n}.json` and is unit-tested, but the frozen `brief:*` contract
  (`src/shared/ipc.ts`, `src/preload/api.ts`/`index.ts`) has no request/response shape or channel
  to fetch it from the renderer - only `get`/`update`/`lock`/`updated` exist. `BriefPanel.tsx`
  currently shows only the current draft/locked version (no history list) as a result. Proposed
  shape: `BriefListVersionsResponse { versions: Array<{ version: number; lockedAt: string; brief:
  DesignBrief }> }` on a `brief:listVersions` channel, wired the same way `brief:get` is today.
