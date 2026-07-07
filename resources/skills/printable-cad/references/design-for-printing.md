# Design for FDM Printing — rules and numbers

Apply these while modeling (Phase 4). Numbers assume FDM/FFF and a **0.4 mm nozzle**
unless stated; scale wall/feature minimums linearly with the actual nozzle. When a rule
and a user-given dimension conflict, surface the conflict — don't silently override the
user.

## Table of contents
1. Walls and minimum features
2. Overhangs, bridges, chamfers vs. fillets
3. Holes and bores
4. Fit tolerances (clearance classes)
5. Print-in-place mechanisms
6. First layer / elephant's foot
7. Orientation and strength
8. Hardware pockets (screws, heat-set inserts, nuts, countersinks, magnets, bearings)
9. Text and embossing
10. Splitting a part to fit the bed

---

## 1. Walls and minimum features

- **Extrusion width** ≈ nozzle diameter (sliceable 100–120%). One perimeter ≈ one nozzle width.
- **Absolute minimum wall** = 2 × nozzle (two perimeters). 0.4 mm nozzle → **0.8 mm**.
- **Default structural minimum** = 3 × nozzle. 0.4 mm → **1.2 mm**. Use this for anything that bears load or gets handled.
- **Thin standalone features** (ribs, fins, pins): width ≥ 2 × nozzle, and keep height/width aspect ≤ ~6:1 or they wobble while printing.
- Set `MIN_WALL` as a constant and route wall thicknesses through it. If the user's spec forces a wall below `2 × nozzle`, flag it explicitly.

## 2. Overhangs, bridges, chamfers vs. fillets

- **45° rule:** surfaces up to 45° from vertical print unsupported and clean. Beyond 45° (toward horizontal) sag or need support. Design overhangs to stay ≤ 45°.
- **Bridges:** unsupported horizontal spans print acceptably up to ~5–10 mm; longer bridges droop. Break long spans or add a sacrificial support rib.
- **Chamfer vs. fillet on downward edges:** a **45° chamfer** on a bottom/overhanging edge is self-supporting; a **fillet** on the same edge curves past 45° near its base and droops or needs support. **Rule of thumb: chamfer the bottom, fillet the top.** This also doubles as elephant's-foot relief (§6).
- Teardrop/diamond holes (§3) are the overhang rule applied to circular horizontal holes.

## 3. Holes and bores

- **Vertical holes** (axis ∥ Z, the print direction) come out slightly undersized due to flow/shrink and inward pull on inner perimeters. For a *dimensionally critical* vertical hole, oversize by ~0.1–0.2 mm or plan to ream/drill.
- **Horizontal holes** (axis ⟂ Z) sag at the top and print egg-shaped. Fixes:
  - **Teardrop** profile (circle + a 45° roof to a point at top) — self-supporting, stays round below.
  - **Diamond/hexagonal** profile — simpler, self-supporting, good for pass-through.
- **Purpose sets the modeled size** — always ask what a hole is *for*:
  - Screw **clearance** hole: nominal screw Ø + clearance (see §8 table).
  - **Tapped/self-tapping** into plastic: pilot ≈ screw Ø − pitch (roughly minor Ø); for common self-tappers use the manufacturer pilot or ~0.8 × screw Ø.
  - **Press fit** (dowel/pin): nominal − 0.0 to −0.1 mm (interference).

## 4. Fit tolerances (clearance classes)

Gap = hole size − shaft/peg size, per **0.4 mm nozzle** and a reasonably tuned printer.
Expose the chosen class as a constant. Never model two mating parts at identical nominal.

| Class | Radial/diametral gap | Use |
|---|---|---|
| **Press / interference** | −0.10 to 0.00 mm | permanent, hammer/press together |
| **Snug / location** | +0.10 to +0.20 mm | assembles by hand, no play, not meant to move |
| **Free / running** | +0.20 to +0.40 mm | rotates/slides freely |
| **Loose / sloppy** | +0.40 to +0.60 mm | quick alignment, tolerant of variance |

Well-calibrated printers can tighten these; unknown printers should use the looser end.
When in doubt, tell the user which class you used so they can reprint a size if needed.

## 5. Print-in-place mechanisms

