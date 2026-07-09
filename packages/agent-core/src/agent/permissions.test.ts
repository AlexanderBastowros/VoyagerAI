import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ASK_USER_QUESTION_STEER, decideToolPermission } from './permissions'

const PROJECT_DIR = '/home/voyager/projects/current'

describe('decideToolPermission', () => {
  it('allows Write to a relative in-project path', () => {
    const decision = decideToolPermission('Write', { file_path: 'outputs/x.py' }, PROJECT_DIR)
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('allows Write to an absolute in-project path', () => {
    const decision = decideToolPermission(
      'Write',
      { file_path: join(PROJECT_DIR, 'outputs', 'x.py') },
      PROJECT_DIR
    )
    expect(decision).toEqual({ kind: 'allow' })
  })

  it('allows Edit and NotebookEdit to in-project paths the same way as Write', () => {
    expect(decideToolPermission('Edit', { file_path: 'outputs/edit.py' }, PROJECT_DIR)).toEqual({
      kind: 'allow'
    })
    expect(decideToolPermission('NotebookEdit', { file_path: 'outputs/nb.ipynb' }, PROJECT_DIR)).toEqual({
      kind: 'allow'
    })
  })

  it('asks when a relative path escapes the project directory via ../', () => {
    const decision = decideToolPermission('Write', { file_path: '../escape.py' }, PROJECT_DIR)
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') throw new Error('expected ask')
    expect(decision.summary).toContain('../escape.py')
    expect(decision.summary).toContain('outside the project folder')
  })

  it('asks when the path is absolute and outside the project directory', () => {
    const decision = decideToolPermission('Write', { file_path: '/Users/x/Desktop/foo.py' }, PROJECT_DIR)
    expect(decision.kind).toBe('ask')
    if (decision.kind !== 'ask') throw new Error('expected ask')
    expect(decision.summary).toBe('Write to /Users/x/Desktop/foo.py (outside the project folder)')
  })

  it('asks when file_path is missing or not a string', () => {
    expect(decideToolPermission('Write', {}, PROJECT_DIR).kind).toBe('ask')
    expect(decideToolPermission('Edit', { file_path: 42 }, PROJECT_DIR).kind).toBe('ask')
    expect(decideToolPermission('Write', { file_path: '' }, PROJECT_DIR).kind).toBe('ask')
  })

  it('always allows Bash', () => {
    expect(decideToolPermission('Bash', { command: 'python outputs/x.py' }, PROJECT_DIR)).toEqual({
      kind: 'allow'
    })
  })

  it('always allows Read, Glob, Grep, Skill, and TodoWrite', () => {
    for (const toolName of ['Read', 'Glob', 'Grep', 'Skill', 'TodoWrite']) {
      expect(decideToolPermission(toolName, {}, PROJECT_DIR)).toEqual({ kind: 'allow' })
    }
  })

  it('always allows any mcp__voyager__* tool', () => {
    expect(decideToolPermission('mcp__voyager__display_model', {}, PROJECT_DIR)).toEqual({ kind: 'allow' })
    expect(decideToolPermission('mcp__voyager__set_status', {}, PROJECT_DIR)).toEqual({ kind: 'allow' })
    expect(decideToolPermission('mcp__voyager__anything_future', {}, PROJECT_DIR)).toEqual({ kind: 'allow' })
  })

  it('denies AskUserQuestion outright with the prose steer message', () => {
    // Allowing it would hang the turn: the built-in picker has no answer
    // channel in this headless SDK setup (see ASK_USER_QUESTION_STEER).
    const decision = decideToolPermission('AskUserQuestion', { questions: [] }, PROJECT_DIR)
    expect(decision).toEqual({ kind: 'deny', message: ASK_USER_QUESTION_STEER })
  })

  it('asks for an unrecognized tool name', () => {
    const decision = decideToolPermission('SomeFutureTool', {}, PROJECT_DIR)
    expect(decision).toEqual({ kind: 'ask', summary: 'Use the SomeFutureTool tool' })
  })
})
