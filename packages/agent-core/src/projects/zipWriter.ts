/**
 * Minimal ZIP container writer for the "export all parts" flow (WS-F / §14: a multi-part
 * project exports as separate per-part files in one zip, never a silent merge) and, later,
 * the graduation package builder (§12.1).
 *
 * Pure bytes-in/bytes-out (no `electron`, no filesystem) so it unit-tests under plain
 * vitest - callers read the artifact files and hand in buffers. Built on `node:zlib`'s
 * `crc32`/`deflateRawSync` (Node 22+) rather than a new archive dependency. Entries are
 * deflated unless deflate doesn't shrink them (already-compressed data), which falls back
 * to stored - both methods are readable by every unzip implementation. No ZIP64 support:
 * sizes are guarded instead, since per-part STL/STEP artifacts sit far below the 4 GiB
 * format limit.
 */

import { crc32, deflateRawSync } from 'node:zlib'

export interface ZipEntry {
  /** File name inside the archive, e.g. `bracket_v2.stl`. Forward-slash separated if
   *  nested; never absolute and never containing `..` segments. */
  name: string
  data: Uint8Array
}

const LOCAL_HEADER_SIG = 0x04034b50
const CENTRAL_HEADER_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
/** General-purpose bit 11: entry names are UTF-8. */
const UTF8_NAME_FLAG = 0x0800
/** Version needed to extract: 2.0 (deflate support). */
const ZIP_VERSION = 20
const METHOD_STORED = 0
const METHOD_DEFLATED = 8
const MAX_UINT32 = 0xffffffff
const MAX_ENTRIES = 0xffff

/** MS-DOS date/time pair (local time, 2-second resolution) used by ZIP headers. The format
 *  can't represent pre-1980 dates, so those clamp to the epoch floor rather than underflow. */
function dosDateTime(at: Date): { date: number; time: number } {
  if (at.getFullYear() < 1980) return { date: (1 << 5) | 1, time: 0 } // 1980-01-01 00:00
  const date = ((at.getFullYear() - 1980) << 9) | ((at.getMonth() + 1) << 5) | at.getDate()
  const time = (at.getHours() << 11) | (at.getMinutes() << 5) | (at.getSeconds() >> 1)
  return { date, time }
}

function assertValidEntryNames(entries: ZipEntry[]): void {
  const seen = new Set<string>()
  for (const entry of entries) {
    const segments = entry.name.split('/')
    if (!entry.name || entry.name.startsWith('/') || entry.name.includes('\\') || segments.includes('..') || segments.includes('')) {
      throw new Error(`writeZip: invalid entry name ${JSON.stringify(entry.name)}`)
    }
    if (seen.has(entry.name)) {
      throw new Error(`writeZip: duplicate entry name ${JSON.stringify(entry.name)}`)
    }
    seen.add(entry.name)
  }
}

/**
 * Builds a complete ZIP archive from in-memory entries. `modifiedAt` stamps every entry
 * (callers pass "now"; injected so tests are deterministic).
 */
export function writeZip(entries: ZipEntry[], modifiedAt: Date): Buffer {
  if (entries.length === 0) throw new Error('writeZip: an archive needs at least one entry')
  if (entries.length > MAX_ENTRIES) throw new Error(`writeZip: too many entries for a non-ZIP64 archive (${entries.length})`)
  assertValidEntryNames(entries)

  const { date, time } = dosDateTime(modifiedAt)
  const chunks: Buffer[] = []
  const centralRecords: Buffer[] = []
  let offset = 0

  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, 'utf8')
    const raw = Buffer.from(entry.data.buffer, entry.data.byteOffset, entry.data.byteLength)
    const deflated = deflateRawSync(raw)
    const useDeflate = deflated.length < raw.length
    const payload = useDeflate ? deflated : raw
    const method = useDeflate ? METHOD_DEFLATED : METHOD_STORED
    const checksum = crc32(raw)
    if (raw.length > MAX_UINT32) {
      throw new Error(`writeZip: entry ${JSON.stringify(entry.name)} exceeds the 4 GiB non-ZIP64 limit`)
    }

    const local = Buffer.alloc(30)
    local.writeUInt32LE(LOCAL_HEADER_SIG, 0)
    local.writeUInt16LE(ZIP_VERSION, 4)
    local.writeUInt16LE(UTF8_NAME_FLAG, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(time, 10)
    local.writeUInt16LE(date, 12)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(raw.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28) // extra field length

    const central = Buffer.alloc(46)
    central.writeUInt32LE(CENTRAL_HEADER_SIG, 0)
    central.writeUInt16LE(ZIP_VERSION, 4) // version made by
    central.writeUInt16LE(ZIP_VERSION, 6) // version needed to extract
    central.writeUInt16LE(UTF8_NAME_FLAG, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt16LE(time, 12)
    central.writeUInt16LE(date, 14)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(raw.length, 24)
    central.writeUInt16LE(nameBytes.length, 28)
    // Offsets 30-41 (extra/comment lengths, disk number, internal/external attributes)
    // stay zero from alloc.
    central.writeUInt32LE(offset, 42) // local header offset

    centralRecords.push(Buffer.concat([central, nameBytes]))
    chunks.push(local, nameBytes, payload)
    offset += local.length + nameBytes.length + payload.length
  }

  if (offset > MAX_UINT32) {
    throw new Error('writeZip: archive exceeds the 4 GiB non-ZIP64 limit')
  }

  const centralDir = Buffer.concat(centralRecords)
  const eocd = Buffer.alloc(22)
  eocd.writeUInt32LE(EOCD_SIG, 0)
  // Offsets 4-7 (disk numbers) stay zero.
  eocd.writeUInt16LE(entries.length, 8)
  eocd.writeUInt16LE(entries.length, 10)
  eocd.writeUInt32LE(centralDir.length, 12)
  eocd.writeUInt32LE(offset, 16)
  eocd.writeUInt16LE(0, 20) // comment length

  return Buffer.concat([...chunks, centralDir, eocd])
}
