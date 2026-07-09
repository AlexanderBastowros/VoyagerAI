# Voyager AI — agent onboarding

Voyager AI is an AI-first 3D modeling desktop app for 3D-printing hobbyists: chat → clarify →
parametric build123d script → STL/STEP → live three.js viewport. Electron shell; a Claude
Agent SDK session per project (runs on the maintainer's Claude CLI subscription); a bundled
`printable-cad` skill drives the design-for-FDM workflow.

**Current phase:** productionizing the POC, CLI-backend-first (Bedrock/AWS comes later, on
trigger — see the roadmap). Solo maintainer; multiple agents work in parallel from a shared
work queue.

## Start here

1. **Work queue:** `agents/production-roadmap.md` — self-contained work orders with
   dependency gates and per-order file ownership. Read its **Ground rules** before touching
   anything; only work the order you were assigned, only in the files it owns.
2. **Design docs:** `docs/PRODUCT_DESIGN.md` (what/why, challenged decisions) and
   `docs/TECHNICAL_ARCHITECTURE.md` (target architecture, schemas, migration plan).
3. **Unscheduled backlog:** `agents/future-improvements.md`.

## Conventions

- **Quality gate before any commit:** `npm run typecheck && npm run build && npm test` —
  all green.
- **Typed IPC contract** lives in `src/shared/ipc.ts`; extend it (plus `src/preload/api.ts`
  and `src/preload/index.ts`) rather than adding ad-hoc channels.
- **Injected dependencies** keep main-process modules unit-testable without Electron — no
  `electron` imports in logic modules (see `AgentSession`, `ProjectStore`, `EnvManager`,
  `ClaudeChecker` for the pattern). Tests are vitest, colocated `*.test.ts`.
- **DFM/geometry numbers** come from
  `resources/skills/printable-cad/references/design-for-printing.md` — never invent
  thresholds; generation and verification share that single source of truth.
- Iterations are **immutable and versioned** — never overwrite or delete a recorded
  iteration; new work always records a new version.

## Running it

`npm install && npm run dev` (needs Node 22+, the Claude CLI signed in, and a one-time
managed Python env install — see `README.md`, including the manual end-to-end test script).
