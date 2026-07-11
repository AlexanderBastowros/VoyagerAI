import type { ContentBlockParam, ImageBlockParam } from '@anthropic-ai/sdk/resources'
import type { ChatAttachment, Placement, PrinterProfileRef, SelectionSummary } from '@shared/ipc'
import type { ProjectIteration } from '../projects/store'

/**
 * The "your printer is already known" (or "no profile yet - ask, then offer to save") paragraph
 * appended by `systemPromptAppend` (WS-E, product doc §4.4). Overrides the printable-cad skill's
 * Phase-1 instruction to ask the nozzle/bed questions up front: with an active profile those
 * answers are settings, not questions. `null` means "a profile store exists but nothing is
 * saved/active"; the caller omits the paragraph entirely only when no store is wired at all
 * (`undefined` - e.g. bare test harnesses).
 */
export function formatPrinterProfileContext(profile: PrinterProfileRef | null): string {
  if (!profile) {
    return [
      'The user has not saved a printer profile yet. Ask the printable-cad skill\'s Phase-1 printer',
      'questions (nozzle diameter, bed size) as usual - then, once the user has answered, offer to',
      'save the answers as a reusable profile with the `save_printer_profile` MCP tool (only save',
      'after they agree). With a saved profile, future projects skip these questions entirely.'
    ].join('\n')
  }

  const materials =
    profile.materials.length > 0 ? ` Materials on hand: ${profile.materials.join(', ')}.` : ''
  return [
    `The user's saved printer profile "${profile.name}" is active: bed ${profile.bedXMm} x`,
    `${profile.bedYMm} x ${profile.bedZMm} mm (X x Y x Z), nozzle diameter`,
    `${profile.nozzleDiameterMm} mm.${materials} Treat these as the already-confirmed answers to the`,
    'printable-cad skill\'s Phase-1 printer questions - do NOT ask the user for nozzle diameter or',
    'bed size; derive the script\'s `NOZZLE`, `BED_X`, `BED_Y`, `BED_Z` (and `MIN_WALL`) constants',
    'from this profile, and use the same values for the Phase-5 validator\'s `--bed-x/--bed-y/',
    '--bed-z/--nozzle` flags. Mention in passing which profile you\'re using so the user can',
    'correct you. If they say this project is for a different printer, use their values instead',
    'and encourage saving them as a new profile with the `save_printer_profile` MCP tool (a',
    'newly saved profile becomes the active one). That matters beyond convenience: Voyager\'s',
    'automatic verification panel checks bed fit against the *active saved profile*, so until',
    'the different printer is saved, tell the user the panel\'s bed-fit result may be judged',
    'against the wrong printer. Also record the switched printer\'s name/bed/nozzle via',
    '`update_brief`\'s `printer_name`/`printer_bed_x_mm`/`printer_bed_y_mm`/`printer_bed_z_mm`/',
    '`printer_nozzle_mm` fields right away - that\'s what makes verification prefer the project\'s',
    'actual printer over the active saved profile, without waiting on a saved-profile confirmation.'
  ].join('\n')
}

/**
 * Extra context appended to the `claude_code` preset system prompt (see
 * `systemPrompt: { type: 'preset', preset: 'claude_code', append: ... }` in
 * session.ts). Orients Claude inside the Voyager AI desktop app and points
 * it at the printable-cad skill and the project's working directory.
 *
 * `printerProfile` is the user's active printer profile (WS-E): a `PrinterProfileRef` pre-answers
 * the skill's Phase-1 printer questions, `null` instructs asking-then-offering-to-save, and
 * `undefined` (no profile store wired - some test harnesses) omits the topic entirely.
 */
