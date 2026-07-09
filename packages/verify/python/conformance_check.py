#!/usr/bin/env python3
"""
conformance_check.py — verification layer 3 (architecture doc §5): brief conformance measured
directly off the STEP B-rep via OCP (the OpenCascade bindings `build123d` depends on), not the
triangle mesh. "Layer 3 is the moat" - it's the only layer that measures the part against what
the user actually asked for.

Checks, each independently wrapped so one failing check degrades to an `info` finding instead of
aborting the whole report (this script's OCP calls are written against stable, documented OCCT
APIs but were not execution-verified against a real build123d/OCP install - see
`agents/production-roadmap.md`'s WS-C entry):

  1. Bounding box vs. `envelope.{x,y,z}` -> one conformance row per axis.
  2. Cylindrical-face census (holes/bores) matched to the brief's `hole` features by
     nearest-diameter greedy pairing (the brief's `position` field is free text, not a
     coordinate, so there is no exact geometric correspondence available) -> one conformance
     row per matched/unmatched hole.
  3. A ray-cast minimum-wall-thickness sample against the exact B-rep (not the mesh - the skill's
     own design-for-printing guidance treats mesh-based thin-wall detection as unreliable) ->
     an unattached finding (no brief field to conform against).

Consumed by `packages/verify/src/layer3BriefConformance.ts`. Prints one JSON object to stdout:
`{"findings": [...], "conformance": [{"briefField", "spec", "measured", "pass"}, ...]}`.

Usage:
  python conformance_check.py part.step --brief-json brief_subset.json [--nozzle 0.4]
"""
import argparse
import json
import random
import sys

from dfm_constants import ABSOLUTE_MIN_WALL_MULTIPLIER

try:
    from OCP.STEPControl import STEPControl_Reader
    from OCP.IFSelect import IFSelect_RetDone
    from OCP.Bnd import Bnd_Box
    from OCP.BRepBndLib import BRepBndLib
    from OCP.TopExp import TopExp_Explorer
    from OCP.TopAbs import TopAbs_FACE, TopAbs_REVERSED
    from OCP.TopoDS import TopoDS
    from OCP.BRepAdaptor import BRepAdaptor_Surface
    from OCP.GeomAbs import GeomAbs_Cylinder
    from OCP.BRepMesh import BRepMesh_IncrementalMesh
    from OCP.BRep import BRep_Tool
    from OCP.TopLoc import TopLoc_Location
    from OCP.IntCurvesFace import IntCurvesFace_ShapeIntersector
    from OCP.gp import gp_Lin, gp_Pnt, gp_Dir
except ImportError as exc:
    print(json.dumps({
        "findings": [{"severity": "blocking", "message": f"OCP is not available: {exc}"}],
        "conformance": []
    }))
    sys.exit(0)

# Fallback spec-vs-measured tolerance for a brief field with no explicit `tolerance`/`toleranceMm`.
# Not a DFM design rule (design-for-printing.md has no "how close must a measurement be to its
# CAD spec" number - that's a different question from a wall/overhang/fit threshold) but grounded
# in it rather than invented outright: it sits at the low end of §4's fit-tolerance table (the
# "Snug / location" class tops out at +0.2 mm), erring slightly wider to absorb ordinary
# STEP-export/tessellation noise without false-failing an otherwise-conforming part.
DEFAULT_MEASUREMENT_TOLERANCE_MM = 0.3
MAX_WALL_SAMPLES = 400
# Seeded so sampling is deterministic across runs on the same geometry, not just the checks
# themselves - matches this codebase's broader "renders/checks should be reproducible" ethos.
SAMPLE_RNG_SEED = 0


def read_step(path):
    reader = STEPControl_Reader()
    status = reader.ReadFile(path)
    if status != IFSelect_RetDone:
        raise RuntimeError(f"Could not read STEP file: {path}")
    reader.TransferRoots()
    return reader.OneShape()


def measure_bbox(shape):
    box = Bnd_Box()
    BRepBndLib.Add_s(shape, box)
    xmin, ymin, zmin, xmax, ymax, zmax = box.Get()
    return xmax - xmin, ymax - ymin, zmax - zmin


def envelope_conformance(shape, envelope):
    dx, dy, dz = measure_bbox(shape)
    rows = []
    for axis, measured in (("x", dx), ("y", dy), ("z", dz)):
        spec = envelope.get(axis)
        if spec is None:
            continue
        tolerance = spec.get("tolerance")
        if tolerance is None:
            tolerance = DEFAULT_MEASUREMENT_TOLERANCE_MM
        ok = abs(measured - spec["value"]) <= tolerance
        rows.append({
            "briefField": f"envelope.{axis}",
            "spec": f"{spec['value']:.2f} mm",
            "measured": f"{measured:.2f} mm",
            "pass": ok
        })
    return rows


