# Voyager AI — Product Design (v1 production)

**Status:** proposal for productionizing the POC · **Audience:** product + engineering
**Companion doc:** [`TECHNICAL_ARCHITECTURE.md`](./TECHNICAL_ARCHITECTURE.md)

---

## 1. Thesis

Voyager AI turns a plain-language description of a physical part into a **verified, printable,
parametric model** — and keeps the human in control of every dimension along the way.

The POC already proves the core loop: chat → clarify → design contract → build123d script →
STL/STEP → live viewport → iterate. Production is not "the POC but bigger"; it is three
deliberate bets layered on that loop:

1. **The Design Brief is the product.** A structured, machine-checkable specification that the
   AI co-authors with the user, that gates generation, and that verification is run *against*.
2. **Trust through verification, not vibes.** Every generated model ships with a verification
   report: deterministic geometry checks first, model-based review only for what can't be
   computed. Multi-model (Bedrock) is the tool here, not the headline.
3. **Human control at the script level.** Users adjust parameters, drag features, and revert
   versions without prompting the AI — because both the human and the AI edit the same
   artifact: the parametric script.

---

## 2. Where we are (POC recap)

Electron desktop app; one Claude Agent SDK session per project running on the **user's own
Claude subscription** via the Claude Code CLI; a bundled `printable-cad` skill enforcing a
phased workflow (printer constraints → clarify → confirm contract → generate → validate →
display); an in-process MCP server (`display_model`, `recommend_print_settings`, `set_status`);
three.js viewport with region-select, measurement, view cube, version history with revert, and
a print-settings panel. Everything runs on the user's machine; the company pays $0 of inference.

That last fact matters more than it looks: **moving to Bedrock means the company pays for
inference for the first time.** That single decision forces accounts, metering, quotas, and a
backend — most of the "productionization" work is downstream of it, not of any AI feature.

---

## 3. Positioning: "a competitor to Zoo" — challenged

Zoo (formerly KittyCAD) made two enormous bets we should not copy:

- **A proprietary geometry kernel** and a new modeling language (KCL). That is a decade-scale
  moat-building exercise aimed at professional mechanical engineers and at developers via API.
- **Text-to-CAD as an API primitive** — one-shot generation, developer-integrated.

Voyager's edge is orthogonal, and we should lean into the difference rather than the label:

| | Zoo | Voyager |
|---|---|---|
| Kernel | Proprietary (KittyCAD) | Open ecosystem (OCCT via build123d/CadQuery) |
| Interface | KCL code + API + design studio | Conversation + Design Brief + viewport |
| Unit of value | Geometry generation | **Verified, printable outcome** |
| Target user | Pro MEs, developers | Prosumer functional-print users → small eng. teams |
| Trust story | You review the code | The system reviews itself and shows you the report |

**ICP (initial):** the "functional print" prosumer — owns 1–3 printers, prints brackets,
enclosures, adapters, jigs; is dimension-literate but not CAD-fluent; today either fights
Fusion/FreeCAD or begs on forums. Print farms and hardware-adjacent engineers are the natural
second ring. We deliberately do **not** chase pro mechanical engineers in v1 — they need
assemblies, GD&T, and simulation, none of which we should build yet.

**Differentiators to defend:** (1) the brief→verify contract loop, (2) DFM-for-printing depth
(the skill's real IP), (3) manufacturable-outcome guarantees (fits *your* bed, split plans,
print settings), (4) the hybrid human/AI editing model.

---

## 4. The five founding ideas — each challenged, then shaped

The request was explicit: challenge every idea. Here is each one, the pushback, and what
survives.

### 4.1 "Pick models by complexity of the user's ask" — **mostly rejected, reshaped as role routing**

**Pushback.** Complexity-routing the *designer* is the wrong lever:

- CAD code generation is a frontier-hard task. The quality gap between a top-tier and a cheap
  model is not marginal — a failed generation costs a full retry loop (script run, export,
  validation, render), which is slower and more expensive than having used the strong model
  once. Routing pays off on high-volume easy tasks, and "design me a part" is never easy.
