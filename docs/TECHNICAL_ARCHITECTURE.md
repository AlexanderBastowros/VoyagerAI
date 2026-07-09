# Voyager AI — Technical Architecture (Bedrock production)

**Status:** proposal · **Companion doc:** [`PRODUCT_DESIGN.md`](./PRODUCT_DESIGN.md)
**Grounding:** references the POC code as it exists on this branch (`src/main/agent/session.ts`,
`src/main/agent/mcpTools.ts`, `resources/skills/printable-cad/`, `src/shared/ipc.ts`, …).

---

## 1. The forcing function

The POC's trust model is "everything runs on the user's machine under the user's own Claude
login." Bedrock inverts it: **AWS credentials must never ship in a client**, so the moment
inference moves to Bedrock, a server side becomes mandatory — session runtime, auth, metering,
storage. That is the single biggest architectural change; everything else is incremental.

We keep **two deployment modes over one shared core**:

- **Mode A — Local (kept):** today's Electron flow, Claude CLI subscription auth. Remains the
  free tier, the offline story, and — critically — the dev harness for the agent core.
- **Mode B — Cloud (new):** client (Electron *and* web) talks to the Voyager backend; the
  agent runs server-side against Bedrock.

The refactor that makes both possible: extract the agent loop, skill, prompts, MCP tools, and
project semantics out of `src/main/**` into a host-agnostic `packages/agent-core`, with the
Electron main process and the cloud session runtime as two thin hosts. `AgentSession` is
already built for this (injected deps, no `electron` imports, injectable `queryFn`) — the seam
exists; we're moving it, not inventing it.

---

## 2. System overview (Mode B)

```
┌─────────────────────────┐        ┌──────────────────────────────────────────────────┐
│  Client (Electron/web)  │        │                    AWS account                    │
│  React + three.js       │  wss   │  ┌──────────┐   ┌────────────────────────────┐  │
│  viewport · chat        │◄──────►│  │ API / WS │──►│  Session Runtime (per-user  │  │
│  brief panel            │  https │  │ gateway  │   │  sandboxed container)       │  │
│  param panel            │        │  │ authn/z  │   │  ┌───────────────────────┐  │  │
│  verification report    │        │  │ metering │   │  │ agent-core            │  │  │
└─────────────────────────┘        │  └────┬─────┘   │  │ (Claude Agent SDK →   │  │  │
                                   │       │         │  │  Bedrock)             │  │  │
                                   │       │         │  ├───────────────────────┤  │  │
                                   │       ▼         │  │ Python CAD env        │  │  │
                                   │  ┌──────────┐   │  │ (build123d/trimesh)   │  │  │
                                   │  │ Postgres │   │  ├───────────────────────┤  │  │
                                   │  │ projects │   │  │ MCP tools → event bus │  │  │
                                   │  │ briefs   │   │  └───────────────────────┘  │  │
                                   │  │ iters    │   └───────┬──────────┬──────────┘  │
                                   │  └──────────┘           │          │             │
                                   │  ┌──────────┐   ┌───────▼───┐  ┌───▼──────────┐  │
                                   │  │    S3    │◄──│ Verifier  │  │ Model Gateway│  │
                                   │  │ scripts  │   │ workers + │  │ (roles →     │──┼─► Amazon Bedrock
                                   │  │ stl/step │   │ render rig│  │  models)     │  │   (Claude, Nova,
                                   │  │ renders  │   └───────────┘  └──────────────┘  │    Llama, DeepSeek…)
                                   │  │ reports  │                                     │
                                   │  └──────────┘                                     │
                                   └──────────────────────────────────────────────────┘
```

Five services, deliberately few:

