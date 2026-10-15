import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0'),
  },
  safeStorage: { isEncryptionAvailable: () => false },
}))

vi.mock('../../../../config.service', () => ({
  getConfigService: () => ({
    getAiProfiles: () => [{
      id: 'ac525902-c3b4-4da2-8435-1e0675ec1344',
      name: 'Qwen3.8-Flash-Next',
      model: 'qwen-vl',
    }],
    getSshSessions: () => [{
      id: 'sess-1',
      name: '公司跳板机',
      host: '10.0.0.5',
    }],
  }),
}))

import { configTools } from '../tools'

function render(toolName: string, args: Record<string, unknown>): string | null {
  const tool = configTools.find(item => item.function.name === toolName)
  return tool?._meta?.streamDisplay?.customRender?.(args) ?? null
}

describe('config_ai_profile step title', () => {
  it('shows the model name when the call only has an id', () => {
    expect(render('config_ai_profile', {
      action: 'update',
      profileId: 'ac525902-c3b4-4da2-8435-1e0675ec1344',
      modelType: 'vision',
    })).toBe('更新 AI 模型: Qwen3.8-Flash-Next')
  })

  it('does not leave a raw id on the card when the model is unknown', () => {
    expect(render('config_ai_profile', {
      action: 'update',
      profileId: 'missing-id',
    })).toBe('更新 AI 模型')
  })
})

describe('config_ssh_session step title', () => {
  it('shows the host name when the call only has an id', () => {
    expect(render('config_ssh_session', {
      action: 'update',
      sessionId: 'sess-1',
      port: 2222,
    })).toBe('更新主机: 公司跳板机')
  })

  it('does not leave a raw id on the card when the host is unknown', () => {
    expect(render('config_ssh_session', {
      action: 'delete',
      sessionId: 'missing',
    })).toBe('删除主机')
  })
})
