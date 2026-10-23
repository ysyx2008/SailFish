/**
 * 派出那一步存盘是一行：一队人的过程不能让这一行大到读回时被换成占位
 * （那样重开对话后专家卡片和群聊都没了）。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp', getName: () => 'SailFish', getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

import {
  toSubAgentView,
  viewStepsPerAgent,
  VIEW_STEPS_MIN,
  VIEW_STEPS_PER_AGENT,
  VIEW_STEPS_TOTAL,
} from '../tools/sub-agent'

function snapshot(name: string, stepCount: number) {
  return {
    name,
    description: '扫描',
    prompt: '很长的任务说明'.repeat(100),
    status: 'completed',
    result: '结论'.repeat(300),
    steps: Array.from({ length: stepCount }, (_, i) => ({
      id: `${name}-${i}`,
      tool: 'read_file',
      args: `/Users/yushen/Source/SFTerminal/electron/services/agent/第${i}个很长的路径.ts`.repeat(2),
      status: 'completed' as const,
      result: '工具输出'.repeat(1000),
    })),
    role: '安全审计',
  } as unknown as Parameters<typeof toSubAgentView>[0]
}

describe('派出那一步的体量', () => {
  it('每位只留最近几步，且留的是最后几步', () => {
    const view = toSubAgentView(snapshot('甲', 189), VIEW_STEPS_PER_AGENT)
    expect(view.steps).toHaveLength(VIEW_STEPS_PER_AGENT)
    expect(view.steps?.at(-1)?.id).toBe('甲-188')
    expect(view.steps?.[0]).not.toHaveProperty('result')
  })

  it('人越多每位留得越少，合计有上限，至少留几步', () => {
    expect(viewStepsPerAgent(2)).toBe(VIEW_STEPS_PER_AGENT)
    expect(viewStepsPerAgent(30)).toBe(Math.floor(VIEW_STEPS_TOTAL / 30))
    expect(viewStepsPerAgent(1000)).toBe(VIEW_STEPS_MIN)
  })

  it('13 位各干了上百步，这一行仍远小于原来的 559KB', () => {
    const limit = viewStepsPerAgent(13)
    const views = Array.from({ length: 13 }, (_, i) => toSubAgentView(snapshot(`专家${i}`, 150), limit))
    const bytes = Buffer.byteLength(JSON.stringify({ subAgents: views }), 'utf8')
    expect(bytes).toBeLessThan(200 * 1024)
  })
})
