import type { ProjectIteration } from '../src/projects/store'
import type { VoyagerMcpDeps, VoyagerMcpEmission, VoyagerMcpProjectStore } from './types'

/** Shared by every tool's test file - not itself a `*.test.ts`, so vitest never runs it directly. */
export function makeDeps(
  projectDir: string,
  emissions: VoyagerMcpEmission[],
  recorded: Array<Parameters<VoyagerMcpProjectStore['recordIteration']>[0]>,
  getActiveIteration: () => ProjectIteration | null
): VoyagerMcpDeps {
  let n = 0
  return {
    projectStore: {
      getProjectDir: () => projectDir,
      recordIteration: async (entry): Promise<ProjectIteration> => {
        recorded.push(entry)
        n += 1
        return { ...entry, n, at: new Date().toISOString() }
      },
      activeIterationRecord: async (): Promise<ProjectIteration | null> => getActiveIteration(),
      getActivePartId: async (): Promise<string> => 'main'
    },
    emit: (emission) => emissions.push(emission)
  }
}

/** A structurally-plausible binary STL: 80-byte header + count + one triangle. */
export function fakeStlBytes(): Buffer {
  return Buffer.alloc(84 + 50, 7)
}
