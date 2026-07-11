---
name: printable-cad
description: >-
  Generate functional, ready-to-print 3D models as parametric Python code using
  build123d or CadQuery, with design-for-FDM-printing rules baked in (minimum wall
  thickness from nozzle size, overhang limits, hole compensation, fit tolerances,
  hardware pockets, bed-size fitting). Use this skill WHENEVER the user wants to
  design or model a physical printable part — brackets, enclosures, mounts, adapters,
  gears, jigs, fixtures, knobs, clips, print-in-place mechanisms — or mentions
  cadquery, build123d, STL, STEP, "parametric part," "3D model for printing," or
  uploads a photo/sketch/drawing of a part they want made. Trigger even if they don't
  name a CAD tool: any request to turn dimensions or a picture into a printable model
  belongs here. Do NOT use for slicing, printer firmware, mesh sculpting (Blender),
  or artistic/organic models with no functional dimensions.
---

# Printable CAD

> **Voyager AI adaptation note:** this is a lightly adapted copy of the `printable-cad`
> skill, embedded in the Voyager AI desktop app. Two changes from the original:
> (1) artifacts are saved to the project-local `./outputs/` directory instead of
> `/mnt/user-data/outputs/`, and (2) Phase 6 uses Voyager's native viewer via the
> `display_model` MCP tool instead of generating `viewer.html` with `preview.py`.
> Everything else — including Phase 5 validation — is unchanged.

Turn a user's requirements into a **parametric, printable** 3D model using code-CAD
(build123d or CadQuery), exported to STL + STEP, with the design-for-manufacturing
rules of FDM printing applied automatically.

The value of this skill is twofold: (1) it never guesses — it extracts every dimension
and tolerance from the user before writing a line of code, and (2) it encodes the
hard-won rules of *what actually prints well*, so the output is a part that comes off
the bed usable, not a geometrically-correct model that fails on the printer.

## The golden rule: assume nothing

A model is only useful if its dimensions are correct, so **never invent a dimension,
tolerance, orientation, or feature the user didn't give you.** If something is
unspecified, ask. It is always cheaper to ask one more question than to generate a
part that's wrong. This applies especially to anything derived from a photo — you can
read *shape* from an image but you can **never** read true *scale* from one. See
`references/clarify-checklist.md` for the full list of things that are commonly left
ambiguous and must be pinned down.

Work through the phases below in order. Do not skip to code generation.

---

## Phase 1 — Setup (do this first, every session)

If the host application's system prompt provides a saved printer profile, treat it as the
answers to the questions below and do not re-ask them; skip to the confirm-with-defaults
items.

Before discussing the part at all, establish the two printer constraints. These drive
minimum wall thickness and maximum part size, so they gate every later decision. Ask
them together, up front:

1. **Nozzle diameter?** (e.g. 0.4 mm — the most common). This sets:
   - **Minimum structural wall** = 2 × nozzle (two perimeters). For 0.4 mm → 0.8 mm absolute floor; **default to ≥ 3 perimeters (1.2 mm)** for anything load-bearing.
   - **Minimum printable feature width** (a rib, a pin, embossed text stroke) = ~2 × nozzle.
2. **Print bed size?** (X × Y × Z in mm, e.g. 256 × 256 × 256). This sets the **maximum part envelope**. Reserve a margin (~5 mm per side) for brim/skirt. If the part won't fit, you'll either reorient it, split it into joined pieces, or tell the user — never silently produce something unprintable.

