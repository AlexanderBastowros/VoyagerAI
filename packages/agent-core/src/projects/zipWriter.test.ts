import { describe, expect, it } from 'vitest'
import { crc32, inflateRawSync } from 'node:zlib'
import { writeZip, type ZipEntry } from './zipWriter'

const STAMP = new Date(2026, 6, 10, 12, 30, 42)

interface ParsedEntry {
  name: string
  data: Buffer
  method: number
  flags: number
  time: number
  date: number
}

/**
 * Independent spec-level reader: walks the central directory back from the EOCD record, then
 * cross-checks every entry's LOCAL header field-by-field against its central copy (offsets 6-25:
 * flags, method, DOS time/date, CRC-32, both sizes) and verifies the payloads tile the file
 * exactly (each entry's data ends where the next local header starts, the last where the central
 * directory starts). Real extractors read whichever half suits them - Info-ZIP trusts the central
 * directory, libarchive/bsdtar streams the local headers - so a writer bug confined to either
 * half must fail here, not just in one family of tools.
 */
function readZip(archive: Buffer): { names: string[]; contents: Map<string, Buffer>; entries: ParsedEntry[] } {
  const eocdOffset = archive.length - 22
  expect(archive.readUInt32LE(eocdOffset)).toBe(0x06054b50)
  const entryCount = archive.readUInt16LE(eocdOffset + 10)
  expect(archive.readUInt16LE(eocdOffset + 8)).toBe(entryCount)
  const centralSize = archive.readUInt32LE(eocdOffset + 12)
  const centralOffset = archive.readUInt32LE(eocdOffset + 16)
  expect(centralOffset + centralSize).toBe(eocdOffset)

  const names: string[] = []
  const contents = new Map<string, Buffer>()
  const entries: ParsedEntry[] = []
  let cursor = centralOffset
  let expectedLocalOffset = 0
  for (let i = 0; i < entryCount; i++) {
    expect(archive.readUInt32LE(cursor)).toBe(0x02014b50)
    const flags = archive.readUInt16LE(cursor + 8)
    const method = archive.readUInt16LE(cursor + 10)
    const time = archive.readUInt16LE(cursor + 12)
    const date = archive.readUInt16LE(cursor + 14)
    const checksum = archive.readUInt32LE(cursor + 16)
    const compressedSize = archive.readUInt32LE(cursor + 20)
    const uncompressedSize = archive.readUInt32LE(cursor + 24)
    const nameLength = archive.readUInt16LE(cursor + 28)
    const localOffset = archive.readUInt32LE(cursor + 42)
    const name = archive.subarray(cursor + 46, cursor + 46 + nameLength).toString('utf8')

    // Entries must tile the file with no gaps or overlaps: this entry starts exactly where the
    // previous one ended, so the size fields are load-bearing, not just decorative.
    expect(localOffset).toBe(expectedLocalOffset)

    // Local header must agree with the central copy on every shared field.
    expect(archive.readUInt32LE(localOffset)).toBe(0x04034b50)
    expect(archive.readUInt16LE(localOffset + 6)).toBe(flags)
    expect(archive.readUInt16LE(localOffset + 8)).toBe(method)
    expect(archive.readUInt16LE(localOffset + 10)).toBe(time)
    expect(archive.readUInt16LE(localOffset + 12)).toBe(date)
    expect(archive.readUInt32LE(localOffset + 14)).toBe(checksum)
    expect(archive.readUInt32LE(localOffset + 18)).toBe(compressedSize)
    expect(archive.readUInt32LE(localOffset + 22)).toBe(uncompressedSize)
    const localNameLength = archive.readUInt16LE(localOffset + 26)
    const localExtraLength = archive.readUInt16LE(localOffset + 28)
    expect(archive.subarray(localOffset + 30, localOffset + 30 + localNameLength).toString('utf8')).toBe(name)

    const dataStart = localOffset + 30 + localNameLength + localExtraLength
    const payload = archive.subarray(dataStart, dataStart + compressedSize)
    expect(method === 8 || method === 0).toBe(true)
    const data = method === 8 ? inflateRawSync(payload) : Buffer.from(payload)
    expect(data.length).toBe(uncompressedSize)
    if (method === 0) expect(compressedSize).toBe(uncompressedSize)
    expect(crc32(data)).toBe(checksum)

    names.push(name)
    contents.set(name, data)
    entries.push({ name, data, method, flags, time, date })
    cursor += 46 + nameLength
    expectedLocalOffset = dataStart + compressedSize
  }
  // The last payload must run right up to the central directory.
  expect(expectedLocalOffset).toBe(centralOffset)
  return { names, contents, entries }
}

