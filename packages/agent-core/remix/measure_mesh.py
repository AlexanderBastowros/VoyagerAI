#!/usr/bin/env python3
"""
measure_mesh.py — WS-G import/remix (architecture doc §12.5): read-only measurement of an
imported mesh (STL/OBJ/3MF), used by `packages/agent-core/src/projects/importModel.ts` for two
things: (1) the bounding box shown in the unit-confirmation dialog for unitless formats
(STL/OBJ carry no units - "this reads as 120mm wide, correct?"), and (2) a quick watertight/face-
count summary. Never mutates the source file - the repair pass that fixes issues runs later, as
part of the generated import script (see `references/remix.md`), not here.

Prints one JSON object to stdout, exit 0 either way (mirrors the `packages/verify/python`
scripts' convention so a caller never has to special-case a non-zero exit for a "found problems"
result vs. a genuine crash):
  success: {"ok": true, "bboxMm": [x, y, z], "watertight": bool, "faceCount": int, "vertexCount": int}
  failure: {"ok": false, "reason": "..."}

Usage:
  python measure_mesh.py part.stl
"""
import argparse
import json
import sys

try:
    import trimesh
except ImportError as exc:
    print(json.dumps({"ok": False, "reason": f"Requires trimesh: pip install trimesh ({exc})"}))
    sys.exit(0)


def main():
    ap = argparse.ArgumentParser(description="Read-only measurement of an imported mesh.")
    ap.add_argument("path", help="path to the STL/OBJ/3MF file")
    args = ap.parse_args()

    try:
        mesh = trimesh.load(args.path, force="mesh")
    except Exception as exc:  # noqa: BLE001 - any load failure is a clean, reported failure
        print(json.dumps({"ok": False, "reason": f"Could not load {args.path}: {exc}"}))
        return

    if mesh.is_empty:
        print(json.dumps({"ok": False, "reason": f"No mesh data found in {args.path}."}))
        return

    print(json.dumps({
        "ok": True,
        "bboxMm": [float(x) for x in mesh.extents],
        "watertight": bool(mesh.is_watertight),
        "faceCount": int(len(mesh.faces)),
        "vertexCount": int(len(mesh.vertices))
    }))


if __name__ == "__main__":
    main()
