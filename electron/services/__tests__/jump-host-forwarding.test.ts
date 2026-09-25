import { describe, it, expect } from 'vitest'
import {
  JUMP_FORWARDING_REFUSED_MESSAGE,
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
