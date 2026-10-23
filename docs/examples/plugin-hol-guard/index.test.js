import { describe, expect, it } from 'vitest'
import pluginModule from './index.js'

const { createBeforeToolCallHook, decisionFromGuardPayload } = pluginModule

describe('HOL Guard plugin example', () => {
  it('leaves unrelated tools unchanged', async () => {
    const hook = createBeforeToolCallHook(() => {
      throw new Error('must not run')
    })

    await expect(hook({ toolName: 'read_file', toolArgs: {}, toolCallId: '1' })).resolves.toEqual({})
  })

  it('allows only an explicitly benign Guard allow result', () => {
    expect(decisionFromGuardPayload({
      minimum_action: 'allow',
      classification: { explicitly_benign: true }
    })).toEqual({})

    expect(decisionFromGuardPayload({
      minimum_action: 'allow',
      classification: { explicitly_benign: false }
    })).toEqual({ block: true })
  })

  it('maps Guard review to SailFish approval', () => {
    expect(decisionFromGuardPayload({ minimum_action: 'review' })).toEqual({ requireApproval: true })
  })

  it('blocks Guard deny and unknown results', () => {
    expect(decisionFromGuardPayload({ minimum_action: 'block' })).toEqual({ block: true })
    expect(decisionFromGuardPayload({ status: 'native_unavailable' })).toEqual({ block: true })
  })

  it('passes the exact execute_command command to Guard', async () => {
    const commands = []
    const hook = createBeforeToolCallHook((command) => {
      commands.push(command)
      return {
        minimum_action: 'allow',
        classification: { explicitly_benign: true }
      }
    })

    const decision = await hook({
      toolName: 'execute_command',
      toolArgs: { command: 'git status && printf ok' },
      toolCallId: '2'
    })

    expect(commands).toEqual(['git status && printf ok'])
    expect(decision).toEqual({})
  })

  it('fails closed for missing command input and Guard errors', async () => {
    const hook = createBeforeToolCallHook(() => {
      throw new Error('guard unavailable')
    })

    await expect(hook({
      toolName: 'execute_command',
      toolArgs: {},
      toolCallId: '3'
    })).resolves.toEqual({ block: true })

    await expect(hook({
      toolName: 'execute_command',
      toolArgs: { command: 'rm -rf ./build' },
      toolCallId: '4'
    })).resolves.toEqual({ block: true })
  })
})

describe('HOL Guard CLI execution', () => {
  it('awaits asynchronous execution and keeps flag-like commands positional', async () => {
    let resolveExecution
    const calls = []
    const execution = new Promise((resolve) => { resolveExecution = resolve })
    const pending = pluginModule.runGuard('--help', (...args) => {
      calls.push(args)
      return execution
    })
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(calls).toEqual([[
      'hol-guard',
      ['command', 'test', '--json', '--', '--help'],
      { encoding: 'utf8', timeout: 10_000, windowsHide: true }
    ]])
    resolveExecution({ stdout: '{"minimum_action":"review"}' })
    await expect(pending).resolves.toEqual({ minimum_action: 'review' })
  })

  it('fails closed for malformed output and asynchronous process errors', async () => {
    for (const executeFile of [
      async () => ({ stdout: 'not JSON' }),
      async () => { throw Object.assign(new Error('missing CLI'), { code: 'ENOENT' }) },
      async () => { throw Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }) },
      async () => { throw Object.assign(new Error('nonzero exit'), { code: 1 }) }
    ]) {
      const hook = createBeforeToolCallHook((command) => pluginModule.runGuard(command, executeFile))
      await expect(hook({
        toolName: 'execute_command', toolArgs: { command: 'echo safe' }
      })).resolves.toEqual({ block: true })
    }
  })

  it('awaits the Guard decision before returning from the hook', async () => {
    let resolveDecision
    const decision = new Promise((resolve) => { resolveDecision = resolve })
    const hook = createBeforeToolCallHook(() => decision)
    const pending = hook({ toolName: 'execute_command', toolArgs: { command: 'echo safe' } })
    let settled = false
    pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    resolveDecision({ minimum_action: 'review' })
    await expect(pending).resolves.toEqual({ requireApproval: true })
  })

  it.each(['exec', 'await_exec', 'send_input'])('does not claim coverage for %s', async (toolName) => {
    const hook = createBeforeToolCallHook(() => { throw new Error('must not inspect other tools') })
    await expect(hook({ toolName, toolArgs: { command: 'echo safe' } })).resolves.toEqual({})
  })
})
