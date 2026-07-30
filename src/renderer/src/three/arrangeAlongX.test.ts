import * as THREE from 'three'
import { describe, expect, it } from 'vitest'
import {
  MODEL_UP_TO_WORLD_UP_DEG,
  PART_GAP_MM,
  PLATE_MARGIN_MM,
  arrangeAlongX,
  type ArrangeItem
} from './arrangeAlongX'
import { groundClamp, rotatedLocalBounds } from './placement'

const IDENTITY: readonly [number, number, number] = [0, 0, 0]

/** A min-corner-origined box, exactly as `loadPart`/`buildMesh` produce one. */
function boxItem(partId: string, x: number, y: number, z: number): ArrangeItem {
  return { partId, localMin: new THREE.Vector3(0, 0, 0), localMax: new THREE.Vector3(x, y, z) }
}

/** The world AABB a placement puts an item at: `worldMin = position + rotatedLocalBounds().min`
 *  (see `rotatedLocalBounds`' contract - parts rotate about their local origin, so `position` is
 *  neither the centre nor the world min). */
function worldBox(
  item: ArrangeItem,
  placement: { position: [number, number, number]; rotation: [number, number, number] }
): { min: THREE.Vector3; max: THREE.Vector3 } {
  const rb = rotatedLocalBounds(item.localMin, item.localMax, placement.rotation)
  const offset = new THREE.Vector3(...placement.position)
  return { min: rb.min.clone().add(offset), max: rb.max.clone().add(offset) }
}

describe('spacing constants', () => {
  it('are the sourced brim/skirt margin, not the print-in-place joint gap', () => {
    // `SKILL.md`: "Reserve a margin (~5 mm per side) for brim/skirt"; `validate_stl.py --margin`
    // defaults to 5 and is spent as `bed - 2 * margin`. The 0.3-0.5 mm figure in
    // `design-for-printing.md` is the print-in-place JOINT clearance - a different category.
    expect(PLATE_MARGIN_MM).toBe(5)
    expect(PART_GAP_MM).toBe(10)
  })
})

describe('arrangeAlongX - identity rotation row geometry', () => {
  const a = boxItem('a', 10, 6, 4)
  const b = boxItem('b', 10, 6, 4)

  it('centres a two-box row on the origin with exactly one gap between facing edges', () => {
    const { placements, rowWidthMm, overflow } = arrangeAlongX([a, b], {
      rotationDeg: IDENTITY,
      usableXMm: null
    })

    expect(rowWidthMm).toBeCloseTo(30) // 10 + 10 (gap) + 10
    expect(overflow).toBeNull()
    expect(placements.map((p) => p.partId)).toEqual(['a', 'b'])

    const boxA = worldBox(a, placements[0].placement)
    const boxB = worldBox(b, placements[1].placement)

    expect(boxA.min.x).toBeCloseTo(-15)
    expect(boxA.max.x).toBeCloseTo(-5)
    expect(boxB.min.x).toBeCloseTo(5)
    expect(boxB.max.x).toBeCloseTo(15)

    // Facing edges exactly one gap apart, and the row symmetric about the grid origin.
    expect(boxB.min.x - boxA.max.x).toBeCloseTo(PART_GAP_MM)
    expect(boxA.min.x + boxB.max.x).toBeCloseTo(0)
  })

  it('straddles the plate centreline in z and rests both parts on the plate', () => {
    const { placements } = arrangeAlongX([a, b], { rotationDeg: IDENTITY, usableXMm: null })
    for (const [i, item] of [a, b].entries()) {
      const world = worldBox(item, placements[i].placement)
      expect(world.min.z + world.max.z).toBeCloseTo(0)
      expect(world.min.y).toBeCloseTo(0)
    }
  })
})

