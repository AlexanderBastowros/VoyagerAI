# Clarify checklist — leave no ambiguity

Walk this at Phase 2. The goal is that after this step, a competent machinist could
build the part from your notes with zero guesses. Ask only the items that are actually
unresolved for the part at hand — don't robotically read all of it aloud — but do not
proceed past a genuine gap. When the user gives an adjective ("sturdy," "small hole,"
"rounded"), convert it to a number and confirm.

## Geometry & datums
- [ ] Every **overall dimension** (L × W × H) with units. Confirm mm vs. inch if there's any doubt.
- [ ] For each feature: is a stated size a **diameter or a radius**? A **width or a half-width**?
- [ ] **Origin / datum**: where is (0,0,0)? Are dimensions from an edge, a center, a face?
- [ ] **Symmetry**: is the part symmetric, and about which plane(s)? (Lets you catch mirror mistakes.)

## Print orientation
- [ ] **Which face sits on the bed?** This decides overhangs, strength (Z is weakest), and where supports land. If the user doesn't know, propose an orientation and explain the tradeoff.

## Walls & solidity
- [ ] **Wall thickness** for hollow parts / enclosures (route through `MIN_WALL`).
- [ ] **Solid or shelled?** If shelled, uniform wall or specific?
- [ ] **Floor/lid thickness** if different from side walls.

## Holes (ask per hole)
- [ ] **Diameter** and **position** (from which datum).
- [ ] **Purpose** — this changes the modeled size:
      clearance for a screw? tapped/self-tapping? press-fit dowel? free-spinning shaft?
- [ ] **Through or blind?** If blind, depth.
- [ ] **Counterbore / countersink?** For what fastener head?
- [ ] **Orientation** — vertical (clean) or horizontal (needs teardrop/diamond)?

## Edges
- [ ] **Fillets vs. chamfers**, and on **which edges** — and remember bottom/overhang edges want chamfers, not fillets, to print support-free.
- [ ] Radius/size of each.

## Mating / assembly
- [ ] Does this part **mate** with another printed part or a bought component? Get the mating dimensions.
- [ ] Required **fit class** (press / snug / free / loose) — see DFM §4.
- [ ] Is this a **print-in-place** mechanism? If so, confirm the joint gap (DFM §5).

## Hardware
- [ ] Screws/bolts: **size and standard** (M3? #6? length? head type?).
- [ ] **Heat-set inserts**? Which series — get the datasheet OD/length, don't assume.
- [ ] **Captive nuts** (hex pocket)? Nut standard and across-flats.
- [ ] **Bearings / magnets / dowels**? Exact OD, ID, thickness.

## Text / markings
- [ ] Any text or logos? Content, **embossed or debossed**, which face, approximate size.

## Constraints & preferences
- [ ] **Max weight / material budget**, or infill preference that affects wall/rib design?
- [ ] **Framework** confirmed (build123d default; CadQuery on request)?
- [ ] **Export formats** (STL always; STEP default; 3MF on request)?

## When an image or drawing was uploaded
- [ ] Describe back **every feature** you see and confirm you've identified them correctly.
- [ ] Get a **real-world dimension for at least one feature** to set scale — never scale off pixels.
- [ ] If it's a dimensioned drawing, **read the dimensions back**, including which are Ø vs. R, and note any that are missing or illegible.
- [ ] Confirm the **view** (is that the top, front, or a section?) so you build the right geometry.
