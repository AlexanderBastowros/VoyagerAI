# Remix: working from an imported model

Most real projects don't start from zero - a Thingiverse/Printables download, a colleague's
STEP file, or a scan. This reference covers what's possible once Voyager imports one as a
project's base, and - critically - what's honest to promise vs. not, per format.

## Table of contents
1. The capability rule: format is destiny
2. The unit-confirmation rule (never guess scale)
3. STEP lineage: ordinary parametric editing
4. Mesh lineage: boolean surgery, not sliders
5. The repair pass
6. Boolean-surgery patterns (plug-and-recut and friends)
7. What to tell the user

---

## 1. The capability rule: format is destiny

Voyager's import pipeline records every import as a normal iteration (`createdBy: 'import'`),
displayed and verified like any other version. But what you can do to it *next* depends
entirely on which format it came in as - never pretend otherwise:

- **STEP → full parametric remix.** It's a true B-rep. Treat `base` exactly like any other
  build123d shape: add features, cut features, fillet/chamfer new geometry, and export STEP
  again at the end. Nothing about Phase 4's discipline changes.
- **STL / OBJ / 3MF → mesh remix only.** A triangle mesh has no feature history to recover -
  reverse-engineering one into parametric features is research-grade, and this skill does not
  attempt it. What *is* real and reliable: measure, orient, scale, **repair**, **split for the
  bed**, and **boolean surgery** (fuse or subtract a parametrically-modeled tool shape into the
  mesh). Say this plainly to the user rather than promising sliders you can't deliver - **never
  put a mesh-lineage dimension in a PARAMS block.** A mesh-lineage iteration has no PARAMS at
  all (the generated import script has none) until a later edit adds one for a shape genuinely
  fused in on top.

Check `manifest.json`'s `importedBase.lineage` (`"step"` or `"mesh"`) before promising the user
anything about what a follow-up edit can do - it's the single source of truth for which of the
two rules above applies to the part in front of you.

## 2. The unit-confirmation rule (never guess scale)

STEP and 3MF carry real-world units; STL and OBJ do not - a "40" in the file could mean 40 mm,
40 inches, or 40 of whatever units the original author's software assumed. Voyager's import
dialog already enforces this at the door for STL/OBJ: it measures the raw bounding box, shows
the user one dimension ("this reads as 120mm wide - correct?"), and only finalizes the import
once they confirm or correct it. This is the same never-guess-scale discipline Phase 2 applies
to photos (SKILL.md's golden rule) - **you never need to ask about it yourself**, because by the
time an imported part reaches you in chat, its scale is already confirmed and baked into the
mesh on disk. If a user pastes in raw STL/OBJ content some other way and asks you to treat it as
real-world dimensions without going through the import dialog, apply the same rule you already
know: ask for one confirmed real-world measurement before treating anything as authoritative.

## 3. STEP lineage: ordinary parametric editing

The generated import script is unremarkable - it just starts from `import_step` instead of a
primitive:

```python
from build123d import export_step, export_stl, import_step

base = import_step("imports/<id>.step")

# Ordinary build123d from here - add_features, cut, fillet, whatever the user asked for.
with BuildPart() as part:
    add(base)
    # ...

export_stl(part.part, "./outputs/<part>_vN.stl", tolerance=0.01, angular_tolerance=0.1)
export_step(part.part, "./outputs/<part>_vN.step")
```

Once you add a dimension worth exposing (a hole diameter, a boss height), give it a normal
`# --- PARAMS ---` entry per SKILL.md Phase 4 - the parameter panel then scopes itself to
exactly the features Voyager added, never to the imported base's own (unexposed) geometry.

## 4. Mesh lineage: boolean surgery, not sliders

A mesh-lineage edit follows the same shape every time: load the mesh, build a small solid tool
with build123d (or use a trimesh primitive directly), mesh the tool if needed, boolean it into
the base, repair, export. There is no PARAMS block for the base mesh's own dimensions - if the
user wants to "make the base bigger," that's a fresh scale/repair pass at the file level, not a
slider (§1).

```python
import trimesh

base = trimesh.load("imports/<id>.stl", force="mesh")

# Build the tool with whichever is more convenient - build123d + a mesh export for anything with
# real geometry (fillets, drafts), or a bare trimesh primitive for something simple:
tool = trimesh.creation.cylinder(radius=2.5, height=20)  # e.g. a straight-through hole
tool.apply_translation([x, y, z])

from mesh_ops_reference import robust_boolean  # see §6 - inline this, don't import cross-project
result = robust_boolean("subtract", base, tool)

result.export("./outputs/<part>_vN.stl")
```

`packages/agent-core/remix/boolean_ops.py` in the app's own source is the reference
implementation for `robust_boolean` above (union/subtract/intersect, `manifold3d`-engine
preferred) - copy its approach directly into the generated script rather than trying to import
it (it lives outside the project directory and isn't shipped into `imports/`/`outputs/`; every
generated script must stay self-contained so the user can hand it to someone else with nothing
more than `pip install trimesh manifold3d`, matching the graduation package's promise that every
exported script just re-runs).

If `manifold3d` isn't installed yet, `pip install manifold3d` into the current environment first
(same "large optional wheel, install lazily" pattern the skill already documents for CadQuery) -
`trimesh.boolean.engines_available` is empty without it, and the boolean call raises a clear,
actionable error rather than a silent wrong result.

**Mesh-lineage exports are STL/3MF only - never STEP.** There is no B-rep to hand back; don't
offer a STEP export you can't produce (`resolveExportSource` already degrades gracefully for an
iteration recorded with no `stepPath`, exactly like this).