describe('arrangeAlongX - print-orientation rotation', () => {
  // Model space is Z-up: this 10 (X) x 6 (Y) x 4 (Z) box prints 4 mm tall on a 10 x 6 footprint.
  const a = boxItem('a', 10, 6, 4)
  const b = boxItem('b', 10, 6, 4)

  it('lands the real bed face on the grid: min.y === 0, depth from model Y, height from model Z', () => {
    const { placements, rowWidthMm } = arrangeAlongX([a, b], {
      rotationDeg: MODEL_UP_TO_WORLD_UP_DEG,
      usableXMm: null
    })

    // Rx(-90) leaves the X footprint alone, so the row width is unchanged from the identity case.
    expect(rowWidthMm).toBeCloseTo(30)

    for (const [i, item] of [a, b].entries()) {
      const { placement } = placements[i]
      expect(placement.rotation).toEqual([-90, 0, 0])

      const world = worldBox(item, placement)
      // Resting on the plate with NO lift: this is what makes the preview honest about the bed face.
      expect(world.min.y).toBeCloseTo(0)
      expect(world.max.x - world.min.x).toBeCloseTo(10) // footprint width  <- model X
      expect(world.max.z - world.min.z).toBeCloseTo(6) //  footprint depth  <- model Y
      expect(world.max.y - world.min.y).toBeCloseTo(4) //  PRINT HEIGHT, now vertical <- model Z
      // Depth straddles the centreline rather than hanging off one side of it.
      expect(world.min.z).toBeCloseTo(-3)
      expect(world.max.z).toBeCloseTo(3)
    }
  })

  it('compensates the rotate-about-min-corner offset in z (position[2] === 3, not 0)', () => {
    // Rx(-90) maps local y (0..6) to world z (-6..0), so a naive `position[2] = 0` would park every
    // part entirely at negative z. `-(rb.min.z + rb.max.z) / 2` is the term that fixes it.
    const { placements } = arrangeAlongX([a], { rotationDeg: MODEL_UP_TO_WORLD_UP_DEG, usableXMm: null })
    expect(placements[0].placement.position[2]).toBeCloseTo(3)
  })

  it('produces placements `groundClamp` leaves untouched (the viewer cannot lift them)', () => {
    // `viewer.setPartPlacement` ground-clamps everything it is handed; if the arranged y were below
    // the resting height the viewer would silently move the row.
    const { placements } = arrangeAlongX([a, b], {
      rotationDeg: MODEL_UP_TO_WORLD_UP_DEG,
      usableXMm: null
    })
    for (const [i, item] of [a, b].entries()) {
      const { placement } = placements[i]
      // `groundClamp` takes the resting height rather than deriving it - the O(vertices) pass is
      // memoised per part+rotation in `ModelViewer.getRestingY`. These items are min-corner boxes,
      // so their 8 AABB corners *are* their vertices and `rotatedLocalBounds` yields exactly the
      // height `restingYFromVertices` would return for the same geometry.
      const restingY = -rotatedLocalBounds(item.localMin, item.localMax, placement.rotation).min.y
      expect(groundClamp(placement, restingY)).toEqual(placement)
    }
  })
})

describe('arrangeAlongX - rotated extents stay disjoint', () => {
  it('reserves a [0,45,0] part its ROTATED x extent, gapped from its neighbour', () => {
    const a = boxItem('a', 10, 6, 4)
    const b = boxItem('b', 10, 6, 4)
    const rotationDeg: readonly [number, number, number] = [0, 45, 0]
    const rotatedWidth = (10 + 4) * Math.SQRT1_2 // ~9.8995: Ry(45) mixes model x and z

    const { placements, rowWidthMm } = arrangeAlongX([a, b], { rotationDeg, usableXMm: null })
    expect(rowWidthMm).toBeCloseTo(2 * rotatedWidth + PART_GAP_MM)

    const boxA = worldBox(a, placements[0].placement)
    const boxB = worldBox(b, placements[1].placement)
    expect(boxA.max.x - boxA.min.x).toBeCloseTo(rotatedWidth)
    expect(boxB.min.x - boxA.max.x).toBeCloseTo(PART_GAP_MM) // disjoint by exactly the gap
  })

  it('compensates a NEGATIVE rotated min.x so the row stays centred and gapped', () => {
    // Ry(-45) pushes the rotated box's min.x to -2.83 (unlike Ry(+45), where it happens to be 0),
    // so this is the case that actually exercises `position[0] = cursor - rb.min.x`. With a naive
    // `position[0] = cursor` both parts would slide left by 2.83 mm - the gap survives, the row's
    // centring does not.
    const a = boxItem('a', 10, 6, 4)
    const b = boxItem('b', 10, 6, 4)
    const rotationDeg: readonly [number, number, number] = [0, -45, 0]
    expect(rotatedLocalBounds(a.localMin, a.localMax, rotationDeg).min.x).toBeCloseTo(-4 * Math.SQRT1_2)

    const { placements, rowWidthMm } = arrangeAlongX([a, b], { rotationDeg, usableXMm: null })
    const boxA = worldBox(a, placements[0].placement)
    const boxB = worldBox(b, placements[1].placement)

    expect(boxA.min.x).toBeCloseTo(-rowWidthMm / 2)
    expect(boxB.max.x).toBeCloseTo(rowWidthMm / 2)
    expect(boxB.min.x - boxA.max.x).toBeCloseTo(PART_GAP_MM)
  })
})

