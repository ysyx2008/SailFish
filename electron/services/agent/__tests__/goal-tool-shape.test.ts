/**
 * 目标相关的工具只给模型一个：动作写在 action 里，不为每件事单开一个工具（工具说明每场对话都占 token）。
 * 对应 SPEC「任务可以挂一个会自己推进的目标」第 11 条。
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

import { getAgentTools, type ToolDefinitionWithMeta } from '../tools'

const goalToolsOf = (supportsGoal: boolean) =>
  (getAgentTools(undefined, { mode: 'assistant', supportsGoal }) as ToolDefinitionWithMeta[])
    .filter((tool) => /goal/i.test(tool.function.name))

describe('目标工具只有一个', () => {
  it('带目标的会话里，给模型的目标工具只有 goal，动作写在 action 里', () => {
    const tools = goalToolsOf(true)
    expect(tools.map((tool) => tool.function.name)).toEqual(['goal'])
    const params = tools[0].function.parameters as { properties: Record<string, { enum?: string[] }>; required: string[] }
    expect(params.properties.action.enum).toEqual(['get', 'create', 'update'])
    expect(params.required).toEqual(['action'])
  })

  it('不能挂目标的会话里，一个目标工具都没有', () => {
    expect(goalToolsOf(false)).toHaveLength(0)
  })

  it('伙计用不上', () => {
    expect(goalToolsOf(true)[0]._meta?.allowedForSubAgent).toBe(false)
  })

  it('预卡片标题随动作切换', () => {
    const render = goalToolsOf(true)[0]._meta?.streamDisplay?.customRender
    expect(render?.({})).toBeNull()
    expect(render?.({ action: 'get' })).toBe('查看目标')
    expect(render?.({ action: 'create', objective: '把测试跑绿' })).toBe('创建目标: 把测试跑绿')
    expect(render?.({ action: 'update', status: 'complete' })).toBe('更新目标: complete')
    expect(render?.({ action: 'update', objective: '改成这样' })).toBe('改写目标: 改成这样')
  })
})
