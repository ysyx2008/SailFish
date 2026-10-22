/**
 * 专家团给界面看的那份：长消息怎么截、随会话落盘再读回来不丢角色和群聊。
 */
import { describe, it, expect } from 'vitest'
import { ExpertTeam, VIEW_MESSAGE_MAX, VIEW_TOTAL_MAX, WAKES_PER_CHECKPOINT } from '../expert-team'
import { Conversation } from '../../conversation/conversation'
import { stepRecordToStep } from '../../conversation/messages'
import type { AgentStep } from '@shared/types'

const members = [
  { name: '写需求', role: '产品专家', description: '把需求写清楚' },
  { name: '写代码', role: '开发专家', description: '实现' },
]

describe('专家团给界面看的那份', () => {
  it('带上团名、每条话、这一段叫醒了几次和是否在等组长', () => {
    const team = new ExpertTeam('小工具组', members)
    team.post('写需求', ['写代码'], '需求写好了')
    const view = team.view('/tmp/team-小工具组.md')
    expect(view.name).toBe('小工具组')
    expect(view.messages).toHaveLength(1)
    expect(view.messages[0]).toMatchObject({ seq: 1, from: '写需求', to: ['写代码'], text: '需求写好了' })
    expect(view.messages[0].omitted).toBeUndefined()
    expect(view.wakes).toBe(1)
    expect(view.wakeLimit).toBe(WAKES_PER_CHECKPOINT)
    expect(view.waitingLeader).toBe(false)
    expect(view.transcriptPath).toBe('/tmp/team-小工具组.md')
  })

  it('单条超过 2 万字才截断，并记下没放进来的字数', () => {
    const team = new ExpertTeam('小工具组', members)
    team.post('写需求', ['写代码'], 'a'.repeat(5000))
    team.post('写代码', [], 'b'.repeat(VIEW_MESSAGE_MAX + 1234))
    const [short, long] = team.view().messages
    expect(short.text).toHaveLength(5000)
    expect(short.omitted).toBeUndefined()
    expect(long.text).toHaveLength(VIEW_MESSAGE_MAX)
    expect(long.omitted).toBe(1234)
  })

  it('合起来超过总上限时只留最近的，记下更早的有几条', () => {
    const team = new ExpertTeam('小工具组', members)
    const each = 15000
    for (let i = 0; i < 6; i++) team.post('写需求', [], String(i).repeat(each))
    const view = team.view()
    expect(view.messages.length).toBe(Math.floor(VIEW_TOTAL_MAX / each))
    expect(view.messages[view.messages.length - 1].seq).toBe(6)
    expect(view.earlierOmitted).toBe(6 - view.messages.length)
    expect(view.messages.reduce((n, m) => n + m.text.length, 0)).toBeLessThanOrEqual(VIEW_TOTAL_MAX)
    expect(new ExpertTeam('空', members).view().earlierOmitted).toBeUndefined()
  })

  it('截断不把表情切成半个', () => {
    const team = new ExpertTeam('小工具组', members)
    team.post('写需求', [], 'a'.repeat(VIEW_MESSAGE_MAX - 1) + '😀' + 'b'.repeat(10))
    const [m] = team.view().messages
    expect(m.text).toBe('a'.repeat(VIEW_MESSAGE_MAX - 1))
    expect(m.omitted).toBe(12)
  })

  it('满一段进入等组长后，界面那份跟着变', () => {
    const team = new ExpertTeam('小工具组', members)
    for (let i = 0; i < WAKES_PER_CHECKPOINT; i++) team.post('写需求', ['写代码'], `第 ${i + 1} 次`)
    expect(team.view().waitingLeader).toBe(true)
    expect(team.view().wakes).toBe(WAKES_PER_CHECKPOINT)
  })
})

describe('派出那一步随会话落盘再读回', () => {
  it('专家角色和整段群聊都在，长消息不被截短', () => {
    const team = new ExpertTeam('小工具组', members)
    team.post('写需求', ['写代码'], '需'.repeat(5000))
    team.leaderSpoke('写代码', '先做最小的一版')
    const dispatchStep = {
      id: 'dispatch_1',
      type: 'tool_call',
      content: '派出专家团「小工具组」· 2 位专家',
      toolName: 'dispatch_experts',
      timestamp: 2,
      subAgents: [
        { id: '写需求', name: '写需求', role: '产品专家', description: '把需求写清楚', status: 'completed' },
        { id: '写代码', name: '写代码', role: '开发专家', description: '实现', status: 'running' },
      ],
      expertTeam: team.view('/tmp/team.md'),
    } as AgentStep

    const conv = Conversation.create({ agentKey: 'tab-e', terminalType: 'assistant' }, { id: 'sess_e', createdAt: 1 })
    conv.commitRun({
      runId: 'run1',
      userRequest: '做个小工具',
      steps: [{ id: 'u', type: 'user_task', content: '做个小工具', timestamp: 1 } as AgentStep, dispatchStep],
      taskMessageLog: [{ role: 'user', content: '做个小工具' }],
      runMessages: [{ role: 'user', content: '做个小工具' }],
      taskStatus: 'success',
      result: '',
    })

    const onDisk = JSON.parse(JSON.stringify(conv.toRecord({ terminalId: 'pty' })))
    const back = onDisk.steps.map(stepRecordToStep).find((s: AgentStep) => s.id === 'dispatch_1') as AgentStep
    expect(back.subAgents?.map(s => s.role)).toEqual(['产品专家', '开发专家'])
    expect(back.expertTeam?.name).toBe('小工具组')
    expect(back.expertTeam?.messages.map(m => m.from)).toEqual(['写需求', '组长'])
    expect(back.expertTeam?.messages[0].text).toHaveLength(5000)
    expect(back.expertTeam?.transcriptPath).toBe('/tmp/team.md')
  })
})