| Service | Responsibility |
|---|---|
| **API/WS gateway** | AuthN/Z, project CRUD, WebSocket fan-out of agent events (replaces the typed IPC in `src/shared/ipc.ts` with the same event vocabulary over the wire), quota/metering enforcement |
| **Session runtime** | One sandboxed container per active design session: agent-core + Python CAD env + MCP tools. Scale-to-zero, resume via Agent SDK session ids (same `resume` semantics `session.ts` uses today) |
| **Model gateway** | The only component that holds Bedrock clients. Role→model registry, fallbacks, caching policy, Guardrails, usage accounting |
| **Verifier workers** | Async pipeline per iteration: geometry checks, brief conformance, render rig, vision critique, (escalation) cross-model review |
| **Data plane** | Postgres (projects, briefs, iterations, reports, transcripts — supersedes `project.json`/`ProjectStore`), S3 (scripts, STL/STEP/3MF, renders, report JSON) |

**What travels over the WebSocket** is the existing `AgentEvent` vocabulary
(`text-delta`, `thinking-delta`, `tool-activity`, `model-displayed`, `stopped`, …) plus new
`brief-updated`, `verification-progress`, `verification-report` events. The renderer barely
changes; its transport does.

---

## 3. Model strategy on Bedrock

### 3.1 Two call paths, on purpose

1. **The designer agent** stays on the **Claude Agent SDK**, pointed at Bedrock
   (`CLAUDE_CODE_USE_BEDROCK=1` + standard AWS credential chain + Bedrock model id). This
   preserves the entire investment in `session.ts` — streaming input mode, `canUseTool`
   permission authority, in-process MCP servers, skills, resume — with the backend swapped.
   Verify the exact env/config against the current Agent SDK docs at implementation time; this
   is the documented Bedrock path for Claude Code and the SDK inherits it.
2. **Every non-agent call** (clarifier extraction, vision critique, cross-model review) goes
   through our **model gateway**: the `AnthropicBedrockMantle` client for Claude models
   (Messages API shape on Bedrock, `anthropic.`-prefixed ids), and the Bedrock
   **Converse API** for non-Anthropic models — Converse is what makes "verify across models"
   one integration instead of five.

### 3.2 Role registry (initial)

Replaces the hardcoded `AgentModel`/`EFFORT_UNSUPPORTED_MODELS` handling in `session.ts` and
`shared/ipc.ts` with config:

| Role | Default | Fallback | Notes |
|---|---|---|---|
| `designer` | `anthropic.claude-opus-4-8` | `anthropic.claude-sonnet-5` | Effort modulated per task: `medium` for parameter-ish tweaks routed through chat, `xhigh` for novel parts |
| `clarifier` | `anthropic.claude-haiku-4-5` | — | Structured outputs (brief field extraction) |
| `vision_critic` | `anthropic.claude-sonnet-5` | Nova Pro (Converse) | Renders + brief in, findings JSON out |
| `cross_checker` | non-Anthropic via Converse (e.g. DeepSeek-R1 or Nova Premier — pick per eval) | second Claude with fresh context | Escalation tier only |

Model ids, regions (use cross-region inference profiles for capacity), per-role effort, and
per-role token budgets are configuration, not code. Selection changes require an eval run
(§10), not a redeploy debate.

### 3.3 Bedrock feature constraints we design around

Known deltas vs. the first-party Anthropic API that shape this design (per current platform
availability tables — recheck at implementation):

| Not on Bedrock | Our stance |
|---|---|
| Server-side web search / web fetch / code execution | Irrelevant — code runs in *our* sandbox by design |
| Files API / Batches / Models API | We store artifacts in S3 ourselves; no batch workloads in v1 |
| **Automatic** prompt caching | Manual `cache_control` breakpoints **are** supported (5m/1h) — the gateway places them: skill/system prefix + conversation prefix. This is a top cost lever, do it early |
| Task budgets, fast mode, mid-conversation system messages | Nice-to-haves; per-role `max_tokens` + effort cover the need |
| Server-side refusal fallbacks | Use the SDK's client-side fallback middleware / plain retry-on-`refusal` in the gateway |

