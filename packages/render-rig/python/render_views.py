#!/usr/bin/env python3
"""
render_views.py — WS-D render rig (architecture doc §4.3, §5 layer 4): headless, deterministic
canonical renders of one iteration's mesh, for the designer's own self-inspection today and the
independent vision critic later (Mode B). Six orthographic axis views (front/back/left/right/
top/bottom) plus two isometric angles, fixed lighting/material, an mm grid baked into every
frame.

Rendering backend: matplotlib's Agg (pure-software) canvas, not pyrender/EGL. Voyager renders
locally on the user's own desktop (Mac/Windows/Linux) - EGL is a Linux/NVIDIA-only headless GL
extension with no macOS equivalent, so a GPU-context renderer would simply not run for a large
share of desktop users. Agg needs no GPU, no display server, and no OS-specific driver stack; it
is the "pinned fallback" the roadmap allows, chosen here as the primary (only) implementation for
that reason. Camera + projection + shading are our own (small, vectorized numpy) code: an
orthographic projection onto each view's (right, up) basis, backface culling, and a painter's-
algorithm depth sort feed matplotlib's 2D `PolyCollection` - this sidesteps `mplot3d`'s well-known
orthographic-aspect-ratio and hidden-surface quirks entirely.

Consumed by `packages/render-rig/src/renderViews.ts` (thin injectable-exec TS wrapper, mirroring
`packages/verify/src/validateStl.ts`) and, through that, the `render_views` MCP tool
(`packages/agent-core/tools/renderViews.ts`). Prints one JSON object to stdout on both success
and failure - never a bare traceback - matching the convention `packages/verify/python/*.py`
already uses:
  success: {"ok": true, "views": {"front": "front.png", ...}, "widthMm": .., "heightMm": ..,
            "depthMm": .., "sizePx": ..}
  failure: {"ok": false, "error": "..."}

Determinism: no wall-clock/random inputs anywhere in the render path (camera, lighting, and
material are fixed constants below); `savefig`'s `metadata` is passed explicitly (never left to
matplotlib's default, which can include a "Creation Time" PNG tEXt chunk) so no timestamp ever
lands in the file. Two runs against the same STL on the same machine/library versions produce
byte-identical PNGs.

Usage:
  python render_views.py part.stl out_dir [--size 512]
"""
import argparse
import json
import math
import os
import sys

try:
    import numpy as np
    import trimesh
except ImportError as exc:
    print(json.dumps({"ok": False, "error": f"Requires numpy and trimesh: pip install trimesh numpy ({exc})"}))
    sys.exit(0)

try:
    import matplotlib
    matplotlib.use("Agg")  # headless: no display server, no GPU - must be set before pyplot import
    import matplotlib.pyplot as plt
    from matplotlib.collections import PolyCollection
except ImportError as exc:
    print(json.dumps({
        "ok": False,
        "error": (
            "Requires matplotlib (not part of Voyager's managed venv yet - see the WS-D contract-"
            f"change request in agents/production-roadmap.md): pip install matplotlib ({exc})"
        )
    }))
    sys.exit(0)


