#!/usr/bin/env python3
"""
part_interference.py — verification layer 2 follow-up (WS-I, architecture doc §14): a cross-part
interference check on the *placed* multi-part arrangement, as opposed to `geometry_report.py`'s
per-part checks (which each run against one part's own STL in isolation). Findings from this
script are folded into the same 'geometry' layer bucket by
`packages/verify/src/layerPartInterference.ts` - conceptually this is layer 2 grown to also look
at the assembled project, not a new layer.

Each part is transformed by its `placement` (position in mm + XYZ-Euler rotation in degrees)
using exactly the convention the renderer's viewport applies: `src/renderer/src/three/viewer.ts`'s
`buildMesh` first bakes the mesh's own bounding-box min corner to its local origin ("min-corner
aligned" - so an identity placement rests the part in the +X/+Y/+Z octant), then
`src/renderer/src/three/placement.ts`'s `applyPlacement` sets the mesh's rotation/position as a
rigid transform on top of that. The composed rotation matches three.js's `Euler` 'XYZ' order,
which (verified against `node_modules/three/src/math/Matrix4.js`'s `makeRotationFromEuler`)
composes as `R = Rx(x) . Ry(y) . Rz(z)` applied to a point as `R @ p`, i.e. a point is rotated
about Z first, then Y, then X - see `rotation_matrix_xyz` below.

AABB-then-mesh, mirroring `geometry_report.py`'s intra-mesh multi-body check: pairs whose
axis-aligned bounding boxes (in the shared placed space) don't genuinely overlap (padded by a
small numerical epsilon so two parts merely *touching* flush - a deliberate, common assembly
pattern - never counts as "overlapping") can't interpenetrate and are skipped without ever
loading the more expensive per-point test. For pairs whose padded AABBs *do* overlap, this tests
whether either mesh has a vertex inside the other's volume via a pure-numpy ray-casting
point-in-mesh test (`points_inside_mesh`) - NOT `trimesh.Trimesh.contains()`/
`trimesh.proximity.signed_distance()`, both of which require an `rtree`-backed proximity
structure that is not part of this repo's guaranteed managed venv (build123d/trimesh/numpy only -
see `packages/agent-core/src/python/envManager.ts`'s `REQUIRED_PACKAGES`; confirmed by hand that
`contains()` raises `ModuleNotFoundError: No module named 'rtree'` in that environment). This is a
coarse, dependency-free interpenetration test - not an exact boolean volume intersection - and
only meaningful for watertight meshes (already enforced upstream by this same layer's
watertight/manifold check on each part).

Consumed by `packages/verify/src/layerPartInterference.ts`. Prints one JSON object to stdout:
`{"findings": [{"severity": ..., "message": ...}, ...]}`.

Usage:
  python part_interference.py --parts-json parts.json

`parts.json` shape: a JSON array of
  {"partId": "lid", "stlPath": "/abs/path/lid.stl", "position": [x, y, z], "rotation": [rx, ry, rz]}
(position in mm, rotation in XYZ-Euler degrees - `Placement` in `src/shared/parts.ts`).
"""
import argparse
import itertools
import json
import sys

try:
    import numpy as np
    import trimesh
except ImportError:
    print(json.dumps({
        "findings": [{"severity": "blocking", "message": "Requires numpy and trimesh: pip install trimesh numpy"}]
    }))
    sys.exit(0)

# Numerical-robustness fudge factors, not DFM design thresholds (design-for-printing.md has no
# "how much AABB padding" or "how many sample points" number - those aren't design rules, they're
# floating-point/perf safety margins, the same category as geometry_report.py's `1e-6` bed-fit
# fudge or conformance_check.py's seeded wall-thickness sampling).
AABB_OVERLAP_EPS_MM = 1e-3
MAX_SAMPLE_POINTS_PER_MESH = 500
SAMPLE_RNG_SEED = 0


def rotation_matrix_xyz(rotation_deg):
    """Matches three.js's `Euler` 'XYZ' order: `R = Rx(x) @ Ry(y) @ Rz(z)` applied as `R @ p` (see
    this module's docstring for the derivation against `Matrix4.makeRotationFromEuler`)."""
    x, y, z = np.radians(rotation_deg)
    cx, sx = np.cos(x), np.sin(x)
    cy, sy = np.cos(y), np.sin(y)
    cz, sz = np.cos(z), np.sin(z)
    rx = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rz = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return rx @ ry @ rz


def placed_mesh(entry):
    """Loads one part's STL and transforms it into the shared placed space: min-corner-aligned to
    its own local origin (matching `viewer.ts`'s `buildMesh`), then rotated and translated by its
    placement (matching `placement.ts`'s `applyPlacement`). Returns None for an empty mesh."""
    mesh = trimesh.load(entry["stlPath"], force="mesh")
    if mesh.is_empty:
        return None
    aligned = mesh.copy()
    aligned.apply_translation(-aligned.bounds[0])
    transform = np.eye(4)
    transform[:3, :3] = rotation_matrix_xyz(entry.get("rotation", [0, 0, 0]))
    transform[:3, 3] = entry.get("position", [0, 0, 0])
    aligned.apply_transform(transform)
    return aligned


def aabb_overlap(bounds_a, bounds_b, eps=AABB_OVERLAP_EPS_MM):
    """Two (2,3) numpy bounds arrays overlap by more than `eps` mm on every axis - padded so parts
    merely touching flush (zero-volume contact, a deliberate assembly pattern) never register as
    "overlapping" and reach the (ambiguous, at an exact shared face) mesh-level test below."""
    return bool(np.all(bounds_a[0] <= bounds_b[1] - eps) and np.all(bounds_b[0] <= bounds_a[1] - eps))


