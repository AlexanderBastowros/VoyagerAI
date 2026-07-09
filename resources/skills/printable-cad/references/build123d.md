# build123d cookbook

Idiomatic **builder-mode** patterns for the printable features you'll reach for most.
Put all dimensions in named constants at the top of the script - user-tunable ones go
in the `PARAMS` block (SKILL.md Phase 4), derived/printer constants stay outside it.
build123d centers primitives at the origin by default (`Align.CENTER`); pass `align=` to
change datum.

```python
from build123d import *

# ---- printer constraints (from Phase 1) ----
NOZZLE   = 0.4
MIN_WALL = 3 * NOZZLE          # structural default = 1.2 mm
BED_X, BED_Y, BED_Z = 256, 256, 256
EF_CHAMFER = 0.5               # elephant's-foot relief

# --- PARAMS ---
WIDTH = 40.0    # unit=mm min=10 max=200 label="Width"
DEPTH = 30.0    # unit=mm min=10 max=200 label="Depth"
HEIGHT = 20.0   # unit=mm min=5 max=100 label="Height"
# --- END PARAMS ---
```

## Basic solid + export

```python
L, W, H = 40, 30, 20
with BuildPart() as part:
    Box(L, W, H)

export_stl(part.part, "part.stl", tolerance=0.01, angular_tolerance=0.1)
export_step(part.part, "part.step")
```

Keep STL `tolerance` small (≈0.01 mm) so curved surfaces are smooth for slicing.

## Shelled enclosure (open-top box)

```python
WALL, FLOOR = MIN_WALL, MIN_WALL
with BuildPart() as box:
    Box(L, W, H)
    # hollow it, removing the top (+Z) face -> wall thickness = -WALL (inward)
    top = box.faces().sort_by(Axis.Z)[-1]
    offset(amount=-WALL, openings=top)
```

For a lid, model it separately and apply a snug/free fit (DFM §4) on the lip.

## Vertical holes, counterbore, countersink

```python
with BuildPart() as part:
    Box(L, W, H)
    top = part.faces().sort_by(Axis.Z)[-1]
    with BuildSketch(top):                     # place holes on the top face
        with GridLocations(20, 0, 2, 1):       # two holes 20 mm apart
            Circle(3.4 / 2)                     # M3 clearance = 3.4 mm dia (DFM §8)
    extrude(amount=-H, mode=Mode.SUBTRACT)     # drill down through

# CAUTION: extrude goes along the face normal. On the TOP face (normal +Z) use a
# NEGATIVE amount to cut downward INTO the part. On the BOTTOM face (normal -Z) a
# positive amount cuts upward into the part. Get the sign wrong and it extrudes into
# air and removes nothing — verify by checking the part volume actually dropped.

# Or use the dedicated hole ops at a location:
with BuildPart() as part2:
    Box(L, W, H)
    with Locations(part2.faces().sort_by(Axis.Z)[-1]):
        CounterBoreHole(radius=3.4/2, counter_bore_radius=5.5/2,
                        counter_bore_depth=3.2)          # M3 socket-cap head
        # CounterSinkHole(radius=3.4/2, counter_sink_radius=6.0/2,
        #                 counter_sink_angle=90)         # M3 flat head
```

## Horizontal hole → teardrop (self-supporting)

A circle with a 45° roof so the top doesn't sag when the hole axis is horizontal.

```python
def teardrop(radius, apex_ratio=1.4):
    # sketch: circle + triangle roof meeting at a point above center
    with BuildSketch() as sk:
        Circle(radius)
        with BuildLine():
            Line((-radius, 0), (0, radius * apex_ratio))
            Line((0, radius * apex_ratio), (radius, 0))
            Line((radius, 0), (-radius, 0))
        make_face()
    return sk.sketch

with BuildPart() as part:
    Box(L, W, H)
    # cut a horizontal hole along Y through the block
    with BuildSketch(Plane.XZ):                # a plane whose normal is Y
        add(teardrop(3.4/2))
    extrude(amount=W, both=True, mode=Mode.SUBTRACT)
```

## Chamfer the bottom (support-free) / fillet the top

Bottom/overhang edges want chamfers, not fillets (DFM §2, §6). `group_by(Axis.Z)[0]`
is the lowest ring of edges; `[-1]` the highest.

```python
with BuildPart() as part:
    Box(L, W, H)
    chamfer(part.edges().group_by(Axis.Z)[0], length=EF_CHAMFER)   # elephant's-foot relief
    fillet(part.edges().group_by(Axis.Z)[-1], radius=2)            # comfortable top edge
```

Select more precisely with filters: `part.edges().filter_by(Axis.Z)` (vertical edges),
`.filter_by(GeomType.CIRCLE)` (round edges), or `.filter_by_position(Axis.Z, minz, maxz)`.

## Heat-set insert boss

Boss hole ≈ insert OD − 0.1..0.2 mm; wall ≥ 2× insert wall; lead-in chamfer on top
(DFM §8). Confirm the insert's datasheet OD with the user.

```python
INSERT_OD, INSERT_LEN, BOSS_WALL = 4.0, 5.7, MIN_WALL
with BuildPart() as boss:
    Cylinder(INSERT_OD/2 + BOSS_WALL, INSERT_LEN + 1,
             align=(Align.CENTER, Align.CENTER, Align.MIN))
    with Locations((0, 0, INSERT_LEN + 1)):
        Hole(radius=(INSERT_OD - 0.15)/2, depth=INSERT_LEN)
    chamfer(boss.edges().group_by(Axis.Z)[-1].filter_by(GeomType.CIRCLE), length=0.6)
```

## Captive hex-nut pocket

Across-flats = nut AF + 0.2 mm; depth = nut thickness + 0.2 mm (DFM §8).

```python
NUT_AF, NUT_T = 5.5, 2.4        # M3 nut (confirm standard)
with BuildPart() as part:
    Box(L, W, H)
    with Locations((0, 0, H/2)):                      # pocket from a face
        with BuildSketch():
            RegularPolygon(radius=(NUT_AF + 0.2)/2/ (3**0.5/2), side_count=6)
        extrude(amount=-(NUT_T + 0.2), mode=Mode.SUBTRACT)
    # add the screw clearance hole through the pocket as needed
```

(`RegularPolygon` radius is circumradius; across-flats = 2 · circumradius · cos30°, hence the divide.)

## Print-in-place clearance

Model the two members with a gap ≥ `JOINT_GAP` between them (DFM §5).

```python
JOINT_GAP = 0.4
# e.g. a captive ring around a post: post radius = R, ring inner radius = R + JOINT_GAP
```

## Patterns & symmetry

- `GridLocations(x_spacing, y_spacing, x_count, y_count)` — rectangular arrays.
- `PolarLocations(radius, count)` — bolt circles, gear-like arrays.
- `Locations((x,y,z), ...)` — explicit placements.
- `mirror(obj, about=Plane.YZ)` — enforce symmetry instead of duplicating math.

## Common exports

```python
export_stl(part.part, "part.stl", tolerance=0.01, angular_tolerance=0.1)
export_step(part.part, "part.step")
export_3mf(part.part, "part.3mf", tolerance=0.01, angular_tolerance=0.1, unit=Unit.MM)
```