## 5. The repair pass

Voyager's import pipeline runs a repair pass automatically at import time for mesh lineage,
before the first iteration is ever recorded - it fills simple holes, drops degenerate/duplicate
faces, and merges coincident vertices, then reports exactly what it changed (folded into the
iteration's summary text, visible in chat/version history). You don't need to re-run this
yourself on a freshly-imported base.

You *do* need to repeat the same discipline on any mesh you produce mid-edit (a boolean result
can reintroduce a bad edge), so always finish a mesh-remix script with the same shape of pass
before exporting - `packages/agent-core/remix/repair_mesh.py` is the reference implementation:

```python
nd_mask = mesh.nondegenerate_faces()
if not nd_mask.all():
    mesh.update_faces(nd_mask)
uniq_mask = mesh.unique_faces()
if not uniq_mask.all():
    mesh.update_faces(uniq_mask)
mesh.merge_vertices()
mesh.remove_unreferenced_vertices()
```

Note what this does **not** attempt: `trimesh.repair.fill_holes`/`fix_normals` both hard-require
`networkx`, which is not in Voyager's managed environment's package list (build123d, trimesh,
numpy only - `packages/agent-core/src/python/envManager.ts`). If a repaired mesh is still not
watertight after your own hole-fill attempt, say so plainly and suggest the user try a different
source file or accept the geometry as-is for non-critical prints - don't claim a fix that didn't
happen. Check `mesh.is_watertight` after any edit and report it truthfully.

## 6. Boolean-surgery patterns (plug-and-recut and friends)

- **Plug-and-recut** ("fill this hole and redrill it at 5mm"): union a plug solid (sized
  slightly larger than the existing hole, extending through the wall) into the base, repair,
  then subtract a fresh tool at the new position/size. Two booleans, one edit - the existing
  hole never has to be "found and edited" the way a parametric feature would be; it's just
  destroyed and remade.
- **Adding a hole**: subtract a cylinder (or teardrop/diamond profile per DFM §3 for a
  horizontal hole - the same overhang rule applies to a mesh-remixed hole as a from-scratch
  one) sized per the same clearance-class table as any other hole (DFM §4 - press/snug/free/
  loose). Nothing about the DFM numbers changes because the base came from an import.
- **Adding a boss/standoff**: union a cylinder or prism onto the base's surface; if it needs a
  hole through it, subtract that as a second boolean, exactly as if you were adding a boss to a
  from-scratch part (DFM §8's hardware-pocket sizing still applies).
- **Trimming/splitting**: subtract a half-space (a large box positioned so one face passes
  through the split plane) to cut a mesh in two for bed-fit, same DFM §10 sizing as splitting a
  generated part.

Always sanity-check the tool's placement against the base's measured bounding box before
committing to the boolean - a tool positioned from a guess rather than the actual imported
geometry's dimensions is exactly the kind of silent-wrong-result this skill's golden rule exists
to prevent.

## 7. What to tell the user

- On a successful mesh import with a repair report: mention what changed in plain language
  ("I found and filled one small hole from the file - it's watertight now") rather than
  reciting the raw report string.
- Before any mesh-lineage edit, if the user asks for something the format can't do (a slider,
  reconstructing a feature history, re-flowing a fillet), say so and explain the boolean-surgery
  alternative instead of attempting something that will silently degrade the geometry.
  "Sliders" is the wrong verb for mesh edits - each request becomes a fresh regeneration, exactly
  like any other iteration, just with a boolean instead of a from-scratch build.
- Licensing is the user's responsibility when remixing someone else's file - it's fine to note
  this once, briefly, but not to gate the workflow on it.