Also: on Bedrock, Claude Sonnet 5 requires `thinking: {type: "disabled"}` when forcing
`tool_choice` — relevant for the clarifier's structured-extraction calls.

**Kept-open alternative** (product doc §4.6): *Claude Platform on AWS* for the Claude roles
(full first-party parity, SigV4/IAM/AWS billing) + Bedrock Converse only for non-Anthropic
verifiers. Because only the model gateway holds provider clients, switching is a config change.

---

## 4. Session runtime & sandboxing

The model writes and executes **arbitrary Python**. Locally that runs as the user, on the
user's machine, at the user's risk. Server-side it is the #1 security surface:

- **One container per active session** (Fargate, or EKS with gVisor/Firecracker-class
  isolation). Image bakes in: agent-core, Claude Code CLI + Agent SDK, the Python CAD env
  (build123d, trimesh, numpy, OCP) — which also kills the POC's first-run `EnvManager`
  provisioning entirely in cloud mode.
- **No network egress** from the CAD-execution sandbox except the model gateway and S3 via
  VPC endpoints. Read-only rootfs; per-session scratch volume; CPU/memory/time limits per
  script run (OCCT booleans can spin — hard timeout + kill, surfaced to the agent as an error
  it can react to, same philosophy as `mcpTools.ts` returning actionable tool errors).
- **Permission model carries over:** `decideToolPermission` + `canUseTool` remain the single
  authority. In cloud mode the "ask the user" path (`requestUserApproval`) rides the
  WebSocket instead of IPC; the default posture tightens (writes only under the project dir —
  which is now the *only* dir).
- **Lifecycle:** sessions hibernate after idle (persist Agent SDK session id — the existing
  `resume`/`skipResumeOnRestart` logic in `session.ts` transfers verbatim), containers are
  reclaimed, resume re-attaches. Interrupt (`AgentSession.interrupt()`) already has the right
  semantics: terminal `stopped` event, session survives.

MCP tools grow beyond today's three (`display_model`, `recommend_print_settings`,
`set_status`): `update_brief` (agent proposes field values; provenance-tagged),
`render_views` (invoke the render rig mid-turn so the designer can self-inspect),
`run_verification` (request layers 1–3 before declaring success), `propose_split_plan`.
Same in-process SDK-MCP pattern as `createVoyagerMcpServer`.

---

## 5. Verification pipeline

Runs per iteration, async, streaming progress events; layers 1–3 are pure computation.

```
iteration recorded (script + STL + STEP)
  │
  1️⃣ static script checks      — parses; PARAMS block valid; import allowlist; no I/O outside sandbox
  2️⃣ geometry validation       — validate_stl.py grown up: watertight/manifold, bed-fit search
  │                              (against the user's printer profile), overhang %, min-feature
  │                              scan, multi-body interference
  3️⃣ brief conformance         — brief fields → measurements on the B-rep/mesh:
  │                              bbox vs envelope · hole Ø/position via cylindrical-face
  │                              detection on STEP (OCP) · wall thickness sampling (ray casting)
  │                              → spec/measured/pass table
  4️⃣ render rig                — headless deterministic renders: 6 ortho + 2 iso + optional
  │                              sections; fixed lighting/material; mm scale reference in frame
  5️⃣ vision critique           — vision_critic model: renders + brief (+ user reference image)
  │                              → findings JSON {finding, severity: blocking|suggestion,
  │                              view, brief_field?}; dimensional judgments are out of scope
  │                              by prompt AND schema
  6️⃣ cross-model review        — escalation only (first gen / N failed iters / user request):
  │                              cross_checker reads script + brief → findings JSON
  ▼
  Verification Report (JSON in S3, summarized in Postgres) → `verification-report` event
```

Two implementation notes:

- **Layer 3 is the moat.** It requires feature-level correspondence between brief and
  geometry. The designer helps: the skill is extended so every script emits a
  `manifest.json` (feature id → brief field → how to measure it). Verification checks the
  manifest's claims *and* independently measures the global ones (bbox, hole census). A
  missing/false manifest entry is itself a failure.
