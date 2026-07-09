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
  part: { name: string; purpose: string; referenceImages: ImageRef[] }  // images carry ≥1 user-scaled dimension
  printer: PrinterProfileRef          // bed XYZ, nozzle Ø, materials — reusable, per-user settings
  envelope: { x: Dim; y: Dim; z: Dim }       // Dim = { value, unit, tolerance?, provenance: 'user'|'inferred' }
  features: Feature[]                 // discriminated union: hole {Ø, purpose: clearance|tapped|press_fit,
                                      //   position}, pocket, boss, fillet/chamfer, text, insert{type, size}…
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
  iterations/{n}/ script.py · manifest.json · part.stl · part.step · part.3mf
                 · renders/{front,back,left,right,top,bottom,iso1,iso2}.png
                 · report.json
  attachments/{uploadId}
```

Postgres: `users`, `printer_profiles`, `projects`, `briefs(project, version, json, locked_at)`,
`iterations(project, n, brief_version, s3_prefix, badge, created_by: agent|param|revert)`,
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

| # | Milestone | Contents | Done when |
|---|---|---|---|
| **M0** | Extract the core | `packages/agent-core` (session loop, prompts, MCP tools, skill, project semantics) + `packages/verify` (validator → library); Electron main becomes a thin host. Pure refactor | POC works exactly as before; existing vitest suites pass against the packages |
| **M1** | Brief + verification, still local | Brief schema/panel/extraction; PARAMS convention in the skill; parameter panel; verification layers 1–3 + render rig running locally; printer profiles | Box-with-holes flow produces a brief, a conformance table, and slider edits |
| **M2** | Bedrock, single model | Model gateway; Agent SDK → Bedrock in a dev account; auth + minimal metering; session runtime containerized; WS transport carrying the existing event vocabulary | Full design loop runs server-side with the client pointed at the cloud |
| **M3** | Multi-model verification | vision_critic on the render rig; clarifier extraction on Haiku-tier; Verification Report UI complete; prompt caching + usage accounting | Report ships with every iteration; cost per accepted design measured |
| **M4** | Control & printability | Direct manipulation via manifest bindings; feature list; split planner + multi-piece verification | >X% of iterations are non-chat (product metric §7) |
| **M5** | Productization | Web client GA, billing/tiers, cross_checker escalation tier, BYO-AWS deployment recipe | First paying cohort |

**Decisions deliberately deferred:** Bedrock vs. Claude Platform on AWS for Claude roles
(gateway config — decide at M2 with real feature/latency data); which non-Anthropic
cross-checker (decide at M3 via the eval suite); web-client-first vs Electron-first for cloud
mode (M2 spike: the renderer is already plain React+three.js — the preload/IPC layer is the
only Electron coupling).
