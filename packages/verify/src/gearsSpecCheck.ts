import type { ConformanceRow, VerificationFinding, VerificationLayer } from '@shared/ipc'

/**
 * Gear-spec verification (WS-H, architecture doc §13 / roadmap's WS-H entry). Unlike layers 1-3
 * (each a python subprocess over one script/mesh/STEP), every check here is a pure formula on the
 * brief's declared `gear` features plus (optionally) the modeled arrangement - no python process,
 * no live env, no pip-installed gear library required. That's a deliberate scope cut: "is this
 * pair of numbers internally consistent" (module/PA match, center distance vs. `m*(z1+z2)/2`,
 * undercut threshold) never needed the actual generated geometry, only the brief + placements.
 *
 * What this file does NOT (yet) check, because it needs a live env this sandbox doesn't have:
 * whether the *actual* exported tooth profile is a true involute (vs. an approximation a given
 * library's spline-based generator might introduce) - that would mean loading the real STL/STEP
 * with OCP/trimesh and sampling the tooth flank, the same caliper-class discipline layer 2/3
 * already apply to walls/holes. Tracked as a follow-up (see this module's doc + the WS-H roadmap
 * entry's contract-change list), not implemented here.
 *
 * Not yet wired into `runVerification.ts` (WS-C-owned/frozen) or `src/main/ipc.ts`'s
 * `verifyIteration` - both need to gather cross-part data (every gear feature in the *whole*
 * locked brief, plus every gear part's `Placement`) that a single per-iteration/per-part
 * `runVerification` call doesn't currently receive. A contract-change request naming the exact
 * wiring is filed in `agents/production-roadmap.md`.
 */

/** One `gear` feature's spec, trimmed to what this check needs (mirrors `Feature`'s `gear`
 *  variant in `src/shared/brief.ts`, but as plain numbers - the caller pulls `.value`/`.moduleMm`
 *  etc. out of the domain `Dim`/`Feature` shapes). */
export interface GearFeatureSpec {
  /** Matches `Feature.id` - referenced in finding/conformance `briefField`s and by `meshesWith`. */
  id: string
  label?: string
  moduleMm: number
  teeth: number
  pressureAngleDeg: number
  /** Degrees; omitted/0 = spur. Sign is the conventional hand indicator (see gears.md §2.2). */
  helixDeg?: number
  /** `Feature.id` of the gear this one is declared to mesh with. */
  meshesWith?: string
  /**
   * The gear's modeled axis position in the shared build space (mm), typically a sibling part's
   * `PartRecord.placement.position` - assumes the generating script centers the gear body on its
   * own local origin (the ordinary build123d convention for a revolved/patterned gear), so a
   * part's placement position *is* its bore axis. Only the X/Y components are used (gears are
   * assumed to sit with parallel, vertical/Z bore axes - the normal flat FDM print orientation for
   * parallel-shaft spur/helical pairs; this check doesn't apply to bevel/crossed-axis pairs).
   * Omit when unknown - the center-distance check degrades to an informational finding instead of
   * guessing.
   */
  axisPositionMm?: readonly [number, number, number]
  /** This gear's `BACKLASH` PARAMS value (mm, per the gears.md §3 convention), read from its
   *  script's manifest. Omit when unknown/not yet extracted. */
  backlashMm?: number
}

export interface GearBacklashAllowanceMm {
  minMm: number
  maxMm: number
}

export interface GearSpecCheckOptions {
  gears: GearFeatureSpec[]
  /**
   * How exactly the modeled center distance must match `m*(z1+z2)/2` - a placement-precision
   * tolerance, NOT a DFM/material number (no print physics involved, just "did the arrangement
   * match the math"). Defaults to 0.05 mm.
   */
  centerDistanceToleranceMm?: number
  /**
   * The FDM backlash allowance range (`design-for-printing.md`'s not-yet-landed gear section -
   * see this module's doc comment and the WS-H roadmap entry's contract-change request). Omit to
   * skip the backlash range check with an `info` finding instead of inventing a number.
   */
  backlashAllowanceMm?: GearBacklashAllowanceMm
  /** Which `VerificationLayer` findings/conformance rows are tagged with. Defaults to
   *  `'brief-conformance'` - the closest existing fit (spec-vs-modeled, like envelope/hole
   *  conformance) until a dedicated `'gear-spec'` layer value lands (contract-change filed,
   *  `src/shared/verification.ts` is frozen/WS-0b-owned). */
  layer?: VerificationLayer
}

