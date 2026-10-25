/**
 * 后台远程通道的连接池。
 *
 * 不认得谁在用：给它一台已存主机和一条命令，它连上去、跑完、把结果交回来。
 * 不开终端窗，不碰终端那边的连接表，界面感觉不到。
 *
 * 一个池对应「一位主人的一场」：
 * - 同一台主机复用一条连接，闲一阵自动断；
 * - 同一个跳板共用一条跳板连接，跳板上同时开的转发有上限；
 * - 同时握手的连接数有上限，多的排队；
 * - 登录被拒不重试；同一组账号连着被几台拒绝，后面的主机不再用它登录；
 * - 主人停下时 dispose：在跑的命令、排队的、已建的连接全部断开。
 */
import { Client } from 'ssh2'
import type { Duplex } from 'node:stream'
import * as fs from 'node:fs/promises'
import * as iconv from 'iconv-lite'
import { isTcpForwardingRefused, JUMP_FORWARDING_REFUSED_MESSAGE, type JumpHostConfig } from '@shared/types'
import { getSshErrorMessage, parseSshError } from '../ssh-error'
import { forceCloseClient } from '../ssh-connect-attempt'
import { createLogger } from '../../utils/logger'
import { AsyncLimiter } from './limiter'
import { credentialGroupKey, hostConnectionKey, jumpLinkKey, type RemoteHost } from './remote-host'

const log = createLogger('RemoteExec')

export type RemoteExecErrorKind =
  | 'auth_failed'          // 密码或密钥被拒
  | 'credentials_paused'   // 这组账号已被好几台拒绝，不再用它登录
  | 'connect_failed'       // 连不上（超时、拒绝连接、握手失败……）
  | 'jump_failed'          // 跳板连不上或跳板登录失败
  | 'forwarding_refused'   // 跳板不让转发（含只能交互登录的堡垒机）
  | 'exec_unsupported'     // 能登录，但这台不支持直接执行命令
  | 'connection_lost'      // 命令跑到一半连接断了
  | 'aborted'              // 主人停下了

export class RemoteExecError extends Error {
  constructor(readonly kind: RemoteExecErrorKind, message: string) {
    super(message)
    this.name = 'RemoteExecError'
  }
}

export interface RemoteExecLimits {
  /** 连接闲多久后自动断 */
  idleCloseMs: number
  /** 同一个跳板上同时开着的转发（通往目标机的连接）上限 */
  jumpForwardLimit: number
  /** 同时握手的连接数上限 */
  handshakeLimit: number
  /** 同一组账号连着被几台主机拒绝，就不再用它登录 */
  loginRejectLimit: number
  /** 握手最长等多久 */
  connectTimeoutMs: number
  /** 超时或按停时，发出终止信号后等多久再关通道 */
  killGraceMs: number
  /** 一条命令的输出最多留多少字节，超出的丢掉 */
  maxOutputBytes: number
}

/** 内部常量，不给人填 */
export const DEFAULT_REMOTE_EXEC_LIMITS: RemoteExecLimits = {
  idleCloseMs: 60_000,
  jumpForwardLimit: 4,
  handshakeLimit: 8,
  loginRejectLimit: 3,
  connectTimeoutMs: 30_000,
  killGraceMs: 500,
  maxOutputBytes: 8 * 1024 * 1024,
}

export interface RemoteExecOptions {
  timeoutMs: number
  signal?: AbortSignal
  /** 带伪终端执行：关通道时远程会收到挂断。默认不带 */
  pty?: boolean
}

export interface RemoteExecResult {
  hostId: string
  hostName: string
  /** 正常结束时的退出码；被信号杀掉、超时、出错时为 null */
  exitCode: number | null
  signal?: string
  /** 标准输出和标准错误，按到达顺序合在一起，已按会话编码解码 */
  output: string
  /** 输出超过上限，后面的被丢掉了 */
  outputTruncated: boolean
  durationMs: number
  timedOut: boolean
  aborted: boolean
  error?: { kind: RemoteExecErrorKind; message: string }
}