# ---- fixed camera protocol (architecture doc §4.3/§5: 6 ortho + 2 iso) ----------------------
# Each entry is (view_dir, up_hint): `view_dir` is the direction the camera looks (from camera
# into the scene, world space); `up_hint` disambiguates roll and is Gram-Schmidt'd against
# `view_dir` in `view_basis()` below. Order here is the canonical, documented view order used
# throughout (SKILL.md, the MCP tool, the TS wrapper's `RENDER_VIEW_NAMES`).
VIEW_DEFS = (
    ("front", (0.0, 1.0, 0.0), (0.0, 0.0, 1.0)),
    ("back", (0.0, -1.0, 0.0), (0.0, 0.0, 1.0)),
    ("right", (-1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    ("left", (1.0, 0.0, 0.0), (0.0, 0.0, 1.0)),
    ("top", (0.0, 0.0, -1.0), (0.0, 1.0, 0.0)),
    ("bottom", (0.0, 0.0, 1.0), (0.0, 1.0, 0.0)),
    ("iso1", (-1.0, -1.0, -1.0), (0.0, 0.0, 1.0)),
    ("iso2", (1.0, -1.0, -1.0), (0.0, 0.0, 1.0)),
)

# ---- fixed lighting/material (architecture doc §4.3: "consistent lighting, neutral material") --
LIGHT_DIR = (0.45, -0.35, 0.82)  # world-space "to-light" direction, fixed regardless of camera
AMBIENT = 0.45
DIFFUSE = 0.55
BASE_COLOR = (0.72, 0.75, 0.80)  # light neutral blue-gray - not the app's per-part palette
EDGE_COLOR = (0.18, 0.18, 0.20)
EDGE_WIDTH = 0.25
BACKGROUND_COLOR = "white"
GRID_COLOR = (0.85, 0.85, 0.88)

DEFAULT_SIZE_PX = 512
PADDING_FACTOR = 1.18  # headroom around the model's bounding sphere so nothing touches the frame edge
MIN_RADIUS_MM = 5.0  # guards degenerate/near-flat parts from a zero or tiny view radius
GRID_STEP_CANDIDATES = (0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500, 1000)
TARGET_GRIDLINES = 6.0


def normalize(v):
    v = np.asarray(v, dtype=float)
    n = np.linalg.norm(v)
    if n < 1e-12:
        raise ValueError(f"cannot normalize a near-zero vector {v!r}")
    return v / n


def view_basis(view_dir, up_hint):
    """Right-handed (right, up, view_dir) basis for one view via Gram-Schmidt against `up_hint`."""
    view_dir = normalize(view_dir)
    right = np.cross(view_dir, up_hint)
    if np.linalg.norm(right) < 1e-8:
        # up_hint parallel to view_dir - not expected given VIEW_DEFS, but guard anyway.
        up_hint = (1.0, 0.0, 0.0) if abs(view_dir[0]) < 0.9 else (0.0, 1.0, 0.0)
        right = np.cross(view_dir, up_hint)
    right = normalize(right)
    up = normalize(np.cross(right, view_dir))
    return right, up, view_dir


def nice_grid_step(radius_mm):
    """Smallest candidate step that keeps the number of gridlines across the frame near
    `TARGET_GRIDLINES` - deterministic, no dependency on matplotlib's own auto-locator."""
    raw = (2.0 * radius_mm) / TARGET_GRIDLINES
    for step in GRID_STEP_CANDIDATES:
        if raw <= step:
            return step
    return GRID_STEP_CANDIDATES[-1]


def render_one_view(mesh, center, radius, name, view_dir, up_hint, extents, size_px, out_path):
    right, up, vdir = view_basis(np.array(view_dir), np.array(up_hint))

    verts = mesh.vertices - center
    faces = mesh.faces
    normals = mesh.face_normals

    # Backface cull: keep faces whose normal points back toward the camera. `vdir` points from
    # the camera into the scene, so a front-facing surface's normal is roughly opposite it.
    facing = normals @ vdir
    kept = np.nonzero(facing < 0)[0]
    if kept.size == 0:
        kept = np.arange(len(faces))  # degenerate (e.g. a single-sided mesh) - draw everything

    tri = verts[faces[kept]]  # (F, 3, 3) world-space (centered) triangle vertices
    depth = tri.mean(axis=1) @ vdir  # larger = farther from camera along the view direction
    order = np.argsort(depth)[::-1]  # farthest-first painter's-algorithm draw order

    u = tri[..., :] @ right  # (F, 3) projected right-axis coordinate per vertex
    w = tri[..., :] @ up  # (F, 3) projected up-axis coordinate per vertex
    polys = np.stack([u, w], axis=-1)[order]  # (F, 3, 2) in draw order

    intensity = np.clip(AMBIENT + DIFFUSE * np.maximum(0.0, normals[kept] @ np.asarray(LIGHT_DIR)), 0.0, 1.0)
    colors = np.clip(np.outer(intensity[order], np.asarray(BASE_COLOR)), 0.0, 1.0)

    dpi = 100
    fig = plt.figure(figsize=(size_px / dpi, size_px / dpi), dpi=dpi)
    fig.patch.set_facecolor(BACKGROUND_COLOR)
    ax = fig.add_axes((0.13, 0.11, 0.82, 0.79))
    ax.set_facecolor(BACKGROUND_COLOR)
    ax.set_xlim(-radius, radius)
    ax.set_ylim(-radius, radius)
    ax.set_aspect("equal")
    ax.set_axisbelow(True)  # gridlines behind the mesh, not over it

    step = nice_grid_step(radius)
    ticks = np.arange(-math.ceil(radius / step) * step, radius + step / 2.0, step)
    ax.set_xticks(ticks)
    ax.set_yticks(ticks)
    ax.tick_params(labelsize=7, colors="0.3")
    ax.grid(True, color=GRID_COLOR, linewidth=0.5)
    ax.set_xlabel("mm", fontsize=8)
    ax.set_ylabel("mm", fontsize=8)

    if polys.size:
        coll = PolyCollection(list(polys), facecolors=list(colors), edgecolors=[EDGE_COLOR], linewidths=EDGE_WIDTH)
        ax.add_collection(coll)

    ax.set_title(
        f"{name.upper()}  ({extents[0]:.1f} × {extents[1]:.1f} × {extents[2]:.1f} mm)",
        fontsize=9
    )

    fig.savefig(out_path, format="png", metadata={"Software": "voyager-render-rig"})
    plt.close(fig)


def render_views(stl_path, out_dir, size_px=DEFAULT_SIZE_PX):
    mesh = trimesh.load(stl_path, force="mesh")
    if mesh.is_empty:
        raise ValueError(f"No mesh data in {stl_path}.")

    os.makedirs(out_dir, exist_ok=True)

    bounds = mesh.bounds  # (2, 3): [min, max]
    center = bounds.mean(axis=0)
    extents = bounds[1] - bounds[0]
    diag = float(np.linalg.norm(extents))
    radius = max(diag / 2.0 * PADDING_FACTOR, MIN_RADIUS_MM)

    views = {}
    for name, view_dir, up_hint in VIEW_DEFS:
        filename = f"{name}.png"
        out_path = os.path.join(out_dir, filename)
        render_one_view(mesh, center, radius, name, view_dir, up_hint, extents, size_px, out_path)
        views[name] = filename

    return {
        "ok": True,
        "views": views,
        "widthMm": float(extents[0]),
        "depthMm": float(extents[1]),
        "heightMm": float(extents[2]),
        "sizePx": size_px
    }


def main():
    ap = argparse.ArgumentParser(description="WS-D render rig: 6 ortho + 2 iso canonical views, JSON result.")
    ap.add_argument("stl", help="path to the STL file")
    ap.add_argument("out_dir", help="directory the view PNGs are written into (created if missing)")
    ap.add_argument("--size", type=int, default=DEFAULT_SIZE_PX, help="square output size in pixels")
    args = ap.parse_args()

    try:
        result = render_views(args.stl, args.out_dir, size_px=args.size)
        print(json.dumps(result))
    except Exception as exc:  # noqa: BLE001 - any failure becomes a clean JSON error, never a traceback
        print(json.dumps({"ok": False, "error": str(exc)}))


if __name__ == "__main__":
    main()
