import { describe, it, expect } from 'vitest'
import type { SessionGroup, SshSession } from '../../../../config.service'
import {
  addSshSessionConfig,
  deleteSshSessionConfig,
  executeSshSessionAction,
  formatSshSessionsDetail,
  formatSshSessionsSummary,
  sshSessionStreamHint,
  updateSshSessionConfig,
  type SshSessionStore,
} from '../ssh-sessions'

function makeStore(initial: SshSession[] = [], groups: SessionGroup[] = []): SshSessionStore {
  let sessions = [...initial]
  let sessionGroups = [...groups]
  return {
    getSshSessions: () => sessions,
    addSshSession: (s) => { sessions = [...sessions, s] },
    updateSshSession: (s) => { sessions = sessions.map(x => x.id === s.id ? s : x) },
    deleteSshSession: (id) => { sessions = sessions.filter(s => s.id !== id) },
    getSessionGroups: () => sessionGroups,
    addSessionGroup: (g) => { sessionGroups = [...sessionGroups, g] },
  }
}

const sample = (over: Partial<SshSession> = {}): SshSession => ({
  id: 's1',
  name: 'prod',
  host: '10.0.0.5',
  port: 22,
  username: 'root',
  authType: 'password',
  password: 'secret-should-not-leak',
  ...over,
})

describe('sshSessionStreamHint', () => {
  const lookup = (id: string) => (id === 's1' ? '公司跳板机' : undefined)

  it('update that only names the id shows the stored name', () => {
    expect(sshSessionStreamHint({
      action: 'update',
      sessionId: 's1',
      port: 2222,
    }, lookup)).toBe('公司跳板机')
  })

  it('update that renames shows the new name', () => {
    expect(sshSessionStreamHint({
      action: 'update',
      sessionId: 's1',
      name: '新名字',
    }, lookup)).toBe('新名字')
  })

  it('delete shows the stored name, not the id', () => {
    expect(sshSessionStreamHint({
      action: 'delete',
      sessionId: 's1',
    }, lookup)).toBe('公司跳板机')
  })

  it('add without a name shows the address', () => {
    expect(sshSessionStreamHint({
      action: 'add',
      host: '10.0.0.5',
    }, lookup)).toBe('10.0.0.5')
  })

  it('unknown id is omitted', () => {
    expect(sshSessionStreamHint({
      action: 'update',
      sessionId: 'missing',
    }, lookup)).toBe('')
  })
})

describe('formatSshSessions', () => {
  it('lists name, address, user, group, auth status; never echoes the password', () => {
    const store = makeStore([sample({ groupId: 'g1' })], [{ id: 'g1', name: '生产' }])
    const summary = formatSshSessionsSummary(store)
    expect(summary).toContain('prod')
    expect(summary).toContain('10.0.0.5')
    expect(summary).toContain('生产')
    expect(summary).toContain('密码已配置')
    expect(summary).not.toContain('secret-should-not-leak')

    const detail = formatSshSessionsDetail(store)
    expect(detail).toContain('prod')
    expect(detail).toContain('密码已配置')
    expect(detail).not.toContain('secret-should-not-leak')
  })

  it('empty list tells agent to use add, not just "0 项"', () => {
    const store = makeStore()
    expect(formatSshSessionsSummary(store)).toContain('config_ssh_session')
    expect(formatSshSessionsSummary(store)).not.toMatch(/\[0 项\]/)
  })
})

describe('addSshSessionConfig', () => {
  it('requires host', () => {
    const r = addSshSessionConfig(makeStore(), { name: 'x' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/缺少 host/)
  })

  it('adds one host with password and does not echo it', () => {
    const store = makeStore()
    const r = addSshSessionConfig(store, {
      name: 'web-1', host: '192.168.1.10', password: 'p@ss',
    })
    expect(r.success).toBe(true)
    expect(r.output).toContain('web-1')
    expect(r.output).not.toContain('p@ss')
    expect(store.getSshSessions()).toHaveLength(1)
    expect(store.getSshSessions()[0].password).toBe('p@ss')
    expect(store.getSshSessions()[0].username).toBe('root')
    expect(store.getSshSessions()[0].port).toBe(22)
  })

  it('creates a group when the name is new', () => {
    const store = makeStore()
    const r = addSshSessionConfig(store, { host: '10.0.0.1', group: '机房A' })
    expect(r.success).toBe(true)
    expect(store.getSessionGroups()).toHaveLength(1)
    expect(store.getSessionGroups()[0].name).toBe('机房A')
    expect(store.getSshSessions()[0].groupId).toBe(store.getSessionGroups()[0].id)
  })
})

describe('updateSshSessionConfig', () => {
  it('keeps password when omitted', () => {
    const store = makeStore([sample()])
    const r = updateSshSessionConfig(store, { sessionId: 's1', host: '10.0.0.9' })
    expect(r.success).toBe(true)
    expect(store.getSshSessions()[0].host).toBe('10.0.0.9')
    expect(store.getSshSessions()[0].password).toBe('secret-should-not-leak')
    expect(r.output).not.toContain('secret-should-not-leak')
  })

  it('finds a uniquely named host without sessionId', () => {
    const store = makeStore([sample()])
    const r = updateSshSessionConfig(store, { name: 'prod', port: 2222 })
    expect(r.success).toBe(true)
    expect(store.getSshSessions()[0].port).toBe(2222)
  })

  it('refuses to guess when names collide', () => {
    const store = makeStore([sample(), sample({ id: 's2' })])
    const r = updateSshSessionConfig(store, { name: 'prod', host: '1.1.1.1' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/sessionId/)
  })
})

describe('deleteSshSessionConfig', () => {
  it('deletes by sessionId and leaves others', () => {
    const store = makeStore([sample(), sample({ id: 's2', name: 'dev', host: '10.0.0.2' })])
    const r = deleteSshSessionConfig(store, { sessionId: 's1' })
    expect(r.success).toBe(true)
    expect(store.getSshSessions().map(s => s.id)).toEqual(['s2'])
  })
})

describe('executeSshSessionAction', () => {
  it('rejects unknown action', () => {
    const r = executeSshSessionAction(makeStore(), { action: 'replace-all' })
    expect(r.success).toBe(false)
    expect(r.error).toMatch(/add、update 或 delete/)
  })
})