export interface GearSpecCheckResult {
  findings: VerificationFinding[]
  conformance: ConformanceRow[]
}

const DEFAULT_CENTER_DISTANCE_TOLERANCE_MM = 0.05
const DEFAULT_LAYER: VerificationLayer = 'brief-conformance'
const EPSILON = 1e-9

function toRad(deg: number): number {
  return (deg * Math.PI) / 180
}

/** Standard full-depth involute undercut threshold with no profile shift: a gear needs at least
 *  this many teeth (real, for a spur gear - use `virtualToothCount` for helical) to avoid the
 *  generating rack cutting into its own root. `2 / sin(PA)^2` ~ 17 at 20 deg PA, ~32 at 14.5 deg
 *  PA - both widely cited textbook figures (Shigley, Machinery's Handbook); the continuous
 *  formula is used directly rather than an ad-hoc rounding of either citation. */
export function minTeethToAvoidUndercut(pressureAngleDeg: number): number {
  return 2 / Math.sin(toRad(pressureAngleDeg)) ** 2
}

/** The "virtual"/formative tooth count used for helical-gear strength and undercut checks -
 *  larger than the real count, which is why a helical gear resists undercut at a lower real
 *  tooth count than an equivalent spur gear. */
export function virtualToothCount(teeth: number, helixDeg = 0): number {
  if (!helixDeg) return teeth
  return teeth / Math.cos(toRad(helixDeg)) ** 3
}

/** Transverse module - equals the base module for a spur gear (`helixDeg` 0/undefined); larger
 *  for a helical gear, which is what actually sets center distance. */
function transverseModuleMm(gear: GearFeatureSpec): number {
  if (!gear.helixDeg) return gear.moduleMm
  return gear.moduleMm / Math.cos(toRad(gear.helixDeg))
}

/** `m_transverse * (z1 + z2) / 2` - the standard (non-profile-shifted) center distance for a
 *  parallel-shaft spur or helical pair (gears.md §2.3 / architecture doc §13). Uses gear `a`'s
 *  transverse module; when the module/helix-match checks in `runGearSpecCheck` pass, `b`'s is
 *  identical, so it doesn't matter which side supplies it. */
export function theoreticalCenterDistanceMm(a: GearFeatureSpec, b: GearFeatureSpec): number {
  return (transverseModuleMm(a) * (a.teeth + b.teeth)) / 2
}

function pairKey(aId: string, bId: string): string {
  return [aId, bId].sort().join('::')
}

function fmt(n: number): string {
  return n.toFixed(2)
}

/**
 * Runs the gear-spec checks (matched module/PA/helix across each declared `meshesWith` pair,
 * center distance vs. the modeled arrangement, backlash within the DFM allowance once one is
 * configured, undercut warnings) over every gear feature in a locked brief. See this module's
 * top-of-file doc comment for what's deliberately out of scope (bevel/crossed-axis center
 * distance, profile shift, live-geometry tooth-profile inspection).
 */