/** Decodes a DOS date/time pair back to calendar fields (the inverse of the writer's packing). */
function decodeDosDateTime(date: number, time: number): {
  year: number
  month: number
  day: number
  hours: number
  minutes: number
  seconds: number
} {
  return {
    year: ((date >> 9) & 0x7f) + 1980,
    month: (date >> 5) & 0x0f,
    day: date & 0x1f,
    hours: (time >> 11) & 0x1f,
    minutes: (time >> 5) & 0x3f,
    seconds: (time & 0x1f) * 2
  }
}

describe('writeZip', () => {
  it('round-trips multiple entries with names, contents, and CRCs intact', () => {
    const entries: ZipEntry[] = [
      { name: 'bracket_v2.stl', data: Buffer.from('solid bracket\nendsolid bracket\n') },
      { name: 'lid_v1.stl', data: Buffer.from('solid lid\nendsolid lid\n') },
      { name: 'lid_v1.step', data: Buffer.from('ISO-10303-21;\nEND-ISO-10303-21;\n') }
    ]
    const { names, contents } = readZip(writeZip(entries, STAMP))
    expect(names).toEqual(['bracket_v2.stl', 'lid_v1.stl', 'lid_v1.step'])
    for (const entry of entries) {
      expect(contents.get(entry.name)).toEqual(Buffer.from(entry.data))
    }
  })

  it('stamps every entry with the given local time as a DOS date/time', () => {
    const { entries } = readZip(writeZip([{ name: 'a.stl', data: Buffer.from('solid a\n') }], STAMP))
    // DOS timestamps have 2-second resolution; STAMP's 42s is even, so it round-trips exactly.
    expect(decodeDosDateTime(entries[0].date, entries[0].time)).toEqual({
      year: 2026,
      month: 7,
      day: 10,
      hours: 12,
      minutes: 30,
      seconds: 42
    })
  })

  it('flags entry names as UTF-8 and round-trips a non-ASCII name', () => {
    const data = Buffer.from('solid ä\n')
    const { entries, contents } = readZip(writeZip([{ name: 'gehäuse_v1.stl', data }], STAMP))
    expect(entries[0].flags & 0x0800).toBe(0x0800)
    expect(entries[0].name).toBe('gehäuse_v1.stl')
    expect(contents.get('gehäuse_v1.stl')).toEqual(data)
  })

  it('deflates compressible data and stores incompressible data', () => {
    const compressible = Buffer.alloc(4096, 'a')
    // High-entropy bytes (a fixed pattern, not random, so the test is deterministic) that
    // deflate cannot shrink.
    const incompressible = Buffer.from(
      Array.from({ length: 256 }, (_, i) => (i * 167 + 13) % 256)
    )
    const archive = writeZip(
      [
        { name: 'big.stl', data: compressible },
        { name: 'noise.bin', data: incompressible }
      ],
      STAMP
    )
    expect(archive.length).toBeLessThan(compressible.length)
    const { contents, entries } = readZip(archive)
    expect(entries.map((e) => e.method)).toEqual([8, 0])
    expect(contents.get('big.stl')).toEqual(compressible)
    expect(contents.get('noise.bin')).toEqual(incompressible)
  })

  it('handles binary data and a Uint8Array view into a larger buffer', () => {
    const backing = new Uint8Array(64).map((_, i) => i)
    const view = backing.subarray(16, 32)
    const { contents } = readZip(writeZip([{ name: 'view.bin', data: view }], STAMP))
    expect(contents.get('view.bin')).toEqual(Buffer.from(view))
  })

  it('rejects an empty archive', () => {
    expect(() => writeZip([], STAMP)).toThrow(/at least one entry/)
  })

  it('rejects duplicate entry names', () => {
    const data = Buffer.from('x')
    expect(() =>
      writeZip(
        [
          { name: 'main_v1.stl', data },
          { name: 'main_v1.stl', data }
        ],
        STAMP
      )
    ).toThrow(/duplicate entry name/)
  })

  it('rejects hostile or malformed entry names', () => {
    const data = Buffer.from('x')
    for (const name of ['', '/abs.stl', '../escape.stl', 'a/../b.stl', 'a//b.stl', 'a\\b.stl']) {
      expect(() => writeZip([{ name, data }], STAMP)).toThrow(/invalid entry name/)
    }
  })

  it('clamps pre-1980 timestamps to the 1980-01-01 DOS epoch floor', () => {
    const { entries, contents } = readZip(
      writeZip([{ name: 'old.stl', data: Buffer.from('x') }], new Date(1970, 0, 1))
    )
    expect(decodeDosDateTime(entries[0].date, entries[0].time)).toEqual({
      year: 1980,
      month: 1,
      day: 1,
      hours: 0,
      minutes: 0,
      seconds: 0
    })
    expect(contents.get('old.stl')).toEqual(Buffer.from('x'))
  })
})
