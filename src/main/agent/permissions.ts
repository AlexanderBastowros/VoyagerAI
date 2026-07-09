import { resolveWithinProject } from './paths'

/**
 * Result of the programmatic permission gate (see `decideToolPermission`).
 * `'allow'` lets the tool run untouched; `'ask'` means the caller must
 * surface `summary` to the user and wait for an explicit decision before the
 * tool is allowed to run; `'deny'` blocks the tool outright without prompting
 * and returns `message` to Claude as the tool result.
 */
export type PermissionDecision =
  | { kind: 'allow' }
  | { kind: 'ask'; summary: string }
  | { kind: 'deny'; message: string }

const ALWAYS_ALLOWED_TOOLS = new Set(['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite'])

/**
 * Steer returned to Claude when it reaches for `AskUserQuestion`. That built-in
 * tool needs an interactive picker the CLI can only render on a TTY; in this
 * headless SDK setup there is no channel to hand the selected answers back as
 * the tool's output (`canUseTool`/`PermissionResult` can only allow or deny),
 * so allowing it hangs the turn forever waiting for an answer that can never
 * arrive. Denying it with this message unblocks the turn and nudges Claude to
 * ask the same question as ordinary chat text, which the app already renders.
 */
export const ASK_USER_QUESTION_STEER =
  'Interactive multiple-choice questions are not supported here. Ask the user your question directly ' +
  'as plain text in your reply instead, listing the options you were going to offer so they can choose.'

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
 * - `AskUserQuestion`: denied outright (never prompts). See
 *   `ASK_USER_QUESTION_STEER` for why allowing it would hang the turn.
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

  if (toolName === 'AskUserQuestion') return { kind: 'deny', message: ASK_USER_QUESTION_STEER }

  if (ALWAYS_ALLOWED_TOOLS.has(toolName)) return { kind: 'allow' }

  if (toolName === 'Bash') return { kind: 'allow' }

  if (toolName.startsWith('mcp__voyager__')) return { kind: 'allow' }

  return { kind: 'ask', summary: `Use the ${toolName} tool` }
}