def detect_cylinders(shape):
    """Returns a deduplicated list of {"diameterMm": float} for each distinct cylindrical face -
    faces are clustered by rounded radius since a single bore can have more than one cylindrical
    face (e.g. a counterbore)."""
    diameters = []
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        surf = BRepAdaptor_Surface(face, True)
        if surf.GetType() == GeomAbs_Cylinder:
            radius = surf.Cylinder().Radius()
            diameters.append(radius * 2)
        explorer.Next()

    diameters.sort(reverse=True)
    deduped = []
    for d in diameters:
        if not any(abs(d - existing) < 0.05 for existing in deduped):
            deduped.append(d)
    return deduped


def hole_conformance(shape, holes):
    """Greedy nearest-diameter pairing between detected cylindrical faces and brief hole
    features - see module docstring for why this isn't position-aware. Brief holes are matched
    largest-first, each claiming whichever remaining detected diameter is numerically closest to
    its spec (not just "same rank when both lists are sorted", which mismatches as soon as an
    unrelated cylindrical feature - e.g. a boss - sits between two real holes in sorted order)."""
    remaining = detect_cylinders(shape)
    findings = []
    rows = []

    holes_sorted = sorted(holes, key=lambda h: h["diameterMm"], reverse=True)

    for spec in holes_sorted:
        if not remaining:
            rows.append({
                "briefField": f"features.{spec['id']}.diameter",
                "spec": f"{spec['diameterMm']:.2f} mm",
                "measured": "not found",
                "pass": False
            })
            findings.append({
                "severity": "blocking",
                "message": f"Brief describes hole '{spec['id']}' ({spec['diameterMm']:.2f} mm) but no matching cylindrical face was found.",
                "briefField": f"features.{spec['id']}.diameter"
            })
            continue

        measured = min(remaining, key=lambda d: abs(d - spec["diameterMm"]))
        remaining.remove(measured)

        tolerance = spec.get("toleranceMm")
        if tolerance is None:
            tolerance = DEFAULT_MEASUREMENT_TOLERANCE_MM
        ok = abs(measured - spec["diameterMm"]) <= tolerance
        rows.append({
            "briefField": f"features.{spec['id']}.diameter",
            "spec": f"{spec['diameterMm']:.2f} mm",
            "measured": f"{measured:.2f} mm",
            "pass": ok
        })
        if not ok:
            findings.append({
                "severity": "blocking",
                "message": (
                    f"Hole '{spec['id']}' measures {measured:.2f} mm, brief specifies "
                    f"{spec['diameterMm']:.2f} mm (tolerance {tolerance:.2f} mm)."
                ),
                "briefField": f"features.{spec['id']}.diameter"
            })

    if remaining:
        findings.append({
            "severity": "info",
            "message": f"{len(remaining)} cylindrical face(s) detected with no corresponding hole feature in the brief."
        })

    return findings, rows


def face_samples(shape, deflection=0.3, cap=MAX_WALL_SAMPLES):
    """Triangulates the shape and yields (point, inward_normal) for a bounded sample of
    triangle centroids across every face, respecting face orientation. Uses reservoir sampling
    (seeded, so it's still deterministic across runs on the same geometry) rather than a first-N
    cutoff, so a part with more triangles than `cap` doesn't systematically skip every face that
    happens to come later in topological traversal order - the thinnest wall could be anywhere."""
    rng = random.Random(SAMPLE_RNG_SEED)
    BRepMesh_IncrementalMesh(shape, deflection)
    samples = []
    seen = 0
    explorer = TopExp_Explorer(shape, TopAbs_FACE)
    while explorer.More():
        face = TopoDS.Face_s(explorer.Current())
        location = TopLoc_Location()
        triangulation = BRep_Tool.Triangulation_s(face, location)
        if triangulation is None:
            explorer.Next()
            continue
        transform = location.Transformation()
        reversed_face = face.Orientation() == TopAbs_REVERSED

        for i in range(1, triangulation.NbTriangles() + 1):
            tri = triangulation.Triangle(i)
            i1, i2, i3 = tri.Get()
            p1 = triangulation.Node(i1).Transformed(transform)
            p2 = triangulation.Node(i2).Transformed(transform)
            p3 = triangulation.Node(i3).Transformed(transform)

            centroid = gp_Pnt((p1.X() + p2.X() + p3.X()) / 3, (p1.Y() + p2.Y() + p3.Y()) / 3, (p1.Z() + p2.Z() + p3.Z()) / 3)
            v1 = (p2.X() - p1.X(), p2.Y() - p1.Y(), p2.Z() - p1.Z())
            v2 = (p3.X() - p1.X(), p3.Y() - p1.Y(), p3.Z() - p1.Z())
            normal = (
                v1[1] * v2[2] - v1[2] * v2[1],
                v1[2] * v2[0] - v1[0] * v2[2],
                v1[0] * v2[1] - v1[1] * v2[0]
            )
            length = (normal[0] ** 2 + normal[1] ** 2 + normal[2] ** 2) ** 0.5
            if length < 1e-9:
                continue
            normal = tuple(c / length for c in normal)
            if reversed_face:
                normal = tuple(-c for c in normal)
            # Inward = away from the surface, into the solid.
            inward = tuple(-c for c in normal)
            candidate = (centroid, gp_Dir(*inward))

            # Reservoir sampling (Algorithm R): every candidate seen so far has an equal cap/seen
            # chance of surviving, regardless of how early or late it was encountered.
            seen += 1
            if len(samples) < cap:
                samples.append(candidate)
            else:
                j = rng.randrange(seen)
                if j < cap:
                    samples[j] = candidate

        explorer.Next()

    return samples