export interface RemoteExecPoolStats {
  openConnections: number
  openJumpLinks: number
  /** 同时握手过的连接数峰值 */
  peakHandshakes: number
  /** 任一跳板上同时开着的转发数峰值 */
  peakForwardsPerJump: number
}

interface JumpLink {
  key: string
  config: JumpHostConfig
  client?: Client
  ready?: Promise<Client>
  /** 通往目标机的转发名额 */
  forwards: AsyncLimiter
  conns: Set<Conn>
  /** 在用这个跳板的连接数（含握手中的） */
  refs: number
  failure?: RemoteExecError
  idleTimer?: NodeJS.Timeout
}

interface Conn {
  key: string
  host: RemoteHost
  client: Client
  active: number
  closed: boolean
  idleTimer?: NodeJS.Timeout
  link?: JumpLink
  releaseForward?: () => void
}

const abortedError = (): RemoteExecError => new RemoteExecError('aborted', '已按停，连接已断开。')

export class RemoteExecPool {
  private readonly limits: RemoteExecLimits
  private readonly conns = new Map<string, Conn>()
  private readonly pending = new Map<string, Promise<Conn>>()
  private readonly links = new Map<string, JumpLink>()
  private readonly clients = new Set<Client>()
  private readonly handshakes: AsyncLimiter
  private readonly lifetime = new AbortController()
  /** 登录被拒的主机：不重试 */
  private readonly rejectedHosts = new Map<string, RemoteExecError>()
  /** 同一组账号被哪几台主机拒绝过（成功登录一次就清零，算「连着」） */
  private readonly credentialRejections = new Map<string, Set<string>>()
  private disposed = false

  constructor(limits: Partial<RemoteExecLimits> = {}) {
    this.limits = { ...DEFAULT_REMOTE_EXEC_LIMITS, ...limits }
    this.handshakes = new AsyncLimiter(this.limits.handshakeLimit)
  }

  get isDisposed(): boolean {
    return this.disposed
  }

  stats(): RemoteExecPoolStats {
    let peakForwards = 0
    for (const link of this.links.values()) peakForwards = Math.max(peakForwards, link.forwards.peak)
    return {
      openConnections: [...this.conns.values()].filter(c => !c.closed).length,
      openJumpLinks: [...this.links.values()].filter(l => l.client).length,
      peakHandshakes: this.handshakes.peak,
      peakForwardsPerJump: peakForwards,
    }
  }

  /** 在一台主机上跑一条命令。连接出错、超时、按停都以结果返回，不抛 */
  async exec(host: RemoteHost, command: string, opts: RemoteExecOptions): Promise<RemoteExecResult> {
    const started = Date.now()
    const base = { hostId: host.id, hostName: host.name }
    const fail = (e: unknown): RemoteExecResult => {
      const err = e instanceof RemoteExecError ? e : new RemoteExecError('connect_failed', getSshErrorMessage(e instanceof Error ? e : String(e)))
      return {
        ...base, exitCode: null, output: '', outputTruncated: false, durationMs: Date.now() - started,
        timedOut: false, aborted: err.kind === 'aborted', error: { kind: err.kind, message: err.message },
      }
    }
    if (this.disposed || opts.signal?.aborted) return fail(abortedError())

    let conn: Conn
    try {
      conn = await this.acquireConn(host, opts.signal)
    } catch (e) {
      return fail(e)
    }
    try {
      const result = await this.runOnConn(conn, command, opts)
      return { ...base, ...result, durationMs: Date.now() - started }
    } finally {
      this.releaseConn(conn)
    }
  }

