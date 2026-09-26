/**
 * 「终端」技能由系统管：不进技能目录 / 设置 / @ 列表，模型不能手动装，
 * 终端还在座时模型卸不掉；终端页照旧直接带终端工具。
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

vi.mock('../../user-skill.service', () => ({
  USER_SKILL_ID_PREFIX: 'user:',
  toUserSkillId: (id: string) => id.startsWith('user:') ? id : `user:${id}`,
  parseUserSkillId: (id: string) => (id.startsWith('user:') ? id.slice(5) || null : null),
  getUserSkillService: () => ({
    getSkill: () => undefined,
    getEnabledSkills: () => [],
    getSkillContent: () => null
  })
}))

import '../skills'
import { getSkill, getSkillsSummary, BuiltinSkillEnablement, TERMINAL_SKILL_ID } from '../skills'
import { createSkillSession } from '../skills/skill-loader'
import { loadSkillTool, unloadSkillTool } from '../tools/misc'
import { getAgentTools } from '../tools'
import type { ToolExecutorConfig } from '../tools/types'

function executor(overrides: Partial<ToolExecutorConfig> = {}): ToolExecutorConfig {
  return {
    skillSession: createSkillSession([]),
    addStep: vi.fn(),
    markSkillUnloaded: vi.fn(),
    ...overrides
  } as unknown as ToolExecutorConfig
}

describe('「终端」技能由系统管', () => {
  it('注册着，带全部终端工具', () => {
    const skill = getSkill(TERMINAL_SKILL_ID)
    expect(skill?.systemManaged).toBe(true)
    expect(skill?.tools.map(t => t.function.name)).toEqual([
      'execute_command', 'check_terminal_status', 'get_terminal_context', 'send_control_key', 'send_input', 'wait'
    ])
  })

  it('不进模型能挑的技能目录，也不进设置页和 @ 列表', () => {
    expect(getSkillsSummary().some(s => s.id === TERMINAL_SKILL_ID)).toBe(false)
    expect(new BuiltinSkillEnablement(undefined).listForSettings().some(s => s.id === TERMINAL_SKILL_ID)).toBe(false)
    const skillTool = getAgentTools(undefined, { mode: 'assistant' }).find(t => t.function.name === 'skill')!
    expect(skillTool.function.description).not.toMatch(/- terminal:/)
    expect(JSON.stringify(skillTool.function.parameters)).not.toContain('"terminal"')
  })

  it('模型手动装：拒绝，并告诉它先开终端', async () => {
    const ex = executor()
    const result = await loadSkillTool({ skill_id: TERMINAL_SKILL_ID }, {} as never, ex)
    expect(result.success).toBe(false)
    expect(result.error).toContain('manage_pane')
    expect(ex.skillSession!.getLoadedSkills()).not.toContain(TERMINAL_SKILL_ID)
  })

  it('终端还在座时模型卸不掉；关窗后能卸', async () => {
    const session = createSkillSession([])
    await session.loadSkill(TERMINAL_SKILL_ID)

    const seated = await unloadSkillTool({ skill_id: TERMINAL_SKILL_ID }, executor({ skillSession: session, getCurrentPtyId: () => 'pty-1' }))
    expect(seated.success).toBe(false)
    expect(session.getLoadedSkills()).toContain(TERMINAL_SKILL_ID)

    const closed = await unloadSkillTool({ skill_id: TERMINAL_SKILL_ID }, executor({ skillSession: session, getCurrentPtyId: () => undefined }))
    expect(closed.success).toBe(true)
    expect(session.getLoadedSkills()).not.toContain(TERMINAL_SKILL_ID)
  })

  it.each(['local', 'ssh'] as const)('终端页（%s）照旧直接带终端工具', (mode) => {
    const names = getAgentTools(undefined, { mode }).map(t => t.function.name)
    expect(names).toContain('execute_command')
    expect(names).toContain('check_terminal_status')
  })
})