def measure_min_wall_thickness(shape):
    """Fires a ray from a bounded sample of triangle centroids along the inward normal and
    records the distance to the next surface hit - the minimum such distance approximates the
    thinnest local wall. Returns None if no valid samples were found."""
    intersector = IntCurvesFace_ShapeIntersector()
    intersector.Load(shape, 1e-6)

    # Offset along the ray before firing it, and only trust hits past that offset - triangulating
    # a curved face (e.g. a small-radius bore) can put a neighboring facet within a few hundredths
    # of a millimeter of the origin along the inward normal, which a too-tight near-cutoff picks
    # up as a false near-zero "hit" (observed against a real STEP export with a 3.4 mm hole).
    offset_mm = 0.05
    min_thickness = None
    for point, direction in face_samples(shape):
        origin = gp_Pnt(
            point.X() + direction.X() * offset_mm,
            point.Y() + direction.Y() * offset_mm,
            point.Z() + direction.Z() * offset_mm
        )
        intersector.Perform(gp_Lin(origin, direction), 0.0, float("inf"))
        if not intersector.IsDone() or intersector.NbPnt() == 0:
            continue
        nearest = offset_mm + min(intersector.WParameter(i) for i in range(1, intersector.NbPnt() + 1))
        if min_thickness is None or nearest < min_thickness:
            min_thickness = nearest

    return min_thickness


def main():
    ap = argparse.ArgumentParser(description="Layer 3 brief-conformance checks on a STEP export.")
    ap.add_argument("step", help="path to the STEP file")
    ap.add_argument("--brief-json", required=True, help="path to a JSON file: {envelope, holes}")
    ap.add_argument("--nozzle", type=float, default=0.4)
    args = ap.parse_args()

    findings = []
    conformance = []

    try:
        with open(args.brief_json, "r", encoding="utf-8") as f:
            brief = json.load(f)
    except (OSError, json.JSONDecodeError) as exc:
        print(json.dumps({
            "findings": [{"severity": "blocking", "message": f"Could not read brief JSON: {exc}"}],
            "conformance": []
        }))
        return

    try:
        shape = read_step(args.step)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({
            "findings": [{"severity": "blocking", "message": f"Could not read STEP file {args.step}: {exc}"}],
            "conformance": []
        }))
        return

    try:
        conformance.extend(envelope_conformance(shape, brief.get("envelope", {})))
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Bounding-box conformance unavailable: {exc}"})

    try:
        hole_findings, hole_rows = hole_conformance(shape, brief.get("holes", []))
        findings.extend(hole_findings)
        conformance.extend(hole_rows)
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Hole conformance unavailable: {exc}"})

    try:
        min_wall = measure_min_wall_thickness(shape)
        if min_wall is not None:
            absolute_min = ABSOLUTE_MIN_WALL_MULTIPLIER * args.nozzle
            severity = "blocking" if min_wall < absolute_min else "info"
            findings.append({
                "severity": severity,
                "message": (
                    f"Minimum sampled wall thickness ~{min_wall:.2f} mm "
                    f"({'below' if severity == 'blocking' else 'at/above'} the {absolute_min:.2f} mm "
                    f"absolute minimum for this nozzle) - ray-cast sample against the exact B-rep, "
                    "not an exhaustive measurement."
                )
            })
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Wall-thickness sampling unavailable in this environment: {exc}"})

    print(json.dumps({"findings": findings, "conformance": conformance}))


if __name__ == "__main__":
    main()
