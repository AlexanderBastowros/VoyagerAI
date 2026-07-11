# Gears (mechanisms v1)

Gear teeth are **never hand-modeled** — a freehand "bumps on a circle" gear looks right and
meshes wrong. Every tooth profile in this skill comes from a vetted involute-gear library, and
every gear you generate is checked against the meshing math *before* you write the script, not
after. This file covers: which library to reach for per gear type, the math to confirm first,
the `PARAMS` convention for gear scripts, the clarify questions to ask, and the sibling-part
convention for a meshing pair.

See `references/design-for-printing.md` for general FDM rules (walls, overhangs, fit classes).
Gear-specific DFM numbers (minimum module vs. nozzle, herringbone preference for FDM, backlash
allowance) are **not yet in that file** — a contract-change request is filed for it (see
`agents/production-roadmap.md`'s WS-H entry). Until it lands, state your backlash/module choice
to the user explicitly rather than presenting it as a house default.

---

## 1. Library per gear type

A timeboxed spike (WS-H) evaluated three candidates. **No framework switch** — build123d stays
the authoring API; a CadQuery-built gear is a `TopoDS` shape that wraps into a build123d script
at the shape level (`Solid` construction from the CadQuery object's `.val().wrapped`, or a STEP
round-trip as the always-available fallback if the direct wrap gives you trouble).

| Gear type | Library | Why | Install |
|---|---|---|---|
| **Spur** (default) | `bd_warehouse.gear` (`SpurGear`) | build123d-native (same author as build123d), exact analytic involute (`InvoluteToothProfile`), Apache-2.0, actively maintained, plain PyPI package. | Eager — pre-installed in the managed env. |
| **Helical / herringbone** | `cq_gears` (CadQuery) | Only one of the three with herringbone (and helical ring-gear) coverage; its involute math is adapted from the long-standing `gears.scad`/`involute_gears.scad` OpenSCAD lineage that's specifically battle-tested in the FDM hobbyist community. **Caveat:** last tagged release is old (v0.45-alpha) and the README calls it "work in progress" — treat generated profiles as needing a visual sanity check against the analytic curve before trusting them blind. | Lazy — `pip install` on demand (see §2). |
| **Bevel, (external) ring, cycloid** | `py_gearworks` (formerly `gggears`) | build123d-native (no CadQuery bridge), has a `mesh_to()` helper for placing a mate at the correct center distance, more actively maintained than `cq_gears`. **Caveat:** the project states its own API "has no stability yet" — pin the exact tag you install, don't float `@main`. | Lazy — `pip install` on demand (see §2), same as `cq_gears`, despite not needing CadQuery — its pre-1.0 status argues for opt-in, not baking it into every project's environment. |
| **Planetary gearsets, gear racks** | `cq_gears` (CadQuery) | Only candidate with explicit planetary/rack builders. | Lazy, same as helical/herringbone above. |
| **Worm gears** | *(none of the three)* | Not covered by any candidate's gear module in this spike. **Do not hand-model a worm gear.** Tell the user it's not supported yet (v2 backlog item) rather than approximating one. | — |

If a script needs a bore or hub the chosen library doesn't parameterize directly (e.g.
`bd_warehouse.gear.SpurGear` has no `bore`/`hub` args), cut it yourself with an ordinary
build123d boolean subtract/union after generating the gear body — same pattern as any other
hole (`references/build123d.md`'s vertical-hole section).

### Installing a lazy gear library

Mirrors the existing CadQuery lazy-install path (`SKILL.md`'s Environment section):

```bash
# Helical / herringbone / planetary / racks
pip install cadquery
pip install "cq_gears @ git+https://github.com/meadiode/cq_gears.git@v0.45-alpha"

# Bevel / ring / cycloid (build123d-native, no CadQuery needed)
pip install "py_gearworks @ git+https://github.com/GarryBGoode/py_gearworks.git@v0.0.18"
```

Pin the tag shown above (not `@main`) — both projects say up front that their APIs aren't
stable yet, and a floating install can silently change tooth geometry between sessions. If an
install fails (no network, no `git` on PATH), say so to the user and fall back to a spur gear or
a STEP-handoff plan rather than hand-modeling the requested profile.

### CadQuery → build123d handoff

```python
import cadquery as cq
from cq_gears import SpurGear  # or HelicalGear, etc.
from build123d import Solid, export_step, export_stl

cq_gear = cq.Workplane("XY").gear(SpurGear(module=1.5, teeth_number=20,
                                            width=6.0, bore_d=6.0))
gear_shape = Solid(cq_gear.val().wrapped)   # wrap the OCP TopoDS_Shape directly

# ...continue the script in build123d (bosses, chamfers, etc.) using gear_shape like
# any other build123d Shape, then export as usual:
export_stl(gear_shape, "gear_v1.stl", tolerance=0.01, angular_tolerance=0.1)
export_step(gear_shape, "gear_v1.step")
```

If the direct `Solid(...)`-from-`wrapped` construction misbehaves for a given cq_gears/py_gearworks
version, fall back to a STEP round-trip instead — export the CadQuery/py_gearworks object to a
temporary STEP file, then `import_step()` it into the build123d script. Slower, but always works
since both frameworks read/write the same STEP format.

---

## 2. Confirm the meshing math BEFORE generating

This is the "properly" test for gears — do this arithmetic and state it back to the user in the
Phase 3 design-contract table, the same as any other DFM decision. Never generate a meshing pair
without doing it.

1. **Module and pressure angle must match across every declared mesh pair.** Module sets tooth
   size (`pitch diameter = module × teeth`); pressure angle sets the tooth's pressure/flank angle
   (commonly 20°, sometimes 14.5°). Two gears with different module or pressure angle **cannot
   mesh** — this isn't a tolerance question, it's a hard incompatibility. If the user specifies
   a mate's module/PA and it doesn't match the gear you're about to generate, stop and flag it.
2. **Helix angle must match in magnitude across a helical/herringbone pair** (opposite hand for
   an ordinary parallel-shaft external mesh — same hand only for the less-common crossed-axis
   case). A spur gear cannot mesh with a helical one.
3. **Center distance for a spur (or helical, using the transverse module) pair:**

   ```
   center_distance_mm = module_mm * (teeth_1 + teeth_2) / 2      # spur, no profile shift
   transverse_module_mm = module_mm / cos(helix_deg)             # helical correction
   center_distance_mm = transverse_module_mm * (teeth_1 + teeth_2) / 2
   ```

   This is the distance between the two gears' bore axes. If the pair generates as **sibling
   parts** (the normal case, §4 below), this is also the distance you place the two parts apart
   with the placement gizmo / `Placement.position` — get it right or the pair won't mesh in the
   viewport, let alone in real life. Profile-shifted gears (non-zero addendum modification) shift
   this distance; v1 doesn't cover profile shift — flag it to the user rather than silently
   ignoring a requested shift.

4. **Undercut minimum tooth count** — a standard full-depth involute gear with no profile shift
   undercuts (weakens/removes material at the tooth root) below a pressure-angle-dependent
   minimum tooth count:

   ```
   min_teeth ≈ 2 / sin(pressure_angle)²        # ≈ 17 at 20° PA, ≈ 32 at 14.5° PA
   ```

   For a helical gear, use the **virtual (formative) tooth count** instead of the real count —
   helical gears resist undercut better at a given real tooth count:

   ```
   virtual_teeth = teeth / cos(helix_deg)³
   ```

   If a gear's (virtual) tooth count is below the minimum for its pressure angle, tell the user:
   fewer teeth means a weaker root, and the options are more teeth, a larger module, profile
   shift (not covered in v1), or accepting the tradeoff for a low-load/idle gear.

5. **Backlash** — FDM parts print slightly oversized on internal/positive features and undersized
   on features that rely on flow-fill, so a pair modeled at the exact theoretical center distance
   with zero backlash will usually bind. Apply *some* backlash; the exact allowance is a DFM
   number that belongs in `design-for-printing.md` (pending contract-change — see the top of this
   file). Until it lands, state the backlash value you used and why, the same way you'd flag any
   other un-sourced number.

---

## 3. PARAMS conventions for gears

Each gear script's `PARAMS` block should expose the numbers that define the tooth form and mesh
so a slider actually re-runs a mesh-compatible gear, not an arbitrary one:

```python
# --- PARAMS ---
MODULE = 1.5          # unit=mm min=0.5 max=5 label="Module"
TEETH = 20             # unit=count min=6 max=200 label="Tooth count"
PRESSURE_ANGLE = 20.0  # unit=deg min=14.5 max=25 label="Pressure angle"
HELIX_ANGLE = 0.0      # unit=deg min=-45 max=45 label="Helix angle (0 = spur)"
BORE_D = 6.0           # unit=mm min=2 max=50 label="Bore diameter"
BACKLASH = 0.10        # unit=mm min=0 max=0.5 label="Backlash allowance (per flank)"
# --- END PARAMS ---
```

- `MODULE`/`PRESSURE_ANGLE`/`HELIX_ANGLE` are the values a verification pass matches across a
  declared `meshesWith` pair — keep the constant names exactly this way (`MODULE`,
  `PRESSURE_ANGLE`, `HELIX_ANGLE`) so a future automated reader doesn't have to guess.
  `TEETH` deliberately differs between the two gears in a pair (that's the point of a gear
  *ratio*) — don't expect it to match.
- `BACKLASH` is the convention this skill uses to record how much tooth-thickness (or
  center-distance) allowance a script applied for FDM printing — record it even before
  `design-for-printing.md` has an official number, so the value is at least visible and
  re-runnable.
- Optional: `HUB_D`/`HUB_H` (unit=mm) if the gear has a raised hub around the bore.
- Printer constants (`NOZZLE`, `BED_X/Y/Z`) stay outside the block as usual (SKILL.md Phase 4).

---

## 4. Gear pairs generate as sibling PARTS, never one multi-body file

A meshing pair is **two parts**, one gear each — call `display_model` once per gear with a
distinct `part` slug (e.g. `part="pinion"`, `part="wheel"`), never both gear bodies unioned (or
even just co-located) into a single exported file. This is what lets each gear keep its own
version history and revert independently, and what lets the viewport's placement gizmo position
them at the correct center distance (§2.3) instead of baking a fixed relative position into the
geometry. If the project is still single-part (WS-I not active in a given build), fall back to
one file per gear exported separately and say so to the user — never merge two gears' geometry
into one body to work around a missing parts model.

---

## 5. Clarify questions (Phase 2 — ask these, don't guess)

A gear is never a standalone shape request — it's a member of a mechanism. Treat these as
mandatory alongside the existing checklist (`references/clarify-checklist.md`):

- **"What does it mesh with?"** — the mating gear's tooth count (and, if the user already has
  it, its module/PA). This is as mandatory as "what's the hole for?" A bare "make me a gear"
  prompt should stop here, not produce an unmated guess.
- **Module or diametral pitch?** — get one number, in the user's preferred system, and confirm
  the DP↔module conversion out loud if they gave DP (`module_mm = 25.4 / DP`).
- **Pressure angle** — default 20° (the modern standard) unless the user names a system that
  implies 14.5° (older/AGMA-legacy hardware they're replacing a part for).
- **Spur, helical, or herringbone?** — herringbone prints flat without the axial thrust helical
  gears need a thrust bearing for; mention this tradeoff if the user hasn't already decided.
- **Bore/keyway/hub** — what shaft does it mount on, and how (press-fit bore, keyway, set screw
  flat, hex bore)?
- **Load-bearing?** — feeds the undercut-tolerance conversation (§2.4) and the print-orientation
  recommendation (gears print flat, teeth-up, to keep the involute profile in-plane rather than
  built from stepped layers).
- **Replacing an existing/broken gear?** — if so, ask for a tooth count *and* a caliper
  measurement of the outer diameter so you can cross-check the implied module
  (`module_mm ≈ OD_mm / (teeth + 2)`) rather than trusting a single number.
