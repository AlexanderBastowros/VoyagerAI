# CadQuery cookbook

The same printable features in CadQuery's fluent (chaining) API. Constants at the top -
user-tunable ones go in the `PARAMS` block (SKILL.md Phase 4), derived/printer constants
stay outside it. `Workplane` selectors (`faces`, `edges`, `>Z`, `<Z`, `|Z`) do the feature
targeting.

```python
import cadquery as cq

NOZZLE   = 0.4
MIN_WALL = 3 * NOZZLE
BED_X, BED_Y, BED_Z = 256, 256, 256
EF_CHAMFER = 0.5

# --- PARAMS ---
WIDTH = 40.0    # unit=mm min=10 max=200 label="Width"
DEPTH = 30.0    # unit=mm min=10 max=200 label="Depth"
HEIGHT = 20.0   # unit=mm min=5 max=100 label="Height"
# --- END PARAMS ---
```

## Basic solid + export

```python
part = cq.Workplane("XY").box(L, W, H)
cq.exporters.export(part, "part.stl", tolerance=0.01, angularTolerance=0.1)
cq.exporters.export(part, "part.step")
```

## Shelled enclosure (open top)

```python
box = (cq.Workplane("XY")
       .box(L, W, H)
       .faces(">Z").shell(-MIN_WALL))   # negative = inward wall; removes selected face
```

## Vertical holes, counterbore, countersink

```python
part = (cq.Workplane("XY").box(L, W, H)
        .faces(">Z").workplane()
        .pushPoints([(-10, 0), (10, 0)])
        .hole(3.4))                                   # M3 clearance dia (DFM §8)

cbore = (cq.Workplane("XY").box(L, W, H)
         .faces(">Z").workplane()
         .cboreHole(3.4, 5.5, 3.2))                   # dia, cbore dia, cbore depth (M3 cap)

csink = (cq.Workplane("XY").box(L, W, H)
         .faces(">Z").workplane()
         .cskHole(3.4, 6.0, 90))                      # dia, csink dia, angle (M3 flat)
```

## Horizontal hole → teardrop (self-supporting)

```python
def teardrop_cutter(radius, length, apex_ratio=1.4):
    prof = (cq.Workplane("XZ")
            .moveTo(-radius, 0).lineTo(0, radius*apex_ratio).lineTo(radius, 0)
            .threePointArc((0, -radius), (-radius, 0)).close())
    return prof.extrude(length, both=True)

part = cq.Workplane("XY").box(L, W, H)
part = part.cut(teardrop_cutter(3.4/2, W).translate((0, 0, 0)))
```

## Chamfer the bottom (support-free) / fillet the top

Bottom/overhang edges want chamfers, not fillets (DFM §2, §6).

```python
part = (cq.Workplane("XY").box(L, W, H)
        .edges("<Z").chamfer(EF_CHAMFER)     # lowest edges -> elephant's-foot relief
        .edges(">Z").fillet(2))              # highest edges -> comfortable top
```

Useful selectors: `"|Z"` vertical edges, `">Z"`/`"<Z"` top/bottom faces or edges,
`"%CIRCLE"` circular edges, and string combos like `edges("|Z and >X")`.

## Heat-set insert boss

```python
INSERT_OD, INSERT_LEN, BOSS_WALL = 4.0, 5.7, MIN_WALL
boss = (cq.Workplane("XY")
        .circle(INSERT_OD/2 + BOSS_WALL).extrude(INSERT_LEN + 1)
        .faces(">Z").workplane()
        .hole(INSERT_OD - 0.15, INSERT_LEN)          # OD minus 0.15 mm bite
        .edges(">Z and %CIRCLE").chamfer(0.6))       # lead-in
```

## Captive hex-nut pocket

Across-flats + 0.2 mm; `polygon(6, diameter)` where diameter is across-corners.

```python
NUT_AF, NUT_T = 5.5, 2.4                              # M3 (confirm standard)
across_corners = (NUT_AF + 0.2) / (3**0.5/2)         # AF -> across-corners
part = (cq.Workplane("XY").box(L, W, H)
        .faces(">Z").workplane()
        .polygon(6, across_corners).cutBlind(-(NUT_T + 0.2)))
```

## Print-in-place clearance

Keep a gap ≥ `JOINT_GAP` between members (DFM §5): e.g. captive ring inner radius =
post radius + `JOINT_GAP` (default 0.4 mm for a 0.4 mm nozzle).

## Patterns & symmetry

- `.rarray(xs, ys, nx, ny)` — rectangular grids of points.
- `.polarArray(radius, startAngle, angle, count)` — bolt circles.
- `.pushPoints([...])` — explicit placements.
- `.mirror("YZ")` / `union` with a mirrored copy — enforce symmetry.

## Common exports

```python
cq.exporters.export(part, "part.stl", tolerance=0.01, angularTolerance=0.1)
cq.exporters.export(part, "part.step")
cq.exporters.export(part, "part.3mf")
```
