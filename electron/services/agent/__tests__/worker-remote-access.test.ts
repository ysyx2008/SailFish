/**
 * 伙计手里的远程通道：范围外 / 单外 / 会话被改 / 会话被删都不连，且都在操作记录里留一行。
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { WorkerRemoteAccess } from '../remote-access/worker-remote-access'
import { RemoteGrant } from '../remote-access/remote-grant'
import { RemoteOpRecorder } from '../remote-access/remote-op-recorder'
import type { RemoteHost } from '../../remote-exec'

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({ info() {}, warn() {}, error() {}, debug() {} }),
}))

let dir: string
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wra-')) })
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }) })

function hostOf(over: Partial<RemoteHost> = {}): RemoteHost {
  return { id: 'h1', name: 'web1', host: '10.0.0.1', port: 22, username: 'ops', ...over } as RemoteHost
}

function setup(resolve: (id: string) => RemoteHost | undefined) {
  const exec = vi.fn(async () => ({
    hostId: 'h1', hostName: 'web1', output: 'ok', outputTruncated: false, exitCode: 0, signal: null,
    timedOut: false, aborted: false, durationMs: 5,
  }))
  const recorder = new RemoteOpRecorder(dir)
  const access = new WorkerRemoteAccess({
    workerName: 'w1',
    grant: new RemoteGrant([{ id: 'h1', name: 'web1', address: 'ops@10.0.0.1:22' }], ['uptime']),
    pool: { exec } as never,
    resolveHost: resolve,
    recorder,
  })
  const entries = async () => {
    await recorder.flush()
    const file = recorder.opsPath
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l))
  }
  return { access, exec, entries }
}

describe('WorkerRemoteAccess 拒绝路径', () => {
  it('范围外主机：不连，留一行', async () => {
    const { access, exec, entries } = setup(() => hostOf())
    const r = await access.run('other', 'uptime', undefined)
    expect(r.ranToCompletion).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    const e = await entries()
    expect(e).toHaveLength(1)
    expect(e[0].failure).toBeTruthy()
    expect(e[0].exitCode).toBeNull()
  })

  it('单外命令：不连，留一行', async () => {
    const { access, exec, entries } = setup(() => hostOf())
    const r = await access.run('h1', 'rm -rf /', undefined)
    expect(r.ranToCompletion).toBe(false)
    expect(exec).not.toHaveBeenCalled()
    expect(await entries()).toHaveLength(1)
  })

  it('已存会话被删：不连，留一行', async () => {
    const { access, exec, entries } = setup(() => undefined)
    await access.run('h1', 'uptime', undefined)
    expect(exec).not.toHaveBeenCalled()
    expect(await entries()).toHaveLength(1)
  })

  it('已存会话批准后改了地址：不连，留一行，提示里写明前后两个地址', async () => {
    const { access, exec, entries } = setup(() => hostOf({ host: '10.9.9.9' }))
    const r = await access.run('h1', 'uptime', undefined)
    expect(r.ranToCompletion).toBe(false)
    expect(r.text).toContain('10.0.0.1')
    expect(r.text).toContain('10.9.9.9')
    expect(exec).not.toHaveBeenCalled()
    expect(await entries()).toHaveLength(1)
  })

  it('地址没变：照常连，留一行成功记录', async () => {
    const { access, exec, entries } = setup(() => hostOf())
    const r = await access.run('h1', 'uptime', undefined)
    expect(r.ranToCompletion).toBe(true)
    expect(exec).toHaveBeenCalledTimes(1)
    const e = await entries()
    expect(e).toHaveLength(1)
    expect(e[0].exitCode).toBe(0)
  })
})