- "Complexity of what the user is asking" is unknowable before clarification. A one-line
  request ("a spool holder") can hide more geometric complexity than a paragraph.
- Bedrock's Intelligent Prompt Routing is built for general chat and routes within one model
  family — it has no notion of an agentic CAD task and shouldn't be in the designer path.

**What survives — route by *role*, not by guessed complexity:**

| Role | Task | Model class (Bedrock) | Why |
|---|---|---|---|
| Designer | Clarify + write/repair the parametric script (agent loop) | Strongest Claude (Opus tier) | Correctness dominates cost |
| Clarifier/intake | Extract structured brief fields from chat, summarize, title projects | Haiku tier | High volume, low stakes |
| Vision critic | Judge canonical renders vs. brief | Sonnet tier (vision) | Vision + judgment at mid cost |
| Cross-checker | Second-opinion code review (escalation only) | Different family (e.g. Nova / DeepSeek-R1 / Llama on Bedrock) | Diversity of failure modes |
| Router/misc | Classification, notifications | Cheapest / heuristics | Often no model at all |

Complexity can still modulate **effort within the designer role** (Claude's `effort` levels —
`medium` for a dimension tweak, `xhigh` for a novel part), which is cheaper and safer than
swapping models. That is the honest version of the original idea.

### 4.2 "Verify output across models" — **accepted with a hard hierarchy**

