import { resolveWithinProject } from './paths'

/**
 * Result of the programmatic permission gate (see `decideToolPermission`).
 * `'allow'` lets the tool run untouched; `'ask'` means the caller must
 * surface `summary` to the user and wait for an explicit decision before the
 * tool is allowed to run.
 */
export type PermissionDecision = { kind: 'allow' } | { kind: 'ask'; summary: string }

const ALWAYS_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite'])

/**
 * Pure policy function backing the Claude Agent SDK's `canUseTool` handler
 * (wired up in session.ts). Kept side-effect-free and dependency-free so it
 * can be unit-tested directly without spinning up a session.
 *
 * Policy:
 * - `Write` / `Edit` / `NotebookEdit`: allowed only when `input.file_path`
 *   resolves inside `projectDir` (via the same `resolveWithinProject`
 *   containment check the MCP tools use). Anything else - missing path,
 *   non-string path, or a path that escapes the project directory - asks
 *   the user instead of silently failing or silently allowing.
 * - `Read` / `Glob` / `Grep` / `Skill` / `TodoWrite`: always allowed. These
 *   are read-only or purely internal bookkeeping.
 * - `Bash`: always allowed. It's needed to run the generated Python scripts
 *   and the printable-cad validator, and runs with `cwd` set to the project
 *   directory. Full bash sandboxing (restricting which paths/commands it can
 *   touch) is out of scope for v1 and is tracked as a v2 follow-up.
 * - `mcp__voyager__*`: always allowed. Voyager's own MCP tools
 *   (display_model, set_status) already path-guard internally via
 *   `resolveWithinProject`, so the gate doesn't need to duplicate that check.
 * - Anything else: asks the user (fail-safe default for unrecognized tools).
 */
export function decideToolPermission(
  toolName: string,
  input: Record<string, unknown>,
  projectDir: string
): PermissionDecision {
  if (toolName === 'Write' || toolName === 'Edit' || toolName === 'NotebookEdit') {
    const filePath = input.file_path
    if (typeof filePath !== 'string' || filePath.length === 0) {
      return { kind: 'ask', summary: `Use the ${toolName} tool` }
    }
    const resolved = resolveWithinProject(projectDir, filePath, 'file_path')
    if (resolved.ok) return { kind: 'allow' }
    return { kind: 'ask', summary: `${toolName} to ${filePath} (outside the project folder)` }
  }

  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return { kind: 'allow' }

  if (toolName === 'Bash') return { kind: 'allow' }

  if (toolName.startsWith('mcp__voyager__')) return { kind: 'allow' }

  return { kind: 'ask', summary: `Use the ${toolName} tool` }
}
