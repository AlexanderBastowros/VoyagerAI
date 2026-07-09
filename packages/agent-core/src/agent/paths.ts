import { isAbsolute, relative, resolve } from 'node:path'

export interface ResolvedPath {
  /** Absolute path on disk. */
  abs: string
  /** Path relative to the project directory - what gets persisted/emitted. */
  rel: string
}

/**
 * Resolves `candidate` (relative or absolute) against `projectDir` and
 * rejects anything that escapes it - Claude's tool calls are trusted for
 * *content* but not for *paths*, so a hallucinated or malicious `../../`
 * must never let the app read/expose/write files outside the project.
 *
 * Shared by the in-process MCP tools (mcpTools.ts) and the `canUseTool`
 * permission policy (permissions.ts) so both enforce the same containment
 * rule with a single implementation.
 */
export function resolveWithinProject(
  projectDir: string,
  candidate: string,
  label: string
): { ok: true; path: ResolvedPath } | { ok: false; error: string } {
  const abs = resolve(projectDir, candidate)
  const rel = relative(projectDir, abs)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, error: `${label} "${candidate}" resolves outside the project directory and was rejected.` }
  }
  return { ok: true, path: { abs, rel } }
}
