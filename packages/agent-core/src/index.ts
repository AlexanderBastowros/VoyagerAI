export { AgentSession } from './agent/session'
export type { AgentSessionDeps, QueryFn } from './agent/session'

export { ProjectStore, DEFAULT_AGENT_SETTINGS } from './projects/store'
export type { ProjectStoreOptions, ProjectRecord, ProjectIteration } from './projects/store'

export { resolveExportSource } from './projects/exportResolver'
export type { ExportSourceResolution } from './projects/exportResolver'

export { EnvManager } from './python/envManager'
export type { EnvManagerOptions, SmokeTestResult, SpawnLike } from './python/envManager'

export { ClaudeChecker } from './setup/claudeChecks'
export type { ClaudeCheckerOptions, ExecResult } from './setup/claudeChecks'

export { runPreflight, createPreflightChecks } from './setup/preflight'
export type { PreflightCheck, PreflightDeps } from './setup/preflight'

export { BriefStore } from '../brief/store'
export type { DesignBriefVersionSummary } from '../brief/store'
export { computeBriefCompleteness, isBriefComplete, missingBriefFields } from '../brief/completeness'
export type { BriefCompleteness, BriefCompletenessCheck } from '../brief/completeness'
