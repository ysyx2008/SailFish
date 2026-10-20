// 本机「先到先得」租约：同一台电脑上，同一份资源同一时间只让一个旗鱼实例持有。
//
// 做法：一个租约文件，内容记着持有者；持有者定时刷新文件时间（心跳）并核对文件里写的还是自己。
// 判断「原持有者已不在」的依据：进程已不存在，或心跳停了一阵。
// 不做自动接班：持有者走了，别的实例要自己再来拿一次。
//
// 读写租约文件时遇到意料之外的 IO 错误（权限、磁盘等）一律向外抛，不当成「有人占着」：
// 调用方据此决定放行，不能让一个坏掉的文件让账号永远连不上。

import * as fs from 'fs'
import * as path from 'path'
import { randomBytes } from 'crypto'

const DEFAULT_HEARTBEAT_MS = 15_000
/** 心跳停多久就当原持有者已不在（防进程号被别的程序复用、持有者卡死）；留三拍的余量 */
const DEFAULT_STALE_MS = 45_000
/** 接手闸门没动多久就当上一个接手者崩在半路 */
const GATE_STALE_MS = 10_000

export type LeaseAcquireResult =
  | { acquired: true }
  | { acquired: false; holderPid?: number }

export interface InstanceLeaseOptions {
  filePath: string
  heartbeatMs?: number
  staleMs?: number
  /** 测试注入；默认用 process.kill(pid, 0) 探活 */
  isProcessAlive?: (pid: number) => boolean
  /** 持有期间发现租约被别人接走（比如本机睡眠太久，心跳断档）时回调一次 */
  onLost?: () => void
}

interface LeaseRecord {
  owner: string
  pid: number
  startedAt: number
}

type HolderRead =
  | { kind: 'none' }
  | { kind: 'unreadable'; mtimeMs: number }
  | { kind: 'ok'; record: LeaseRecord; mtimeMs: number }

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err: any) {
    // EPERM：进程在，只是没权限发信号
    return err?.code === 'EPERM'
  }
}

export class InstanceLease {
  private readonly filePath: string
  private readonly gatePath: string
  private readonly heartbeatMs: number
  private readonly staleMs: number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly onLost: (() => void) | null

  private readonly owner = randomBytes(8).toString('hex')
  private timer: ReturnType<typeof setInterval> | null = null
  private _held = false

  constructor(options: InstanceLeaseOptions) {
    this.filePath = options.filePath
    this.gatePath = `${options.filePath}.taking`
    this.heartbeatMs = options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.staleMs = options.staleMs ?? DEFAULT_STALE_MS
    this.isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive
    this.onLost = options.onLost ?? null
  }

  get held(): boolean {
    return this._held
  }

