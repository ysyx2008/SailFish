import { describe, expect, it } from 'vitest'
import { Agent } from '../agent'
import type { AgentContext, AgentRun, AgentServices, PromptOptions } from '../types'
import type { ToolDefinition } from '../../ai.service'
import type { RiskLevel } from '@shared/types/agent'

class GateAgent extends Agent {
  protected getAgentId(): string {
    return 'gate'
  }
  getAvailableTools(): ToolDefinition[] {
    return []
  }
  protected buildSystemPrompt(_context: AgentContext, _options: PromptOptions): string {
    return ''
  }
  arm(run: AgentRun) {
    this.currentRun = run
  }
  ask(run: AgentRun, toolCallId: string, risk: RiskLevel) {
    return this.waitForConfirmation(run, toolCallId, 'do_thing', { command: 'rm old.log' }, risk)
  }
}

function runOf(id: string): AgentRun {
  return {
    id,
    aborted: false,
    executionPhase: 'thinking',
    steps: [{ id: 'u1', type: 'user_task', content: '删掉旧日志', timestamp: 1 }],
    messages: [],
    context: {
      terminalType: 'assistant',
      cwd: '/home/me',
      unattended: true,
      systemInfo: { os: 'darwin', shell: 'zsh' },
    },
    abortController: new AbortController(),
  } as AgentRun
}

describe('伙计的确认走主人这场', () => {
  it('高风险问在主人这场，卡片上带伙计的名字', async () => {
    const parent = new GateAgent({} as AgentServices)
    const child = new GateAgent({} as AgentServices)
    const parentRun = runOf('parent-run')
    parent.arm(parentRun)
    child.markAsSubAgent()
    child.bindConfirmationHost(parent, '甲')

    let seen = ''
    parent.setCallbacks({
      onNeedConfirm: (c) => {
        seen = (c.reasons ?? []).join(' ')
        expect(c.agentId).toBe('parent-run')
        expect(c.displayName).toBeUndefined()
        c.resolve(true)
      },
    })

    const result = await child.ask(runOf('child'), 'c1', 'dangerous')
    expect(result.approved).toBe(true)
    expect(seen).toContain('甲')
    expect(parentRun.pendingConfirmation).toBeUndefined()
  })

  it('硬墙直接拦，不问主人这场', async () => {
    const parent = new GateAgent({} as AgentServices)
    const child = new GateAgent({} as AgentServices)
    parent.arm(runOf('parent-run'))
    child.markAsSubAgent()
    child.bindConfirmationHost(parent, '甲')
    let asked = false
    parent.setCallbacks({ onNeedConfirm: () => { asked = true } })

    const result = await child.ask(runOf('child'), 'c2', 'blocked')
    expect(result.approved).toBe(false)
    expect(asked).toBe(false)
  })

  it('额外禁止开着时，高风险直接拦', async () => {
    const parent = new GateAgent({} as AgentServices)
    const child = new GateAgent({} as AgentServices)
    parent.arm(runOf('parent-run'))
    child.markAsSubAgent()
    child.bindConfirmationHost(parent, '甲')
    child.updateConfig({ commandRiskPolicy: { subAgentBlockDangerous: true } as never })
    let asked = false
    parent.setCallbacks({ onNeedConfirm: () => { asked = true } })

    const result = await child.ask(runOf('child'), 'c3', 'dangerous')
    expect(result.approved).toBe(false)
    expect(asked).toBe(false)
  })

  it('问的时候不改主人正在干的阶段；伙计被打断就收掉这张卡', async () => {
    const parent = new GateAgent({} as AgentServices)
    const child = new GateAgent({} as AgentServices)
    const parentRun = runOf('parent-run')
    parentRun.executionPhase = 'waiting'
    parent.arm(parentRun)
    child.markAsSubAgent()
    child.bindConfirmationHost(parent, '甲')

    let dismissed = 0
    parent.setCallbacks({
      onNeedConfirm: () => {},
      onConfirmDismissed: () => { dismissed += 1 },
    })

    const childRun = runOf('child')
    const pending = child.ask(childRun, 'c1', 'dangerous')
    await Promise.resolve()
    expect(parentRun.executionPhase).toBe('waiting')
    childRun.abortController?.abort()
    await expect(pending).resolves.toEqual({ approved: false })
    expect(dismissed).toBe(1)
    expect(parentRun.executionPhase).toBe('waiting')
    expect(parentRun.pendingConfirmation).toBeUndefined()
  })

  it('两个伙计排着问，一次一件', async () => {
    const parent = new GateAgent({} as AgentServices)
    parent.arm(runOf('parent-run'))
    const a = new GateAgent({} as AgentServices)
    const b = new GateAgent({} as AgentServices)
    a.markAsSubAgent()
    b.markAsSubAgent()
    a.bindConfirmationHost(parent, '甲')
    b.bindConfirmationHost(parent, '乙')

    const order: string[] = []
    let releaseFirst: ((approved: boolean) => void) | undefined
    parent.setCallbacks({
      onNeedConfirm: (c) => {
        order.push(c.toolCallId)
        if (c.toolCallId === 'first') releaseFirst = c.resolve
        else c.resolve(true)
      },
    })

    const first = a.ask(runOf('a'), 'first', 'dangerous')
    const second = b.ask(runOf('b'), 'second', 'dangerous')
    await Promise.resolve()
    expect(order).toEqual(['first'])
    releaseFirst?.(true)
    await expect(first).resolves.toEqual({ approved: true })
    await expect(second).resolves.toEqual({ approved: true })
    expect(order).toEqual(['first', 'second'])
  })
})