  /** 主人停下：在跑的、排队的、已建的全部断开。之后这个池不再接活 */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.lifetime.abort()
    for (const conn of [...this.conns.values()]) this.closeConn(conn)
    for (const link of this.links.values()) this.closeLinkClient(link)
    for (const client of [...this.clients]) forceCloseClient(client)
    this.clients.clear()
    this.pending.clear()
  }

  // ==================== 取连接 ====================

  private async acquireConn(host: RemoteHost, signal?: AbortSignal): Promise<Conn> {
    const key = hostConnectionKey(host)
    for (let attempt = 0; attempt < 2; attempt++) {
      const rejected = this.rejectedHosts.get(key)
      if (rejected) throw rejected
      let conn = this.conns.get(key)
      if (!conn || conn.closed) {
        let p = this.pending.get(key)
        if (!p) {
          p = this.connect(host).finally(() => this.pending.delete(key))
          this.pending.set(key, p)
        }
        conn = await this.waitFor(p, signal)
      }
      if (this.disposed) throw abortedError()
      if (conn.closed) continue
      conn.active++
      if (conn.idleTimer) {
        clearTimeout(conn.idleTimer)
        conn.idleTimer = undefined
      }
      return conn
    }
    throw new RemoteExecError('connection_lost', '连接刚建好就断了。')
  }

  private waitFor<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (!signal) return p
    return new Promise<T>((resolve, reject) => {
      if (signal.aborted) {
        reject(abortedError())
        return
      }
      const onAbort = () => reject(abortedError())
      signal.addEventListener('abort', onAbort, { once: true })
      p.then(
        v => { signal.removeEventListener('abort', onAbort); resolve(v) },
        e => { signal.removeEventListener('abort', onAbort); reject(e) },
      )
    })
  }

  private releaseConn(conn: Conn): void {
    conn.active = Math.max(0, conn.active - 1)
    if (conn.closed || conn.active > 0) return
    // 别的主机在排队等这个跳板的名额：让出来
    if (conn.link && conn.link.forwards.waiting > 0) {
      this.closeConn(conn)
      return
    }
    conn.idleTimer = setTimeout(() => this.closeConn(conn), this.limits.idleCloseMs)
    conn.idleTimer.unref?.()
  }

  // ==================== 建连接 ====================

  private async connect(host: RemoteHost): Promise<Conn> {
    const key = hostConnectionKey(host)
    const credential = credentialGroupKey(host)
    this.assertCredentialUsable(credential)

    let link: JumpLink | undefined
    let releaseForward: (() => void) | undefined
    if (host.jumpHost) {
      link = this.linkFor(host.jumpHost)
      if (link.failure) throw link.failure
      // 名额满了先让闲着的连接让位，再排队
      if (link.forwards.inUse >= link.forwards.limit) this.evictIdle(link)
      releaseForward = await link.forwards.acquire(this.lifetime.signal, abortedError)
      link.refs++
      this.cancelLinkIdle(link)
    }

    const giveBack = () => {
      if (link) {
        link.refs--
        this.maybeIdleLink(link)
      }
      releaseForward?.()
    }

    let releaseHandshake: (() => void) | undefined
    try {
      releaseHandshake = await this.handshakes.acquire(this.lifetime.signal, abortedError)
      this.assertCredentialUsable(credential)
      if (link?.failure) throw link.failure

      const sock = link ? await this.forward(link, host) : undefined
      let client: Client
      try {
        client = await this.openClient(host, sock)
      } catch (e) {
        if (sock) sock.destroy()
        throw this.noteLoginResult(e, host, credential)
      }
      this.credentialRejections.delete(credential)

      const conn: Conn = { key, host, client, active: 0, closed: false, link, releaseForward }
      this.conns.set(key, conn)
      link?.conns.add(conn)
      client.on('close', () => this.closeConn(conn))
      return conn
    } catch (e) {
      giveBack()
      throw e
    } finally {
      releaseHandshake?.()
    }
  }

  private assertCredentialUsable(credential: string): void {
    const rejected = this.credentialRejections.get(credential)
    if (rejected && rejected.size >= this.limits.loginRejectLimit) {
      throw new RemoteExecError(
        'credentials_paused',
        `这组账号已被 ${rejected.size} 台主机拒绝登录，这一批后面不再用它登录。`,
      )
    }
  }

  /** 登录失败记账：被拒的主机不重试，同一组账号被拒的主机数攒够就暂停 */
  private noteLoginResult(e: unknown, host: RemoteHost, credential: string): RemoteExecError {
    const err = this.toConnectError(e)
    if (err.kind === 'auth_failed') {
      this.rejectedHosts.set(hostConnectionKey(host), err)
      let hosts = this.credentialRejections.get(credential)
      if (!hosts) {
        hosts = new Set()
        this.credentialRejections.set(credential, hosts)
      }
      hosts.add(hostConnectionKey(host))
      log.warn(`login rejected: ${host.username}@${host.host}:${host.port}（该账号已被 ${hosts.size} 台拒绝）`)
    }
    return err
  }

  private toConnectError(e: unknown): RemoteExecError {
    if (e instanceof RemoteExecError) return e
    const error = e instanceof Error ? e : new Error(String(e))
    const kind = parseSshError(error) === 'auth_failed' ? 'auth_failed' : 'connect_failed'
    return new RemoteExecError(kind, getSshErrorMessage(error))
  }

  private async readPrivateKey(path: string | undefined): Promise<Buffer | undefined> {
    if (!path) return undefined
    try {
      return await fs.readFile(path)
    } catch {
      throw new RemoteExecError('connect_failed', `无法读取私钥文件: ${path}`)
    }
  }

  /** 握手一台主机（直连，或经跳板转发出来的 socket） */
  private async openClient(host: RemoteHost, sock?: Duplex): Promise<Client> {
    const privateKey = await this.readPrivateKey(host.privateKeyPath)
    return new Promise<Client>((resolve, reject) => {
      const client = new Client()
      this.clients.add(client)
      let settled = false
      client.once('ready', () => {
        settled = true
        resolve(client)
      })
      client.on('error', err => {
        // 握手完成前出错才是连接失败；之后的错误（断线）由 close 处理
        if (!settled) {
          settled = true
          this.clients.delete(client)
          forceCloseClient(client)
          reject(err)
        } else {
          log.debug(`${host.host} client error: ${err.message}`)
        }
      })
      client.on('close', () => {
        this.clients.delete(client)
        // 握手没完成就被关了（按停、对面掐断）：不会再有 ready 或 error
        if (!settled) {
          settled = true
          reject(this.disposed ? abortedError() : new Error('Connection lost before handshake'))
        }
      })
      if (this.disposed) {
        settled = true
        forceCloseClient(client)
        reject(abortedError())
        return
      }
      client.connect({
        host: host.host,
        port: host.port,
        username: host.username,
        readyTimeout: this.limits.connectTimeoutMs,
        keepaliveInterval: 10_000,
        sock,
        ...(privateKey
          ? { privateKey, ...(host.passphrase ? { passphrase: host.passphrase } : {}) }
          : host.password ? { password: host.password } : {}),
      })
    })
  }

  // ==================== 跳板 ====================

  private linkFor(config: JumpHostConfig): JumpLink {
    const key = jumpLinkKey(config)
    let link = this.links.get(key)
    if (!link) {
      link = { key, config, forwards: new AsyncLimiter(this.limits.jumpForwardLimit), conns: new Set(), refs: 0 }
      this.links.set(key, link)
    }
    return link
  }

  private evictIdle(link: JumpLink): void {
    for (const conn of [...link.conns]) {
      if (conn.active === 0 && !conn.closed) this.closeConn(conn)
    }
  }

  private ensureLinkClient(link: JumpLink): Promise<Client> {
    if (link.client) return Promise.resolve(link.client)
    if (link.ready) return link.ready
    const ready = this.openJumpClient(link).then(
      client => {
        link.client = client
        return client
      },
      e => {
        link.ready = undefined
        const err = e instanceof RemoteExecError ? e : this.toJumpError(e)
        link.failure = err
        throw err
      },
    )
    link.ready = ready
    return ready
  }

  private toJumpError(e: unknown): RemoteExecError {
    const error = e instanceof Error ? e : new Error(String(e))
    return new RemoteExecError('jump_failed', `连接跳板机失败: ${getSshErrorMessage(error)}`)
  }

  private async openJumpClient(link: JumpLink): Promise<Client> {
    const jump = link.config
    const credential = credentialGroupKey(jump)
    this.assertCredentialUsable(credential)
    const privateKey = jump.authType === 'privateKey' ? await this.readPrivateKey(jump.privateKeyPath) : undefined
    return new Promise<Client>((resolve, reject) => {
      const client = new Client()
      this.clients.add(client)
      let settled = false
      client.once('ready', () => {
        settled = true
        this.credentialRejections.delete(credential)
        resolve(client)
      })
      client.on('keyboard-interactive', (_n, _i, _l, _p, finish) => finish([jump.password || '']))
      client.on('error', err => {
        if (!settled) {
          settled = true
          this.clients.delete(client)
          forceCloseClient(client)
          if (parseSshError(err) === 'auth_failed') {
            let hosts = this.credentialRejections.get(credential)
            if (!hosts) {
              hosts = new Set()
              this.credentialRejections.set(credential, hosts)
            }
            hosts.add(link.key)
          }
          reject(err)
        } else {
          log.debug(`jump ${jump.host} client error: ${err.message}`)
        }
      })
      client.on('close', () => {
        this.clients.delete(client)
        if (link.client === client) {
          link.client = undefined
          link.ready = undefined
        }
        if (!settled) {
          settled = true
          reject(this.disposed ? abortedError() : new Error('Connection lost before handshake'))
        }
      })
      if (this.disposed) {
        settled = true
        forceCloseClient(client)
        reject(abortedError())
        return
      }
      client.connect({
        host: jump.host,
        port: jump.port,
        username: jump.username,
        readyTimeout: this.limits.connectTimeoutMs,
        keepaliveInterval: 10_000,
        tryKeyboard: true,
        ...(privateKey
          ? { privateKey, ...(jump.passphrase ? { passphrase: jump.passphrase } : {}) }
          : jump.password ? { password: jump.password } : {}),
      })
    })
  }

  private async forward(link: JumpLink, host: RemoteHost): Promise<Duplex> {
    const jumpClient = await this.ensureLinkClient(link)
    return new Promise<Duplex>((resolve, reject) => {
      jumpClient.forwardOut('127.0.0.1', 0, host.host, host.port, (err, stream) => {
        if (!err) {
          resolve(stream)
          return
        }
        if (isTcpForwardingRefused(err)) {
          // 这个跳板不让转发：后面经它的主机不必再试
          const refused = new RemoteExecError('forwarding_refused', JUMP_FORWARDING_REFUSED_MESSAGE)
          link.failure = refused
          reject(refused)
          return
        }
        reject(new RemoteExecError('connect_failed', `通过跳板机建立隧道失败: ${err.message}`))
      })
    })
  }

  private cancelLinkIdle(link: JumpLink): void {
    if (link.idleTimer) {
      clearTimeout(link.idleTimer)
      link.idleTimer = undefined
    }
  }

  private maybeIdleLink(link: JumpLink): void {
    if (link.refs > 0 || !link.client || link.idleTimer) return
    link.idleTimer = setTimeout(() => {
      link.idleTimer = undefined
      if (link.refs === 0) this.closeLinkClient(link)
    }, this.limits.idleCloseMs)
    link.idleTimer.unref?.()
  }

  private closeLinkClient(link: JumpLink): void {
    this.cancelLinkIdle(link)
    const client = link.client
    link.client = undefined
    link.ready = undefined
    if (client) forceCloseClient(client)
  }

  // ==================== 关连接 ====================

  private closeConn(conn: Conn): void {
    if (conn.closed) return
    conn.closed = true
    if (conn.idleTimer) clearTimeout(conn.idleTimer)
    if (this.conns.get(conn.key) === conn) this.conns.delete(conn.key)
    forceCloseClient(conn.client)
    this.clients.delete(conn.client)
    if (conn.link) {
      conn.link.conns.delete(conn)
      conn.link.refs--
      this.maybeIdleLink(conn.link)
    }
    conn.releaseForward?.()
    conn.releaseForward = undefined
  }

  // ==================== 跑命令 ====================

  private runOnConn(
    conn: Conn,
    command: string,
    opts: RemoteExecOptions,
  ): Promise<Omit<RemoteExecResult, 'hostId' | 'hostName' | 'durationMs'>> {
    const empty = { exitCode: null, output: '', outputTruncated: false, timedOut: false, aborted: false }
    const signals = [this.lifetime.signal, ...(opts.signal ? [opts.signal] : [])]
    return new Promise(resolve => {
      if (signals.some(s => s.aborted)) {
        resolve({ ...empty, aborted: true, error: { kind: 'aborted', message: abortedError().message } })
        return
      }
      conn.client.exec(command, opts.pty ? { pty: true } : {}, (err, stream) => {
        if (err) {
          const error = /unable to exec/i.test(err.message)
            ? { kind: 'exec_unsupported' as const, message: '这台不支持直接执行命令。' }
            : { kind: 'connect_failed' as const, message: `命令没能发出去：${err.message}` }
          resolve({ ...empty, error })
          return
        }

        const chunks: Buffer[] = []
        let kept = 0
        let truncated = false
        const onData = (data: Buffer) => {
          const room = this.limits.maxOutputBytes - kept
          if (room <= 0) {
            truncated = true
            return
          }
          const piece = data.length > room ? data.subarray(0, room) : data
          if (data.length > room) truncated = true
          chunks.push(piece)
          kept += piece.length
        }
        stream.on('data', onData)
        stream.stderr.on('data', onData)

        let timedOut = false
        let aborted = false
        let finished = false
        let timeoutTimer: NodeJS.Timeout | undefined
        let killTimer: NodeJS.Timeout | undefined
        let forceTimer: NodeJS.Timeout | undefined

        const finish = (exitCode: number | null, signal?: string) => {
          if (finished) return
          finished = true
          if (timeoutTimer) clearTimeout(timeoutTimer)
          if (killTimer) clearTimeout(killTimer)
          if (forceTimer) clearTimeout(forceTimer)
          for (const s of signals) s.removeEventListener('abort', onAbort)
          const raw = Buffer.concat(chunks)
          const output = conn.host.encoding === 'utf-8' ? raw.toString('utf-8') : iconv.decode(raw, conn.host.encoding)
          const lost = !timedOut && !aborted && exitCode === null && !signal
          resolve({
            exitCode,
            signal,
            output,
            outputTruncated: truncated,
            timedOut,
            aborted,
            ...(lost ? { error: { kind: 'connection_lost' as const, message: '命令没有跑完，连接断了。' } } : {}),
          })
        }

        /** 先发终止信号，给远程一点时间收尾；还不结束就关通道，再兜底强收 */
        const kill = () => {
          try { stream.signal('KILL') } catch { /* 通道已不可写 */ }
          killTimer = setTimeout(() => {
            try { stream.close() } catch { /* 已关 */ }
            forceTimer = setTimeout(() => finish(null), 2_000)
            forceTimer.unref?.()
          }, this.limits.killGraceMs)
          killTimer.unref?.()
        }

        const onAbort = () => {
          if (finished || aborted) return
          aborted = true
          kill()
        }
        for (const s of signals) s.addEventListener('abort', onAbort, { once: true })

        timeoutTimer = setTimeout(() => {
          if (finished) return
          timedOut = true
          kill()
        }, opts.timeoutMs)
        timeoutTimer.unref?.()

        stream.on('close', (code: number | null | undefined, sig: string | null | undefined) => {
          finish(typeof code === 'number' ? code : null, sig ?? undefined)
        })
      })
    })
  }
}
