#!/usr/bin/env python3
"""
boolean_ops.py — WS-G import/remix (architecture doc §12.5): reference implementation of the
"robust manifold3d-class booleans" the roadmap calls for on mesh-lineage remix edits ("add a 5mm
hole through the base" is a plug-and-recut boolean: subtract the old hole's plug, union it back
solid, then subtract a fresh tool at the new size/position).

This is a standalone, independently runnable library + CLI. It is NOT invoked automatically by
`packages/agent-core/src/projects/importModel.ts` - boolean surgery happens in *later* agent
turns (the agent writes a script that loads the mesh-lineage part and edits it), not at import
time. `references/remix.md` documents the pattern below for the agent to follow directly in its
own generated scripts (self-contained - a script the user can re-run with nothing more than
`pip install trimesh manifold3d`, matching this app's graduation-package philosophy of never
handing back a script with a hidden internal dependency).

Prefers the `manifold3d` engine (robust, actively maintained, trimesh's own recommended backend
for exactly this "second-guess-free CSG on real-world meshes" use case) and reports a clear,
actionable error - not a crash - when no boolean backend is installed, since the managed
environment's required-package list (`packages/agent-core/src/python/envManager.ts`) does not
include it by default (large optional dependency, installed lazily on first use, mirroring how
the skill already documents CadQuery's large OCP wheel as an on-demand install).

Prints one JSON object to stdout, exit 0 either way:
  success: {"ok": true, "bboxMm": [x, y, z], "watertight": bool}
  failure: {"ok": false, "reason": "..."}

Usage:
  python boolean_ops.py {union|subtract|intersect} base.stl tool.stl --out result.stl
"""
import argparse
import json
import sys

try:
    import trimesh
except ImportError as exc:
    print(json.dumps({"ok": False, "reason": f"Requires trimesh: pip install trimesh ({exc})"}))
    sys.exit(0)

_OPS = {
    "union": trimesh.boolean.union,
    "subtract": trimesh.boolean.difference,
    "intersect": trimesh.boolean.intersection
}


def robust_boolean(op: str, base, tool):
    """Runs `op` (one of "union"/"subtract"/"intersect") on `base`/`tool`, preferring the
    `manifold` engine - trimesh's actual boolean solver, not a custom implementation, but pinned
    to the specific engine known to handle real-world (non-perfectly-clean) meshes robustly,
    rather than trusting whatever trimesh auto-selects. Raises with a clear, actionable message
    if no boolean backend is installed (`engines_available` is empty) instead of trimesh's own
    lower-level `ImportError`."""
    if op not in _OPS:
        raise ValueError(f"Unknown boolean op: {op}")
    if not trimesh.boolean.engines_available:
        raise RuntimeError(
            "No boolean backend is installed - run `pip install manifold3d` in the managed "
            "environment, then retry. (Blender is trimesh's other supported backend but isn't "
            "part of this app's managed environment.)"
        )
    return _OPS[op]([base, tool], engine="manifold")


def main():
    ap = argparse.ArgumentParser(description="Plug-and-recut style boolean surgery on two meshes.")
    ap.add_argument("op", choices=["union", "subtract", "intersect"])
    ap.add_argument("base", help="path to the base mesh")
    ap.add_argument("tool", help="path to the tool mesh (the shape being added/cut)")
    ap.add_argument("--out", required=True, help="path to write the result STL")
    args = ap.parse_args()

    try:
        base = trimesh.load(args.base, force="mesh")
        tool = trimesh.load(args.tool, force="mesh")
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": f"Could not load an input mesh: {exc}"}))
        return

    try:
        result = robust_boolean(args.op, base, tool)
    except Exception as exc:  # noqa: BLE001 - includes the no-backend-installed RuntimeError above
        print(json.dumps({"ok": False, "reason": str(exc)}))
        return

    try:
        result.export(args.out)
    except Exception as exc:  # noqa: BLE001
        print(json.dumps({"ok": False, "reason": f"Could not export result to {args.out}: {exc}"}))
        return

    print(json.dumps({
        "ok": True,
        "bboxMm": [float(x) for x in result.extents],
        "watertight": bool(result.is_watertight)
    }))


if __name__ == "__main__":
    main()