**Pushback.** LLM-verifies-LLM is the *last* resort, not the first. Most of what makes a CAD
output wrong is objectively computable: watertightness, bed fit, wall thickness, overhangs,
hole diameters, whether the brief's "40mm" is actually 40mm in the STEP file. Burning a second
model's tokens to "check" arithmetic a script checks perfectly is waste, and worse, it's less
reliable (models agree with each other; calipers don't).

**What survives — the verification pyramid** (cheap/deterministic at the bottom, expensive
judgment at the top; each layer only sees what the layers below can't decide):

1. **Static script checks** — parses, params block well-formed, no forbidden imports.
2. **Geometry validation** — extends the existing `validate_stl.py`: watertight/manifold, bed
   fit (any orientation), overhang fraction, min-feature scan, part interference (multi-body).
3. **Brief conformance** — *the killer feature*: every numeric field in the Design Brief
   becomes an automated assertion measured against the B-rep/mesh (bounding box, hole
   diameters and positions, wall thickness at named faces). "Spec: 40.0mm, Measured: 40.0mm ✓"
   in the report. No LLM involved.
4. **Vision critique** — a vision model reviews the deterministic render rig's canonical views
   against the brief and any user-uploaded reference image. It checks what geometry math
   can't: is a feature *missing*, misplaced, mirrored, mis-oriented; does this look like what
   was asked for. It is explicitly **forbidden from judging dimensions** — VLMs cannot
   measure, and pretending they can would poison trust in the report.
5. **Cross-model code review** — a different model family reviews the script against the
   brief. Runs only on escalation: first generation of a project, after N failed iterations,
   or on user request ("second opinion" button). Not on every tweak.

Verification output is a single **Verification Report** artifact per iteration (see §5.4) —
that report, not the multi-model machinery, is what the user sees and what marketing sells.

### 4.3 "Take images of models through a preview and have other models verify/suggest" — **accepted, but not the user's preview**

**Pushback.** Screenshotting the live viewport gives you whatever camera angle the user last
left it at, with selection highlights, gizmos, and theme colors baked in — useless for
systematic review, and it makes verification depend on client state.

**What survives.** A server-side, deterministic **render rig**: headless renders of every
iteration from a fixed camera protocol — 6 orthographic axis views + 2 isometric, plus
optional section cuts and a turntable strip — with consistent lighting, neutral material, and
a millimeter grid/scale reference in frame. These renders are:

- fed to the vision critic (4.2 layer 4),
- fed back to the **designer itself** before it declares success ("look at what you built" —
  self-inspection catches most gross errors at zero extra-model cost),
- stored as iteration thumbnails/history for the user,
- the basis for visual diffing between iterations ("what changed v3→v4").

### 4.4 "Standard-sized prompt / mandatory design request doc" — **goal accepted, mechanism rejected**

**Pushback.** A mandatory long-form intake form is an activation killer and pushes the cost of
ambiguity onto the party least equipped to resolve it. Hobbyists don't know their fit
tolerances or that an M3 clearance hole is modeled at 3.4mm — *teaching them that is the
product's job*, and the POC's clarify-phase already does it conversationally. Also,
"standard-sized" is the wrong constraint: prompt *size* doesn't need normalizing; prompt
*content* needs structuring.

**What survives — the Design Brief as a co-authored artifact, not a form:**

- **Structured schema** (see architecture doc §6): part identity/purpose, global envelope,
  features (holes with purpose, pockets, bosses, text…), materials & tolerance classes,
  explicit *don't-wants*, constraints (must fit bed / may be split / max pieces / orientation),
  reference images with at least one scaled dimension, acceptance criteria.
- **Three ways in, one artifact out:** (a) free-form chat — the clarifier extracts fields and
  the designer asks only for what's missing (current UX, kept); (b) the brief panel — a live
  side-by-side document the user can edit directly at any time; (c) template import — power
  users and repeat customers start from a filled template. All paths converge on the same
  schema.
- **Printer profiles are settings, not questions.** Bed size, nozzle, materials on hand live
  in a reusable machine profile (per printer, per user). The POC re-asks these every project —
  that stops. Constraints like "must be split into multiple prints" *derive automatically*
  from profile + requested envelope.
- **Completeness gates generation, not form-filling.** The brief has required fields per
  feature type; generation unlocks when the brief validates, however the fields got filled.
  The existing "confirm the design contract" moment becomes "review and lock the brief," and
  the locked brief version is stamped onto every iteration it produces.
- Because the brief is schema'd, it is **machine-checkable** — which is what makes
  verification layer 3 (brief conformance) possible. This is the deep reason to structure
  intake, and it's a much better justification than prompt-size hygiene.

### 4.5 "More 3D modeling tools so users don't fully rely on the AI" — **goal strongly accepted, scope aggressively cut**

**Pushback.** "3D modeling tools" read naively means mesh/B-rep direct editing — push/pull
faces, booleans, fillet tools. That path has two fatal problems: (1) it is the entire product
surface of Fusion/Onshape/Zoo, built over decades on purpose-built kernels — we would ship a
worse Tinkercad and starve the differentiating work; (2) **representation conflict**: the
source of truth is the parametric script. A manual mesh edit forks from the script, and the
next AI regeneration silently destroys it. Any manual tool that doesn't write back to the
script is a trap for the user.

**What survives — human editing at the same level the AI edits (the script):**

- **P0 — Parameter panel.** Generated scripts already carry named constants at the top; we
  formalize this into an annotated `PARAMS` block (name, value, unit, range, description). The
  client renders sliders/inputs; changing a value re-runs the script server-side and produces
  a new iteration in seconds, no LLM call, near-zero cost. This alone covers the majority of
  "make it 2mm wider" traffic that currently burns a full agent turn.
- **P1 — Direct manipulation mapped to parameters.** Drag a face/edge in the viewport; the
  system resolves which parameter(s) drive that geometry (via a feature↔parameter map the
  designer emits with each script) and turns the drag into a parameter change. Feels like
  CAD; is actually parameter editing; never forks the model.
- **P1 — Feature list.** A tree derived from the script's structure (base solid, holes,
  fillets…) supporting select-in-viewport, suppress/unsuppress, and "ask AI about this
  feature" — a precision upgrade over today's marquee region-select.
- **P2 — Constrained sketch-on-face** (add a hole/pocket on a picked face with numeric
  placement) — emitted *as script code*, so it stays in the single representation.
- **Explicit non-goals for v1:** mesh sculpting, freeform surfacing, a general boolean/CSG
  editor, assemblies with mating constraints, our own kernel. Written down so we can say no
  quickly. When a user genuinely needs those tools, the answer is not to rebuild them — it's
  the **graduation path to real CAD** (§5.5): they leave with the STEP, the script, and the
  brief, and optionally with plugins that carry the parameters along.

### 4.6 "Use Amazon Bedrock" — **accepted, with eyes open (and one alternative to keep on the table)**

**Pushback / trade-offs to acknowledge:**

- Bedrock's Claude surface trails the first-party API in features (no server-side web
  search/code execution, no Files/Batches/Models APIs, no automatic prompt caching — manual
  `cache_control` works; details in the architecture doc). None are blockers for our loop —
  we run our own sandbox anyway — but it's a real constraint list, not zero.