  /**
   * 尝试拿到租约。拿不到时说明另一个还在的实例持有着。
   * 租约文件读写出了意料之外的错误时抛出，由调用方决定怎么办。
   */
  tryAcquire(): LeaseAcquireResult {
    if (this._held) return { acquired: true }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })

    for (let attempt = 0; attempt < 3; attempt++) {
      if (this.createExclusive()) {
        this.beginHolding()
        return { acquired: true }
      }
      const holder = this.readHolder()
      if (holder.kind === 'none') continue // 刚好被释放了，再来一次
      if (!this.isStale(holder)) {
        return { acquired: false, holderPid: holder.kind === 'ok' ? holder.record.pid : undefined }
      }
      if (this.takeOverStale()) {
        this.beginHolding()
        return { acquired: true }
      }
    }
    return { acquired: false }
  }

  /** 交还租约。只删自己写的那份；重复调用、文件已没了都不报错。 */
  release(): void {
    this.stopTimer()
    if (!this._held) return
    this._held = false
    try {
      const holder = this.readHolder()
      if (holder.kind === 'ok' && holder.record.owner === this.owner) {
        fs.unlinkSync(this.filePath)
      }
    } catch { /* 清理失败不影响退出；别人会按「原持有者已不在」处理 */ }
  }

  /**
   * 此刻文件里写的是不是还是自己。心跳之间租约可能已被接走，退出前用它做最后确认。
   * 读不出来时不下结论，按仍持有处理。
   */
  stillOwns(): boolean {
    if (!this._held) return false
    try {
      const holder = this.readHolder()
      return holder.kind === 'ok' && holder.record.owner === this.owner
    } catch {
      return true
    }
  }

  // ---------------------------------------------------------------------------

  private createExclusive(): boolean {
    const record: LeaseRecord = { owner: this.owner, pid: process.pid, startedAt: Date.now() }
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(record), { flag: 'wx' })
      return true
    } catch (err: any) {
      if (err?.code === 'EEXIST') return false
      throw err
    }
  }

  /** 文件不存在返回 none；内容写到一半或格式不对返回 unreadable；其余 IO 错误向外抛。 */
  private readHolder(): HolderRead {
    let mtimeMs: number
    let text: string
    try {
      mtimeMs = fs.statSync(this.filePath).mtimeMs
      text = fs.readFileSync(this.filePath, 'utf-8')
    } catch (err: any) {
      if (err?.code === 'ENOENT') return { kind: 'none' }
      throw err
    }
    try {
      const parsed = JSON.parse(text) as Partial<LeaseRecord>
      if (typeof parsed.owner === 'string' && typeof parsed.pid === 'number') {
        return {
          kind: 'ok',
          record: { owner: parsed.owner, pid: parsed.pid, startedAt: parsed.startedAt ?? 0 },
          mtimeMs,
        }
      }
    } catch { /* 按读不出来处理，只看心跳时间 */ }
    return { kind: 'unreadable', mtimeMs }
  }

  private isStale(holder: Exclude<HolderRead, { kind: 'none' }>): boolean {
    if (holder.kind === 'ok') {
      // 同一个进程里换了一份租约：上一份是自己漏掉没交还的，它的心跳发现被接走后会自己收手
      if (holder.record.pid === process.pid) return true
      if (!this.isProcessAlive(holder.record.pid)) return true
    }
    return Date.now() - holder.mtimeMs > this.staleMs
  }

  /**
   * 清掉过期租约并换成自己的。多个实例同时发现租约过期时，只有拿到闸门的那一个能动手，
   * 免得一个人刚建好的新租约被另一个人当成过期的删掉。
   */
  private takeOverStale(): boolean {
    if (!this.enterGate()) return false
    try {
      const now = this.readHolder()
      if (now.kind !== 'none') {
        if (!this.isStale(now)) return false // 等闸门的工夫已经有人拿走了
        try {
          fs.unlinkSync(this.filePath)
        } catch (err: any) {
          if (err?.code !== 'ENOENT') throw err
        }
      }
      return this.createExclusive()
    } finally {
      try { fs.unlinkSync(this.gatePath) } catch { /* 闸门没删掉，过一会儿按「上一个接手者崩了」处理 */ }
    }
  }

  private enterGate(): boolean {
    for (let i = 0; i < 2; i++) {
      try {
        fs.writeFileSync(this.gatePath, this.owner, { flag: 'wx' })
        return true
      } catch (err: any) {
        if (err?.code !== 'EEXIST') throw err
      }
      let age: number
      try {
        age = Date.now() - fs.statSync(this.gatePath).mtimeMs
      } catch (err: any) {
        if (err?.code === 'ENOENT') continue
        throw err
      }
      if (age <= GATE_STALE_MS) return false // 别人正在接手
      try {
        fs.unlinkSync(this.gatePath)
      } catch (err: any) {
        if (err?.code !== 'ENOENT') throw err
      }
    }
    return false
  }

  private beginHolding(): void {
    this._held = true
    this.stopTimer()
    this.timer = setInterval(() => this.beat(), this.heartbeatMs)
    this.timer.unref?.()
  }

  private stopTimer(): void {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = null
  }

  private beat(): void {
    if (!this._held) return
    let holder: HolderRead
    try {
      holder = this.readHolder()
    } catch {
      return // 暂时读不了，下一拍再看
    }
    if (holder.kind === 'unreadable') return // 写到一半，下一拍再看
    if (holder.kind === 'none') {
      try {
        if (this.createExclusive()) return // 文件被误删，补回来
      } catch {
        return
      }
      this.lose()
      return
    }
    if (holder.record.owner !== this.owner) {
      this.lose()
      return
    }
    try {
      const now = new Date()
      fs.utimesSync(this.filePath, now, now)
    } catch { /* 下一拍再刷新 */ }
  }

  private lose(): void {
    this.stopTimer()
    this._held = false
    try {
      this.onLost?.()
    } catch { /* 回调出错不能连累定时器所在的主进程 */ }
  }
}
