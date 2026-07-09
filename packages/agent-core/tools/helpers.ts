import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** Minimum size of a structurally-plausible binary STL (80-byte header + 4-byte triangle count). */
export const MIN_STL_BYTES = 84

export function textResult(text: string, isError = false): CallToolResult {
  return { content: [{ type: 'text', text }], isError }
}

export function toArrayBuffer(buffer: Buffer): ArrayBuffer {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
}