- The genuine wins: **multi-model under one roof** (Claude + Nova + Llama + Mistral +
  DeepSeek for the verifier/critic roles), AWS-native IAM/VPC/PrivateLink, Guardrails,
  marketplace billing, and — the sleeper enterprise feature — **"deploy into the customer's
  own AWS account"** as a sales motion.
- **Alternative to keep on the table:** *Claude Platform on AWS* (Anthropic-operated, SigV4
  auth, AWS billing, same-day feature parity, bare model IDs) for the Claude roles, with
  Bedrock's Converse API only for the non-Anthropic verifier models. Because we put every
  model call behind our own gateway (architecture doc §5), this stays a config decision, not
  an architecture decision — we don't have to be right about it today.

---

## 5. Product surface (v1)

### 5.1 The core journey

1. **Set up once:** account, printer profile(s) (bed, nozzle, materials), units.
2. **Start a design:** chat, brief panel, or template — or **import an existing model**
   (STEP/STL/3MF/OBJ, from anywhere — §5.6) and remix it. Attach reference photos/sketches.
3. **Clarify:** the agent asks only what the brief is missing; the brief panel fills in live
   on the side. User can type answers or edit fields directly — same thing.
4. **Lock the brief:** review the compact contract (today's Phase 3, now a real artifact with
   a version number). One click to lock and generate.
5. **Generate & verify:** progress narration (existing `set_status`), then the model appears
   *with its Verification Report* — geometry checks, brief conformance table, render strip,
   vision-critic notes. Failures block the "verified" badge, not the display.
6. **Iterate three ways:** parameter panel (instant, free), direct manipulation (instant,
   free), or chat/region-select (agent turn). Every path yields a new immutable iteration;
   revert works exactly as today.
7. **Make it printable:** bed-fit check against the *user's* profile; if oversized, the
   split-planner proposes cut planes + joint features (dowels/dovetail/screw bosses), each
   piece re-verified for bed fit; print settings on demand (existing tool, kept).
8. **Export:** per-part STL/STEP/3MF (parts are never silently merged into one file —
   §5.3), an explicit arranged-plate export, or the **graduation package** (§5.5) —
   geometry + script + brief + parameter manifest in one bundle. The user owns the full
   stack.

### 5.2 The Design Brief panel

Persistent right-hand document with completeness meter, per-field provenance (user-typed vs.
AI-inferred — inferred fields render in a distinct style until confirmed), lock/version
history, and diffing between brief versions. The brief is exportable/importable (JSON +
human-readable render) — this is also the B2B seed: a team lead writes briefs, others run them.

### 5.3 Multi-part projects, arrangement & split plans

Real projects are rarely one body: a box *and* its lid, a gear *pair*, a bracket set. The
POC's model — a project is one part with one iteration history — merges everything a script
produces into a single exported file. Production makes **parts first-class**:

- **A project holds parts; each part has its own script lineage, version history, and
  active iteration.** Everything that works per-project today (immutable iterations,
  revert, parameter panel) works per-part. Gear pairs (§5.7), split-plan pieces, and
  imported bases (§5.6) all land naturally as sibling parts. A parts panel lists them with
  visibility toggles and select/focus.