describe('arrangeAlongX - idempotence', () => {
  const items = [boxItem('a', 10, 6, 4), boxItem('b', 22, 3, 9), boxItem('c', 5, 5, 5)]
  const options = { rotationDeg: MODEL_UP_TO_WORLD_UP_DEG, usableXMm: 246 }

  it('returns deep-equal results for repeated calls', () => {
    expect(arrangeAlongX(items, options)).toEqual(arrangeAlongX(items, options))
  })

  it('re-arranging an already-arranged set is a no-op (input is local bounds, never placements)', () => {
    // The row is a function of the items' LOCAL geometry bounds and the requested rotation only -
    // the parts' current placements are not an input, so nothing can accumulate across toggles.
    const first = arrangeAlongX(items, options)
    const second = arrangeAlongX(items, options)
    expect(second.placements).toEqual(first.placements)
    expect(second.rowWidthMm).toBe(first.rowWidthMm)
  })
})

describe('arrangeAlongX - bed overflow', () => {
  // 129 + 10 + 129 = 268 mm row against a 256 mm bed's 246 mm usable width.
  const items = [boxItem('a', 129, 6, 4), boxItem('b', 129, 6, 4)]

  it('reports both numbers and changes nothing', () => {
    const usableXMm = 246
    const arranged = arrangeAlongX(items, { rotationDeg: IDENTITY, usableXMm })
    expect(arranged.rowWidthMm).toBeCloseTo(268)
    expect(arranged.overflow).toEqual({ rowWidthMm: arranged.rowWidthMm, usableXMm })

    // No shrink, no wrap onto a second row - identical placements to the bed-unknown call.
    const unchecked = arrangeAlongX(items, { rotationDeg: IDENTITY, usableXMm: null })
    expect(arranged.placements).toEqual(unchecked.placements)
  })

  it('gives no verdict at all when the bed width is unknown', () => {
    expect(arrangeAlongX(items, { rotationDeg: IDENTITY, usableXMm: null }).overflow).toBeNull()
  })

  it('does not flag a row that exactly fills the usable width', () => {
    expect(arrangeAlongX(items, { rotationDeg: IDENTITY, usableXMm: 268 }).overflow).toBeNull()
  })
})

describe('arrangeAlongX - degenerate inputs', () => {
  it('handles an empty part list', () => {
    expect(arrangeAlongX([], { rotationDeg: MODEL_UP_TO_WORLD_UP_DEG, usableXMm: 246 })).toEqual({
      placements: [],
      rowWidthMm: 0,
      overflow: null
    })
  })

  it('centres a single part on the origin with no gap applied', () => {
    const a = boxItem('a', 10, 6, 4)
    const { placements, rowWidthMm } = arrangeAlongX([a], { rotationDeg: IDENTITY, usableXMm: null })
    expect(rowWidthMm).toBeCloseTo(10) // no gap for a row of one
    const world = worldBox(a, placements[0].placement)
    expect(world.min.x).toBeCloseTo(-5)
    expect(world.max.x).toBeCloseTo(5)
  })

  it('survives a zero-extent (degenerate) box without producing NaN', () => {
    const flat = boxItem('flat', 0, 0, 0)
    const { placements, rowWidthMm } = arrangeAlongX([flat], {
      rotationDeg: MODEL_UP_TO_WORLD_UP_DEG,
      usableXMm: null
    })
    expect(rowWidthMm).toBe(0)
    expect(placements[0].placement.position.every(Number.isFinite)).toBe(true)
  })
})
