#!/usr/bin/env python3
"""
validate_stl.py — printability sanity checks on an exported STL.

Checks:
  1. Watertight / manifold  — a non-watertight mesh can slice with holes or errors.
  2. Bed fit               — does the bounding box fit the print bed (as-modeled, and
                             in the best axis-aligned orientation)?
  3. Overhang analysis     — how much downward-facing surface is steeper than 45° from
                             vertical (i.e. would need support), and the steepest angle.

Minimum wall thickness is intentionally NOT checked here: reliable thin-wall detection
on a triangle mesh is error-prone, so it's enforced at design time instead. This tool is
a post-export sanity check, not a substitute for designing to the rules.

Usage:
  python validate_stl.py part.stl --bed-x 256 --bed-y 256 --bed-z 256 --nozzle 0.4
"""
import argparse
import sys

try:
    import numpy as np
    import trimesh
except ImportError:
    sys.exit("Requires numpy and trimesh:  pip install trimesh numpy")


def fmt(x):
    return f"{x:.2f}"


def main():
    ap = argparse.ArgumentParser(description="Printability checks for an STL.")
    ap.add_argument("stl", help="path to the STL file")
    ap.add_argument("--bed-x", type=float, default=None, help="bed size X (mm)")
    ap.add_argument("--bed-y", type=float, default=None, help="bed size Y (mm)")
    ap.add_argument("--bed-z", type=float, default=None, help="bed height Z (mm)")
    ap.add_argument("--nozzle", type=float, default=0.4, help="nozzle diameter (mm)")
    ap.add_argument("--margin", type=float, default=5.0,
                    help="per-side bed margin for brim/skirt (mm), default 5")
    ap.add_argument("--overhang-deg", type=float, default=45.0,
                    help="overhang threshold from vertical (deg), default 45")
    ap.add_argument("--bed-eps", type=float, default=0.5,
                    help="faces within this height of the base are treated as resting "
                         "on the bed, not overhangs (mm)")
    args = ap.parse_args()

    mesh = trimesh.load(args.stl, force="mesh")
    if mesh.is_empty:
        sys.exit(f"Could not load a mesh from {args.stl}")

    print(f"\n=== validate: {args.stl} ===")
    print(f"triangles: {len(mesh.faces)}   vertices: {len(mesh.vertices)}")

    # ---- 1. watertight / manifold ----
    wt = mesh.is_watertight
    winding = mesh.is_winding_consistent
    print("\n[1] Watertight / manifold")
    print(f"    watertight ............. {'PASS' if wt else 'FAIL'}")
    print(f"    consistent winding ..... {'PASS' if winding else 'FAIL'}")
    if not wt:
        try:
            open_edges = len(mesh.edges_open) if hasattr(mesh, "edges_open") else "n/a"
            print(f"    open/boundary edges .... {open_edges}")
        except Exception:
            pass
        print("    -> not watertight; consider mesh repair or check the CAD boolean ops.")

    # ---- 2. bed fit ----
    ext = mesh.extents  # (dx, dy, dz)
    print("\n[2] Bounding box")
    print(f"    size (X,Y,Z) ........... {fmt(ext[0])} x {fmt(ext[1])} x {fmt(ext[2])} mm")
    if None not in (args.bed_x, args.bed_y, args.bed_z):
        usable = np.array([args.bed_x, args.bed_y, args.bed_z]) - \
                 np.array([2 * args.margin, 2 * args.margin, 0.0])
        as_modeled = np.all(ext <= usable + 1e-6)
        # best axis-aligned orientation: sort part dims into sorted usable dims
        best = np.all(np.sort(ext) <= np.sort(usable) + 1e-6)
        print(f"    bed (usable w/ margin) . {fmt(usable[0])} x {fmt(usable[1])} x {fmt(usable[2])} mm")
        print(f"    fits as modeled ........ {'PASS' if as_modeled else 'FAIL'}")
        print(f"    fits in some rotation .. {'PASS' if best else 'FAIL'}")
        if not best:
            print("    -> exceeds bed in every axis-aligned orientation; split or reorient (DFM §10).")
        elif not as_modeled:
            print("    -> fits only if reoriented; rotate before slicing.")
    else:
        print("    (pass --bed-x/--bed-y/--bed-z to check bed fit)")

    # ---- 3. overhang analysis ----
    n = mesh.face_normals
    centroids = mesh.triangles_center
    areas = mesh.area_faces
    minz = mesh.bounds[0][2]

    threshold = np.sin(np.radians(args.overhang_deg))  # |n_z| above this = needs support
    downward = n[:, 2] < 0
    on_bed = centroids[:, 2] <= (minz + args.bed_eps)
    needs_support = downward & (np.abs(n[:, 2]) > threshold) & (~on_bed)

    total_area = float(areas.sum())
    support_area = float(areas[needs_support].sum())
    frac = (support_area / total_area * 100.0) if total_area else 0.0

    # steepest overhang angle (from vertical) among downward, non-bed faces
    dfaces = downward & (~on_bed)
    if dfaces.any():
        steepest = np.degrees(np.arcsin(np.clip(np.abs(n[dfaces, 2]), 0, 1))).max()
    else:
        steepest = 0.0

    print(f"\n[3] Overhangs (threshold {args.overhang_deg:.0f}° from vertical)")
    print(f"    surface needing support  {fmt(frac)} % of total area")
    print(f"    steepest overhang ...... {fmt(steepest)}° from vertical")
    if frac < 0.5:
        print("    -> essentially support-free.")
    elif frac < 8:
        print("    -> minor overhangs; likely fine or light support.")
    else:
        print("    -> significant overhangs; reorient, add chamfers, or plan supports (DFM §2).")

    print("\n(Note: overhang detection excludes faces resting on the bed via --bed-eps; "
          "the slicer supports the first layer for you.)\n")


if __name__ == "__main__":
    main()
