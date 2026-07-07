"""Smoke test for the Voyager AI managed Python environment.

Builds a 20mm cube with a 5mm-diameter through-hole using build123d, exports
it to STL, then re-opens the STL with trimesh to confirm the result is a
valid, watertight solid mesh. Run with the managed venv's own interpreter:

    <venv>/bin/python3 smoke_test.py /path/to/output.stl

On success, prints exactly one line to stdout:

    SMOKE_TEST_OK size=<bytes> watertight=True

and exits 0. On failure, prints a message to stderr and exits non-zero.
"""

from __future__ import annotations

import os
import sys


def main() -> int:
    out_path = sys.argv[1] if len(sys.argv) > 1 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "voyager_smoke_test.stl"
    )

    try:
        from build123d import Box, Cylinder, export_stl
    except Exception as exc:  # noqa: BLE001 - want any import failure reported
        print(f"Failed to import build123d: {exc}", file=sys.stderr)
        return 1

    try:
        box = Box(20, 20, 20)
        # Taller than the box so the cut goes all the way through.
        hole = Cylinder(radius=2.5, height=40)
        part = box - hole
        export_stl(part, out_path)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to build/export test part: {exc}", file=sys.stderr)
        return 1

    if not os.path.exists(out_path):
        print(f"STL was not written to {out_path}", file=sys.stderr)
        return 1

    size = os.path.getsize(out_path)
    if size < 100:
        print(f"STL output is suspiciously small ({size} bytes)", file=sys.stderr)
        return 1

    try:
        import trimesh
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to import trimesh: {exc}", file=sys.stderr)
        return 1

    try:
        mesh = trimesh.load(out_path)
        watertight = bool(mesh.is_watertight)
    except Exception as exc:  # noqa: BLE001
        print(f"Failed to load/validate STL with trimesh: {exc}", file=sys.stderr)
        return 1

    print(f"SMOKE_TEST_OK size={size} watertight={watertight}")
    return 0 if watertight else 1


if __name__ == "__main__":
    sys.exit(main())