Also confirm, with sensible defaults (state the default, let the user override — don't interrogate):
- **CAD framework** — default **build123d**; use **CadQuery** if the user prefers it or already has a CadQuery codebase.
- **Units** — default **millimeters** (standard for FDM).
- **Material** — only matters if it affects clearances/warp advice; ask only if relevant (e.g. print-in-place, tight fits, or a large flat ABS part prone to warping).

Store these as the top constants of the generated script (`NOZZLE`, `BED_X`, `BED_Y`,
`BED_Z`, `MIN_WALL`) so the DFM rules are visible and tunable.

---

## Phase 2 — Specify the part (interrogate until zero ambiguity)

Get the user's description, dimensions, and any uploaded photos/sketches. Then close
every gap. Read `references/clarify-checklist.md` and walk it — it lists the specific
questions that catch the ambiguities people don't think to state: which face sits on
the bed (print orientation), wall thicknesses, every hole's diameter *and its purpose*
(clearance vs. tapped vs. press-fit — this changes the modeled size), fillets vs.
chamfers, mating tolerances, hardware (screws, heat-set inserts, captive nuts,
bearings, magnets), and text.

**On uploaded images:** describe back what you see and label every feature, then ask
the user to supply the real-world dimension of at least one feature so you can
establish scale. Never scale off pixels. If a drawing has dimensions, read them back
to confirm you've parsed them correctly (including which are diameters vs. radii).

If the user is vague ("make it sturdy," "a normal-size hole"), translate to numbers
and confirm — don't proceed on an adjective.

---

## Phase 3 — Confirm the design contract

Before writing code, restate the **complete** specification as a compact table:
every dimension, every hole, every tolerance, the print orientation, the framework,
and which DFM rules you'll apply automatically (e.g. "bottom edges chamfered 0.5 mm
at 45° for support-free printing and elephant's-foot relief," "M3 clearance holes
modeled at 3.4 mm," "0.3 mm clearance on the print-in-place hinge"). Get an explicit
"yes, generate it" before proceeding. This is the last cheap moment to catch a
misunderstanding.

---

## Phase 4 — Generate the model

Write a **single parametric script** with all dimensions as named constants at the top,
grouped and commented, so the user can tweak and re-run. Follow the framework cookbook
for idioms: `references/build123d.md` or `references/cadquery.md`.

### The PARAMS block

Every script's user-tunable dimensions go in one annotated block, delimited by exact
marker comments, with one bare assignment per line:

```python
# --- PARAMS ---
WIDTH = 40.0     # unit=mm min=10 max=200 label="Width" brief=envelope.x
HEIGHT = 20.0    # unit=mm min=5 max=100 label="Height" brief=envelope.y
HOLE_D = 3.4     # unit=mm min=2 max=10 label="Mounting hole diameter"
# --- END PARAMS ---
```

Rules (a script that breaks these fails layer-1 verification and can't be extracted):
- One `NAME = VALUE` per line — a bare numeric literal, never an expression
  (`MIN_WALL = 3 * NOZZLE` stays *outside* the block, as an ordinary derived constant).
- `NAME` is `UPPER_SNAKE_CASE`.
- The trailing comment carries space-separated `key=value` annotations. `unit` and
  `label` are required on every line; `min`/`max` are optional (include them whenever a
  DFM rule or common sense bounds the value — e.g. a hole can't shrink to 0); `brief`
  is an optional back-reference to a locked Design Brief field (e.g. `envelope.x`) once
  one exists.
- Only put dimensions a user would plausibly want to slide/type here — the part's real
  shape-defining numbers (width, height, hole size, wall thickness, hardware clearances).
  Printer constants from Phase 1 (`NOZZLE`, `BED_X/Y/Z`) don't need to be in the block.

This block is what powers the parameter panel's sliders (instant, no-agent-turn
re-generation) — nothing else about how you write the script changes.

Apply these DFM rules automatically while modeling — they are the point of the skill.
The full rationale and numbers are in `references/design-for-printing.md`; the
essentials:

- **Walls** ≥ `MIN_WALL`. Never emit a wall thinner than 2 × nozzle. Flag it if the
  user's own dimension forces a thinner wall.
- **Overhangs** — keep unsupported faces within **45° of vertical**. Prefer a **45°
  chamfer** over a fillet on downward-facing / bottom edges (fillets droop and may need
  support; a 45° chamfer prints clean). Fillets are fine on top and vertical edges.
- **Holes** — orient holes vertically (axis along Z) where possible. For **horizontal**
  holes, use a **teardrop or diamond** profile so the top doesn't sag. Compensate size
  by purpose: clearance holes for hardware are modeled at nominal + clearance (see the
  hardware table in the DFM reference), not at nominal.
- **First-layer / elephant's foot** — add a small (~0.4–0.6 mm) 45° chamfer to the
  bottom outer edge and to the bottoms of bores that must stay dimensionally accurate.
- **Orientation for strength** — layer bonding is weakest in Z; orient so loads don't
  pull layers apart. Note the intended print orientation in a comment.
- **Fits & print-in-place** — apply the clearance class the user chose (press / snug /
  free / print-in-place). Never model mating parts at identical nominal size.
- **Hardware pockets** — size heat-set-insert bosses, captive-nut hex pockets,
  counterbores/countersinks, magnet/bearing pockets from the reference tables, not from
  memory.

**Export** both:
- **STL** (`.stl`) — mesh for slicing/printing. Use a fine deflection so curves are smooth.
- **STEP** (`.step`) — parametric B-rep for re-editing and sharing.
- Offer **3MF** as well when the user's slicer prefers it.

Save outputs to the project's `./outputs/` directory (relative to the working
directory). Save the script there too. Version every artifact per iteration:
`<part>_vN.py`, `<part>_vN.stl`, `<part>_vN.step` — N starts at 1 and increments on
each refinement, so earlier iterations are never overwritten.

Then extract the manifest — a trivial, deterministic parse of the PARAMS block, **no
LLM involved**, which is exactly why it must run as a separate command rather than being
hand-typed:

```bash
python scripts/extract_params.py <part>_vN.py --out <part>_vN.manifest.json
```

Save `<part>_vN.manifest.json` next to that version's STL, same basename as the
script/STL/STEP so it's versioned identically. If it exits non-zero, the PARAMS block
has a grammar error — fix the block (not the extractor) and re-run it before continuing;
never write manifest.json by hand.

---

## Phase 5 — Validate

Run the validator on the exported STL:

```bash
python scripts/validate_stl.py <part>.stl --bed-x <X> --bed-y <Y> --bed-z <Z> --nozzle <N>
```

It reports: **watertight/manifold** (a non-watertight mesh may slice wrong), **bounding
box vs. bed** (does it fit, in any of the three axis-aligned orientations), and an
**overhang analysis** (fraction of downward-facing surface steeper than 45°, i.e. what
would need support). Read the results back to the user and, if something's off, fix the
model — don't just report the problem.

Minimum-wall correctness is enforced at **design** time (Phase 4), not measured on the
mesh, because thin-wall detection on a triangle soup is unreliable. If the user forced a
sub-minimum wall, that's flagged in Phase 4.

Before moving to Phase 6, call the `render_views` MCP tool on the STL you just validated
and actually look at the result. It renders 6 orthographic views (front/back/left/right/
top/bottom) plus 2 isometric angles — fixed lighting, a neutral material, and an mm grid
in frame — so you can check what you built, not just what the numbers say. Look at every
view against the brief/request: is a feature missing, misplaced, mirrored, or
mis-oriented; does the silhouette match what was asked for. This is a sanity check, not a
measurement tool — it cannot judge dimensions (that's already covered above); use it to
catch the gross, obvious errors dimension checks can't (a hole on the wrong face, a
mirrored bracket, a boss floating in space). If something looks wrong, fix the model and
re-validate/re-render before displaying it — don't display a model you haven't looked at.
If the tool reports that rendering isn't available in this session, don't block on it —
proceed to Phase 6.

---

## Phase 6 — Display and iterate

Voyager AI has a built-in 3D viewport — do **not** generate `viewer.html` with
`preview.py`. Instead, after the STL validates and you've looked at its renders, call the
`display_model` MCP tool:

- `stl_path` — path to the exported STL (required)
- `step_path` — path to the exported STEP (if produced)
- `script_path` — path to the parametric Python script
- `summary` — one or two sentences: what the part is, key dimensions, and which DFM
  rules were applied

The model appears in the user's viewport immediately. Then invite corrections in chat.
Expect iteration — re-run Phases 4–6 as parameters change, incrementing the version
number on every regeneration and calling `display_model` again each time.

The user may highlight a region of the displayed model; their next message will then
include a machine-generated "Selected region" context block with the region's bounding
box, centroid, and size in model coordinates (mm). Use it together with your parametric
script to identify which feature they mean, and confirm your interpretation ("that's
the left mounting hole — correct?") before regenerating if there's any ambiguity.

Every displayed version is also snapshotted by Voyager to `./outputs/versions/<part>/vN.py`
(an exact copy of the script that produced version N of that part — `<part>` is `main` for
a single-part project). If the user reverts to an earlier version, their next message will
include a machine-generated "Reverted model" context block naming that version and its
snapshot script. Treat that script as the current source of truth — copy it forward to the
next `<part>_vN.py` and modify that, rather than continuing from a later version you
generated earlier.

Print settings (below) are an optional follow-up step once the user is happy with the model —
don't volunteer them unasked.

---

## Phase 7 — Print settings (on request)

When the user asks for print settings, slicer settings, or "how do I print this," call the
`recommend_print_settings` MCP tool rather than answering in prose. Recommend concrete FDM
settings tailored to the part's geometry, the material (ask if it wasn't already established in
Phase 1/2 and it matters — e.g. PLA vs. PETG vs. ABS changes temps and bed adhesion needs), and
the DFM decisions already baked into the model (wall counts, overhangs, orientation from Phase 4):

- **Layer height** — finer (0.12–0.16 mm) for visible detail or small text/threads, coarser
  (0.24–0.28 mm) for a quick strength part with no fine features; 0.2 mm is a reasonable default.
- **Walls/perimeters** — match or exceed the `MIN_WALL`-derived perimeter count from Phase 1/4;
  load-bearing parts want more (4+), decorative parts can use fewer.
- **Top/bottom layers** and **infill** — denser (30%+, a strong pattern like gyroid or cubic) for
  load-bearing parts; sparse (10–15%, grid) for a display or fit-check part.
- **Supports** — "None" if every overhang is within the 45° rule already applied in Phase 4,
  otherwise flag which faces need "Touching build plate" or "Everywhere" supports.
- **Adhesion** — "Brim" for small footprints or tall/thin parts prone to tipping, "Raft" for
  warp-prone materials (ABS) or minimal first-layer contact, "None"/"Skirt" otherwise.
- **Temps and speed** — standard ranges for the chosen material.
- **Orientation** — restate the print orientation from Phase 4's DFM notes (which face sits on
  the bed and why).

The tool records which model version (`iteration`) the recommendation is for automatically — you
don't set it. The settings render as a list in Voyager's print-settings panel, above the chat;
after calling the tool, a short chat reply ("Settings are up in the panel above") is enough — you
don't need to repeat every value in prose too.

---

## Environment / dependencies

Voyager AI provisions a managed Python environment with **build123d**, **trimesh**, and
**numpy** pre-installed; the `python` on PATH is that environment — use it directly for
generation and validation. If a package is unexpectedly missing, `pip install` it into
the current environment (CadQuery, if the user prefers it, may need installing this
way; its OCP wheel is large, so the first install can take a minute). If an install
fails, say so and give the user the finished script, still applying every DFM rule and
the confirm-the-contract discipline.

---

## Reference files

- `references/clarify-checklist.md` — the anti-ambiguity checklist. Read at Phase 2, every time.
- `references/design-for-printing.md` — DFM rules and all the numbers (walls, overhangs, holes, fit-tolerance classes, hardware/insert/nut/countersink tables, text, splitting for bed). Read at Phase 4.
- `references/build123d.md` — build123d cookbook: idiomatic patterns for the common printable features.
- `references/cadquery.md` — CadQuery cookbook: the same patterns in the fluent API.
