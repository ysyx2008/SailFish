import { describe, expect, it } from 'vitest'
import { SSH_CONNECT_CANCELLED } from '@shared/types'
import { encodeHostKeyChanged } from '@shared/utils/ssh-host-key-message'
import {
  formatSshConnectFailure,
  isSshConnectCancelledMessage,
  unwrapIpcInvokeError
} from './ssh-connect-error'

describe('unwrapIpcInvokeError', () => {
  it('剥掉 Electron invoke 外壳，留下里面的说明', () => {
    expect(
      unwrapIpcInvokeError(
        "Error invoking remote method 'ssh:connect': Error: 连接超时：无法连接到服务器，请检查网络或主机地址"
      )
    ).toBe('连接超时：无法连接到服务器，请检查网络或主机地址')
  })

  it('没有外壳时原样返回', () => {
    expect(unwrapIpcInvokeError('认证失败：用户名或密码错误，请检查登录凭据')).toBe(
      '认证失败：用户名或密码错误，请检查登录凭据'
    )
  })
})

describe('isSshConnectCancelledMessage', () => {
  it('识别稳定错误码，包括被 IPC 包过的', () => {
    expect(isSshConnectCancelledMessage(SSH_CONNECT_CANCELLED)).toBe(true)
    expect(
      isSshConnectCancelledMessage(
        `Error invoking remote method 'ssh:connect': Error: ${SSH_CONNECT_CANCELLED}`
      )
    ).toBe(true)
  })

  it('识别旧版整句取消文案', () => {
    expect(
      isSshConnectCancelledMessage(
        "Error invoking remote method 'ssh:connect': Error: SSH connect cancelled by user"
      )
    ).toBe(true)
  })

  it('真正的连接失败不算取消', () => {
    expect(
      isSshConnectCancelledMessage(
        "Error invoking remote method 'ssh:connect': Error: 连接超时：无法连接到服务器，请检查网络或主机地址"
      )
    ).toBe(false)
  })
})

describe('formatSshConnectFailure', () => {
  it('取消不给失败文案', () => {
    expect(
      formatSshConnectFailure(
        new Error(`Error invoking remote method 'ssh:connect': Error: ${SSH_CONNECT_CANCELLED}`),
        '连接失败'
      )
    ).toEqual({ cancelled: true, message: '' })
  })

  it('真失败只留下里面的说明', () => {
    expect(
      formatSshConnectFailure(
        new Error(
          "Error invoking remote method 'ssh:connect': Error: 认证失败：用户名或密码错误，请检查登录凭据"
        ),
        '连接失败'
      )
    ).toEqual({
      cancelled: false,
      message: '认证失败：用户名或密码错误，请检查登录凭据'
    })
  })

  it('主机身份变了时留下说明，并带上可以记住的那台机器', () => {
    const encoded = encodeHostKeyChanged('Example.COM', 22, '身份变了')
    expect(
      formatSshConnectFailure(
        new Error(`Error invoking remote method 'ssh:connect': Error: ${encoded}`),
        '连接失败'
      )
    ).toEqual({
      cancelled: false,
      message: '身份变了',
      hostKeyChanged: { host: 'Example.COM', port: 22 },
    })
  })

  it('剥不干净时用兜底文案', () => {
    expect(formatSshConnectFailure(new Error(''), '连接失败')).toEqual({
      cancelled: false,
      message: '连接失败'
    })
  })
})
