#!/usr/bin/env python3
"""
repair_mesh.py — WS-G import/remix (architecture doc §12.5): standalone repair pass for an
imported mesh (STL/OBJ/3MF) - degenerate/duplicate face removal, vertex merging, and a
dependency-free hole fill - exported alongside a JSON report of exactly what changed (the
"repair pass that reports what it changed" the roadmap calls for). Also applies an optional
real-world scale factor, since import time is when a unitless STL/OBJ's scale gets confirmed
(`references/remix.md`).

This is a standalone, independently runnable reference implementation of the same algorithm
`packages/agent-core/src/projects/importModel.ts` inlines directly into each project's generated
`<part>_vN.py` import script (so that recorded script stays self-contained - re-runnable with
nothing beyond `pip install trimesh`, no dependency on this file or this package). Keep the two
in sync if you change one.

Dependency-free by design (no networkx/scipy): the managed Python env's required-package list
(`packages/agent-core/src/python/envManager.ts`) is just build123d/trimesh/numpy, and trimesh's
own `repair.fill_holes`/`repair.fix_normals` both hard-require networkx - the same reason
`packages/verify/python/geometry_report.py` avoids `mesh.split()` in favor of a plain numpy
union-find over `face_adjacency`. This script's hole fill walks boundary-edge adjacency directly
and fan-triangulates each loop from its first vertex - correct for a simple (near-convex) hole,
which covers the common "one triangle went missing" case; a highly non-convex hole may still
need a manual fix, which is reported (not silently declared fixed) via `is_watertight` after the
attempt. Mesh winding consistency (`trimesh.repair.fix_normals`) is not auto-fixed for the same
networkx reason - an inconsistent-winding mesh is reported as a `suggestion`-level note instead
of crashing or silently claiming to fix it, mirroring `geometry_report.py`'s own severity split
between `is_watertight` (blocking) and `is_winding_consistent` (suggestion).

Prints one JSON object to stdout, exit 0 either way:
  success: {"ok": true, "repairReport": [...], "watertight": bool, "bboxMm": [x,y,z],
            "faceCount": int, "vertexCount": int}
  failure: {"ok": false, "reason": "..."}

Usage:
  python repair_mesh.py part.stl --out repaired.stl [--scale 1.0]
"""
import argparse
import json
import sys
from collections import defaultdict

try:
    import numpy as np
    import trimesh
except ImportError as exc:
    print(json.dumps({"ok": False, "reason": f"Requires trimesh and numpy: pip install trimesh numpy ({exc})"}))
    sys.exit(0)


def fill_holes_dependency_free(mesh):
    """Groups the mesh's open (single-face) edges into closed loops by walking vertex adjacency,
    then fan-triangulates each loop from its first vertex. No networkx/scipy - see module
    docstring. Returns the number of loops filled (0 if the mesh had no open boundary)."""
    edge_count = defaultdict(int)
    for a, b in mesh.edges_sorted:
        edge_count[(int(a), int(b))] += 1
    boundary = [e for e, c in edge_count.items() if c == 1]
    if not boundary:
        return 0

    adjacency = defaultdict(list)
    for a, b in boundary:
        adjacency[a].append(b)
        adjacency[b].append(a)

    visited = set()
    loops = []
    for a, b in boundary:
        key = tuple(sorted((a, b)))
        if key in visited:
            continue
        loop = [a, b]
        visited.add(key)
        cur = b
        while True:
            candidates = [n for n in adjacency[cur] if tuple(sorted((cur, n))) not in visited]
            if not candidates:
                break
            nxt = candidates[0]
            visited.add(tuple(sorted((cur, nxt))))
            if nxt == loop[0]:
                break
            loop.append(nxt)
            cur = nxt
        loops.append(loop)

    extra_faces = []
    for loop in loops:
        for i in range(1, len(loop) - 1):
            extra_faces.append([loop[0], loop[i], loop[i + 1]])
    if extra_faces:
        mesh.faces = np.vstack([mesh.faces, np.array(extra_faces)])
    return len(loops)


def repair_mesh(mesh):
    """Runs the repair pass in place and returns a human-readable report of exactly what
    changed - an empty list means the mesh needed nothing."""
    report = []

    nd_mask = mesh.nondegenerate_faces()
    if not nd_mask.all():
        report.append(f"removed {int((~nd_mask).sum())} degenerate face(s)")
        mesh.update_faces(nd_mask)

    uniq_mask = mesh.unique_faces()
    if not uniq_mask.all():
        report.append(f"removed {int((~uniq_mask).sum())} duplicate face(s)")
        mesh.update_faces(uniq_mask)

    mesh.merge_vertices()
    mesh.remove_unreferenced_vertices()

    if not mesh.is_watertight:
        filled = fill_holes_dependency_free(mesh)
        if filled:
            report.append(f"filled {filled} hole(s)")
            mesh.remove_unreferenced_vertices()
        if not mesh.is_watertight:
            report.append("still not watertight after repair - the hole(s) may be too irregular for automatic fill")

    if not mesh.is_winding_consistent:
        report.append("winding is inconsistent (not auto-fixed in this environment - requires networkx)")

    return report


def main():
    ap = argparse.ArgumentParser(description="Repair + optionally scale an imported mesh, reporting what changed.")
    ap.add_argument("path", help="path to the source STL/OBJ/3MF file")
    ap.add_argument("--out", required=True, help="path to write the repaired STL")
    ap.add_argument("--scale", type=float, default=1.0, help="uniform scale factor to apply before repair")
    args = ap.parse_args()

    try:
        mesh = trimesh.load(args.path, force="mesh")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": f"Could not load {args.path}: {exc}"}))
        return

    if mesh.is_empty:
        print(json.dumps({"ok": False, "reason": f"No mesh data found in {args.path}."}))
        return

    if args.scale != 1.0:
        mesh.apply_scale(args.scale)

    report = repair_mesh(mesh)

    try:
        mesh.export(args.out)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": f"Could not export repaired mesh to {args.out}: {exc}"}))
        return

    print(json.dumps({
        "ok": True,
        "repairReport": report,
        "watertight": bool(mesh.is_watertight),
        "bboxMm": [float(x) for x in mesh.extents],
        "faceCount": int(len(mesh.faces)),
        "vertexCount": int(len(mesh.vertices))
    }))


if __name__ == "__main__":
    main()