export function systemPromptAppend(projectDir: string, printerProfile?: PrinterProfileRef | null): string {
  return [
    'You are the modeling engine inside Voyager AI, a desktop app for 3D-printing hobbyists.',
    'The user sees your replies in a chat panel next to a live 3D viewport - keep replies',
    'conversational and compact; you are not writing documentation.',
    '',
    `Your project working directory (cwd) is \`${projectDir}\`. It already contains an` +
      ' `./outputs/` directory and a project-local copy of the printable-cad skill' +
      ' (installed under `.claude/skills/printable-cad`).',
    '',
    'ALWAYS follow the printable-cad skill\'s phased workflow for any part-modeling request -',
    'it is installed in this project and takes priority over improvising. Save every artifact to',
    '`./outputs/` with a version suffix (`<part>_vN.py`, `<part>_vN.stl`, `<part>_vN.step`) so',
    'earlier iterations are never overwritten.',
    '',
    'Alongside the chat, the user sees a live Design Brief panel - the structured, machine-checkable',
    'spec (part identity, envelope, features, materials, constraints, exclusions, acceptance',
    'criteria) that gates generation and later verification. During Phase 2 (specify the part), call',
    'the `update_brief` MCP tool as soon as you confirm a field with the user - don\'t hold it all in',
    'your own context until the end; the panel should fill in live as the conversation progresses.',
    'Every value you set through `update_brief` is recorded with "inferred" provenance and renders',
    'distinctly in the panel until the user confirms it or edits it directly - you never get to mark',
    'a field as user-confirmed yourself. Phase 4 (generating code) requires a locked brief: the user',
    'locks it from the panel, which also sends you a message telling you it\'s locked so you can',
    'proceed. If the user asks you to generate before that message arrives, tell them to review and',
    'lock the brief in the panel first rather than generating against an unlocked one.',
    '',
    'After every successful export + validation (Phase 5 of the skill), call the `display_model`',
    'MCP tool so the model appears in the user\'s viewport - never generate `viewer.html`, Voyager',
    'has its own native viewer. Call `set_status` for brief progress notes on longer steps (running',
    'the script, validating the mesh) so the user isn\'t staring at a blank chat.',
    '',
    'A Voyager project can hold more than one part (a box AND its lid, a gear pair, split pieces) -',
    'each with its own version history and placement in a shared build space (architecture doc',
    '§14). Name the part in `display_model`\'s `part` argument (a short slug like "lid" or',
    '"gear_small") whenever the project has, or should have, more than one part: a new slug creates',
    'a new part, an existing slug keeps refining it; omit it only for a genuinely single-part',
    'project. If the user\'s next request could plausibly apply to more than one part and none is',
    'clearly the one in focus, ask which part they mean before regenerating - never guess.',
    '',
    'When the user asks for print settings or slicer settings for the current model, call the',
    '`recommend_print_settings` MCP tool (skill Phase 7) instead of just replying in prose - it',
    'renders as a list in Voyager\'s print-settings panel.',
    '',
    ...(printerProfile !== undefined ? [formatPrinterProfileContext(printerProfile), ''] : []),
    'The user cannot run commands themselves - you run everything (the script, the validator, etc.)',
    'on their behalf. `python` on PATH is Voyager\'s managed CAD environment with build123d, trimesh,',
    'and numpy pre-installed; use it directly.',
    '',
    'The user may highlight a region of the currently displayed model. When they do, their next',
    'message will include a "Selected region" context block (bounding box, centroid, size, triangle',
    'count) generated by the viewport, not typed by the user - correlate it with the current',
    'parametric script to figure out which feature they mean, per the skill\'s Phase 6 guidance.',
    '',
    'Every displayed version is snapshotted to `./outputs/versions/<part>/vN.py` (an exact copy of',
    'the script that produced version N of that part - `<part>` is `main` for a single-part',
    'project). The user can revert to an earlier version; when they do, their',
    'next message will include a "Reverted model" context block naming that version and its',
    '`./outputs/versions/<part>/vN.py` script. Treat that script as the current source of truth: copy it',
    'forward to the next `<part>_vN.py` and modify that, rather than continuing from a later version',
    'you generated earlier - the user has intentionally branched back to it.'
  ].join('\n')
}

/**
 * Formats a `SelectionSummary` (a highlighted viewport region) into the
 * "Selected region" context block the printable-cad skill expects to find
 * appended to the user's message (see SKILL.md Phase 6). Includes
 * `selection.partId` (WS-I multi-part, §14) when set, so a region-selected on
 * a specific part in a multi-part project tells the agent which part
 * "make this hole bigger" refers to, instead of leaving it to guess or ask.
 */
export function formatSelectionContext(selection: SelectionSummary): string {
  const fmt = (n: number): string => n.toFixed(2)
  const [minX, minY, minZ] = selection.bboxMin
  const [maxX, maxY, maxZ] = selection.bboxMax
  const [cx, cy, cz] = selection.centroid
  const [dx, dy, dz] = selection.dims

  return [
    '--- Selected region (from viewport, not typed by the user) ---',
    ...(selection.partId ? [`Part: ${selection.partId}`] : []),
    `Bounding box min: (${fmt(minX)}, ${fmt(minY)}, ${fmt(minZ)}) mm`,
    `Bounding box max: (${fmt(maxX)}, ${fmt(maxY)}, ${fmt(maxZ)}) mm`,
    `Centroid: (${fmt(cx)}, ${fmt(cy)}, ${fmt(cz)}) mm`,
    `Dimensions (W x D x H): ${fmt(dx)} x ${fmt(dy)} x ${fmt(dz)} mm`,
    `Triangle count: ${selection.triCount}`,
    'Correlate this region with the current parametric script\'s geometry (by position and size)' +
      ' to identify which named feature the user means; confirm your interpretation before' +
      ' regenerating if there is any ambiguity.'
  ].join('\n')
}

