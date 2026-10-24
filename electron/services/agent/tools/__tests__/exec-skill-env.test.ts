/**
 * exec 带 skill_id 时，只给这场已经装上的技能注入密钥。
 */
import { describe, expect, it, vi } from 'vitest'

const { tmpUserData } = vi.hoisted(() => {
  const os = require('os') as typeof import('os')
  const path = require('path') as typeof import('path')
  return { tmpUserData: path.join(os.tmpdir(), `sft-exec-skill-env-${process.pid}`) }
})

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue(tmpUserData),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() },
}))

const getSkillEnvMap = vi.fn(async (skillId: string) => {
  if (skillId === 'mail') return { API_KEY: 'secret-mail' }
  if (skillId === 'other') return { API_KEY: 'secret-other' }
  return {}
})

vi.mock('../../../credential.service', () => ({
  getSkillEnvMap: (skillId: string) => getSkillEnvMap(skillId),
  mapSkillEnvToDeclaredCase: (envMap: Record<string, string>) => envMap,
}))

vi.mock('../../../user-skill.service', () => ({
  getUserSkillService: () => ({
    getSkill: () => ({ requires: { env: ['API_KEY'] } }),
  }),
}))

import { executeCommandDirect, skillLoadedForExec } from '../exec'
import { getExecManager } from '../exec-manager'
import type { ToolExecutorConfig } from '../types'

function executor(loaded: { builtin?: string[]; user?: string[] }): ToolExecutorConfig {
  const builtin = new Set(loaded.builtin ?? [])
  const user = new Set(loaded.user ?? [])
  return {
    addStep: vi.fn(),
    isSubAgent: false,
    skillSession: {
      getLoadedSkills: () => [...builtin],
      getWorkingDirectory: () => undefined,
    },
    isUserSkillLoaded: (id: string) => user.has(id) || user.has(`user:${id}`) || [...user].some(x => x === id || x.endsWith(`:${id}`)),
  } as unknown as ToolExecutorConfig
}

describe('skillLoadedForExec', () => {
  it('认这场装上的系统技能和用户技能，不认没装上的', () => {
    const ex = executor({ builtin: ['coding'], user: ['user:mail'] })
    expect(skillLoadedForExec(ex, 'coding')).toBe(true)
    expect(skillLoadedForExec(ex, 'mail')).toBe(true)
    expect(skillLoadedForExec(ex, 'user:mail')).toBe(true)
    expect(skillLoadedForExec(ex, 'other')).toBe(false)
  })

  it('伙计只有自己带上的技能，主人装着而它没带的不算', () => {
    const child = executor({ builtin: ['coding'] })
    expect(skillLoadedForExec(child, 'coding')).toBe(true)
    expect(skillLoadedForExec(child, 'mail')).toBe(false)
  })
})

describe('executeCommandDirect 的技能密钥', () => {
  it('技能没装上时不执行命令，也不去取密钥', async () => {
    getSkillEnvMap.mockClear()
    const spawn = vi.spyOn(getExecManager(), 'spawn')
    const ex = executor({})
    const result = await executeCommandDirect(
      { command: 'echo hi', skill_id: 'other' },
      'call-1',
      { executionMode: 'free' } as never,
      ex,
    )
    expect(result.success).toBe(false)
    expect(result.error).toContain('other')
    expect(result.error).toContain('没有执行')
    expect(getSkillEnvMap).not.toHaveBeenCalled()
    expect(spawn).not.toHaveBeenCalled()
    spawn.mockRestore()
  })

  it('装上的技能会把自己的密钥交给命令', async () => {
    getSkillEnvMap.mockClear()
    const spawn = vi.spyOn(getExecManager(), 'spawn').mockImplementation(() => {
      throw new Error('spawn-captured')
    })
    const ex = executor({ user: ['user:mail'] })
    await expect(executeCommandDirect(
      { command: 'echo hi', skill_id: 'mail' },
      'call-2',
      { executionMode: 'free' } as never,
      ex,
    )).rejects.toThrow('spawn-captured')
    expect(getSkillEnvMap).toHaveBeenCalledWith('mail')
    expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
      env: { API_KEY: 'secret-mail' },
    }))
    expect(JSON.stringify(spawn.mock.calls)).not.toContain('secret-other')
    spawn.mockRestore()
  })
})
