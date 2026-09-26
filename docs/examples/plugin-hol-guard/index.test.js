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
