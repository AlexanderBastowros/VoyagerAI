#!/usr/bin/env python3
"""
preview.py — generate a preview of an STL so the user can eyeball it before printing.

Outputs (next to the STL, or --outdir):
  <name>_viewer.html  — self-contained interactive viewer (orbit/zoom), STL embedded
                        as base64. Loads three.js from a CDN; works offline otherwise.
  <name>_views.png    — static isometric + front/top/right orthographic thumbnails
                        (matplotlib, headless-safe fallback).

Usage:
  python preview.py part.stl [--outdir DIR] [--no-html] [--no-png]
"""
import argparse
import base64
import os
import sys

try:
    import numpy as np
    import trimesh
except ImportError:
    sys.exit("Requires numpy and trimesh:  pip install trimesh numpy")


VIEWER_TEMPLATE = """<!doctype html>
<html><head><meta charset="utf-8"><title>{name} preview</title>
<style>
  html,body{{margin:0;height:100%;background:#1e1f22;overflow:hidden;
    font-family:system-ui,sans-serif}}
  #hud{{position:fixed;top:10px;left:12px;color:#c9cdd4;font-size:13px;
    background:rgba(0,0,0,.35);padding:6px 10px;border-radius:6px}}
</style></head>
<body>
<div id="hud">{name} &middot; drag to orbit &middot; scroll to zoom</div>
<script type="importmap">
{{ "imports": {{
  "three": "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js",
  "three/addons/": "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/"
}} }}
</script>
<script type="module">
import * as THREE from 'three';
import {{ OrbitControls }} from 'three/addons/controls/OrbitControls.js';
import {{ STLLoader }} from 'three/addons/loaders/STLLoader.js';

const b64 = "{b64}";
const bin = atob(b64);
const buf = new Uint8Array(bin.length);
for (let i=0;i<bin.length;i++) buf[i]=bin.charCodeAt(i);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x1e1f22);
const camera = new THREE.PerspectiveCamera(45, innerWidth/innerHeight, 0.1, 100000);
const renderer = new THREE.WebGLRenderer({{antialias:true}});
renderer.setSize(innerWidth, innerHeight);
renderer.setPixelRatio(devicePixelRatio);
document.body.appendChild(renderer.domElement);

scene.add(new THREE.HemisphereLight(0xffffff, 0x333333, 1.1));
const key = new THREE.DirectionalLight(0xffffff, 1.4); key.position.set(1,1.5,1); scene.add(key);
const fill = new THREE.DirectionalLight(0xffffff, .5); fill.position.set(-1,-.5,-1); scene.add(fill);

const geo = new STLLoader().parse(buf.buffer);
geo.computeVertexNormals(); geo.center();
const mat = new THREE.MeshStandardMaterial({{color:0x66aaff, metalness:.1, roughness:.65, flatShading:false}});
const mesh = new THREE.Mesh(geo, mat); scene.add(mesh);

geo.computeBoundingSphere();
const r = geo.boundingSphere.radius;
camera.position.set(r*1.8, r*1.4, r*2.2);
const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;

scene.add(new THREE.GridHelper(r*6, 24, 0x444444, 0x333333));

addEventListener('resize', ()=>{{
  camera.aspect = innerWidth/innerHeight; camera.updateProjectionMatrix();
  renderer.setSize(innerWidth, innerHeight);
}});
(function loop(){{ requestAnimationFrame(loop); controls.update(); renderer.render(scene,camera); }})();
</script>
</body></html>
"""


def make_html(stl_path, out_html, name):
    with open(stl_path, "rb") as f:
        b64 = base64.b64encode(f.read()).decode("ascii")
    html = VIEWER_TEMPLATE.format(name=name, b64=b64)
    with open(out_html, "w") as f:
        f.write(html)
    return out_html


def make_png(mesh, out_png, name):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    from mpl_toolkits.mplot3d.art3d import Poly3DCollection

    tris = mesh.triangles
    # simple lambert shading from a fixed light
    light = np.array([0.4, 0.4, 0.8]); light = light / np.linalg.norm(light)
    shade = np.clip(mesh.face_normals @ light, 0.15, 1.0)
    base = np.array([0.40, 0.67, 1.0])
    colors = np.clip(base[None, :] * shade[:, None], 0, 1)

    views = [("isometric", 25, -60), ("front", 0, -90), ("top", 89, -90), ("right", 0, 0)]
    fig = plt.figure(figsize=(10, 10), facecolor="#1e1f22")
    for i, (title, elev, azim) in enumerate(views, 1):
        ax = fig.add_subplot(2, 2, i, projection="3d")
        ax.set_facecolor("#1e1f22")
        coll = Poly3DCollection(tris, facecolors=colors, edgecolors="none")
        ax.add_collection3d(coll)
        b = mesh.bounds
        ax.set_xlim(b[0][0], b[1][0]); ax.set_ylim(b[0][1], b[1][1]); ax.set_zlim(b[0][2], b[1][2])
        try:
            ax.set_box_aspect(mesh.extents)
        except Exception:
            pass
        ax.view_init(elev=elev, azim=azim)
        ax.set_title(title, color="#c9cdd4")
        ax.set_axis_off()
    fig.suptitle(name, color="#e6e8eb", fontsize=14)
    fig.tight_layout()
    fig.savefig(out_png, dpi=110, facecolor="#1e1f22", bbox_inches="tight")
    plt.close(fig)
    return out_png


def main():
    ap = argparse.ArgumentParser(description="Preview an STL as an interactive viewer + PNGs.")
    ap.add_argument("stl")
    ap.add_argument("--outdir", default=None)
    ap.add_argument("--no-html", action="store_true")
    ap.add_argument("--no-png", action="store_true")
    args = ap.parse_args()

    stl_path = args.stl
    name = os.path.splitext(os.path.basename(stl_path))[0]
    outdir = args.outdir or os.path.dirname(os.path.abspath(stl_path))
    os.makedirs(outdir, exist_ok=True)

    mesh = trimesh.load(stl_path, force="mesh")
    if mesh.is_empty:
        sys.exit(f"Could not load a mesh from {stl_path}")

    made = []
    if not args.no_html:
        out_html = os.path.join(outdir, f"{name}_viewer.html")
        made.append(make_html(stl_path, out_html, name))
    if not args.no_png:
        try:
            out_png = os.path.join(outdir, f"{name}_views.png")
            made.append(make_png(mesh, out_png, name))
        except ImportError:
            print("matplotlib not installed; skipping PNG (pip install matplotlib)")

    print("wrote:")
    for m in made:
        print(f"  {m}")


if __name__ == "__main__":
    main()
