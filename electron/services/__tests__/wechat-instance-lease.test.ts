import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { InstanceLease } from '../im/wechat/instance-lease'

const FOREIGN_PID = 4242
const aliveOnlyForeign = (pid: number) => pid === FOREIGN_PID

describe('InstanceLease', () => {
  let dir: string
  let file: string

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-lease-'))
    file = path.join(dir, 'accounts', 'acct.lock')
  })
  afterEach(() => {
    vi.useRealTimers()
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function plantHolder(record: object | string, ageMs = 0) {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, typeof record === 'string' ? record : JSON.stringify(record))
    if (ageMs > 0) {
      const t = new Date(Date.now() - ageMs)
      fs.utimesSync(file, t, t)
    }
  }
  const foreignRecord = { owner: 'foreign', pid: FOREIGN_PID, startedAt: 1 }

  it('没人持有时拿到租约，并把自己的进程号记在文件里', () => {
    const lease = new InstanceLease({ filePath: file })

    expect(lease.tryAcquire()).toEqual({ acquired: true })
    expect(lease.held).toBe(true)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(process.pid)
    lease.release()
  })

  it('另一个活着的进程持有且心跳新鲜：拿不到，并报出持有者', () => {
    plantHolder(foreignRecord)
    const lease = new InstanceLease({ filePath: file, isProcessAlive: aliveOnlyForeign })

    expect(lease.tryAcquire()).toEqual({ acquired: false, holderPid: FOREIGN_PID })
    expect(lease.held).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).owner).toBe('foreign')
  })

  it('原持有者进程已不在：直接接手', () => {
    plantHolder({ ...foreignRecord, pid: 9999 })
    const lease = new InstanceLease({ filePath: file, isProcessAlive: aliveOnlyForeign })

    expect(lease.tryAcquire()).toEqual({ acquired: true })
    lease.release()
  })

  it('进程还在但心跳停了很久（进程号被复用或卡死）：接手', () => {
    plantHolder(foreignRecord, 10 * 60_000)
    const lease = new InstanceLease({ filePath: file, staleMs: 60_000, isProcessAlive: aliveOnlyForeign })

    expect(lease.tryAcquire()).toEqual({ acquired: true })
    lease.release()
  })

  it('租约文件写到一半读不出来：心跳新鲜就当还有人持有，很久没动才接手', () => {
    plantHolder('{not json')
    const fresh = new InstanceLease({ filePath: file, staleMs: 60_000, isProcessAlive: aliveOnlyForeign })
    expect(fresh.tryAcquire().acquired).toBe(false)

    plantHolder('{not json', 10 * 60_000)
    const old = new InstanceLease({ filePath: file, staleMs: 60_000, isProcessAlive: aliveOnlyForeign })
    expect(old.tryAcquire()).toEqual({ acquired: true })
    old.release()
  })

  it('多个实例同时发现租约过期：只有拿到闸门的那一个能接手，另一个让出', () => {
    plantHolder({ ...foreignRecord, pid: 9999 })
    // 有人正拿着接手闸门（刚创建，还没结束）
    fs.writeFileSync(`${file}.taking`, 'someone-else')
    const lease = new InstanceLease({ filePath: file, isProcessAlive: aliveOnlyForeign })

    expect(lease.tryAcquire().acquired).toBe(false)
    // 过期租约原样没被动，也没被它删掉
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(9999)
  })

  it('上一个接手者崩在半路留下的闸门：过一阵就当作废，新来的能接手', () => {
    plantHolder({ ...foreignRecord, pid: 9999 })
    fs.writeFileSync(`${file}.taking`, 'crashed-taker')
    const old = new Date(Date.now() - 60_000)
    fs.utimesSync(`${file}.taking`, old, old)
    const lease = new InstanceLease({ filePath: file, isProcessAlive: aliveOnlyForeign })

    expect(lease.tryAcquire()).toEqual({ acquired: true })
    expect(fs.existsSync(`${file}.taking`)).toBe(false)
    lease.release()
  })

  it('等闸门的工夫租约已被别人换成新的：不删它', () => {
    // 闸门被占着期间，过期租约被换成了活着的新持有者；接手者拿到闸门后必须重新核对
    plantHolder({ ...foreignRecord, pid: 9999 })
    const lease = new InstanceLease({
      filePath: file,
      // 第一次探活（判断过期）说已不在；之后新持有者已写入，再探活就是活的
      isProcessAlive: (pid) => pid === FOREIGN_PID,
    })
    const probe = vi.spyOn(lease as any, 'enterGate').mockImplementation(() => {
      plantHolder(foreignRecord)
      return true
    })

    expect(lease.tryAcquire().acquired).toBe(false)
    expect(JSON.parse(fs.readFileSync(file, 'utf-8')).pid).toBe(FOREIGN_PID)
    probe.mockRestore()
  })

  it('租约文件读写出了意料之外的错误：向外抛，不当成「有人占着」', () => {
    // 租约的位置被占成目录：读它报 EISDIR
    fs.mkdirSync(file, { recursive: true })
    const lease = new InstanceLease({ filePath: file })

    expect(() => lease.tryAcquire()).toThrow()
    expect(lease.held).toBe(false)
  })

  it('stillOwns：心跳之间被换走能立刻看出来', () => {
    const lease = new InstanceLease({ filePath: file })
    lease.tryAcquire()
    expect(lease.stillOwns()).toBe(true)

    fs.writeFileSync(file, JSON.stringify(foreignRecord))

    expect(lease.stillOwns()).toBe(false)
    lease.release()
  })

  it('持有者的 onLost 回调抛错，不会带崩定时器', () => {
    vi.useFakeTimers()
    const lease = new InstanceLease({
      filePath: file,
      heartbeatMs: 1000,
      onLost: () => { throw new Error('boom') },
    })
    lease.tryAcquire()
    fs.writeFileSync(file, JSON.stringify(foreignRecord))

    expect(() => vi.advanceTimersByTime(1000)).not.toThrow()
    expect(lease.held).toBe(false)
  })

  it('交还只删自己写的那份，别人的原样留着；重复交还不报错', () => {
    const lease = new InstanceLease({ filePath: file })
    lease.tryAcquire()
    lease.release()
    expect(fs.existsSync(file)).toBe(false)

    plantHolder(foreignRecord)
    lease.release()
    expect(fs.existsSync(file)).toBe(true)
  })

  it('拿到租约后心跳持续刷新文件时间', () => {
    vi.useFakeTimers()
    const lease = new InstanceLease({ filePath: file, heartbeatMs: 1000 })
    lease.tryAcquire()
    const old = new Date(Date.now() - 60 * 60_000)
    fs.utimesSync(file, old, old)

    vi.advanceTimersByTime(1000)

    expect(fs.statSync(file).mtimeMs).toBeGreaterThan(old.getTime() + 30 * 60_000)
    lease.release()
  })

  it('同一进程里换了一份租约：新的接手，旧的下一次心跳发现被接走并收手', () => {
    vi.useFakeTimers()
    const onLost = vi.fn()
    const stale = new InstanceLease({ filePath: file, heartbeatMs: 1000, onLost })
    stale.tryAcquire()

    const fresh = new InstanceLease({ filePath: file, heartbeatMs: 1000 })
    expect(fresh.tryAcquire()).toEqual({ acquired: true })

    vi.advanceTimersByTime(1000)

    expect(onLost).toHaveBeenCalledTimes(1)
    expect(stale.held).toBe(false)
    expect(fresh.held).toBe(true)
    // 旧的收手后再交还，不能把新的租约删掉
    stale.release()
    expect(fs.existsSync(file)).toBe(true)
    fresh.release()
  })

  it('租约文件被误删：心跳补回来，不算丢失', () => {
    vi.useFakeTimers()
    const onLost = vi.fn()
    const lease = new InstanceLease({ filePath: file, heartbeatMs: 1000, onLost })
    lease.tryAcquire()
    fs.rmSync(file)

    vi.advanceTimersByTime(1000)

    expect(fs.existsSync(file)).toBe(true)
    expect(onLost).not.toHaveBeenCalled()
    expect(lease.held).toBe(true)
    lease.release()
  })

  it('被别的进程接走（本机睡眠太久心跳断档）：下一次心跳发现并回调一次', () => {
    vi.useFakeTimers()
    const onLost = vi.fn()
    const lease = new InstanceLease({ filePath: file, heartbeatMs: 1000, onLost })
    lease.tryAcquire()
    fs.writeFileSync(file, JSON.stringify(foreignRecord))

    vi.advanceTimersByTime(3000)

    expect(onLost).toHaveBeenCalledTimes(1)
    expect(lease.held).toBe(false)
  })
})