- **Render rig tech:** trimesh/pyrender with EGL headless (or a pinned Blender CLI) — pick
  whichever gives deterministic output in CI; renders must be byte-comparable enough for
  visual diffing between iterations.

The same pipeline binary runs in local mode (minus the model-based layers unless the user's
auth allows them) — one codebase, two modes, per §1.

---

## 6. The Design Brief (schema sketch)

Stored as versioned JSON (zod-validated — zod is already a dependency); rendered as the brief
panel; consumed by the designer (prompt), the conformance layer (assertions), and the split
planner (constraints).

```ts
interface DesignBrief {
  version: number                     // brief versions are immutable once locked
  lockedAt?: string                   // generation stamps briefVersion on each iteration
  parts: Array<{ id: string; name: string; purpose: string; referenceImages: ImageRef[] }>
                                      // ≥1 part (§14); images carry ≥1 user-scaled dimension;
                                      // every Feature below carries a `partId`
  printer: PrinterProfileRef          // bed XYZ, nozzle Ø, materials — reusable, per-user settings
  envelope: { x: Dim; y: Dim; z: Dim }       // Dim = { value, unit, tolerance?, provenance: 'user'|'inferred' }
  features: Feature[]                 // discriminated union: hole {Ø, purpose: clearance|tapped|press_fit,
                                      //   position}, pocket, boss, fillet/chamfer, text, insert{type, size},
                                      //   gear {module, teeth, pressureAngle, helix?, bore, hub?,
                                      //     meshesWith?: featureId}  (§13)…
  materials: { requested?: string; onHand: string[] }
  constraints: {
    mustFitBed: boolean
    allowSplit: boolean; maxPieces?: number
    printOrientation?: 'agent-decides' | Orientation
    loadBearing?: boolean
  }
  exclusions: string[]                // explicit don't-wants — prompted verbatim to the designer
  acceptance: string[]                // human-readable criteria; vision critic reads these
}
```

Provenance (`user` vs `inferred`) is load-bearing: inferred values render distinctly in the
panel until confirmed, and the designer is instructed never to treat an inferred dimension as
settled — the same "never invent a dimension" golden rule the skill already encodes, made
enforceable.

---

## 7. Parameter panel & direct manipulation

- **PARAMS convention** (skill-enforced, layer-1-verified): a single annotated block of
  constants at the top of every script — `NAME = value  # unit=mm min=.. max=.. label=".."
  brief=envelope.x`. Extraction is a trivial parse (Python `ast` server-side); no LLM.
- **Parameter edit path:** client → API (`param:update`) → session runtime re-executes the
  script with overridden constants (no agent turn) → export → **layers 1–3 verification
  only** → new iteration. Seconds, ~free. The `brief=` back-references keep brief and
  parameters bidirectionally consistent (editing a brief-bound param proposes a brief patch).
