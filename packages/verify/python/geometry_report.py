#!/usr/bin/env python3
"""
geometry_report.py — verification layer 2 (architecture doc §5): the mesh-level checks
`validate_stl.py` already does (watertight/manifold, bed-fit, overhangs), grown with a
multi-body interference proxy and a coarse thin-feature smell test, emitted as JSON findings
rather than the human-readable text `validate_stl.py` prints (that script's CLI contract is
owned by the skill's Phase 5 and stays untouched - this is a separate, automatic-pipeline sibling).

Consumed by `packages/verify/src/layer2Geometry.ts`. Prints one JSON object to stdout:
`{"findings": [{"severity": ..., "message": ...}, ...]}`.

Deliberately does NOT attempt a real per-point wall-thickness ray-cast on the mesh - the skill's
own design-for-printing guidance treats mesh-based thin-wall detection as unreliable (a "triangle
soup"); the real ray-cast thickness check lives in layer 3, on the exact B-rep via OCP. This
script's thin-feature check is intentionally coarse: a per-body bounding-box floor, `suggestion`
severity only, never blocking.

Usage:
  python geometry_report.py part.stl --bed-x 256 --bed-y 256 --bed-z 256 --nozzle 0.4
"""
import argparse
import itertools
import json
import sys

from dfm_constants import ABSOLUTE_MIN_WALL_MULTIPLIER

try:
    import numpy as np
    import trimesh
except ImportError:
    print(json.dumps({
        "findings": [{"severity": "blocking", "message": "Requires numpy and trimesh: pip install trimesh numpy"}]
    }))
    sys.exit(0)


def aabb_overlap(bounds_a, bounds_b):
    """Two (2,3) numpy bounds arrays ([min], [max]) overlap iff they overlap on every axis."""
    return bool(np.all(bounds_a[0] <= bounds_b[1]) and np.all(bounds_b[0] <= bounds_a[1]))


def face_groups_by_connectivity(mesh):
    """Groups face indices into connected components via a plain union-find over
    `mesh.face_adjacency` - deliberately not `mesh.split()`, which needs an optional graph
    engine (networkx/scipy) that isn't a hard trimesh dependency and isn't guaranteed to be in
    the managed venv. `face_adjacency` itself is pure numpy, so this has no extra dependency."""
    n = len(mesh.faces)
    parent = list(range(n))

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    def union(a, b):
        ra, rb = find(a), find(b)
        if ra != rb:
            parent[ra] = rb

    for a, b in mesh.face_adjacency:
        union(int(a), int(b))

    groups = {}
    for i in range(n):
        root = find(i)
        groups.setdefault(root, []).append(i)
    return list(groups.values())


def bounds_for_faces(mesh, face_indices):
    """Bounding box (2,3) of the vertices touched by a set of face indices - avoids building a
    full submesh Trimesh object just to read its bounds."""
    vertex_indices = np.unique(mesh.faces[face_indices].flatten())
    points = mesh.vertices[vertex_indices]
    return np.array([points.min(axis=0), points.max(axis=0)])