export function runGearSpecCheck(options: GearSpecCheckOptions): GearSpecCheckResult {
  const layer = options.layer ?? DEFAULT_LAYER
  const centerDistanceToleranceMm = options.centerDistanceToleranceMm ?? DEFAULT_CENTER_DISTANCE_TOLERANCE_MM
  const findings: VerificationFinding[] = []
  const conformance: ConformanceRow[] = []

  const byId = new Map(options.gears.map((g) => [g.id, g]))
  const visitedPairs = new Set<string>()

  const gearLabel = (g: GearFeatureSpec): string => g.label ?? g.id

  for (const gear of options.gears) {
    // -- undercut: a per-gear property, independent of pairing --
    const zv = virtualToothCount(gear.teeth, gear.helixDeg)
    const zMin = minTeethToAvoidUndercut(gear.pressureAngleDeg)
    if (zv < zMin) {
      findings.push({
        layer,
        severity: 'suggestion',
        message: `Gear '${gearLabel(gear)}' has ${gear.teeth} teeth at ${gear.pressureAngleDeg}° PA (virtual count ${fmt(
          zv
        )}), below the ~${fmt(zMin)}-tooth undercut threshold for a non-profile-shifted gear - the root may be undercut/weakened. More teeth, a larger module, or profile shift (not covered in v1) can fix this.`,
        briefField: `features.${gear.id}.teeth`
      })
    }

    // -- pairing --
    if (!gear.meshesWith) {
      findings.push({
        layer,
        severity: 'suggestion',
        message: `Gear '${gearLabel(gear)}' has no declared mesh partner (meshesWith unset) - module/PA match, center distance, and backlash checks were skipped. Confirm what it meshes with.`,
        briefField: `features.${gear.id}.meshesWith`
      })
      continue
    }

    const mate = byId.get(gear.meshesWith)
    if (!mate) {
      findings.push({
        layer,
        severity: 'blocking',
        message: `Gear '${gearLabel(gear)}' declares meshesWith='${gear.meshesWith}', but no such gear feature exists in the brief.`,
        briefField: `features.${gear.id}.meshesWith`
      })
      continue
    }

    const key = pairKey(gear.id, mate.id)
    if (visitedPairs.has(key)) continue
    visitedPairs.add(key)

    if (mate.meshesWith !== undefined && mate.meshesWith !== gear.id) {
      findings.push({
        layer,
        severity: 'suggestion',
        message: `Gear '${gearLabel(gear)}' declares meshesWith='${mate.id}', but '${gearLabel(mate)}' declares meshesWith='${mate.meshesWith}' instead of '${gear.id}' - confirm which gears actually mesh.`,
        briefField: `features.${gear.id}.meshesWith`
      })
    }

    // -- module match (blocking) --
    const moduleMatch = Math.abs(gear.moduleMm - mate.moduleMm) < EPSILON
    conformance.push({
      briefField: `features.${gear.id}+${mate.id}.module`,
      spec: `${fmt(gear.moduleMm)} mm (must match)`,
      measured: `${fmt(gear.moduleMm)} mm vs ${fmt(mate.moduleMm)} mm`,
      pass: moduleMatch
    })
    if (!moduleMatch) {
      findings.push({
        layer,
        severity: 'blocking',
        message: `Module mismatch: '${gearLabel(gear)}' is module ${fmt(gear.moduleMm)} mm, '${gearLabel(mate)}' is module ${fmt(mate.moduleMm)} mm - a meshing pair must share the same module.`,
        briefField: `features.${gear.id}+${mate.id}.module`
      })
    }

    // -- pressure angle match (blocking) --
    const paMatch = Math.abs(gear.pressureAngleDeg - mate.pressureAngleDeg) < EPSILON
    conformance.push({
      briefField: `features.${gear.id}+${mate.id}.pressureAngle`,
      spec: `${fmt(gear.pressureAngleDeg)}° (must match)`,
      measured: `${fmt(gear.pressureAngleDeg)}° vs ${fmt(mate.pressureAngleDeg)}°`,
      pass: paMatch
    })
    if (!paMatch) {
      findings.push({
        layer,
        severity: 'blocking',
        message: `Pressure angle mismatch: '${gearLabel(gear)}' is ${fmt(gear.pressureAngleDeg)}°, '${gearLabel(mate)}' is ${fmt(mate.pressureAngleDeg)}° - a meshing pair must share the same pressure angle.`,
        briefField: `features.${gear.id}+${mate.id}.pressureAngle`
      })
    }

    // -- helix: magnitude must match (blocking); same sign is unusual, not necessarily wrong --
    const helixA = gear.helixDeg ?? 0
    const helixB = mate.helixDeg ?? 0
    const helixMagnitudeMatch = Math.abs(Math.abs(helixA) - Math.abs(helixB)) < EPSILON
    if (!helixMagnitudeMatch) {
      findings.push({
        layer,
        severity: 'blocking',
        message: `Helix angle mismatch: '${gearLabel(gear)}' is ${fmt(helixA)}°, '${gearLabel(mate)}' is ${fmt(helixB)}° - a spur gear can't mesh with a helical one, and helical mates must share the same helix magnitude.`,
        briefField: `features.${gear.id}+${mate.id}.helix`
      })
    } else if (helixA !== 0 && Math.sign(helixA) === Math.sign(helixB)) {
      findings.push({
        layer,
        severity: 'suggestion',
        message: `Gears '${gearLabel(gear)}'/'${gearLabel(mate)}' declare the same-hand helix angle (both ${fmt(helixA)}°) - an ordinary parallel-shaft external mesh needs opposite hands. Confirm this is an intentional crossed-axis pair, not a sign mistake.`,
        briefField: `features.${gear.id}+${mate.id}.helix`
      })
    }

    // -- center distance vs. modeled axes (blocking when both positions are known) --
    const theoreticalMm = theoreticalCenterDistanceMm(gear, mate)
    if (gear.axisPositionMm && mate.axisPositionMm) {
      const [ax, ay] = gear.axisPositionMm
      const [bx, by] = mate.axisPositionMm
      const actualMm = Math.hypot(ax - bx, ay - by)
      const deltaMm = actualMm - theoreticalMm
      const withinTolerance = Math.abs(deltaMm) <= centerDistanceToleranceMm
      conformance.push({
        briefField: `features.${gear.id}+${mate.id}.centerDistance`,
        spec: `${fmt(theoreticalMm)} mm (m·(z₁+z₂)/2)`,
        measured: `${fmt(actualMm)} mm (Δ ${deltaMm >= 0 ? '+' : ''}${fmt(deltaMm)} mm)`,
        pass: withinTolerance
      })
      if (!withinTolerance) {
        findings.push({
          layer,
          severity: 'blocking',
          message: `Center distance for '${gearLabel(gear)}'/'${gearLabel(mate)}' is modeled at ${fmt(actualMm)} mm, but the formula gives ${fmt(theoreticalMm)} mm (Δ ${fmt(deltaMm)} mm) - ${deltaMm < 0 ? 'the gears will interfere/collide' : 'the mesh will be loose or may not engage'}.`,
          briefField: `features.${gear.id}+${mate.id}.centerDistance`
        })
      }
    } else {
      findings.push({
        layer,
        severity: 'info',
        message: `Center distance for '${gearLabel(gear)}'/'${gearLabel(mate)}' not checked - no modeled axis position supplied for one or both parts (expected ${fmt(theoreticalMm)} mm per m·(z₁+z₂)/2).`,
        briefField: `features.${gear.id}+${mate.id}.centerDistance`
      })
    }

    // -- backlash within the DFM allowance --
    if (!options.backlashAllowanceMm) {
      findings.push({
        layer,
        severity: 'info',
        message: `Backlash for '${gearLabel(gear)}'/'${gearLabel(mate)}' not checked - no DFM backlash allowance is configured yet (pending contract-change to design-for-printing.md; see references/gears.md).`,
        briefField: `features.${gear.id}+${mate.id}.backlash`
      })
    } else if (gear.backlashMm === undefined || mate.backlashMm === undefined) {
      findings.push({
        layer,
        severity: 'info',
        message: `Backlash for '${gearLabel(gear)}'/'${gearLabel(mate)}' not checked - one or both scripts have no BACKLASH PARAMS value yet (references/gears.md §3).`,
        briefField: `features.${gear.id}+${mate.id}.backlash`
      })
    } else {
      if (Math.abs(gear.backlashMm - mate.backlashMm) > EPSILON) {
        findings.push({
          layer,
          severity: 'suggestion',
          message: `Gears '${gearLabel(gear)}'/'${gearLabel(mate)}' declare different BACKLASH values (${fmt(gear.backlashMm)} mm vs ${fmt(mate.backlashMm)} mm) - align them so both sides assume the same intended clearance.`,
          briefField: `features.${gear.id}+${mate.id}.backlash`
        })
      }
      const backlashMm = (gear.backlashMm + mate.backlashMm) / 2
      const { minMm, maxMm } = options.backlashAllowanceMm
      if (backlashMm < minMm) {
        findings.push({
          layer,
          severity: 'suggestion',
          message: `Backlash for '${gearLabel(gear)}'/'${gearLabel(mate)}' is ${fmt(backlashMm)} mm, below the ${fmt(minMm)} mm DFM minimum - the pair may bind/gall when printed.`,
          briefField: `features.${gear.id}+${mate.id}.backlash`
        })
      } else if (backlashMm > maxMm) {
        findings.push({
          layer,
          severity: 'suggestion',
          message: `Backlash for '${gearLabel(gear)}'/'${gearLabel(mate)}' is ${fmt(backlashMm)} mm, above the ${fmt(maxMm)} mm DFM maximum - expect a looser mesh with more play/backlash than typical.`,
          briefField: `features.${gear.id}+${mate.id}.backlash`
        })
      }
    }
  }

  return { findings, conformance }
}