/**
 * Formats the "Reverted model" context block injected into the user's turn
 * while they are sitting on an earlier version (their `activeIteration` is
 * behind the latest recorded one). Tells the agent which version is current
 * and, crucially, which on-disk script produced it, so further edits branch
 * from that script instead of the superseded later versions. Uses the
 * app-controlled `scriptSnapshotPath` (guaranteed to match the STL) when
 * present, falling back to the agent-written `scriptPath` for older records.
 */
export function formatRevertContext(active: ProjectIteration, latestN: number): string {
  const script = active.scriptSnapshotPath ?? active.scriptPath
  const supersededRange =
    active.n + 1 === latestN ? `v${latestN}` : `v${active.n + 1}-v${latestN}`
  return [
    '--- Reverted model (from Voyager, not typed by the user) ---',
    `The user reverted to model v${active.n}. It is the currently displayed version.`,
    `The script that produced it is \`${script}\`.`,
    `Base any further changes on that script - copy it forward to the next \`<part>_vN.py\` and`,
    `modify that. Do NOT continue from the now-superseded later versions (${supersededRange}); the`,
    'user has intentionally branched back to this one.'
  ].join('\n')
}

/** One part's name/id and placement, as needed by `formatArrangementContext` - a trimmed view of
 *  `PartRecord` (name + id + placement only; the arrangement block has no use for visibility or
 *  the active-iteration pointer). */
export interface PartArrangementEntry {
  id: string
  name: string
  placement: Placement
}

/**
 * Formats the "Part arrangement" context block (WS-I follow-up, architecture doc §14): every
 * part's name/id and placement (position in mm, XYZ-Euler rotation in degrees) in the shared
 * build space, and which part - if any - the user currently has focused. Gives the agent the
 * spatial context `prompts.ts`'s parts-vocabulary paragraph assumes it has when deciding which
 * part an ambiguous request targets. Callers should only pass this for a genuinely multi-part
 * project (2+ parts) - see `buildUserMessage`'s `arrangementContext` param - a single-part project
 * has nothing to disambiguate and the block would just be noise.
 */
export function formatArrangementContext(parts: PartArrangementEntry[], focusedPartId?: string | null): string {
  const lines = parts.map((part) => {
    const [px, py, pz] = part.placement.position
    const [rx, ry, rz] = part.placement.rotation
    const focusTag = part.id === focusedPartId ? ' [currently focused]' : ''
    return `- "${part.name}" (part: ${part.id})${focusTag}: position (${px}, ${py}, ${pz}) mm, rotation (${rx}, ${ry}, ${rz})°`
  })
  return [
    '--- Part arrangement (from Voyager, not typed by the user) ---',
    'This project has multiple parts, laid out together in a shared build space:',
    ...lines,
    focusedPartId
      ? `The user has "${focusedPartId}" focused in the parts panel - assume an otherwise-ambiguous change targets it unless they say otherwise.`
      : 'No part is currently focused - if the request could apply to more than one part, ask which one before regenerating.'
  ].join('\n')
}

/**
 * Combines the user's typed text with formatted context blocks - a highlighted
 * selection region, a "Reverted model" notice, and/or the multi-part "Part
 * arrangement" block (all optional, all can be present) - into the user
 * turn's message content. Stays a plain string when there are no attachments
 * (matching every message before this feature existed); only becomes a
 * content-block array - images first, so the following text block can refer
 * to "the image above" - when the user attached at least one image.
 */
export function buildUserMessage(
  text: string,
  selectionContext?: SelectionSummary | null,
  attachments?: ChatAttachment[],
  revertContext?: string | null,
  arrangementContext?: string | null
): string | ContentBlockParam[] {
  const blocks = [text]
  if (selectionContext) blocks.push(formatSelectionContext(selectionContext))
  if (revertContext) blocks.push(revertContext)
  if (arrangementContext) blocks.push(arrangementContext)
  const combined = blocks.join('\n\n')
  if (!attachments || attachments.length === 0) return combined

  const imageBlocks: ImageBlockParam[] = attachments.map((attachment) => ({
    type: 'image',
    source: { type: 'base64', media_type: attachment.mediaType, data: attachment.data }
  }))
  return [...imageBlocks, { type: 'text', text: combined }]
}
