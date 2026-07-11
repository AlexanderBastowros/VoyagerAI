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
   editing it — the dispatcher routes it through a contracts work order (WS-0b, then
   WS-0c, and so on).
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
WS-0a (extract agent-core) ── DONE
   └─► WS-0b (shared contracts + integration stubs) ── DONE
          ├─► WS-A  Design Brief system ── DONE
          ├─► WS-B  PARAMS + parameter panel ── DONE
          ├─► WS-C  Verification layers 1–3    ┐
          ├─► WS-D  Render rig + self-inspect  ├─ parallel, disjoint file footprints
          ├─► WS-E  Printer profiles ── DONE   ┘
          └─► WS-0c (contract addendum: import/parts/gears) ── DONE
                 ├─► WS-G  External model import/remix  ┐
                 ├─► WS-H  Gear generation              ├─ parallel (H's verify checks after WS-C)
                 └─► WS-I  Multi-part & placement ── DONE ┘
                        └─► WS-F  Graduation package + per-part export (needs WS-I)
Then: M1 integration pass (dispatcher-led).
M2+ (Bedrock, multi-model, plugins) — sketched only; decomposed when a trigger fires.
```

Notes on the gates:
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
- **Why:** the coordination point that makes WS-A…WS-I conflict-free.
- **Files owned:** all of the above.
- **Done when:** quality gate green; each downstream work order can be started without
  editing any 0b-owned file.

### WS-0c — Contract addendum: import / parts / gears · **Status: DONE** · gate for WS-G/H/I, single agent, quick

- **Landed:** `src/shared/brief.ts` gained the `gear` feature variant (`module`/`teeth`/
  `pressureAngle` as positive numbers, `helix?`, `bore`/`hub?` as `Dim`s, `meshesWith?`);
  `src/shared/manifest.ts` gained the optional `importedBase` marker (`path` + `step`|`mesh`
  `lineage`) for remix projects; new `src/shared/parts.ts` defines `Placement` (position mm +
  XYZ-degrees Euler rotation, `identityPlacement()`), `PartRecord` (id/name/placement/visible/
  `activeIteration`), `MAIN_PART_ID`, and guards. `src/shared/ipc.ts` re-exports `parts`, adds the
  `IterationCreatedBy` union (`agent`|`param`|`revert`|`import`) surfaced on `IterationInfo` and
  `ModelDisplayedPayload`, part identity (`ModelDisplayedPayload.partId`, `SelectionSummary.partId`,
  `SendMessageRequest.focusedPartId`, `ExportModelRequest`/`ExportPackageRequest.partId`),
  `ExportFormat`'s `'plate'`, `ImportModelRequest`/`Response` (two-phase unit confirmation),
  `PartListResponse` (`parts` + the project-level `activePartId` pointer),
  `PartGetModelRequest`/`PartSetPlacementRequest`/`PartSetVisibilityRequest`/`PartSetActiveRequest`
  (`part:getModel` returns one part's active model with STL bytes, on-demand, so the viewer can
  render every visible part without bloating the light `part:list`; `part:setActive` lets focusing a
  part in the panel redirect the param/verification/history panels to it - keeping those WS-B/WS-C
  panels unchanged, since they already follow the active iteration), `BriefListVersionsResponse`, and
  the `model:import`/`part:{list,getModel,setPlacement,setVisibility,setActive,updated}`/
  `brief:listVersions` channel constants. `src/main/ipc.ts` wires `brief:listVersions` to the **real** `BriefStore.
  listVersions` (draining WS-A's queued request) and stubs `model:import` + the three `part:*`
  channels (empty results; WS-I/WS-G replace the bodies at these designated points, the same pattern
  WS-B/WS-C used). `src/preload/**` bridge `model.import`, `brief.listVersions`, and a `part.*`
  group. `appStore.ts` gained `parts`/`selectedPartId`/`importDialogOpen` slices + setters (reset on
  project switch; `addIteration` now carries `createdBy`); `App.tsx` mounts the new placeholder
  `PartsPanel` (below `BriefPanel`) and `ImportDialog` (store-opened overlay). `store.ts`'s
  `ProjectIteration`/`recordIteration` gained the optional `createdBy` pass-through (widening only,
  zero behavior change). **Mechanical consequence of the mandated gear union member:** the two
  exhaustive `Feature` consumers - `packages/agent-core/brief/completeness.ts` and the renderer's
  `briefSelectors.ts` - were minimally updated (gears have no free-text locator, so their
  completeness reduces to a real bore; `featureSummary` gained a `gear` case). Quality gate green:
  362 tests (352 prior + 10 new for gear/importedBase/parts), build, typecheck.
- **Note for WS-A:** the `brief:listVersions` plumbing (channel + real handler + preload) is landed,
  so `BriefPanel` *can* fetch history; wiring the actual version-list UI into `BriefPanel.tsx`
  (WS-A-owned) is a small remaining WS-A follow-up.
- **Why:** WS-G/WS-H/WS-I were added to the roadmap after WS-0b shipped, so the contract
  surface they consume doesn't exist yet. Same rules as 0b: one owner lands the frozen
  shared files; the streams then build against them without touching them. Also drains the
  pending contract-change queue (below).
- **Scope:** types + zod schemas + stub wiring, no behavior:
  - `src/shared/brief.ts` — add the `gear` feature type (`module`, `teeth`,
    `pressureAngle`, `helix?`, `bore`, `hub?`, `meshesWith?`; architecture doc §6, §13).
  - `src/shared/manifest.ts` — `importedBase` marker for remix projects (§12.5).
  - `src/shared/parts.ts` (new) — `PartRecord` + `Placement` (architecture doc §14).
  - `src/shared/ipc.ts` — `model:import`; the part-scoped surface (`part:*`
    list/setPlacement/setVisibility; export requests gain `partId`;
    `ModelDisplayedPayload` gains part identity); `ExportFormat` + `'plate'`; iteration
    provenance `createdBy: 'agent' | 'param' | 'revert' | 'import'` on
    `ProjectIteration`/`recordIteration` (WS-B deliberately deferred this — WS-G/WS-I
    need it programmatically); plus the queued `brief:listVersions` request from WS-A.
  - Stub handlers in `src/main/ipc.ts` + `src/preload/**`; `appStore` parts/placements
    slice; `PartsPanel` + `ImportDialog` placeholder mounts in `App.tsx`.
- **Files owned:** the same contract set WS-0b owned (`src/shared/**`, preload,
  `src/main/ipc.ts` wiring, `appStore` slices, `App.tsx` mounts) plus
  `packages/agent-core/src/projects/store.ts` for the `createdBy` widening only.
- **Done when:** quality gate green; WS-G, WS-H, and WS-I can each start without editing
  any contract file; `BriefPanel` can list locked brief versions (WS-A's queued request).

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

### WS-B — PARAMS convention + parameter panel (no-LLM re-run) · **Status: DONE**

- **Landed:** `resources/skills/printable-cad/SKILL.md` Phase 4 gained the formal `# ---
  PARAMS ---` / `# --- END PARAMS ---` block grammar (one bare `NAME = VALUE` assignment
  per line, `unit=`/`label=` required, `min=`/`max=`/`brief=` optional) and an instruction
  to run the new extractor and save `<part>_vN.manifest.json` beside that version's
  STL/STEP; `references/build123d.md`/`cadquery.md` preambles updated to match.
  `packages/agent-core/params/python/extract_params.py` is the deterministic (no-LLM)
  extractor - a line-oriented parser over the block, not a full `ast` walk (the grammar is
  intentionally too constrained to need one), emitting `ScriptManifest` JSON to stdout or
  `--out`. On the TS side, `packages/agent-core/params/` adds `paramsBlock.ts`
  (regex substitution of one constant's literal, preserving indentation/comment),
  `manifestConvention.ts` (`manifest.json` always lives beside its STL, same basename -
  no new `ProjectIteration` field needed), `validate.ts`/`patchManifest.ts` (range-check
  and clone-patch a manifest without re-invoking the extractor - the edited value is
  already known exactly), `findExports.ts` (locates whatever filename a re-run script
  chose for its own STL/STEP), and `rerun.ts` (orchestrates all of the above: substitute →
  write to a fresh `outputs/param-edits/<uuid>/` scratch dir → run with the managed venv's
  python, 60s timeout → locate the export → write the patched manifest beside it). All six
  new modules are unit-tested (mocked spawn); `rerun.ts` was additionally smoke-tested
  end-to-end against a real `python3` subprocess (not just the mocked test) to confirm the
  substituted constant actually reaches the re-run script. `src/main/ipc.ts`'s WS-0b stub
  handlers for `param:update`/`param:getManifest` are now real: validate → `rerunWithParam`
  → `recordIteration` → broadcast `model:displayed` (same push the agent path already
  uses, so the viewport/version history update identically either way) - gated on
  `agentSession.isBusy()` like the other project-mutating handlers. `ParamPanel.tsx`
  renders sliders (bounded entries) or number inputs (unbounded), committing on
  release/blur/Enter rather than continuously, and refetches the manifest whenever the
  displayed iteration changes.
  Necessarily touched a few adjacent/shared files with small, additive, non-restructuring
  edits rather than filing a contract-change note, since each was either explicitly
  invited (the `param:update`/`getManifest` handler *bodies* in `ipc.ts` were WS-0b's own
  designated stub-replacement points) or a mechanical consequence of adding a new
  package-local folder (same pattern WS-0b already used for `tools/`): `packages/agent-
  core/tsconfig.json`/`src/index.ts` (barrel export for `params/`), `projects/store.ts`
  (optional `extractParamsScriptPath` constructor option + copy-into-skill step, mirroring
  `verifyScriptPath` exactly; omitted → skips the copy, so it's backward compatible),
  `electron-builder.yml` (one more `extraResources` entry, mirroring the `verify` one).
  Did **not** add a `createdBy: 'param'` tag to `ProjectIteration`/`recordIteration()` (the
  scope note below anticipated one) - the "done when" bar only requires version history to
  treat a param edit identically to an agent iteration, which a plain descriptive summary
  string (`"<Label>: <value> <unit>"`) already satisfies without widening `recordIteration`'s
  signature; worth revisiting only if a future work order actually needs to distinguish
  provenance programmatically. Quality gate green: 269 tests (228 prior + 41 new), build,
  typecheck. Manual Electron E2E (dragging a real slider in the running app) was not
  exercised - the app's own setup gate needs a signed-in Claude CLI + provisioned managed
  Python env, neither available in this sandbox; the real-python3 smoke test above is the
  closest substitute obtained.
- **Why:** product doc §4.5 P0 — instant, free dimension tweaks; the biggest UX/cost win.
- **Files owned:** `resources/skills/printable-cad/**` (except `scripts/validate_stl.py`,
  which moved to `packages/verify`), `packages/agent-core/params/**`,
  `src/renderer/src/components/ParamPanel.tsx`.
- **Done when:** dragging a slider produces a new iteration in seconds with no agent turn;
  version history/revert treats it identically to agent iterations.

### WS-C — Verification layers 1–3 · **Status: DONE** · depends: 0a (layers 1–2), 0b + WS-A landing (layer 3 end-to-end)

- **Landed:** `packages/verify/python/` gained three JSON-emitting scripts, siblings of the
  skill-facing `validate_stl.py` (left untouched - `SKILL.md` Phase 5 still runs it directly):
  `static_check.py` (layer 1 - `ast.parse` syntax check + an import allowlist walk, blocking on
  disallowed modules like `os`/`subprocess`/`socket`), `geometry_report.py` (layer 2 -
  watertight/manifold, bed-fit against `brief.printer` when set, overhangs, a multi-body +
  approximate-AABB-interference check, and a coarse per-body bounding-box thin-feature smell
  test), and `conformance_check.py` (layer 3, OCP-only - bbox vs `envelope.{x,y,z}`, hole census
  via cylindrical-face detection matched to brief `hole` features by nearest-diameter greedy
  pairing, and a ray-cast min-wall-thickness sample against the exact B-rep). Each is wrapped by a
  same-shaped TS module under `packages/verify/src/` (`layer1StaticScript.ts`/`layer2Geometry.ts`/
  `layer3BriefConformance.ts`, injectable-spawn like `validateStl.ts`) and composed by
  `runVerification.ts`, which runs layer 1 always, layer 2 once an STL exists, layer 3 once a STEP
  exists **and** the brief is locked, and computes the report badge. `reportConvention.ts` mirrors
  WS-B's manifest convention exactly - `<base>.verification.json` beside the STL.
  `packages/agent-core/src/projects/store.ts` gained one small additive hook,
  `ProjectStoreOptions.onIterationRecorded?`, fired (fire-and-forget) at the end of
  `recordIteration()` - the single choke point both the agent's `display_model` tool and WS-B's
  `param:update` handler already go through, so verification runs automatically on every iteration
  without touching either call site. `src/main/ipc.ts` wires that hook to a new `verifyIteration()`
  function (reads the locked brief + composes `runVerification`, persists, broadcasts
  `verification:updated`) and replaces the `verification:get` stub with a real read via
  `readVerificationForIteration`. The same `verifyIteration` backs a new on-demand
  `run_verification` MCP tool (`packages/agent-core/tools/runVerification.ts`) for the case where
  something conformance-relevant changed without a new iteration (e.g. the brief was locked after
  the model was already displayed) - one small additive `VoyagerMcpDeps.runVerification`/
  `VoyagerMcpEmission` variant and `AgentSessionDeps.runVerification`/`emitVerificationUpdated` in
  `session.ts`, mirroring the `briefStore`/`emitBriefUpdated` pattern exactly.
  `VerificationPanel.tsx` is a real collapsible panel now (badge chip, findings grouped by layer
  with severity icons, a conformance table with failed rows in red), fetching on mount and on
  iteration change and subscribing to `verification:updated`, mirroring `ParamPanel.tsx`'s shape;
  pure helpers live in `src/renderer/src/state/verificationSelectors.ts` (badge label/tone, layer
  grouping), tested without React per the existing `briefSelectors`/`setupSelectors` precedent.
  **Execution-verified against real geometry, not just mocked-spawn tests** - a throwaway venv
  with `trimesh`/`numpy`/`build123d` (which pulls in `cadquery-ocp`, providing the `OCP` module)
  confirmed all three scripts against a real STL and a real STEP export (a 40×20×10 mm box with a
  Ø3.4 mm hole), including the target "done when" case: a brief specifying a wrong hole diameter
  produces a `pass: false` conformance row and flips the badge to `fail`. That pass caught and
  fixed two real bugs the mocked TS tests couldn't have caught: (1) `trimesh.split()` needs an
  optional graph engine (networkx/scipy) that isn't a hard trimesh dependency and wasn't
  guaranteed to be in the managed venv - replaced with a dependency-free union-find over
  `mesh.face_adjacency` (pure numpy); (2) the wall-thickness ray-cast's near-hit cutoff was too
  tight and picked up adjacent-triangulation-facet grazing as a false near-zero "hit" on a curved
  bore surface - fixed by widening the offset/cutoff to 0.05 mm.
  **A follow-up adversarial code review (4 parallel finder passes) surfaced and fixed several
  more real bugs** before landing, re-verified against the same real STL/STEP fixtures: a
  falsy-zero bug where an explicit `tolerance: 0`/`toleranceMm: 0` in the brief was silently
  replaced by the 0.3 mm default (`x or default` treating `0` as unset); `hole_conformance`'s
  "nearest-diameter" matching was actually blind rank-order zipping (sort both lists, pair by
  index) and mismatched holes whenever an unrelated cylindrical feature sat between two real
  holes by diameter - replaced with genuine greedy nearest-diameter pairing; `static_check.py`
  only caught `OSError`/`SyntaxError`, not `UnicodeDecodeError`/null-byte `ValueError`, so a
  non-UTF-8 or null-byte script crashed instead of producing a clean `blocking` finding;
  `geometry_report.py`'s checks past the initial mesh load weren't individually guarded, so any
  trimesh exception mid-check lost the whole report - now each check (watertight, bed-fit,
  overhang, multi-body/thin-feature) degrades independently, matching layer 3's discipline; the
  0.3 mm default conformance tolerance was an invented number per this repo's CLAUDE.md
  convention - reworded to explicitly ground it in design-for-printing.md §4's fit-tolerance
  table instead of floating free; the "2× nozzle" absolute-minimum-wall formula was hardcoded
  independently in three places - extracted to `packages/verify/python/dfm_constants.py`; the
  wall-thickness ray-cast's 400-sample cap filled greedily in topological face order, silently
  never sampling faces encountered late - replaced with seeded reservoir sampling so every face
  has an equal chance regardless of order; `VerificationPanel.tsx`'s `verification:updated`
  subscription applied any pushed report unconditionally, so a slow layer-3 run for an older
  iteration could resolve after a newer, faster one and clobber the panel with stale data - fixed
  with an iteration-match guard (`verificationSelectors.ts`'s `isUpdateForCurrentIteration`); the
  empty-state message conflated "never verified" (`report === null`, e.g. after `revertTo()`,
  which doesn't run the hook) with "verified, zero findings"; and `ProjectStore.recordIteration()`
  now catches a synchronous throw from `onIterationRecorded` so a bug in a future hook
  implementation can't turn an already-persisted iteration into a reported failure. `runVerification`
  also now runs its three independent layers concurrently instead of sequentially. Quality gate
  green: 352 tests (339 prior + 13 new), build, typecheck.
- **Known gap:** layer 3's hole↔feature matching is nearest-diameter-greedy, not position-aware -
  `Feature.position` is free text, not a coordinate, so there's no exact correspondence available
  without a future manifest field that ties a feature id to a measurement recipe.
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

### WS-D — Render rig + designer self-inspection · **Status: DONE (partial)** · depends: 0a, 0b

- **Landed:** `packages/render-rig` (new npm workspace, mirroring `packages/verify`'s shape).
  **Rendering backend is matplotlib's Agg canvas, not pyrender/EGL** despite the scope line
  below - Voyager renders locally on the user's own desktop (Mac/Windows/Linux), and EGL is a
  Linux/NVIDIA-only headless GL extension with no macOS equivalent, so a pyrender/EGL-only path
  would simply not run for a large share of desktop users (this dev sandbox is macOS, where it
  could not have been exercised either). Agg is a pure-software rasterizer bundled with
  matplotlib - no GPU, no display server, no OS driver stack - and is exactly the "pinned
  fallback" the scope line allows; it was chosen as the primary (only) implementation for that
  reason, with the camera/projection/shading done as our own small vectorized-numpy code (see
  below) rather than relying on `mplot3d`'s 3D camera model.
  `python/render_views.py` renders one STL's 6 orthographic axis views + 2 isometric views to
  fixed-size PNGs - deterministic camera basis (Gram-Schmidt'd `(right, up, view_dir)` per view,
  a documented, fixed `VIEW_DEFS` table), backface culling + a painter's-algorithm depth sort
  feeding matplotlib's 2D `PolyCollection` (own small vectorized-numpy projection/shading code,
  **not** `mplot3d` - sidesteps its orthographic-aspect-ratio/hidden-surface quirks), fixed
  ambient+diffuse lighting from a constant world-space light direction, a fixed neutral
  blue-gray material (deliberately not the app's per-part palette), and an mm grid + tick labels
  baked into every frame (the "mm scale reference" requirement) with a "nice step" chosen so
  gridlines land near round mm values regardless of part size. Prints one JSON line on stdout,
  `{"ok": true, "views": {...}, "widthMm", "heightMm", "depthMm", "sizePx"}` or `{"ok": false,
  "error"}` on any failure (including missing imports) - never a bare traceback, matching
  `packages/verify/python/*.py`'s convention exactly. `src/renderViews.ts` is the thin
  injectable-exec TS wrapper (`packages/verify/src/validateStl.ts`'s exact shape, own local copy
  of the small `execFile` helper rather than a cross-package dependency on `@voyager/verify` -
  render-rig and verify are independent siblings per the architecture doc, not a stack);
  `renderConvention.ts` gives renders a home beside each iteration's STL
  (`<base>.renders/{front,back,left,right,top,bottom,iso1,iso2}.png`, mirroring
  `manifestPathForStl`/`verificationPathForStl`'s "one rule for what lives next to the STL"
  convention, but naming a directory instead of a single file). Root `package.json`/`tsconfig.json`
  gained the same per-package `typecheck:render-rig` wiring `agent-core`/`verify` already have
  (`vitest.config.ts`'s `packages/**/*.test.ts` glob already covered the new tests with no
  change needed).
  `packages/agent-core/tools/renderViews.ts` is the `render_views` MCP tool, same standalone-
  handler/injected-deps shape as `runVerification.ts`: reads the active iteration, calls
  `deps.renderViews(iteration)`, reads each PNG's bytes itself (mirrors `display_model` reading
  its own STL bytes), and returns them as MCP **image content blocks** (`{type: 'image', data:
  base64, mimeType: 'image/png'}`) plus a one-line text summary - the model can actually *see*
  the renders, not just get told they exist, which is the whole point of self-inspection. Wired
  into the registry (`tools/index.ts`) and one small additive optional field on
  `VoyagerMcpDeps`/new `RenderIterationOutcome` type (`tools/types.ts`), exactly mirroring how
  WS-C's `runVerification`/WS-E's `printerProfiles` were added - both files are siblings of this
  order's own `tools/renderViews.ts`, not a different stream's surface. SKILL.md gained one
  surgical paragraph at the Phase 5/6 boundary (WS-D's explicitly-owned paragraphs): call
  `render_views` and look at the result - missing/misplaced/mirrored/mis-oriented features -
  before calling `display_model`; explicitly told it's a sanity check, not a measurement tool,
  and to proceed to Phase 6 without blocking if rendering reports itself unavailable.
  **Execution-verified against real geometry** (WS-C precedent): an ad-hoc `pip install --user
  trimesh numpy matplotlib` in the sandbox (none of the three importable from the repo's own
  managed venv here) rendered a deliberately asymmetric L-shaped test STL; front/back/left/right
  visually confirmed *not* mirrored or rotated wrong (worked through the camera-basis math by
  hand for two views to confirm the rendered silhouettes match); two independent runs against the
  same STL produced **byte-identical PNGs** (same checksum, same size) - the "pixel-stable across
  two runs" done-when criterion. Quality gate green: 463 tests (448 prior + 15 new: 4 render-rig
  exec-wrapper, 5 `renderDirForStl`, 6 tool), build, typecheck (now including the new
  `typecheck:render-rig`).
- **Not wired live (honest gap - see contract-change requests below):** `deps.renderViews` is
  optional and nothing in this order's file ownership constructs a real implementation, so
  today the tool always replies "Rendering is not available in this session" in the actual app -
  `src/main/ipc.ts` (where `verifyIteration`/`AgentSession` are constructed) and
  `packages/agent-core/src/agent/session.ts` (`AgentSessionDeps`, the `createVoyagerMcpServer`
  call) are where WS-C's `runVerification` and WS-E's `printerProfiles` were threaded through by
  their own orders even though neither file was in *their* "Files owned" line either - this
  order's brief was explicit to touch only its three owned surfaces and file a request for
  anything else, so that wiring (fully specified below, all-additive, ~20 lines) is left for the
  dispatcher to route rather than assumed. Net effect: the "done when" criteria (canonical
  render set on disk per iteration; transcript shows self-inspection before display) are **not**
  met end-to-end yet - only the tool + renderer are done and independently verified. Thumbnails
  in the version-history UI (`ProjectsDrawer.tsx`'s "Versions" list) are **not implemented**:
  reading PNG bytes into the renderer process needs a new IPC channel (nothing in the frozen
  `src/shared/ipc.ts` surface exposes arbitrary file bytes, nor should it generically), which is
  a contract change outside this order's file ownership - filed below instead of edited.
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

### WS-E — Printer profiles · **Status: DONE** · depends: 0a, 0b

- **Landed:** `packages/agent-core/src/projects/printerProfiles.ts` (the roadmap path above omits
  `src/`, same shorthand as WS-A's `prompts.ts`) — `PrinterProfileStore`, app-level
  `<userData>/printer-profiles.json` (constructor-injected `baseDir`, no `electron` imports),
  persisting exactly the frozen `PrinterProfileListResponse` shape: zod-validated lenient reads for
  display paths, **strict reads for mutations** (missing file = empty store; I/O error aborts the
  save; an unparseable file is preserved as `.bak`, never silently clobbered), **atomic
  temp-file+rename writes**, promise-chain-serialized mutations, slug ids derived from the name
  (`save` throws on a stale non-empty id instead of forking a duplicate), and
  new-profile-becomes-active semantics. `src/main/ipc.ts` replaced the three WS-0b stub bodies
  (the designated points): `list`/`save`/`setActive` run on the real store and mutations broadcast
  `printerProfile:updated`; `verifyIteration` now merges the **active profile** into the
  verification input when `brief.printer` is unset, so layer 2's bed-fit/nozzle checks read the
  profile (this order's stated "why") without persisting anything onto the brief. Agent hook:
  `tools/savePrinterProfile.ts` (`save_printer_profile` MCP tool - the ask-then-offer-to-save flow;
  one tool file + one registry line, the pattern `tools/index.ts` documents) with additive
  `VoyagerMcpDeps.printerProfiles`/`printer-profiles-updated` emission in `tools/types.ts`;
  `prompts.ts`'s `systemPromptAppend` gained an optional `printerProfile` param (`undefined` = no
  store wired, topic omitted; `null` = "ask Phase-1 questions, then offer to save"; a profile =
  "these are the already-confirmed Phase-1 answers - do NOT ask; derive `NOZZLE`/`BED_X/Y/Z`
  (+`MIN_WALL`) and the Phase-5 validator flags from it"); `session.ts` reads the active profile in
  `ensureStarted`, bakes it into the system prompt, and **restarts the query (with `resume`) when
  the active profile changes** between turns, mirroring the `appliedSettings` pattern, plus
  allow-listing/humanizing the new tool. The small additive `prompts.ts`/`session.ts` edits are
  this order's explicit "prompt hook" scope (WS-C precedent for additive session deps); `SKILL.md`
  was **not** touched - request filed below. UI: `PrinterProfilesPanel.tsx` (house collapsible
  panel: profile list with radio set-active + edit, add/edit form with client-side validation,
  fetch-on-mount + `onUpdated` subscription feeding the WS-0b `setPrinterProfiles` slice), mounted
  below `PrintSettingsPanel` via a one-import/one-line `App.tsx` edit (0b pre-landed the slices/
  channels/preload for WS-E but no mount stub existed; WS-I precedent for minimal App.tsx
  integration edits). A 5-finder adversarial review with per-finding refutation verifiers caught
  and fixed before landing: the original non-atomic truncate-write + fallback-to-empty mutation
  read could turn one corrupt/torn file into a silent wipe of every profile (now atomic + strict +
  `.bak`); a **pre-existing** stale-`consume()`-loop bug where any query restart's superseded loop
  later ran `resetAfterExit()` against the *replacement* session (clearing `busy` mid-turn, killing
  the new queue - WS-E's profile-change restart put it on the mainline first-save flow) - fixed
  with an owning-query identity guard + per-consume `receivedAnyMessage`, with a regression test
  verified to fail without the guard; the panel's in-flight save could discard concurrent form
  edits (form + edit buttons now disable while busy); and the switched-printer prompt arm told the
  agent to use ad-hoc printer values while the verification panel judges bed-fit by the *active
  saved* profile - the prompt now says to save the new printer (saving activates it) and to warn
  that the panel checks the saved profile until then (root-cause fix filed below). Quality gate
  green: 423 tests after rebasing onto WS-0c/WS-I (383 prior + 40 new: 25 store, 4 tool, 6 prompts, 5 session incl. the
  stale-loop regression), build, typecheck. Not runtime-verified here: the live Electron E2E
  (signed-in CLI + managed env), the same sandbox gap WS-B/WS-C noted.
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

### WS-F — Graduation package + per-part export · **Status: DONE** · depends: 0a, 0b, **WS-I** (parts model)

- **Partial (maintainer-directed fix, 2026-07-10):** the "export all parts" slice landed —
  `model:export` now honors `partId`, and a multi-part project with no explicit part saves
  every part's active iteration as separate `<partId>_v<N>.stl/.step` files in one zip
  (never merged): `resolveAllPartsExportSources` in `exportResolver.ts` + a dependency-free
  `zipWriter.ts` (node:zlib), both unit-tested. Additive `ExportModelResponse.skippedParts`
  surfaces parts left out (no iterations / no STEP) in the success snackbar. Still open:
  3MF, plate export, package builder (`exportPackage.ts` can reuse `writeZip`), "Export…"
  menu, per-part export UI.
- **Landed (2026-07-11):** the remainder. **3MF** resolves per part exactly like STL/STEP now
  (`resolveExportSource`/`resolveAllPartsExportSources` widened to `SingleFileExportFormat =
  'stl'|'step'|'3mf'`) via a convention-derived sibling path (`deriveThreeMfPath`, same
  "no new field needed" pattern `manifestPathForStl` already uses) that `src/main/ipc.ts`
  probes for with a real `stat()` before trusting it - degrades to the existing "no export"
  messaging when absent, since `ProjectIteration` has no `threeMfPath` field (SKILL.md only
  "offers" 3MF today; see the contract-change request below). **Plate export** (new
  `packages/agent-core/src/projects/plateStl.ts`, dependency-free, unit-tested): a pure
  binary-STL parser/writer plus a hand-rolled XYZ-Euler rotation matrix (bit-for-bit the same
  formula as three.js's `Matrix4.makeRotationFromEuler`, so agent-core takes no `three`
  dependency) that origin-aligns each part's geometry, ground-clamps against *that*
  iteration's own bounds (mirrors `loadPart()`'s re-clamp-on-load reasoning - a stale
  persisted `placement.position[1]` can't sink a refined part below the plate), then merges
  every **visible** part into one binary STL; wired into `model:export`'s `'plate'` branch
  (`partId` ignored, parts without a visible iteration reported via `skippedParts`).
  **Package builder** (new `packages/agent-core/src/projects/exportPackage.ts`, pure logic
  with injected `PackageFsDeps` so it unit-tests against an in-memory fake): per-part
  `{part}_v{N}.step/.3mf/.stl/.py` sections (bundling only what `fileExists` confirms -
  format-honesty degrade, mirroring mesh-lineage parts having no STEP), one combined
  `manifest.json` (keyed by part id), the project's *currently* locked brief as a single
  `brief.v{K}.json` (omitted if never locked), and a generated `README.md` (re-run with
  `pip install build123d`, import instructions, per-part gaps, which locked brief version
  each part was generated against) - wired into the `model:exportPackage` stub-replacement
  point in `src/main/ipc.ts`. **"Export…" menu** in `ViewportControls.tsx` replaces the two
  STL/STEP buttons with one dropdown: "This part" (STL/STEP/3MF, scoped to the focused part)
  and "All parts" (STL/STEP/3MF zips) sections on a multi-part project, plus "Export plate"
  and "Export package" always - same "Exporting …"/silent-cancel/verbatim-error conventions.
  Quality gate green: 474 tests (27 new: 6 more `exportResolver` 3MF cases, 10 new
  `exportPackage.test.ts`, 11 new `plateStl.test.ts`), typecheck, build. Also validated with
  real tools in scratch (not committed) integration tests: a generated package zip passed
  `unzip -t`/`-l` and round-tripped its STL byte-for-byte through a real `unzip -o` extract;
  a two-part plate STL was written to disk and its binary header/triangle count re-parsed
  independently, confirming both parts' geometry rests on the plate after a 45° rotation.
  Not runtime-verified in a live Electron window in this sandbox (same CLI/Python-env gap
  WS-B/C/I noted).
- **Why:** architecture doc §12.1, §14 / product doc §5.3, §5.5 — anti-lock-in bundle,
  plus the fix for "everything merges into one file": exports resolve **per part**.
- **Scope:** part-scoped export resolution (`exportResolver` generalized to an artifact
  set per part — keep its path-containment guard): individual STL/STEP/3MF per part;
  "export all parts" = separate files in one zip, never silently merged; explicit
  **plate export** baking current placements into one merged STL; package builder (zip:
  per-part sections of STEP + 3MF + STL + script + manifest, plus locked brief JSON +
  generated README); "Export…" menu in `ViewportControls` (per part / all / plate /
  package); skill note ensuring 3MF is always produced.
- **Files owned:** `packages/agent-core/projects/exportResolver.ts`,
  `packages/agent-core/projects/exportPackage.ts`, `packages/agent-core/projects/plateStl.ts`
  (new sibling file for the plate-export STL transform/merge, per this order's own text),
  `src/renderer/src/components/ViewportControls.tsx` (export menu only), plus the
  `model:export`/`model:exportPackage` handler bodies (designated stub-replacement points) in
  `src/main/ipc.ts` and additive `packages/agent-core/src/index.ts` exports.
- **Done when:** a two-part project exports each part as its own file, "all parts" as a
  zip of separate files, and a plate STL matching the viewport arrangement; the exported
  package opens: STEP imports into Fusion/Onshape, script re-runs with
  `pip install build123d`, README renders.

### WS-G — External model import & remix · **Status: TODO** · depends: 0a, 0b, **0c**

- **Why:** product doc §5.6 / architecture doc §12.5 — most hobbyist projects start from an
  existing file (a Thingiverse/Printables STL, a colleague's STEP, a scan), and
  import → repair → verify → split → print settings is a complete zero-generation use case
  on its own. Capability is format-honest: STEP = full parametric remix; mesh = boolean
  surgery/repair/split, never sliders on geometry we didn't create.
- **Scope:** import flow (picker/drag-drop → copy to project `imports/`, measure, **unit
  confirmation for unitless STL/OBJ** — show one measured dimension, user confirms or
  corrects; record as iteration with `createdBy: 'import'`, display + verify like any
  iteration). STEP lineage: scripts reference the base via `import_step` and model on top.
  Mesh lineage: trimesh load; robust (manifold3d-class) booleans; parametric features
  built in build123d, meshed, then fused/subtracted; repair pass (fill holes, drop
  degenerate faces) that reports what it changed; mesh-lineage iterations record no STEP
  (`resolveExportSource` already degrades gracefully). Skill guidance in a **new**
  reference file `references/remix.md` (boolean-surgery patterns like plug-and-recut,
  unit-confirmation rule, mesh-vs-STEP capability rules). `ImportDialog.tsx` UI on the 0c
  mount point.
- **Files owned:** `packages/agent-core/projects/importModel.ts`,
  `packages/agent-core/remix/**`,
  `resources/skills/printable-cad/references/remix.md` (new file — disjoint from WS-B's
  skill edits), `src/renderer/src/components/ImportDialog.tsx`.
- **Coordination:** the one-line pointer to `references/remix.md` in `SKILL.md` is a
  contract-change request (WS-B owns `SKILL.md`) — file it rather than editing.
- **Done when:** a downloaded STL imports with confirmed scale, displays, gets a layer-2
  verification result, and accepts "add a 5mm hole through the base" (boolean surgery →
  new iteration); an imported STEP accepts a parametric added feature and still exports
  STEP; an import that fails watertightness gets a repair pass with a report of what
  changed.

### WS-H — Gear generation (mechanisms v1) · **Status: TODO** · depends: 0a, 0b, **0c** (gear-spec verify checks additionally wait for WS-C)

- **Why:** product doc §5.7 / architecture doc §13 — gears are a top functional-print
  request and the sharpest "properly" test: library-generated involutes with checkable
  meshing math, never hand-modeled teeth. Fully CLI-phase.
- **Scope:**
  1. **Timeboxed library spike** — evaluate `bd_warehouse.gear` (build123d-native),
     `cq_gears` (CadQuery; broadest gear-type coverage), `gggears`
     (build123d-compatible), and anything else surfaced. Criteria: involute correctness
     vs. the analytic profile, type coverage, export mesh quality, license/maintenance.
     Record the per-gear-type defaults in this work order. **No framework switch** —
     both ecosystems share OCP/OCCT, so CadQuery-built gears wrap into build123d scripts
     at the shape level (STEP handoff as fallback).
  2. **Env:** add chosen libraries to the managed Python env package list; CadQuery-based
     libs install lazily (large OCP wheel — the skill already documents this path).
  3. **Skill:** new `references/gears.md` — library-per-gear-type, meshing math the agent
     confirms before generating (module/PA match, center distance, undercut minimums),
     PARAMS conventions for gears, clarify questions ("what does it mesh with?").
  4. **Verification (after WS-C):** gear-spec checks as new files — matched module/PA
     across declared mates, center distance vs. modeled axes, backlash within DFM
     allowance, undercut warnings.
- **Files owned:** `resources/skills/printable-cad/references/gears.md` (new file —
  disjoint from WS-B's skill edits), `packages/agent-core/src/python/envManager.ts` (package
  list), `packages/verify/**/gears*` (new files, land after WS-C).
- **Coordination (contract-change requests, don't edit):** gear DFM numbers into
  `references/design-for-printing.md` and a pointer line in `SKILL.md` (both WS-B-owned).
- **Coordination:** once WS-I lands, gear pairs generate as **sibling parts** (one per
  gear), not a multi-body single file — if both are in flight, agree the `display_model`
  part-arg convention via the contracts section.
- **Done when:** "a 20-tooth and 40-tooth meshing pair, module 1.5, 20° PA, 6mm bores,
  herringbone" yields two gears whose verification passes the pair checks (center
  distance 45mm, matched module/PA), whose profiles are library-generated involutes (not
  freehand), and whose module/teeth appear as sliders in the parameter panel; a bare
  "make me a gear" prompt triggers the skill's gear clarify questions instead of
  generating an unmated guess.

### WS-I — Multi-part projects: parts, placement, parts panel · **Status: DONE** · depends: 0a, 0b, **0c**

- **Landed:** `packages/agent-core/src/projects/store.ts` reshaped from a flat `iterations`/
  `activeIteration` record to `parts: StoredPart[]` + a project-level `activePartId` pointer. Each
  part carries its own iteration history, active pointer, `placement`, and `visible`; every unscoped
  method (`recordIteration`/`activeIterationRecord`/`listIterations`/`latestIteration`/`revertTo`)
  defaults to the **active part** so every existing caller (the frozen `src/main/ipc.ts` handlers,
  `session.ts`'s revert-context, the print/verify tools) keeps working unchanged, while an optional
  `partId` targets a specific part. New part API: `listParts`/`getActivePartId`/`setActivePart`/
  `setPlacement`/`setVisibility`, a `slugifyPartId` path-traversal guard (part ids become
  `outputs/versions/<partId>/` dirs), per-part iteration numbering, and part-scoped chat-history
  ids. A `migrateRecord()` discovers a pre-WS-I project as a single `main` part
  (discover-don't-recreate). `packages/agent-core/tools/displayModel.ts` gained `part`/`part_name`
  args (slugified, created on first use, emitted as `ModelDisplayedPayload.partId`); `tools/types.ts`
  widened `VoyagerMcpProjectStore`. `src/main/ipc.ts` replaced the WS-0c `part:*` stubs with real
  handlers (`part:list`/`getModel`/`setPlacement`/`setVisibility`/`setActive`, gated on
  `isBusy()` + broadcasting `part:updated`, the designated stub-replacement points). Renderer:
  `viewer.ts` now renders a `Map<partId, mesh>` at each part's placement with a focused part for
  selection/measurement/gizmo (`loadPart`/`setPartPlacement`/`setPartVisible`/`focusPart`/
  `frameAll`, highlight re-parented under the focused mesh so it aligns with placed parts); new
  `placementController.ts` wraps three's `TransformControls` (translate on the plate + rotate,
  ground-snapped on release, layout-only); new pure `placement.ts` (Euler + ground-snap math,
  unit-tested); `selectionController.ts` folds the focused mesh's world matrix into the projection
  and tags `SelectionSummary.partId`; new `PartsPanel.tsx` (list + visibility toggles +
  click-to-focus, hidden for a single-part project); `syncParts.ts` loads every part on hydration.
  `App.tsx`/`Viewport.tsx`/`ProjectsDrawer.tsx` were rewired for multi-part load, part-aware
  `model:displayed`, and gizmo attach/detach. A follow-up adversarial code review (3 parallel finder
  passes over the diff) caught and fixed several real bugs before landing: `param:update` recorded
  into the active part but broadcast a payload with no `partId`, so a slider edit on a non-`main`
  active part loaded geometry into the wrong part (now tags `partId` + `createdBy: 'param'`);
  `recordIteration` pushed a new part into the in-memory record *before* the `copyFile` that can
  throw, leaving a phantom un-persisted part (now defers all mutation until after the copy);
  `migrateRecord` dereferenced `part.iterations` unguarded, so a malformed part triggered the
  destructive fresh-record overwrite (now coerces); `buildProjectSnapshot` read + IPC-cloned the
  active part's STL that the renderer no longer consumes (now an empty buffer - the geometry loads
  per-part); the placement gizmo wasn't gated on `agentBusy` (a drag mid-turn silently diverged the
  viewer from disk - now busy-gated + optimistic-store-update with rollback); `loadPart` reused a
  rotated part's stale ground-snapped Y on re-display so a refined part floated (ground-snap is now
  the invariant on every placement application); `syncViewportParts` set the store before loading
  meshes, racing the focus/gizmo effects (now loads meshes first); the `model:displayed` refetch
  wasn't sequence-guarded (stale refetch could regress the panels - now token-guarded); and the
  gizmo's `g`/`r`/`t` shortcuts fired while typing (now ignore text fields). Quality gate green: 383
  tests (362 prior + 21 new: store parts, displayModel part arg, placement math, 2 review regressions),
  build, typecheck.
- **Delivered vs. Done-when:** ✅ separate parts with independent histories + revert (store, tested);
  ✅ agent regenerates one part without touching another's history (`display_model part` arg, tested);
  ✅ gizmo move/rotate with ground-snap + placement persists across restart (placementController +
  persisted `placement`); ✅ region-select captures the selected part (`SelectionSummary.partId`
  populated by `selectionController`). **Two coordination follow-ups** (filed below, exactly as this
  order's coordination notes anticipated): the agent only *uses* the `part` arg / *sees* the selected
  part + arrangement once the WS-A-owned `prompts.ts` parts-vocabulary lands; the interpenetration
  check lands in WS-C's layer 2. Both are contract-change requests, not WS-I code.
- **Not runtime-verified in this environment:** the live gizmo drag / multi-part WebGL interaction
  can't be exercised in the sandbox (no Electron + signed-in CLI + managed Python env, same gap
  WS-B/WS-C noted). Verified via typecheck/build, the full unit suite, and the pure placement-math
  tests; the three.js `TransformControls` API surface used (`getHelper`/`setMode`/`setSpace`/
  `showX/Y/Z`/`dragging-changed`) was confirmed against the installed `three@0.185`.
- **Known gap — the parameter panel doesn't work on multi-part projects (future fix).** The WS-B
  parameter panel + `param:update` path (no-LLM slider re-run) was built for a single-part project
  and operates on the *active part*'s manifest/iteration. On a project with more than one part it
  does not correctly target the focused part - editing a slider doesn't reliably re-run/re-record
  the intended part's script. WS-I wired `param:update` to at least emit the active part's `partId`
  (so a re-run lands in the right viewer slot), but the end-to-end parameter workflow across parts
  is unverified and known-broken. **A future work order should:** make `ParamPanel` refetch and edit
  the *focused* part's manifest on `part:setActive`, ensure each part carries its own PARAMS manifest
  and `param:getManifest`/`param:update` resolve it per part, and add a multi-part param test.
  Files to look at: `src/renderer/src/components/ParamPanel.tsx` (WS-B), the `param:*` handlers in
  `src/main/ipc.ts`, `packages/agent-core/params/**`, and the focus/refetch path in
  `src/renderer/src/components/PartsPanel.tsx` (WS-I). Not a WS-I regression - single-part parameter
  editing is unchanged.
- **Why:** product doc §5.3 / architecture doc §14 — real projects are a box *and* its
  lid, a gear *pair*, a bracket set; the single-part data model is why everything merges
  into one exported file. Gear pairs (WS-H), split-plan pieces, and imports (WS-G) all
  need parts to land in their natural shape. WS-F builds on this.
- **Scope:** parts data model in `ProjectStore` — per-part iteration histories,
  active-iteration pointers, and revert (existing semantics preserved, scoped per part);
  migration: existing projects discover a single `main` part (discover-don't-recreate,
  like the pre-R3 project migration); `display_model` gains the `part` slug argument
  (default `main`, part created on first use); **placements** — persisted per-part
  position + orientation, a viewport move/rotate gizmo with ground-snap
  (`TransformControls`-class, alongside the existing selection/measurement controllers),
  layout-only (never rewrites script or mesh); `PartsPanel.tsx` (list, visibility
  toggles, select/focus, per-part version history); selection context and the
  user-message envelope gain part identity + current arrangement so the agent has spatial
  context. Explicitly out of scope: assembly constraints/mates (product doc §4.5
  non-goal).
- **Files owned:** `packages/agent-core/src/projects/store.ts`,
  `packages/agent-core/tools/displayModel.ts`,
  `src/renderer/src/three/placementController.ts` (new) + part-related changes in
  `src/renderer/src/three/viewer.ts`, `src/renderer/src/components/PartsPanel.tsx`.
- **Coordination (contract-change requests, don't edit):** parts-vocabulary prompt
  additions (`prompts.ts` is WS-A-owned); cross-part interference check lands in
  WS-C's layer 2 (file a request naming the placement input it should consume).
- **Done when:** a project holds a box and a lid as separate parts with independent
  version histories and revert; the lid moves/rotates with the gizmo and its placement
  survives an app restart; region-select reports which part was selected; the agent
  regenerates the lid without touching the box's history; verification (if WS-C has
  landed) flags an interpenetrating arrangement.

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

- **Multi-part viewer upgrades needed additive 0b/WS-I-surface edits — → LANDED
  (maintainer-directed, 2026-07-10).** New `part:duplicate` channel (`PartDuplicateRequest` →
  `PartListResponse`, busy-gated handler + `part:updated` broadcast, `ProjectStore.duplicatePart`
  sharing the source's immutable artifacts), preload `part.duplicate`, and an
  `appStore.gizmoMode` slice. Behavior changes on WS-I surfaces: per-part palette colors
  (`partColorFor` in `colors.ts`, worn by viewer meshes + PartsPanel swatches), ground-*snap*
  relaxed to ground-*clamp* (`groundClamp` in `three/placement.ts` - parts can lift vertically,
  never sink below the plate; the gizmo's vertical translate handle is now shown), a
  Move/Rotate toolbar toggle mirroring the g/r shortcuts, PartsPanel per-row Duplicate, and
  Viewport lazily fetching geometry for parts that appear without a `model:displayed` push.

- **WS-F all-parts zip needed two additive 0b-file edits — → LANDED (maintainer-directed,
  2026-07-10).** `src/shared/ipc.ts`: optional `ExportModelResponse.skippedParts?: string[]`
  plus an updated `ExportModelRequest.partId` doc (omitted on a multi-part project now means
  "all parts as one zip of separate files", §14); `src/main/ipc.ts`: the `model:export`
  handler body (a designated stub-replacement point) gained the zip branch and now passes
  `request.partId` through to `activeIterationRecord`. No channel names or preload wiring
  changed; `src/preload/api.ts` only had its `model.export` doc comment refreshed.

- **WS-F 3MF export needs a SKILL.md Phase 4 change (WS-B-owned) — always produce 3MF, not just
  "offer" it.** `resolveExportSource`/`resolveAllPartsExportSources`/`exportPackage.ts` (WS-F,
  2026-07-11) now resolve a part's 3MF export the same way as STL/STEP - but purely by
  *convention*: `deriveThreeMfPath` computes the sibling path (`<part>_vN.3mf` beside the STL,
  same pattern `manifestPathForStl` already uses), and `src/main/ipc.ts` probes for it with a
  real `stat()` before trusting it, since `ProjectIteration` carries no `threeMfPath` field (no
  contract change needed for the *resolution* mechanism itself). SKILL.md's Phase 4 currently
  says only "Offer **3MF** as well when the user's slicer prefers it" (a conditional, model-
  discretion action) - so a real project mostly won't have the sibling file, and every 3MF
  export/package section quietly degrades to "no 3MF export" even though the mechanism is fully
  wired end-to-end. Proposed change (WS-B-owned `resources/skills/printable-cad/SKILL.md`):
  change Phase 4's export step to *always* run `export_3mf(...)` alongside STL/STEP (mirroring
  `build123d.md`'s already-documented `export_3mf` call), versioned identically
  (`<part>_vN.3mf`) - not left conditional on the user's slicer preference. Filing here rather
  than editing SKILL.md directly (WS-B ownership).

- **WS-A needs a `brief:listVersions` channel.** `BriefStore.listVersions(projectDir)`
  (`packages/agent-core/brief/store.ts`) reads back every locked version's full snapshot from
  `<projectDir>/brief/versions/v{n}.json` and is unit-tested, but the frozen `brief:*` contract
  (`src/shared/ipc.ts`, `src/preload/api.ts`/`index.ts`) has no request/response shape or channel
  to fetch it from the renderer - only `get`/`update`/`lock`/`updated` exist. `BriefPanel.tsx`
  currently shows only the current draft/locked version (no history list) as a result. Proposed
  shape: `BriefListVersionsResponse { versions: Array<{ version: number; lockedAt: string; brief:
  DesignBrief }> }` on a `brief:listVersions` channel, wired the same way `brief:get` is today.
  **→ LANDED in WS-0c:** the `brief:listVersions` channel, the exact response shape above, the real
  main handler (`BriefStore.listVersions`), and the `window.voyager.brief.listVersions()` preload
  method all shipped. Remaining: the version-list UI inside `BriefPanel.tsx` (WS-A-owned) - a small
  WS-A follow-up, not a contract change.

- **WS-I needs parts-vocabulary + envelope part-context in `prompts.ts` (WS-A-owned).** The
  multi-part *mechanism* is fully landed (WS-I): `display_model` takes a `part` slug, the store keeps
  per-part histories, the parts panel + placement gizmo work, `SelectionSummary.partId` is populated,
  and `SendMessageRequest.focusedPartId` exists in the contract. But the agent won't *use* or *see*
  any of it until `packages/agent-core/src/agent/prompts.ts` is updated - and that file is WS-A-owned,
  so WS-I did not touch it. Needed:
  1. `systemPromptAppend` (skill/designer prompt): teach the parts vocabulary - name the `part` on
     `display_model` for a multi-part project (a box AND its lid, a gear pair, split pieces), and ask
     which part a change targets when ambiguous (arch doc §14; also unblocks WS-H gear pairs
     generating as sibling parts).
  2. `formatSelectionContext(selection)`: include `selection.partId` when set, so a region-select on
     a specific part tells the agent which part "make this hole bigger" refers to.
  3. `buildUserMessage(...)`: accept and render the **current arrangement** (part names + placements)
     and the **focused part** so the agent has spatial context. The data is available main-side -
     `AgentSession` can read `projectStore.listParts()`; `focusedPartId` needs a one-line pass-through
     in `ChatPanel.tsx` (send it) → `src/main/ipc.ts`'s `agent:sendMessage` handler → a new optional
     `focusedPartId` param on `AgentSession.sendMessage`. These pass-throughs are small and coupled to
     the `prompts.ts` change, so land them together.
  Until this lands, criteria "region-select reports which part was selected" and multi-part agent
  authoring are captured/persisted on the WS-I side but not yet surfaced to the model.

- **WS-I needs a cross-part interference check in WS-C's layer 2.** WS-I persists each part's
  `placement` (`ProjectStore.setPlacement`; `listParts()` exposes `PartRecord.placement`) but does no
  geometry interference check itself. WS-C's layer 2 (`packages/verify/python/geometry_report.py`,
  composed by `runVerification` in `packages/verify` and wired through `verifyIteration` in
  `src/main/ipc.ts`) should run a cross-part interference/clearance check on the **placed
  arrangement** and surface interpenetration as a layer-2 finding (product doc §5.3 / arch §14).
  Proposed input the check should consume, assembled in `verifyIteration` from the store: for the
  active project, `Array<{ partId: string; stlPath: string; placement: { position: [n,n,n];
  rotation: [n,n,n] } }>` (each part's active-iteration STL + its placement) - transform each mesh by
  its placement, then AABB-then-mesh interference-test the set. This is the same caliper-class,
  LLM-free check the verification pyramid already favors.

- **WS-E needs printer fields in `update_brief`'s patch shape (WS-A-owned `brief/agentPatch.ts`).**
  `DesignBriefSchema.printer` exists (0b) and WS-C's `verifyIteration` *prefers* `brief.printer`
  over the app-level active profile, but `briefAgentPatchShape` has no printer fields, so the agent
  cannot record a per-project printer into the brief at all. Confirmed consequence (adversarial
  review, WS-E): when the user says "this project is for a different printer" and declines to save
  it, the agent's constants/validator flags follow the ad-hoc printer while automatic layer-2
  bed-fit judges by the *active saved* profile - a false FAIL, or worse a false PASS for a part
  that can't fit the printer it will actually print on. WS-E's stopgap is prompt-side (encourage
  saving, which activates the new profile; warn otherwise). Root fix: add `printer_name`/
  `printer_bed_x_mm`/`printer_bed_y_mm`/`printer_bed_z_mm`/`printer_nozzle_mm`/
  `printer_materials` to `briefAgentPatchShape` + `mergeAgentPatch` (agent-core-local, not a
  frozen-contract change), and one sentence in WS-E's switched-printer prompt arm telling the
  agent to record the project's printer via `update_brief` - `verifyIteration`'s
  brief-printer-first logic then does the right thing with no other change.

- **WS-E requests a Phase-1 sentence in `SKILL.md` (WS-B-owned).** Phase 1 currently says to ask
  the nozzle/bed questions "together, up front" every session; WS-E now overrides that via the
  system prompt when a saved profile exists. The override wins in practice, but the skill text
  contradicts the host app's behavior - proposed addition at the top of Phase 1: *"If the host
  application's system prompt provides a saved printer profile, treat it as the answers to the
  questions below and do not re-ask them; skip to the confirm-with-defaults items."* Note the
  skill is copied per-project at creation (`ProjectStore.materializeProject` copies only when
  missing), so existing projects keep their old copy either way - the system-prompt override is
  the mechanism that works for them.

- **WS-E notes the frozen `printerProfile:*` contract has no delete.** The panel can list, save,
  and set-active but never remove a profile (a mis-added printer lives forever; the store's only
  escape hatch is hand-editing `<userData>/printer-profiles.json`). Proposed:
  `printerProfile:delete` with `PrinterProfileDeleteRequest { id: string }` →
  `PrinterProfileListResponse` (active pointer moves to `null` when the active profile is
  deleted), wired like `printerProfile:setActive`, plus a delete affordance in
  `PrinterProfilesPanel.tsx` (WS-E-owned, trivial once the channel exists).

- **WS-D needs `render_views` threaded through `src/main/ipc.ts` + `session.ts` to actually run**
  (neither file is in WS-D's "Files owned" line, and this order's brief was explicit to touch
  only its three owned surfaces). The tool + renderer are done and independently
  execution-verified (see WS-D's landed note); only the main-process wiring that constructs a
  real `deps.renderViews` and threads it through is missing, and it is small and entirely
  additive - mirrors WS-C's `runVerification` wiring line-for-line:
  1. `src/main/ipc.ts`: add a `renderScriptPath()` resolver next to `geometryReportScriptPath()`
     (same dev/packaged `app.isPackaged` branch, pointing at
     `packages/render-rig/python/render_views.py`), and a `renderIteration(iteration, projectDir)`
     function next to `verifyIteration` that calls `@voyager/render-rig`'s `renderViews({
     pythonPath: envManager.pythonPath(), scriptPath: renderScriptPath(), stlPath: join(projectDir,
     iteration.stlPath), outDir: join(projectDir, renderDirForStl(iteration.stlPath)) })` and
     returns the `RenderIterationOutcome` shape `tools/types.ts` already declares (`{ ok: true,
     dir: outDir, views: result.views, widthMm, heightMm, depthMm }` on success, `{ ok: false,
     error }` passthrough on failure). Pass `renderViews: (iteration) =>
     renderIteration(iteration, projectStore.getProjectDir())` into the existing `new
     AgentSession({...})` call (alongside `runVerification`/`printerProfiles`, ~line 275).
  2. `packages/agent-core/src/agent/session.ts`: add `renderViews?: (iteration: ProjectIteration)
     => Promise<RenderIterationOutcome>` to `AgentSessionDeps` (mirrors `runVerification`'s optional
     field exactly) and pass `renderViews: this.deps.renderViews` into the `createVoyagerMcpServer({
     ... })` call. Optionally (UX polish, not a blocker - `decideToolPermission`'s blanket
     `mcp__voyager__*` allow already covers it either way): add
     `'mcp__voyager__render_views'` to the `allowedTools` array and a
     `case 'mcp__voyager__render_views': return activity('Rendering canonical views')` arm in
     `humanizeToolUse`.
  3. `electron-builder.yml`: add a `- from: packages/render-rig/python` / `to: render-rig`
     `extraResources` entry (mirrors the existing `verify`/`params` entries) so packaged builds
     ship `render_views.py`.
  Until this lands, `render_views` always replies "Rendering is not available in this session."

- **WS-D needs `matplotlib` added to the managed venv's `REQUIRED_PACKAGES`
  (`packages/agent-core/src/python/envManager.ts`, owned outside this order).** The render rig's
  rasterizer is matplotlib (see WS-D's landed note for why, over pyrender/EGL); `trimesh`/`numpy`
  are already required but matplotlib isn't. `render_views.py` detects the missing import and
  reports a clean `{"ok": false, "error": ...}` rather than crashing, so nothing breaks today -
  but `render_views` can't actually produce a render in any real install until
  `REQUIRED_PACKAGES` gains `'matplotlib'` (and the `STAGE_PATTERNS` progress-line matcher gains
  a `matplotlib` entry, cosmetic only). `packages/render-rig/python/requirements.txt` documents
  the same gap.

- **WS-D requests a new `render:list`/`render:get`-shaped channel for version-history
  thumbnails** (frozen `src/shared/ipc.ts`/preload/`src/main/ipc.ts` surface, owned outside this
  order). The scope line asked for thumbnails in `ProjectsDrawer.tsx`'s "Versions" list, but
  nothing in the existing contract exposes arbitrary file bytes to the renderer process (nor
  should it, generically) - reading a render PNG back requires a new round-trip. Proposed:
  `render:get` with `RenderGetRequest { partId?: string; n: number; view: RenderViewName }` →
  `RenderGetResponse { dataUrl: string | null }` (base64 `data:image/png;base64,...`, `null` if
  that iteration has no render set yet - e.g. recorded before this order's `renderIteration` hook
  existed, or before `render_views` was ever called for it), handler reading
  `renderDirForStl`'s convention path off disk via `@voyager/render-rig`. `ProjectsDrawer.tsx`
  would fetch one thumbnail view (e.g. `iso1`) per visible version row, lazily, the same
  on-demand shape `part:getModel` already uses instead of pushing every iteration's images
  up front.
