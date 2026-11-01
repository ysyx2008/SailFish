import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('../../agent/workspace-paths', () => ({ getScratchPath: () => '' }))
import { WatchContextSnapshots } from '../context-snapshots'

let directory: string
beforeEach(() => { directory = fs.mkdtempSync(path.join(os.tmpdir(), 'watch-context-test-')) })
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(directory, { recursive: true, force: true }) })
const pointer = (text: string) => /已保存到: ([^\n]+)/.exec(text)![1]

describe('有界且执行期可读的关切快照', () => {
  it('相同内容跨轮复用同一文件，避免高频状态重复写盘', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory })
    const first = snapshots.open()
    const file = pointer(await first.format('x'.repeat(5000), 'watch-state'))
    first.close()
    const second = snapshots.open()
    expect(pointer(await second.format('x'.repeat(5000), 'watch-state'))).toBe(file)
    expect(fs.readdirSync(directory)).toHaveLength(1)
    expect(fs.readFileSync(file, 'utf8')).toBe('x'.repeat(5000))
    second.close()
  })
  it('文件数与字节额度回收旧文件，但保护正在使用的快照', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxBytes: 11000, maxFiles: 2 })
    const active = snapshots.open()
    const pinned = pointer(await active.format('a'.repeat(5000), 'watch-state'))
    const old = snapshots.open()
    const oldFile = pointer(await old.format('b'.repeat(5000), 'watch-state'))
    old.close()
    const next = snapshots.open()
    const nextFile = pointer(await next.format('c'.repeat(5000), 'watch-state'))
    expect(fs.existsSync(pinned)).toBe(true)
    expect(fs.existsSync(oldFile)).toBe(false)
    expect(fs.readFileSync(nextFile, 'utf8')).toBe('c'.repeat(5000))
    expect(fs.readdirSync(directory)).toHaveLength(2)
    active.close(); next.close()
  })
  it('所有快照都在使用时明确失败，不删除活动快照', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxBytes: 6000 })
    const active = snapshots.open()
    const file = pointer(await active.format('a'.repeat(5000), 'watch-state'))
    const other = snapshots.open()
    await expect(other.format('b'.repeat(5000), 'watch-state')).rejects.toThrow('不能回收')
    expect(fs.readFileSync(file, 'utf8')).toBe('a'.repeat(5000))
    expect(fs.readdirSync(directory)).toHaveLength(1)
    active.close(); other.close()
  })
  it('多个执行共享同一内容时，释放其中一个不会解除另一个的保护', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxFiles: 1 })
    const one = snapshots.open(), two = snapshots.open(), three = snapshots.open()
    await one.format('a'.repeat(5000), 'watch-state')
    await two.format('a'.repeat(5000), 'watch-state')
    one.close()
    await expect(three.format('b'.repeat(5000), 'watch-state')).rejects.toThrow('不能回收')
    two.close()
    await expect(three.format('b'.repeat(5000), 'watch-state')).resolves.toContain('已保存到')
    three.close()
  })
  it('执行结束后不再创建快照', async () => {
    const lease = new WatchContextSnapshots({ directory: () => directory }).open()
    lease.close()
    await expect(lease.format('x'.repeat(5000), 'watch-state')).rejects.toThrow('已结束')
    expect(fs.readdirSync(directory)).toHaveLength(0)
  })
  it('写入过程中结束执行，迟到的结果不保留活动引用', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxFiles: 1 })
    let release!: () => void
    let entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = fs.promises.writeFile
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      entered = true
      await gate
      return original(...args)
    })
    const lease = snapshots.open()
    const pending = lease.format('a'.repeat(5000), 'watch-state')
    await vi.waitFor(() => expect(entered).toBe(true))
    lease.close()
    release()
    await expect(pending).rejects.toThrow('已结束')
    spy.mockRestore()
    const next = snapshots.open()
    await expect(next.format('b'.repeat(5000), 'watch-state')).resolves.toContain('已保存到')
    next.close()
  })
  it('写到一半发生 IO 错误，不留下可误读的完整快照或临时文件', async () => {
    const original = fs.promises.writeFile
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      await original(args[0], 'partial', 'utf8')
      throw new Error('IO_FAILURE')
    })
    const lease = new WatchContextSnapshots({ directory: () => directory }).open()
    await expect(lease.format('a'.repeat(5000), 'watch-state')).rejects.toThrow('IO_FAILURE')
    spy.mockRestore()
    expect(fs.readdirSync(directory)).toHaveLength(0)
    lease.close()
  })

  it('复用前校验完整性，外部截短的缓存由权威内容原子恢复', async () => {
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxFiles: 1, maxBytes: 6000 })
    const one = snapshots.open()
    const file = pointer(await one.format('a'.repeat(5000), 'watch-state'))
    one.close()
    fs.writeFileSync(file, 'partial')
    const two = snapshots.open()
    expect(pointer(await two.format('a'.repeat(5000), 'watch-state'))).toBe(file)
    expect(fs.readFileSync(file, 'utf8')).toBe('a'.repeat(5000))
    two.close()
  })
  it('崩溃残留临时文件计入容量并在需要时回收', async () => {
    const temporary = path.join(directory, `watch-state-${'0'.repeat(64)}.txt.00000000-0000-0000-0000-000000000000.tmp`)
    fs.writeFileSync(temporary, 'x'.repeat(5000))
    const lease = new WatchContextSnapshots({ directory: () => directory, maxBytes: 6000 }).open()
    await lease.format('a'.repeat(5000), 'watch-state')
    expect(fs.existsSync(temporary)).toBe(false)
    expect(fs.readdirSync(directory)).toHaveLength(1)
    lease.close()
  })
  it('磁盘阻塞时拒绝无限堆积准备任务', async () => {
    let release!: () => void
    let entered = false
    const gate = new Promise<void>(resolve => { release = resolve })
    const original = fs.promises.writeFile
    const spy = vi.spyOn(fs.promises, 'writeFile').mockImplementation(async (...args) => {
      entered = true; await gate; return original(...args)
    })
    const snapshots = new WatchContextSnapshots({ directory: () => directory, maxPending: 1 })
    const one = snapshots.open(), two = snapshots.open()
    const pending = one.format('a'.repeat(5000), 'watch-state')
    await vi.waitFor(() => expect(entered).toBe(true))
    await expect(two.format('b'.repeat(5000), 'watch-state')).rejects.toThrow('繁忙或无响应')
    release()
    await pending
    one.close(); two.close(); spy.mockRestore()
  })

})