- **Arrangement: move parts around the viewport — as layout, never as geometry.** A
  move/rotate gizmo with ground-snap positions parts relative to each other; placements
  persist with the project. They're deliberately *not* baked into any script or mesh — the
  part's geometry stays pristine — but they're more than cosmetic: the AI receives the
  current arrangement as spatial context ("the lid is sitting 2mm above the box"), and
  verification runs **cross-part interference/clearance checks on the placed arrangement**.
  The boundary from §4.5 holds: this is snap-and-transform, not an assembly-constraint
  solver — no mates, no kinematics, and we say so.
- **Per-part export — parts are never silently merged.** Each part downloads individually
  (its active iteration's STL/STEP); "export all" produces *separate files* in one zip; and
  an explicit **plate export** exists for the one case where merging is the point — baking
  the current arrangement into a single STL as an arranged build plate.
- **Split plans** stay first-class objects (pieces, cut planes, joint types/clearances) and
  now simply *produce parts*: each piece gets its own bed-fit validation, placement, and
  export. Deterministic checks own "does each piece fit"; the AI owns "where should the
  seams go" (visible surfaces, strength across layer lines).

### 5.4 The Verification Report

Per-iteration artifact with a three-state badge (Verified ✓ / Warnings ⚠ / Failed ✗):

- Geometry: watertight, bed fit (orientation found), overhang %, min-feature warnings.
- **Brief conformance table:** every numeric spec vs. measured value, pass/fail.
- Render strip (canonical views) + vision-critic findings, each tagged `blocking` /
  `suggestion`, each dismissible by the user (dismissals are remembered on the brief).
- Cross-model review findings when that tier ran.

The report is shareable (link/PDF) — "I printed this because the report was green" is the
word-of-mouth artifact.

### 5.5 Graduation & CAD interoperability

**The concern:** users will eventually want to modify parts in real CAD — Fusion 360,
Onshape, FreeCAD, SolidWorks. If Voyager can't hand off cleanly, that's a ceiling on trust
("will I be stuck?") long before it's actual churn.

**The framing, challenged both ways.** Two tempting responses are both wrong. Pretending
users never leave breeds lock-in resentment and kills prosumer word-of-mouth. Chasing
**bidirectional sync** ("edit in Fusion, sync back") is the two-masters trap — external
edits fork from the parametric script, exactly the representation conflict that killed
direct mesh editing in §4.5, except now the second master lives in someone else's kernel.
The right shape is **one-way graduation, done so well it's a selling point**: your part
leaves with its geometry, its source code, and its spec. Zoo and the text-to-CAD crowd only
partially match that.

**The good news: we're already halfway there.** Every iteration exports **STEP** (true
B-rep, not a mesh) alongside STL, and STEP imports natively into Fusion, Onshape, FreeCAD,
and SolidWorks today — no plugin required. What STEP loses is design intent: no feature
tree, no parameters, no history. The interop ladder recovers as much of that as each target
allows:

| Tier | What the user gets | How |
|---|---|---|
| **0 — today** | Open the part in any real CAD | STEP/STL export (shipped); add 3MF. Document "Open in Fusion/Onshape" explicitly instead of leaving it as tribal knowledge |
| **1 — graduation package** | Geometry **+ full parametric source + spec** in one bundle | One-click export: STEP + 3MF + the build123d script + brief JSON + parameter manifest. build123d is pip-installable OSS — a power user keeps *complete* parametric control outside Voyager, forever |
| **2a — Onshape integration** | Iterations appear in an Onshape document automatically | Onshape is cloud+API-first: an integrated app (OAuth, no desktop install) pushes each iteration as a new document version. Technically the easiest deep integration |
| **2b — Fusion 360 add-in** | STEP import + Voyager's named parameters carried into Fusion | Python add-in: pulls iterations from Voyager, imports geometry, creates Fusion **user parameters** from the parameter manifest. (Honesty note: on an imported dumb solid those parameters document intent and feed the user's own downstream features — they don't retro-drive the imported B-rep. Driving comes at Tier 3) |
| **3 — native feature rebuild** (demand-gated) | A **real, editable feature tree** in the target CAD | We don't need to solve B-rep feature recognition (research-grade); we already *know* the features — the script and its manifest. Replay the constrained feature vocabulary (base solid, holes, fillets, chamfers, pockets, bosses) as native Fusion API features / Onshape FeatureScript. A genuine differentiator if Tier 1/2 demand proves it |