- Moving parts printed already-assembled need a gap ≥ **1–2 extrusion widths**; practical default **0.3–0.5 mm** for a 0.4 mm nozzle.
- Below ~0.25 mm the layers can fuse. Above ~0.6 mm the joint gets sloppy.
- Avoid gaps that fall on a single layer boundary for a horizontal interface — a small vertical gap of 2–3 layers releases more reliably.
- State the gap as a constant (`JOINT_GAP`) and mention it in the confirm-the-contract step; it's the #1 thing that makes a print-in-place part fail or fuse.

## 6. First layer / elephant's foot

- The first layers bulge outward slightly ("elephant's foot") from bed heat + squish. This eats into precise bottom dimensions and can jam bottom-referenced fits.
- **Relief:** add a small **0.4–0.6 mm × 45° chamfer** to the bottom outer edge and to the bottom of bores/counterbores that must stay accurate. (Slicer compensation also exists, but modeling the chamfer makes the part robust across slicers.)

## 7. Orientation and strength

- **Z is weakest.** Layer-to-layer adhesion is far weaker than in-plane. Orient so tension/bending doesn't try to peel layers apart (e.g. a hook should print so its load runs along layers, not across them).
- Prefer a **large flat face on the bed** for adhesion and to minimize supports.
- Minimize overhangs by orientation before resorting to support material.
- Record the intended orientation as a comment in the script and mention it to the user — the same geometry can be strong or fragile depending on how it's placed.

## 8. Hardware pockets

Sizes for a 0.4 mm nozzle; verify against the specific part the user has.

**Machine-screw clearance holes (metric, "close" clearance):**

| Screw | Clearance hole Ø | Head counterbore Ø (socket cap) | Countersink Ø (90° flat head) |
|---|---|---|---|
| M2 | 2.4 mm | 3.8 mm | 4.0 mm |
| M2.5 | 2.9 mm | 4.5 mm | 5.0 mm |
| M3 | 3.4 mm | 5.5 mm | 6.0 mm |
| M4 | 4.5 mm | 7.0 mm | 8.0 mm |
| M5 | 5.5 mm | 8.5 mm | 10.0 mm |

Counterbore **depth** = head height + ~0.2 mm. Countersink angle = 90° for standard metric flat heads.

**Heat-set threaded inserts (typical brass, e.g. McMaster/CNC-Kitchen style):** model the
boss hole ~**insert OD − 0.1 to −0.2 mm** (the insert melts in and forms threads in the
plastic). Give the boss a wall ≥ **2 × insert wall thickness** around it, and lead-in
chamfer the top. Confirm the exact insert series with the user — dimensions vary by brand.
Common starting points: M3 insert → ~4.0 mm hole; M4 → ~5.6 mm hole; but **ask for the datasheet value.**

**Captive nuts (hex pocket):** across-flats = nut width across flats + **0.2 mm**; depth =
nut thickness + ~0.2 mm. If the pocket is enclosed (nut trapped inside), the layer bridging
over it needs a flat roof (design a 0.2–0.4 mm ledge or accept a short internal bridge).
Standard across-flats: M3 = 5.5 mm, M4 = 7.0 mm, M5 = 8.0 mm (confirm — DIN 934 vs. nyloc differ).

**Magnets / bearings / dowels:** press-fit pockets use the press class (§4) for a permanent
hold, or snug + glue. For a 608 bearing (22 mm OD) press pocket ≈ 21.9–22.0 mm. Always ask
the user for the actual OD and thickness; don't assume a size from the name.

## 9. Text and embossing

- **Stroke width** ≥ 2 × nozzle (0.8 mm for 0.4 nozzle) or thin strokes drop out.
- **Depth/height** ≥ 2–3 layers (~0.4–0.6 mm).
- **Debossed** (recessed) text on a top surface prints cleanly. **Embossed** (raised) is fine on top too. Text on a *bottom* face fights elephant's foot — avoid unless requested.
- Keep font sizes modest; very small serifs won't resolve.

## 10. Splitting a part to fit the bed

If any dimension exceeds bed − margin, in order of preference:
1. **Reorient** — a diagonal placement gains ~1.4× the bed's edge length along one axis; a taller-than-wide part may fit standing up.
2. **Split with registration + fastening:**
   - **Alignment:** dowel pins (press one side, snug the other), or a puzzle/dovetail joint.
   - **Fastening:** screw tabs with heat-set inserts, bolt-and-captive-nut, or a dovetail + glue.
   - Put the split on a plane that doesn't cross a critical feature, and add elephant's-foot chamfers to the new bottom faces.
3. If neither works, tell the user the part exceeds their bed and lay out the options — don't emit an unprintable STL without saying so.
