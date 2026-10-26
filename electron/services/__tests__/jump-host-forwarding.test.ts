import { describe, it, expect } from 'vitest'
import {
  JUMP_FORWARDING_REFUSED_MESSAGE,
  effectiveJumpHost,
  jumpHostFromGroup,
  isTcpForwardingRefused,
  type JumpHostConfig
} from '@shared/types'

const linuxJump: JumpHostConfig = {
  host: '10.0.0.1',
  port: 22,
  username: 'jump',
  authType: 'password'
}

describe('跳板机不允许端口转发', () => {
  it('认出 OpenSSH 拒绝转发', () => {
    expect(isTcpForwardingRefused({ message: 'open failed', reason: 1 })).toBe(true)
    expect(isTcpForwardingRefused('administratively prohibited: open failed')).toBe(true)
    expect(isTcpForwardingRefused('port forwarding is disabled')).toBe(true)
    expect(isTcpForwardingRefused('Connection refused')).toBe(false)
    expect(isTcpForwardingRefused({ message: 'connect failed', reason: 2 })).toBe(false)
  })

  it('提示语说明到不了目标机器，并告诉 JumpServer 用户去勾选', () => {
    expect(JUMP_FORWARDING_REFUSED_MESSAGE).toContain('不允许端口转发')
    expect(JUMP_FORWARDING_REFUSED_MESSAGE).toContain('目标机器')
    expect(JUMP_FORWARDING_REFUSED_MESSAGE).toContain('这是 JumpServer')
  })

  it('堡垒机同步分组标成 JumpServer，手填的 Linux 跳板保持原样', () => {
    expect(jumpHostFromGroup('JumpServer (bastion.example)', linuxJump).product).toBe('jumpserver')
    expect(jumpHostFromGroup('办公网', linuxJump).product).toBeUndefined()
    expect(jumpHostFromGroup('办公网', { ...linuxJump, product: 'jumpserver' }).product).toBe('jumpserver')
  })
})

describe('会话最终生效的跳板机', () => {
  const ownJump: JumpHostConfig = { ...linuxJump, host: '10.9.9.9', username: 'own' }
  const groups = [
    { id: 'g-office', name: '办公网', jumpHost: linuxJump },
    { id: 'g-js', name: 'JumpServer (bastion.example)', jumpHost: linuxJump },
    { id: 'g-plain', name: '直连' }
  ]

  it('会话显式不用跳板：即使分组有也不用', () => {
    expect(effectiveJumpHost({ jumpHostOverride: null, groupId: 'g-office' }, groups)).toBeUndefined()
  })

  it('会话自定义跳板：压过分组', () => {
    expect(effectiveJumpHost({ jumpHostOverride: ownJump, groupId: 'g-office' }, groups)).toBe(ownJump)
  })

  it('没写就继承分组的跳板，手填的 Linux 跳板保持原样', () => {
    expect(effectiveJumpHost({ groupId: 'g-office' }, groups)).toBe(linuxJump)
  })

  it('继承堡垒机同步分组时标成 JumpServer', () => {
    expect(effectiveJumpHost({ groupId: 'g-js' }, groups)?.product).toBe('jumpserver')
  })

  it('没有分组、分组不存在、分组没设跳板：都是没有', () => {
    expect(effectiveJumpHost({}, groups)).toBeUndefined()
    expect(effectiveJumpHost({ groupId: 'missing' }, groups)).toBeUndefined()
    expect(effectiveJumpHost({ groupId: 'g-plain' }, groups)).toBeUndefined()
  })
})