**Return path (not sync):** an externally edited STEP can come back into a Voyager project
as a reference/base solid the script builds on — useful ("I filleted it in Fusion, now add
the mounting holes"), but it enters as dumb geometry and the brief notes it. One-way in each
direction, never a sync loop.

Graduation events are tracked as a *healthy* signal, not churn — a user who graduates a
part trusts the tool enough to build on it, and the brief/script they leave with carries the
Voyager format with them.

### 5.6 Start from an existing model (import & remix)

Most real hobbyist projects don't start from zero — they start from a Thingiverse/Printables
download, a STEP file from a colleague, or a scan. A Voyager session can start from an
**imported model** that was never created by this app, and the capability is honest about
what each format allows instead of pretending all imports are equal:

- **STEP import → full remix.** OCCT/build123d reads STEP as a true solid. The script
  references it as the base and adds or cuts features parametrically — holes, bosses,
  fillets on new geometry — with the parameter panel working on everything Voyager added.
- **Mesh import (STL/3MF/OBJ) → mesh remix.** A triangle mesh is not a feature model, and
  converting one back into features is research-grade — we say so rather than fake it. What
  works, and works well: measure, orient, scale, **repair** (holes, degenerate faces),
  **split for the bed**, and **boolean surgery** — parametric features are modeled fresh
  and fused/subtracted into the mesh. "Fill this hole and re-drill it at 5mm" is a
  plug-and-recut boolean, so even existing-geometry edits are possible; what's *not*
  possible is a slider on geometry we didn't create.
- **Import-only is a complete use case.** Repair + verification (watertight, bed fit,
  overhangs) + split plan + print settings on a downloaded file involves zero generation —
  a cheap, high-frequency reason to open the app.
- **Scale is never assumed.** STL/OBJ are unitless; import asks the user to confirm one
  measured dimension ("this reads as 120mm wide — correct?") — the same never-guess-scale
  rule the skill applies to photos.
- **The representation stays unified** (§4.5's argument extended): the imported file
  becomes a base solid *referenced by the script*, so human and AI keep editing one
  artifact. The brief tracks the features Voyager adds; verification asserts only those;
  region-select works on imports for "this hole/this face" conversations.
- Mesh-lineage iterations export STL/3MF (no STEP — there's no B-rep to export);
  STEP-lineage keeps the full export set. Respecting the source model's license when
  remixing is the user's responsibility.

### 5.7 Mechanisms: gears done properly

Gears are a top-tier functional-print request (gearboxes, replacement appliance gears, RC
parts) — and the sharpest test of what "properly" means in this product. A freehand
LLM-modeled gear is bumps on a circle; a real one is an **involute profile** with a matched
module and pressure angle, FDM backlash allowance, undercut handling below the minimum
tooth count, and a mate it actually meshes with.

- **Strategy: vetted libraries, not hand-modeled teeth — and no framework switch.** Gear
  generation comes from established code-CAD gear libraries (candidates:
  `bd_warehouse.gear` — build123d-native, by the build123d author; `cq_gears` — CadQuery,
  the broadest type coverage incl. helical/herringbone/bevel/planetary/ring; `gggears` —
  build123d-compatible; a timeboxed spike picks the defaults per gear type). The tempting
  alternative — "switch to CadQuery for its gear ecosystem" — is **rejected**: both
  frameworks wrap the same OCCT kernel through the same OCP bindings, so a CadQuery-built
  gear drops into a build123d script at the shape level (STEP handoff as the fallback).
  Framework choice is per-library, not per-project; build123d stays the authoring API.
- **Gears are brief-first-class, and *pairs* are the unit of correctness.** The brief's
  gear feature carries module, tooth count, pressure angle, helix, bore/keyway, hub, and —
  critically — the mesh partner. Verification then checks what a caliper-and-formula pass
  can check: matched module/PA across a pair, center distance `m·(z₁+z₂)/2` (± profile
  shift), backlash within the FDM allowance, undercut warnings. Gear DFM numbers (minimum
  module vs. nozzle, print-flat orientation, herringbone preference for FDM) go into the
  skill's `design-for-printing.md` — the same single source of truth as everything else.
- **The pattern generalizes.** Gears are the first entry of a mechanism library
  (bd_warehouse also covers threads and fasteners; print-in-place hinges are already in
  the skill) — gears go first because demand and checkability are both highest.

### 5.8 What stays from the POC (deliberately)

Chat-first interaction; versioned never-overwrite iterations with revert; region-select →
agent context; viewport toolset (measure, wireframe, view cube, dimensions); print settings
panel; the `printable-cad` skill's phased discipline and DFM reference tables (now also the
source of truth for verification thresholds — one set of numbers, two consumers).

---

## 6. Packaging & pricing (directional)

Paying for inference forces this conversation now, not later:

- **Free / local:** the current desktop mode — BYO Claude subscription, everything runs
  locally. Costs us ~nothing, remains the community funnel and the dev harness.
- **Cloud Starter (~$15–25/mo):** hosted projects, N verified designs/mo, parameter edits
  free and unmetered (they cost us ~nothing — a deliberate pricing asymmetry that *teaches
  users the manual tools*, aligning cost incentives with the product bet in §4.5).
- **Pro (~$50–80/mo):** more designs, cross-model review tier, split planner, brief templates,
  priority queue.
- **Team/Enterprise:** shared brief libraries, admin, SSO — and **BYO-AWS**: the agent runtime
  and Bedrock calls deployed into the customer's account (their IAM, their data boundary,
  their negotiated Bedrock pricing). This is the Bedrock bet paying for itself.

Meter on **verified design iterations** (agent turns), never on parameter tweaks or renders.

## 7. Success metrics

- **Activation:** first verified model within 15 minutes of install/signup.
- **North star:** verified designs printed per active user per month (proxy: exports of
  green-badge iterations).
- **Trust:** first-generation brief-conformance pass rate; % of dimension errors caught by
  verification *before* the user notices (report catches vs. user-reported).
- **Control:** share of iterations from parameter panel / direct manipulation vs. chat
  (target: >40% non-chat by v1.1 — measures whether §4.5 worked).
- **Efficiency:** median iterations-to-accepted; inference cost per accepted design.

## 8. Top risks

1. **Backend pivot underestimated** — accounts/metering/sandboxing is more work than any AI
   feature. Mitigation: keep local mode alive as the fallback ship vehicle; phase the backend
   (architecture doc §11).
2. **Verification over-promise** — a green badge on a wrong part is worse than no badge.
   Mitigation: brief conformance only asserts what it measures; vision findings are labeled
   as opinions; badge semantics documented in-product.
3. **Param extraction brittleness** — the panel dies if scripts drift from the convention.
   Mitigation: PARAMS block is enforced by the skill *and* validated in CI of every iteration
   (a script that breaks the convention fails verification layer 1).
4. **Cost blowout on the designer role** — Opus-tier agent turns with renders and re-runs.
   Mitigation: prompt caching, effort modulation, free parameter-edit path absorbing tweak
   traffic, per-tier turn budgets.
5. **Zoo/Autodesk ship "good enough" text-to-CAD** — mitigation: our moat is the brief +
   verification + print-readiness loop, not raw generation; keep compounding DFM depth.
6. **Interop effort trap** — Tier 3 native rebuild (§5.5) is seductive and large; two
   plugin ecosystems (Autodesk + Onshape app stores) are a maintenance tax. Mitigation:
   Tier 1 (graduation package) ships almost for free and covers the trust story; every tier
   above it is gated on measured demand, not roadmap optimism.
