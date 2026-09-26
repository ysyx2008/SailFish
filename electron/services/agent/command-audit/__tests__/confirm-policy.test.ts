import { describe, it, expect } from 'vitest'
import {
  isHardBlocked,
  riskNeedsConfirm,
  commandNeedsConfirm,
  isSubAgentBlocked,
  formatHardBlockedMessage,
} from '../confirm-policy'
import type { CommandRiskAssessment } from '../types'

function assessment(
  level: CommandRiskAssessment['level'],
  hasUnknown = false,
): CommandRiskAssessment {
  return { level, parsed: true, calls: [], hasUnknown }
}

describe('isHardBlocked', () => {
  it('仅 blocked 为硬拒绝', () => {
    expect(isHardBlocked('blocked')).toBe(true)
    expect(isHardBlocked('dangerous')).toBe(false)
    expect(isHardBlocked('moderate')).toBe(false)
    expect(isHardBlocked('safe')).toBe(false)
  })
})

describe('riskNeedsConfirm', () => {
  it('blocked：永不走确认（须硬拒绝）', () => {
    expect(riskNeedsConfirm('blocked', 'strict')).toBe(false)
    expect(riskNeedsConfirm('blocked', 'relaxed')).toBe(false)
    expect(riskNeedsConfirm('blocked', 'free')).toBe(false)
  })

  it('strict：非 blocked 全部确认（含 safe）', () => {
    expect(riskNeedsConfirm('safe', 'strict')).toBe(true)
    expect(riskNeedsConfirm('moderate', 'strict')).toBe(true)
    expect(riskNeedsConfirm('dangerous', 'strict')).toBe(true)
  })

  it('free：任意等级都不确认', () => {
    expect(riskNeedsConfirm('safe', 'free')).toBe(false)
    expect(riskNeedsConfirm('moderate', 'free')).toBe(false)
    expect(riskNeedsConfirm('dangerous', 'free')).toBe(false)
  })

  it('relaxed：safe 不确认，只确认 dangerous', () => {
    expect(riskNeedsConfirm('safe', 'relaxed')).toBe(false)
    expect(riskNeedsConfirm('moderate', 'relaxed')).toBe(false)
    expect(riskNeedsConfirm('dangerous', 'relaxed')).toBe(true)
  })

  it('relaxed：开启 relaxedConfirmModerate 时 moderate 也确认', () => {
    expect(riskNeedsConfirm('moderate', 'relaxed', {
      relaxedConfirmModerate: true,
    } as any)).toBe(true)
  })
})

describe('commandNeedsConfirm', () => {
  it('strict：连 safe 也确认', () => {
    expect(commandNeedsConfirm(assessment('safe'), 'strict')).toBe(true)
  })

  it('relaxed: unknown moderate 不再确认（只确认 dangerous）', () => {
    expect(commandNeedsConfirm(assessment('moderate', true), 'relaxed')).toBe(false)
  })

  it('relaxed: 开启 relaxedConfirmModerate 时 moderate 也确认', () => {
    expect(commandNeedsConfirm(assessment('moderate'), 'relaxed', {
      ...({} as any),
      relaxedConfirmModerate: true,
    })).toBe(true)
  })

  it('relaxed: 已知 safe 不确认', () => {
    expect(commandNeedsConfirm(assessment('safe', false), 'relaxed')).toBe(false)
  })

  it('relaxed: dangerous 确认', () => {
    expect(commandNeedsConfirm(assessment('dangerous'), 'relaxed')).toBe(true)
  })

  it('blocked 不走确认（调用方应硬拒绝）', () => {
    expect(commandNeedsConfirm(assessment('blocked'), 'relaxed')).toBe(false)
    expect(commandNeedsConfirm(assessment('blocked'), 'strict')).toBe(false)
  })

  it('free: dangerous 也不确认', () => {
    expect(commandNeedsConfirm(assessment('dangerous'), 'free')).toBe(false)
  })
})

describe('isSubAgentBlocked', () => {
  it('默认不拦 dangerous，硬墙仍拦', () => {
    expect(isSubAgentBlocked(assessment('dangerous'))).toBe(false)
    expect(isSubAgentBlocked(assessment('blocked'))).toBe(true)
  })

  it('显式额外禁止时拦 dangerous', () => {
    expect(isSubAgentBlocked(assessment('dangerous'), {
      subAgentBlockDangerous: true,
    } as any)).toBe(true)
  })

  it('sub-agent 阻止 blocked', () => {
    expect(isSubAgentBlocked(assessment('blocked'))).toBe(true)
  })

  it('sub-agent 不再阻止 unknown moderate（与主 Agent 一致）', () => {
    expect(isSubAgentBlocked(assessment('moderate', true))).toBe(false)
  })

  it('sub-agent 关闭 blockDangerous 时不拦 dangerous', () => {
    expect(isSubAgentBlocked(assessment('dangerous'), {
      subAgentBlockDangerous: false,
    } as any)).toBe(false)
    expect(isSubAgentBlocked(assessment('blocked'), {
      subAgentBlockDangerous: false,
    } as any)).toBe(true)
  })
})

describe('formatHardBlockedMessage', () => {
  it('无原因时只陈述硬拒事实', () => {
    const msg = formatHardBlockedMessage(assessment('blocked'))
    expect(msg).toContain('不会执行')
    expect(msg).toContain('不会征求确认')
    expect(msg).not.toContain('原因：')
    expect(msg).not.toContain('不要')
  })

  it('带上触发硬拒的原因，不含行动指导', () => {
    const msg = formatHardBlockedMessage({
      level: 'blocked',
      parsed: false,
      calls: [{
        level: 'blocked',
        commandLevel: 'blocked',
        reasons: ['整串命令命中 blocked 规则'],
      }],
    })
    expect(msg).toContain('不会执行')
    expect(msg).toContain('原因：整串命令命中 blocked 规则')
    expect(msg).not.toContain('换写法')
    expect(msg).not.toContain('请主人')
  })

  it('传入原命令时作为事实附上', () => {
    const msg = formatHardBlockedMessage(assessment('blocked'), 'rm -rf /')
    expect(msg).toContain('原命令：rm -rf /')
    expect(msg).not.toContain('不要')
  })

  it('只收录 blocked 子命令的原因', () => {
    const msg = formatHardBlockedMessage({
      level: 'blocked',
      parsed: true,
      calls: [
        { level: 'moderate', commandLevel: 'moderate', reasons: ['日常改权限'] },
        { level: 'blocked', commandLevel: 'blocked', reasons: ['禁止写入或删除'] },
      ],
    })
    expect(msg).toContain('禁止写入或删除')
    expect(msg).not.toContain('日常改权限')
  })
})
