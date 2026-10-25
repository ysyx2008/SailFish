/**
 * 测试用的假 SSH 主机：用 ssh2 自带的 Server 起在本机随机端口上。
 *
 * 能注入：慢握手、拒绝登录、不支持 exec、跳板拒绝转发。
 * 命令用一小套约定的写法：
 *   echo X    把 X 写到标准输出
 *   err X     把 X 写到标准错误
 *   exit N    以退出码 N 结束
 *   hang      一直不结束；收到 KILL 信号就结束（ignoreSignal 时只在通道被关时结束）
 *   gbk       输出 GBK 编码的「你好」
 *   flood     输出 64KB 的字母
 *   drop      输出一行后把整条连接掐断
 */
import { Server, utils, type Connection } from 'ssh2'
import * as net from 'node:net'
import type { AddressInfo } from 'node:net'

export interface FakeHostOptions {
  /** 允许的账号 -> 密码 */
  users?: Record<string, string>
  /** 登录前的延迟，用来拉长握手 */
  authDelayMs?: number
  /** 拒绝所有 exec 请求（模拟只能交互的设备） */
  rejectExec?: boolean
  /** 作为跳板：允许转发；false 时拒绝所有 tcpip 通道 */
  allowForward?: boolean
  /** 收到 KILL 信号也不理 */
  ignoreSignal?: boolean
}

export interface FakeHost {
  port: number
  /** 到过的连接总数 */
  readonly connections: number
  /** 当前正在握手（连上了还没登录完）的连接数的峰值 */
  readonly peakHandshaking: number
  /** 跳板：同时开着的转发通道数的峰值 */
  readonly peakTunnels: number
  /** 跳板：收到过的转发请求数（只在允许转发时统计） */
  readonly tunnelRequests: number
  /** 收到的信号 */
  readonly signals: string[]
  /** 执行过的命令 */
  readonly commands: string[]
  /** 当前还连着的连接数 */
  readonly open: number
  /** 掐断所有连接 */
  dropAll(): void
  close(): Promise<void>
}

let hostKey: string | undefined
function getHostKey(): string {
  if (!hostKey) {
    // ssh2 生成的 ed25519 私钥偶尔解析不回来，生成后自己试读一次，不行就重来
    for (let i = 0; i < 20 && !hostKey; i++) {
      const candidate = utils.generateKeyPairSync('ed25519').private
      if (!(utils.parseKey(candidate) instanceof Error)) hostKey = candidate
    }
    if (!hostKey) throw new Error('无法生成可用的主机密钥')
  }
  return hostKey
}

export async function startFakeHost(opts: FakeHostOptions = {}): Promise<FakeHost> {
  const users = opts.users ?? { tester: 'secret' }
  const allowForward = opts.allowForward ?? false
  const state = {
    connections: 0, handshaking: 0, peakHandshaking: 0, tunnels: 0, peakTunnels: 0, tunnelRequests: 0,
    signals: [] as string[], commands: [] as string[],
  }
  const live = new Set<Connection>()

  const server = new Server({ hostKeys: [getHostKey()] }, client => {
    state.connections++
    state.handshaking++
    state.peakHandshaking = Math.max(state.peakHandshaking, state.handshaking)
    live.add(client)
    let handshaken = false
    const doneHandshake = () => {
      if (handshaken) return
      handshaken = true
      state.handshaking--
    }
    client.on('close', () => {
      doneHandshake()
      live.delete(client)
    })
    client.on('error', () => { /* 客户端掐断时的噪声 */ })
    client.on('authentication', ctx => {
      const ok = ctx.method === 'password' && users[ctx.username] === ctx.password
      const decide = () => (ok ? ctx.accept() : ctx.reject(['password']))
      if (opts.authDelayMs) setTimeout(decide, opts.authDelayMs)
      else decide()
    })
    client.on('ready', () => {
      doneHandshake()
      client.on('session', accept => {
        const session = accept()
        session.on('signal', (acceptSignal, _reject, info) => {
          acceptSignal?.()
          state.signals.push(info.name)
        })
        session.on('exec', (acceptExec, rejectExec, info) => {
          if (opts.rejectExec) {
            rejectExec()
            return
          }
          const stream = acceptExec()
          state.commands.push(info.command)
          runCommand(info.command, stream, session, client, state, opts)
        })
      })
      // 不注册 tcpip 处理时，ssh2 服务端会以「管理员禁止」（reason 1）回绝，和真实 sshd 禁止转发一致
      if (!allowForward) return
      client.on('tcpip', (accept, reject, info) => {
        state.tunnelRequests++
        const upstream = net.connect(info.destPort, info.destIP)
        upstream.on('error', () => reject())
        upstream.on('connect', () => {
          const channel = accept()
          state.tunnels++
          state.peakTunnels = Math.max(state.peakTunnels, state.tunnels)
          let closed = false
          const done = () => {
            if (closed) return
            closed = true
            state.tunnels--
            upstream.destroy()
          }
          channel.on('close', done)
          channel.on('error', done)
          upstream.on('close', () => { channel.close(); done() })
          channel.pipe(upstream)
          upstream.pipe(channel)
        })
      })
    })
  })

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as AddressInfo).port

  return {
    port,
    get connections() { return state.connections },
    get peakHandshaking() { return state.peakHandshaking },
    get peakTunnels() { return state.peakTunnels },
    get tunnelRequests() { return state.tunnelRequests },
    get signals() { return state.signals },
    get commands() { return state.commands },
    get open() { return live.size },
    dropAll() {
      for (const conn of live) conn.end()
    },
    close() {
      for (const conn of live) conn.end()
      return new Promise<void>(resolve => server.close(() => resolve()))
    },
  }
}

function runCommand(
  command: string,
  stream: import('ssh2').ServerChannel,
  session: import('ssh2').Session,
  client: Connection,
  _state: unknown,
  opts: FakeHostOptions,
): void {
  const [verb, ...rest] = command.split(' ')
  const arg = rest.join(' ')
  const finish = (code: number) => {
    stream.exit(code)
    stream.end()
  }
  switch (verb) {
    case 'echo':
      stream.write(`${arg}\n`)
      finish(0)
      return
    case 'err':
      stream.stderr.write(`${arg}\n`)
      finish(0)
      return
    case 'exit':
      finish(Number(arg) || 0)
      return
    case 'gbk':
      stream.write(Buffer.from([0xc4, 0xe3, 0xba, 0xc3]))
      finish(0)
      return
    case 'flood':
      stream.write('a'.repeat(64 * 1024))
      finish(0)
      return
    case 'drop':
      stream.write('before-drop\n')
      setTimeout(() => client.end(), 20)
      return
    case 'hang':
      if (!opts.ignoreSignal) {
        session.on('signal', () => {
          stream.exit('KILL', false, '')
          stream.end()
        })
      }
      return
    default:
      stream.stderr.write(`unknown command: ${command}\n`)
      finish(127)
  }
}