def points_inside_mesh(points, mesh):
    """Pure-numpy point-in-watertight-mesh test via ray casting (Möller-Trumbore), since this
    repo's guaranteed venv can't use trimesh's own `contains()` (see module docstring). Casts one
    ray per point in a fixed, off-axis direction (chosen non-axis-aligned so it doesn't glance
    along a typical box-ish printed part's faces/edges) and counts triangle crossings; an odd
    count means the point is inside (the standard ray-casting parity rule). O(points x
    triangles) - `MAX_SAMPLE_POINTS_PER_MESH` caps the point count so a very dense mesh can't stall
    verification; sampling is seeded for reproducibility, mirroring `conformance_check.py`."""
    if len(points) == 0:
        return np.zeros(0, dtype=bool)
    if len(points) > MAX_SAMPLE_POINTS_PER_MESH:
        rng = np.random.default_rng(SAMPLE_RNG_SEED)
        idx = rng.choice(len(points), size=MAX_SAMPLE_POINTS_PER_MESH, replace=False)
        sample = points[idx]
    else:
        sample = points

    direction = np.array([0.6472, 0.5127, 0.5648])
    direction = direction / np.linalg.norm(direction)

    tri = mesh.triangles
    v0, v1, v2 = tri[:, 0], tri[:, 1], tri[:, 2]
    e1 = v1 - v0
    e2 = v2 - v0
    pvec = np.cross(direction, e2)
    det = np.einsum('ij,ij->i', e1, pvec)
    valid_det = np.abs(det) > 1e-9
    inv_det = np.zeros_like(det)
    inv_det[valid_det] = 1.0 / det[valid_det]

    eps = 1e-9
    inside = np.zeros(len(sample), dtype=bool)
    for i, p in enumerate(sample):
        tvec = p - v0
        u = np.einsum('ij,ij->i', tvec, pvec) * inv_det
        valid_u = valid_det & (u >= -eps) & (u <= 1 + eps)

        qvec = np.cross(tvec, e1)
        v = np.einsum('ij,ij->i', qvec, np.tile(direction, (len(qvec), 1))) * inv_det
        valid_v = valid_u & (v >= -eps) & (u + v <= 1 + eps)

        t = np.einsum('ij,ij->i', e2, qvec) * inv_det
        hits = valid_v & (t > eps)
        inside[i] = (int(np.count_nonzero(hits)) % 2) == 1

    if len(points) > MAX_SAMPLE_POINTS_PER_MESH:
        full = np.zeros(len(points), dtype=bool)
        full[idx] = inside
        return full
    return inside


def interpenetrates(mesh_a, mesh_b):
    """True if either mesh has a sampled vertex inside the other's volume, False if neither does,
    or None if either mesh isn't watertight (a non-watertight mesh makes ray-casting containment
    meaningless - the caller reports an `info` finding for that pair instead of a false blocking
    result)."""
    if not (mesh_a.is_watertight and mesh_b.is_watertight):
        return None
    try:
        if np.any(points_inside_mesh(mesh_a.vertices, mesh_b)):
            return True
        if np.any(points_inside_mesh(mesh_b.vertices, mesh_a)):
            return True
        return False
    except Exception:  # noqa: BLE001 - degrade this pair to "unknown", never crash the report
        return None


def main():
    ap = argparse.ArgumentParser(description="Cross-part interference check, JSON output.")
    ap.add_argument(
        "--parts-json",
        required=True,
        help='path to a JSON file: [{"partId", "stlPath", "position": [x,y,z], "rotation": [rx,ry,rz]}, ...]'
    )
    args = ap.parse_args()

    try:
        with open(args.parts_json, "r") as f:
            parts = json.load(f)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"findings": [{"severity": "blocking", "message": f"Could not read parts manifest: {exc}"}]}))
        return

    if len(parts) < 2:
        print(json.dumps({"findings": []}))
        return

    findings = []
    loaded = {}
    for part in parts:
        part_id = part.get("partId", "?")
        try:
            mesh = placed_mesh(part)
        except Exception as exc:  # noqa: BLE001
            findings.append({
                "severity": "info",
                "message": f'Could not load part "{part_id}" for the interference check: {exc}'
            })
            continue
        if mesh is None:
            findings.append({
                "severity": "info",
                "message": f'Part "{part_id}" has no mesh data - skipped in the interference check.'
            })
            continue
        loaded[part_id] = mesh

    for a_id, b_id in itertools.combinations(loaded.keys(), 2):
        mesh_a, mesh_b = loaded[a_id], loaded[b_id]
        if not aabb_overlap(mesh_a.bounds, mesh_b.bounds):
            continue
        result = interpenetrates(mesh_a, mesh_b)
        if result is True:
            findings.append({
                "severity": "blocking",
                "message": (
                    f'Parts "{a_id}" and "{b_id}" interpenetrate at their current placement - '
                    "move or reorient one of them (architecture doc §14)."
                )
            })
        elif result is None:
            findings.append({
                "severity": "info",
                "message": (
                    f'Parts "{a_id}" and "{b_id}" have overlapping bounding boxes but at least one '
                    "isn't watertight - interference could not be conclusively checked."
                )
            })
        # result is False: bounding boxes overlap but the exact meshes don't - no finding needed.

    print(json.dumps({"findings": findings}))


if __name__ == "__main__":
    main()