def main():
    ap = argparse.ArgumentParser(description="Layer 2 geometry checks, JSON output.")
    ap.add_argument("stl", help="path to the STL file")
    ap.add_argument("--bed-x", type=float, default=None)
    ap.add_argument("--bed-y", type=float, default=None)
    ap.add_argument("--bed-z", type=float, default=None)
    ap.add_argument("--nozzle", type=float, default=0.4)
    ap.add_argument("--margin", type=float, default=5.0)
    ap.add_argument("--overhang-deg", type=float, default=45.0)
    ap.add_argument("--bed-eps", type=float, default=0.5)
    args = ap.parse_args()

    findings = []

    try:
        mesh = trimesh.load(args.stl, force="mesh")
    except Exception as exc:  # noqa: BLE001 - any load failure is a blocking finding, not a crash
        print(json.dumps({"findings": [{"severity": "blocking", "message": f"Could not load {args.stl}: {exc}"}]}))
        return

    if mesh.is_empty:
        print(json.dumps({"findings": [{"severity": "blocking", "message": f"No mesh data in {args.stl}."}]}))
        return

    # Each check below is independently wrapped - a `trimesh` exception in one (e.g. a
    # degenerate-but-loadable mesh tripping up `is_winding_consistent` or `face_adjacency`)
    # degrades to an `info` finding for that check only, instead of losing the rest of the report.

    try:
        if not mesh.is_watertight:
            findings.append({
                "severity": "blocking",
                "message": "Mesh is not watertight - may slice with holes or errors. Check the CAD boolean ops."
            })
        elif not mesh.is_winding_consistent:
            findings.append({"severity": "suggestion", "message": "Mesh winding is inconsistent."})
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Watertight/manifold check unavailable: {exc}"})

    ext = mesh.extents
    try:
        if None not in (args.bed_x, args.bed_y, args.bed_z):
            usable = np.array([args.bed_x, args.bed_y, args.bed_z]) - np.array([2 * args.margin, 2 * args.margin, 0.0])
            as_modeled = bool(np.all(ext <= usable + 1e-6))
            best = bool(np.all(np.sort(ext) <= np.sort(usable) + 1e-6))
            if not best:
                findings.append({
                    "severity": "blocking",
                    "message": (
                        f"Part ({ext[0]:.1f}x{ext[1]:.1f}x{ext[2]:.1f} mm) exceeds the bed "
                        f"({usable[0]:.1f}x{usable[1]:.1f}x{usable[2]:.1f} mm usable) in every "
                        "axis-aligned orientation - split or reorient (DFM §10)."
                    )
                })
            elif not as_modeled:
                findings.append({
                    "severity": "suggestion",
                    "message": "Part fits the bed only if reoriented - rotate before slicing."
                })
        else:
            findings.append({"severity": "info", "message": "No printer profile set - bed fit was not checked."})
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Bed-fit check unavailable: {exc}"})

    try:
        n = mesh.face_normals
        centroids = mesh.triangles_center
        areas = mesh.area_faces
        minz = mesh.bounds[0][2]
        threshold = np.sin(np.radians(args.overhang_deg))
        downward = n[:, 2] < 0
        on_bed = centroids[:, 2] <= (minz + args.bed_eps)
        needs_support = downward & (np.abs(n[:, 2]) > threshold) & (~on_bed)
        total_area = float(areas.sum())
        support_area = float(areas[needs_support].sum())
        frac = (support_area / total_area * 100.0) if total_area else 0.0
        if frac >= 8:
            findings.append({
                "severity": "suggestion",
                "message": f"{frac:.1f}% of surface area needs support - reorient, chamfer, or plan supports (DFM §2)."
            })
        elif frac >= 0.5:
            findings.append({"severity": "info", "message": f"{frac:.1f}% of surface area needs support (minor)."})
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Overhang analysis unavailable: {exc}"})

    try:
        min_wall = ABSOLUTE_MIN_WALL_MULTIPLIER * args.nozzle
        face_groups = face_groups_by_connectivity(mesh)
        body_bounds = [bounds_for_faces(mesh, group) for group in face_groups]

        if len(body_bounds) > 1:
            overlapping = False
            for a, b in itertools.combinations(body_bounds, 2):
                if aabb_overlap(a, b):
                    overlapping = True
                    break
            if overlapping:
                findings.append({
                    "severity": "blocking",
                    "message": (
                        f"{len(body_bounds)} disjoint bodies detected with overlapping bounding boxes - "
                        "possible interference (approximate bounding-box check, not an exact boolean test)."
                    )
                })
            else:
                findings.append({
                    "severity": "info",
                    "message": f"{len(body_bounds)} disjoint bodies detected (bounding boxes don't overlap)."
                })

            # ---- coarse thin-feature smell test (per body bounding-box floor) ----
            for i, bounds in enumerate(body_bounds):
                thinnest = float(np.min(bounds[1] - bounds[0]))
                if thinnest < min_wall:
                    findings.append({
                        "severity": "suggestion",
                        "message": (
                            f"Body {i + 1}'s bounding box is only {thinnest:.2f} mm along its thinnest axis "
                            f"(< {min_wall:.2f} mm = {ABSOLUTE_MIN_WALL_MULTIPLIER}x nozzle) - a coarse proxy, "
                            "not a wall-thickness measurement; verify manually if this body is meant to be "
                            "load-bearing."
                        )
                    })
        else:
            thinnest = float(np.min(ext))
            if thinnest < min_wall:
                findings.append({
                    "severity": "suggestion",
                    "message": (
                        f"Overall bounding box is only {thinnest:.2f} mm along its thinnest axis "
                        f"(< {min_wall:.2f} mm = {ABSOLUTE_MIN_WALL_MULTIPLIER}x nozzle) - a coarse proxy, "
                        "not a wall-thickness measurement; verify manually."
                    )
                })
    except Exception as exc:  # noqa: BLE001
        findings.append({"severity": "info", "message": f"Multi-body/thin-feature check unavailable: {exc}"})

    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    main()