- **Direct manipulation:** the script manifest (§5) includes feature→parameter bindings with
  drag axes. The viewport turns a face-drag into a parameter delta; falls back to
  "selected region + suggested parameter" chat context (today's `SelectionSummary` flow) when
  no binding exists.
- **Version semantics unchanged:** every path — agent turn, param edit, revert — produces an
  immutable iteration; `activeIteration`/revert logic from `ProjectStore` ports as-is, with
  the revert-context injection (`formatRevertContext`) kept for agent turns.

---

## 8. Data plane

```
s3://voyager-{env}/projects/{projectId}/
  brief/v{N}.json
  parts/{partId}/iterations/{n}/ script.py · manifest.json · part.stl · part.step · part.3mf
                                · renders/{front,back,left,right,top,bottom,iso1,iso2}.png
                                · report.json
  attachments/{uploadId}
  imports/{importId}.{step|stl|3mf|obj}   # externally sourced base models (§12.5)
```

Postgres: `users`, `printer_profiles`, `projects`, `briefs(project, version, json, locked_at)`,
`parts(project, part_id, name, placement, visible)` (§14),
`iterations(project, part_id, n, brief_version, s3_prefix, badge, created_by: agent|param|revert|import)`,
`transcripts` (chat persistence — replaces `appendMessage` into `project.json`),
`usage_events` (per-turn tokens by role/model — metering + the eval feedback loop).

Local mode keeps the current on-disk layout; `ProjectStore` becomes an interface with disk and
cloud implementations.

---

## 9. Security summary

- No AWS/Bedrock credentials in any client, ever. Clients get short-lived session tokens for
  the Voyager API only.
- Generated code executes only in the egress-blocked sandbox (§4); model gateway is the sole
  path to models; S3 access via presigned URLs scoped per project.
- Tenant isolation at the container boundary (one session = one container = one project's
  data mounted).
- Bedrock Guardrails attached at the gateway for user-facing text roles; the designer's code
  output is governed by the sandbox + verification instead (guardrails don't read Python).
- Prompt-injection surface: user briefs and reference images flow into prompts — treat
  brief fields as data (schema-validated, length-capped), and keep `canUseTool` as a
  deny-by-default authority exactly as the POC does.

---

## 10. Cost & quality engineering

- **Prompt caching first:** manual `cache_control` on the stable prefix (system + skill +
  brief) and the conversation prefix. Agent turns in a design session are bursty — 5m TTL
  fits; measure `cache_read_input_tokens` per turn in `usage_events` and alarm on regressions.
- **Effort modulation** within the designer role (product doc §4.1) — the cheap, honest
  version of complexity routing.
- **Free paths absorb tweak traffic:** parameter edits and renders bypass models entirely.
- **Budgets:** per-role `max_tokens`; per-turn and per-session token ceilings by pricing tier,
  enforced at the gateway.
- **Eval harness before model debates:** a fixture suite of brief→expected-geometry cases
  (the box-with-holes manual test in the README is fixture #1) scored by the deterministic
  verifier. Every role's model/prompt/effort change runs the suite; this is also how the
  `cross_checker` model gets picked with evidence instead of vibes.

---

## 11. Migration plan

Each milestone ships something usable; the POC never stops working.

**Backend sequencing (decided):** M0 and M1 run entirely on **Mode A** (Claude CLI, zero
marginal inference cost). M2 is adopted **on trigger**, not on schedule — the hard trigger
is the *first external user* (a personal Claude subscription cannot serve other people's
inference); secondary triggers are the multi-model verification layers and a hosted web
client. The API-key middle rung (below) can precede full AWS to measure per-design cost.
The agent-facing work queue for the current phase lives in
[`agents/production-roadmap.md`](../agents/production-roadmap.md).

| # | Milestone | Contents | Done when |
|---|---|---|---|
| **M0** | Extract the core | `packages/agent-core` (session loop, prompts, MCP tools, skill, project semantics) + `packages/verify` (validator → library); Electron main becomes a thin host. Pure refactor | POC works exactly as before; existing vitest suites pass against the packages |
| **M1** | Brief + verification, still local | Brief schema/panel/extraction; PARAMS convention in the skill; parameter panel; verification layers 1–3 + render rig running locally; printer profiles; graduation-package export (§12.1 — it only bundles artifacts every iteration already produces) | Box-with-holes flow produces a brief, a conformance table, and slider edits; the exported package opens in Fusion/Onshape via its STEP |
| **M2** | Bedrock, single model | Model gateway; Agent SDK → Bedrock in a dev account; auth + minimal metering; session runtime containerized; WS transport carrying the existing event vocabulary | Full design loop runs server-side with the client pointed at the cloud |
| **M3** | Multi-model verification | vision_critic on the render rig; clarifier extraction on Haiku-tier; Verification Report UI complete; prompt caching + usage accounting | Report ships with every iteration; cost per accepted design measured |
| **M4** | Control & printability | Direct manipulation via manifest bindings; feature list; split planner + multi-piece verification | >X% of iterations are non-chat (product metric §7) |
| **M5** | Productization | Web client GA, billing/tiers, cross_checker escalation tier, BYO-AWS deployment recipe; Onshape integrated app + Fusion 360 add-in (§12.2–12.3) | First paying cohort |

**Decisions deliberately deferred:** whether to insert an **Anthropic API-key mode** as a
pay-as-you-go middle rung before full AWS (decide pre-M2 from measured per-design token
cost; already sketched in `agents/future-improvements.md`); Bedrock vs. Claude Platform on
AWS for Claude roles
(gateway config — decide at M2 with real feature/latency data); which non-Anthropic
cross-checker (decide at M3 via the eval suite); web-client-first vs Electron-first for cloud
mode (M2 spike: the renderer is already plain React+three.js — the preload/IPC layer is the
only Electron coupling); native feature rebuild in Fusion/Onshape (§12.4 — demand-gated M6,
proceed only if Tier 1/2 graduation telemetry shows users asking for editable feature trees).

---

## 12. CAD interoperability

Users graduating a part to Fusion 360 / Onshape / FreeCAD / SolidWorks is a supported,
one-way flow (product doc §5.5 for the reasoning; bidirectional sync is rejected there).
STEP is the interchange backbone — every iteration already produces one, and all four tools
import it natively. The engineering below recovers progressively more design intent on top
of that baseline.

### 12.1 Graduation package (Tier 1)

A zip per iteration (or per project, active iteration by default):

```
{part}_v{N}.step          # AP242 B-rep (OCCT writer — already what build123d emits)
{part}_v{N}.3mf           # print-ready mesh (skill Phase 4 already offers 3MF)
{part}_v{N}.stl
{part}_v{N}.py            # the parametric build123d script — the real source of truth
brief.v{K}.json           # the locked Design Brief this iteration was generated from (§6)
manifest.json             # PARAMS + feature→parameter map (§5, §7)
README.md                 # generated: how to re-run the script (pip install build123d),
                          # how to import into Fusion/Onshape, what each file is
```

Implementation is small: extend `ExportFormat` in `src/shared/ipc.ts`
(`'stl' | 'step'` → `+ '3mf' | 'package'`), and generalize `resolveExportSource`
(`src/main/projects/exportResolver.ts`) to resolve the artifact set — its path-containment
guard applies unchanged. Cloud mode serves the same bundle from the iteration's S3 prefix
(§8) via a presigned URL. No new artifact generation: the package only bundles what every
iteration already produces.

### 12.2 Onshape integrated app (Tier 2a)

Onshape is the easiest deep target — cloud-native, REST API, OAuth2, distribution through
its app store; nothing to install on the user's machine, and the integration runs entirely
server-side (our backend ↔ Onshape's API):

- **Connect:** user links their Onshape account (OAuth) in Voyager settings; we store the
  grant per user.
- **Push:** "Send to Onshape" on a project creates (or reuses) an Onshape document; each
  Voyager iteration is uploaded as a STEP translation/import and committed as a **new
  document version** named `v{N} — {summary}` (mapping our immutable-iteration model onto
  Onshape's versioning, which fits it naturally).
- **Context:** the brief JSON and script ride along as attached blob elements, so the spec
  travels with the geometry.

Exact endpoint names/scopes get pinned at implementation time against Onshape's current API
docs; the shape of the integration (OAuth + translation import + version per iteration) is
stable.

### 12.3 Fusion 360 add-in (Tier 2b)

Fusion is desktop, so this is a **Python add-in** (Autodesk's supported extension model,
distributable via the Autodesk App Store):

- Signs in to the Voyager API (device-code flow — no secrets in the add-in), lists the
  user's projects/iterations.
- Imports the selected iteration's STEP via Fusion's import API, and creates **Fusion user
  parameters** from `manifest.json` (name, value, unit, description).
- "Refresh from Voyager" pulls a newer iteration as a new component/body next to the old
  one — never silently replacing geometry the user has built on.

**Honest limitation, stated in-product:** on an imported (history-free) solid, those user
parameters *document* the design and can drive the user's own downstream native features,
but they do not retro-drive the imported B-rep. Parameters that actually drive geometry
require Tier 3.

### 12.4 Native feature rebuild (Tier 3 — demand-gated)

Reconstructing a feature tree from a bare B-rep is research-grade feature recognition — we
don't attempt it. We sidestep it: **Voyager already knows the features**, because the
designer emits the script and its manifest (§5). The rebuild add-in replays that constrained
feature vocabulary as *native* operations — in Fusion via the API (sketch + extrude the base
solid, hole features, fillet/chamfer on resolved edges), in Onshape via generated
FeatureScript. The part is rebuilt from scratch inside the target CAD rather than annotated
onto an import, so parameters genuinely drive geometry and the user gets a real, editable
timeline.

Scope guard: only the skill's feature vocabulary (base solid, holes, pockets, bosses,
fillets/chamfers, text) is replayable; anything outside it falls back to Tier 2 STEP import
for that body. Edge/face resolution for fillets is the hard 20% — the manifest carries
geometric selectors (face normals + centroids) rather than OCCT topology ids precisely so a
rebuilt-in-Fusion solid can re-find them. Gated on Tier 1/2 telemetry (§11 deferred
decisions).

### 12.5 Import & remix (the return path, generalized)

Any external model — a Voyager part edited elsewhere, or a file that never touched Voyager
(Thingiverse STL, a colleague's STEP, a scan) — can start or continue a project. One-way in
each direction; there is deliberately no state kept consistent between Voyager and the
external tool. Product framing: product doc §5.6.

**Import flow:** file picker / drag-drop → copied into the project (`imports/`), measured
(bbox, watertight, triangle/face count) → **unit confirmation** for unitless formats
(STL/OBJ carry no units; the dialog shows one measured dimension and asks the user to
confirm or correct it — the skill's never-guess-scale rule, enforced at the door) →
recorded as iteration v1 with `createdBy: 'import'`, displayed and verified like any other
iteration.

**Two lineages, set by format:**

- **STEP lineage** — OCCT/build123d imports a true B-rep solid. Generated scripts reference
  it (`base = import_step("imports/…")`) and model on top; everything downstream (params on
  added features, fillets touching new geometry, full STEP export) works.
- **Mesh lineage** (STL/3MF/OBJ via trimesh) — booleans run on the mesh (manifold3d-class
  robust booleans); parametric features are built in build123d, meshed, then fused or
  subtracted. A **repair pass** (fill holes, drop degenerate faces) runs on request and
  reports exactly what it changed. Explicitly out of scope: mesh→B-rep conversion —
  feature recognition on triangle soup is research-grade, and naive triangle→face
  conversion blows up OCCT on real files. Mesh-lineage iterations export STL/3MF only;
  `resolveExportSource` already degrades gracefully when an iteration has no STEP.

**Semantics downstream:** the manifest marks the base as `imported`, so the parameter panel
scopes itself to Voyager-added features; the brief records the import and tracks added
features only; verification layers 1–2 run unchanged on any lineage, layer 3 asserts only
what Voyager added; the render rig and region-select need no changes at all.

---

## 13. Mechanism generation — gears first

Product framing: product doc §5.7. Fully CLI-phase work — nothing here needs Bedrock.

**Library strategy (spike, then pin).** Gear teeth are never hand-modeled by the agent;
generation comes from vetted libraries. Candidates for a timeboxed eval:
`bd_warehouse.gear` (build123d-native, same author as build123d), `cq_gears` (CadQuery;
broadest coverage — spur/helical/herringbone/bevel/planetary/ring), `gggears`
(build123d-compatible), plus anything else the spike surfaces. Criteria: involute
correctness (profile inspection against the analytic curve), gear-type coverage, export
mesh quality, maintenance/license. The result is a per-gear-type default recorded in the
work order, not a religion.

**Framework interop, not framework switch.** build123d and CadQuery both wrap OCCT through
the same OCP bindings — a CadQuery-generated gear is a `TopoDS` shape that a build123d
script can wrap directly (STEP handoff as the fallback path). So the primary authoring API
stays build123d, CadQuery-based libraries are imported where they win, and the managed env
(`EnvManager` package list) adds the chosen gear libraries — CadQuery lazily, since its OCP
wheel is large (the skill already documents that install path).

**Skill:** a new `references/gears.md` teaches: which library per gear type; the meshing
math the agent must confirm before generating (module/PA matching across a pair, center
distance `m·(z₁+z₂)/2` ± profile shift, minimum tooth count vs. undercut at the chosen
pressure angle); PARAMS conventions for gears (module, teeth, PA, helix, bore, hub — so
the parameter panel gets gears for free); and clarify-phase questions ("what does it mesh
with?" is as mandatory as "what's the hole for?"). Gear **DFM numbers** (min module vs.
nozzle, print-flat orientation, herringbone preference for FDM, backlash allowance) are
added to `references/design-for-printing.md` — the existing single source of truth that
generation and verification share.

**Verification:** gear-spec checks join the deterministic layers (§5): given the brief's
gear features, verify matched module/PA between declared mates, center distance against
the modeled axes, backlash within the DFM allowance, and warn on undercut-prone tooth
counts. These are formula checks on brief + geometry — exactly the caliper-class work the
verification pyramid keeps away from LLMs.

**Brief:** the `gear` feature type (§6) makes pairs first-class via `meshesWith`, which is
what turns "generate a gear" into a checkable spec instead of a shape request.

---

## 14. Multi-part projects & placement

Product framing: product doc §5.3. Contract-level change — it reshapes `ProjectStore`, the
`display_model` tool, the brief, and export, so it lands in the WS-0b contracts before the
parallel streams build against single-part assumptions.

**Data model.** A project holds **parts**; each part carries its own script lineage,
iteration history, and active-iteration pointer. All existing single-part semantics —
immutable iterations, revert, the parameter panel's re-run path — apply *per part*. A
pre-existing project migrates to one part (`main`), the same discover-don't-recreate
migration style the POC used for pre-R3 single-project installs. `display_model` gains a
`part` argument (slug, created on first use, default `main`), so the agent declares which
part an export belongs to; region-select context gains part identity. Storage becomes
part-scoped (§8): `parts/{partId}/iterations/{n}/`.

**Placement is layout, not geometry.** Each part has a persisted placement (position +
orientation) edited with a viewport gizmo (three.js `TransformControls`-class, with
ground-snap). Placements never modify a part's script or mesh — no invisible geometry
drift. They still do real work: (1) the agent receives the current arrangement as spatial
context in the user-message envelope (alongside the existing selection summary), and
(2) verification layer 2 runs **cross-part interference/clearance** on the placed
arrangement. Explicitly not an assembly-constraint solver (product doc §4.5 non-goal): no
mates, no kinematics.

**Per-part export.** Export resolution (`resolveExportSource`) becomes part-scoped: an
individual part's active iteration exports as its own STL/STEP/3MF; "export all parts"
produces separate files in one zip — never a silent merge; an explicit **plate export**
bakes current placements into one merged STL when an arranged build plate is actually what
the user wants. The graduation package (§12.1) gains per-part sections under one bundle.

**Agent semantics.** Still one session per project. Prompts/skill teach the parts
vocabulary (name the part on `display_model`; ask which part a change targets when
ambiguous). Gear pairs (§13) and split-plan pieces generate as sibling parts rather than
multi-body single files — which is precisely the bug this section exists to fix.
