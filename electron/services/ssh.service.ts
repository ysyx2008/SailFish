import { Client, ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import stripAnsi from 'strip-ansi'
import * as iconv from 'iconv-lite'
import { isTcpForwardingRefused, JUMP_FORWARDING_REFUSED_MESSAGE, type JumpHostConfig, type SshConfig, type SshEncoding } from '@shared/types'
import { getUnixProbeCommands } from './host-profile.service'
import { getSshErrorMessage } from './ssh-error'
import { SshConnectAttempt, SshConnectCancelledError, forceCloseClient } from './ssh-connect-attempt'
import { requestLocalNetworkAccessIfDenied } from '../utils/local-network-permission'
import { createLogger } from '../utils/logger'
import { appendCappedTerminalOutput } from '../utils/terminal-output-sanitize'
import type { ExecuteInTerminalResult } from './pty.service'

export type { JumpHostConfig, SshConfig, SshEncoding }

const log = createLogger('SSH')

// 终端状态接口（与 pty.service.ts 保持一致）
export interface TerminalStatus {
  isIdle: boolean
  shellPid?: number
  foregroundPid?: number
  foregroundProcess?: string
  stateDescription?: string
}

interface SshInstance {
  client: Client
  jumpClient?: Client  // 跳板机客户端（如果通过跳板机连接）
  stream: ClientChannel | null
  dataCallbacks: ((data: string) => void)[]
  config: SshConfig
  encoding: string     // 实际使用的编码
}

// 断开连接事件类型
export interface SshDisconnectEvent {
  id: string
  reason: 'closed' | 'error' | 'stream_closed' | 'jump_host_closed'
  error?: Error
}

export class SshService {
  private instances: Map<string, SshInstance> = new Map()
  // 断开连接回调
  private disconnectCallbacks: Map<string, ((event: SshDisconnectEvent) => void)[]> = new Map()
  // 握手中的连接尝试：调用方用自带的 attemptId 中止（会话 id 此时还没生成）
  private pendingConnects: Map<string, SshConnectAttempt> = new Map()

  /**
   * 建立 SSH 连接（支持跳板机）
   *
   * @param options.reuseId 重连时传入旧会话 id：卸掉仍占用该 key 的旧实例后，
   *   新连接继续使用同一 id（对外身份不变）。新开连接不传，仍分配 uuid。
   * @param options.attemptId 调用方自带的尝试标识，握手期间可用 `cancelConnect` 中止。
   */
  async connect(
    config: SshConfig,
    options?: { reuseId?: string; attemptId?: string }
  ): Promise<string> {
    const reuseId = options?.reuseId?.trim() || undefined
    const id = reuseId || uuidv4()
    if (reuseId && this.instances.has(id)) {
      this.disconnect(id)
    }

    const attemptId = options?.attemptId?.trim() || undefined
    let attempt: SshConnectAttempt | undefined
    if (attemptId) {
      this.cancelConnect(attemptId)
      attempt = new SshConnectAttempt()
      this.pendingConnects.set(attemptId, attempt)
    }

    try {
      const sessionId = config.jumpHost
        ? await this.connectViaJumpHost(id, config, attempt)
        : await this.directConnect(id, config, undefined, attempt)

      // 取消与握手成功撞在同一瞬间（进程内直接调用才可能命中；经 IPC 的取消由
      // 调用方在 await 之后重新校验归属并回收）：已建立的会话没人接手，必须收掉
      if (attempt?.isCancelled) {
        log.info(`${sessionId} connected after cancel, closing immediately`)
        this.disconnect(sessionId)
        throw new SshConnectCancelledError()
      }

      return sessionId
    } finally {
      if (attemptId && this.pendingConnects.get(attemptId) === attempt) {
        this.pendingConnects.delete(attemptId)
      }
    }
  }

  /**
   * 中止仍在握手中的连接尝试（用户放弃连接）。
   * @returns 是否命中一个进行中的尝试
   */
  cancelConnect(attemptId: string): boolean {
    const attempt = this.pendingConnects.get(attemptId)
    if (!attempt) return false
    log.info(`connect attempt ${attemptId} cancelled`)
    this.pendingConnects.delete(attemptId)
    attempt.cancel()
    return true
  }

  /**
   * 直接建立 SSH 连接
   */
  private async directConnect(
    id: string,
    config: SshConfig,
    sock?: NodeJS.ReadableStream,
    attempt?: SshConnectAttempt
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      attempt?.trackClient(client)
      attempt?.onCancel(() => reject(new SshConnectCancelledError()))
      
      // 确定使用的编码，默认 utf-8
      const encoding = config.encoding || 'utf-8'

      const instance: SshInstance = {
        client,
        stream: null,
        dataCallbacks: [],
        config,
        encoding
      }

      // 准备私钥
      let privateKey: string | Buffer | undefined = config.privateKey
      if (!privateKey && config.privateKeyPath) {
        try {
          privateKey = fs.readFileSync(config.privateKeyPath)
        } catch (err) {
          reject(new Error(`无法读取私钥文件: ${config.privateKeyPath}`))
          return
        }
      }

      // 连接配置
      const connectConfig: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string | Buffer
        passphrase?: string
        readyTimeout: number
        keepaliveInterval: number
        sock?: NodeJS.ReadableStream
      } = {
        host: config.host,
        port: config.port,
        username: config.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      }

      // 如果通过跳板机连接，使用传入的 socket
      if (sock) {
        connectConfig.sock = sock
      }

      if (privateKey) {
        connectConfig.privateKey = privateKey
        if (config.passphrase) {
          connectConfig.passphrase = config.passphrase
        }
      } else if (config.password) {
        connectConfig.password = config.password
      }

      client.on('ready', () => {
        // 打开 Shell
        client.shell(
          {
            term: 'xterm-256color',
            cols: config.cols || 80,
            rows: config.rows || 24
          },
          (err, stream) => {
            if (err) {
              client.end()
              reject(new Error(err.message || String(err)))
              return
            }

            instance.stream = stream

            // 监听数据（使用配置的编码解码）
            stream.on('data', (data: Buffer) => {
              let str: string
              if (encoding === 'utf-8') {
                str = data.toString('utf-8')
              } else {
                // 使用 iconv-lite 解码非 UTF-8 编码
                str = iconv.decode(data, encoding)
              }
              instance.dataCallbacks.forEach(callback => callback(str))
            })

            // 监听关闭（reuseId 重连后旧 stream 的 close 可能晚到——只处理仍属于本 client 的实例）
            stream.on('close', () => {
              const current = this.instances.get(id)
              if (!current || current.client !== client) {
                log.info(`${id} stream closed (stale/absent, ignore)`)
                return
              }
              log.info(`${id} stream closed`)
              this.emitDisconnect({ id, reason: 'stream_closed' })
              client.end()
            })

            this.instances.set(id, instance)
            resolve(id)
          }
        )
      })

      client.on('error', err => {
        // 用户已取消：这条 error 是我们自己销毁客户端引起的，Promise 也已结束
        if (attempt?.isCancelled) {
          log.info(`${id} error after cancel, ignore:`, err.message)
          return
        }
        // 仅当 Map 里已是「别的 client」时视为过期（reuseId 重连竞态）。
        // 尚未入 Map 的连接失败（current 为空）必须照常 reject。
        const current = this.instances.get(id)
        if (current && current.client !== client) {
          log.info(`${id} error from stale client, ignore:`, err)
          return
        }
        log.error(`${id} error:`, err)
        if (current) {
          this.emitDisconnect({ id, reason: 'error', error: err })
          this.instances.delete(id)
        }
        // ⚠️ 勿删：EHOSTUNREACH 时再触发本地网络授权探测（见 local-network-permission.ts）
        requestLocalNetworkAccessIfDenied(err, 'ssh-connect')
        const friendlyMessage = getSshErrorMessage(err)
        reject(new Error(friendlyMessage))
      })

      client.on('close', () => {
        const current = this.instances.get(id)
        if (!current || current.client !== client) {
          if (current && current.client !== client) {
            log.info(`${id} connection closed (stale client, ignore)`)
          }
          return
        }
        log.info(`${id} connection closed`)
        this.emitDisconnect({ id, reason: 'closed' })
        this.instances.delete(id)
      })

      // 已取消（Promise 在 onCancel 里已 reject）就别再发起握手，免得留下无人认领的连接
      if (attempt?.isCancelled) return
      client.connect(connectConfig)
    })
  }

  /**
   * 通过跳板机建立 SSH 连接
   */
  private async connectViaJumpHost(
    id: string,
    config: SshConfig,
    attempt?: SshConnectAttempt
  ): Promise<string> {
    const jumpHost = config.jumpHost!
    log.info(`Connecting via jump host: ${jumpHost.username}@${jumpHost.host}:${jumpHost.port} -> ${config.username}@${config.host}:${config.port}`)

    return new Promise((resolve, reject) => {
      const jumpClient = new Client()
      attempt?.trackClient(jumpClient)
      attempt?.onCancel(() => reject(new SshConnectCancelledError()))

      let jumpPrivateKey: string | Buffer | undefined
      if (jumpHost.authType === 'privateKey' && jumpHost.privateKeyPath) {
        try {
          jumpPrivateKey = fs.readFileSync(jumpHost.privateKeyPath)
        } catch (err) {
          reject(new Error(`无法读取跳板机私钥文件: ${jumpHost.privateKeyPath}`))
          return
        }
      }

      const jumpConnectConfig: Record<string, unknown> = {
        host: jumpHost.host,
        port: jumpHost.port,
        username: jumpHost.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        tryKeyboard: true,
        debug: (msg: string) => log.debug(`[jump-ssh] ${msg}`)
      }

      if (jumpPrivateKey) {
        jumpConnectConfig.privateKey = jumpPrivateKey
        if (jumpHost.passphrase) {
          jumpConnectConfig.passphrase = jumpHost.passphrase
        }
      } else if (jumpHost.password) {
        jumpConnectConfig.password = jumpHost.password
      }

      jumpClient.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
        finish([jumpHost.password || ''])
      })

      jumpClient.on('ready', () => {
        log.info(`Jump host connected: ${jumpHost.username}@${jumpHost.host}`)

        jumpClient.forwardOut(
          '127.0.0.1',
          0,
          config.host,
          config.port,
          async (err, stream) => {
            if (err) {
              if (isTcpForwardingRefused(err)) {
                jumpClient.end()
                if (jumpHost.product === 'jumpserver') {
                  log.warn(`Port forwarding not supported, falling back to JumpServer direct shell mode`)
                  try {
                    const result = await this.connectViaJumpServerShell(id, config, attempt)
                    resolve(result)
                  } catch (shellErr) {
                    reject(shellErr)
                  }
                } else {
                  log.warn(`Port forwarding refused by jump host ${jumpHost.host}: ${err.message}`)
                  reject(new Error(`${JUMP_FORWARDING_REFUSED_MESSAGE}（${err.message}）`))
                }
                return
              }

              log.error(`Forward failed:`, err)
              jumpClient.end()
              reject(new Error(`通过跳板机建立隧道失败: ${err.message}`))
              return
            }

            try {
              await this.directConnect(id, config, stream as unknown as NodeJS.ReadableStream, attempt)

              const instance = this.instances.get(id)
              if (instance) {
                instance.jumpClient = jumpClient
              }

              resolve(id)
            } catch (connectErr) {
              jumpClient.end()
              reject(connectErr)
            }
          }
        )
      })

      jumpClient.on('error', err => {
        if (attempt?.isCancelled) {
          log.info(`${id} jump host error after cancel, ignore:`, err.message)
          return
        }
        log.error(`Jump host error:`, err)
        requestLocalNetworkAccessIfDenied(err, 'ssh-jump')
        const friendlyMessage = getSshErrorMessage(err)
        reject(new Error(`连接跳板机失败: ${friendlyMessage}`))
      })

      jumpClient.on('close', () => {
        log.info(`Jump host connection closed`)
        const instance = this.instances.get(id)
        // reuseId 重连后旧 jumpClient 的 close 可能晚到——只处理仍挂着本 jumpClient 的实例
        if (!instance || instance.jumpClient !== jumpClient) {
          log.info(`${id} jump host closed (stale jumpClient, ignore)`)
          return
        }
        this.emitDisconnect({ id, reason: 'jump_host_closed' })
        instance.client.end()
        this.instances.delete(id)
      })

      if (attempt?.isCancelled) return
      jumpClient.connect(jumpConnectConfig)
    })
  }

  /**
   * JumpServer 直连模式：通过 Koko SSH 代理的 shell 直接连接目标资产
   * 使用 JumpServer 的直连用户名格式: {js_user}#{target_ip} 或 {js_user}#{target_ip}#{account}
   */
  private async connectViaJumpServerShell(
    id: string,
    config: SshConfig,
    attempt?: SshConnectAttempt
  ): Promise<string> {
    const jumpHost = config.jumpHost!

    // 使用 JumpServer 用户名连接 Koko，通过交互式 shell 访问目标资产
    const directUsername = jumpHost.username
    log.info(`JumpServer shell mode: ${directUsername}@${jumpHost.host}:${jumpHost.port} (target: ${config.host})`)

    return new Promise((resolve, reject) => {
      const client = new Client()
      attempt?.trackClient(client)
      attempt?.onCancel(() => reject(new SshConnectCancelledError()))
      const encoding = config.encoding || 'utf-8'

      const connectConfig: Record<string, unknown> = {
        host: jumpHost.host,
        port: jumpHost.port,
        username: directUsername,
        readyTimeout: 30000,
        keepaliveInterval: 10000,
        tryKeyboard: true,
        debug: (msg: string) => log.debug(`[jump-shell] ${msg}`)
      }

      let jumpPrivateKey: string | Buffer | undefined
      if (jumpHost.authType === 'privateKey' && jumpHost.privateKeyPath) {
        try {
          jumpPrivateKey = fs.readFileSync(jumpHost.privateKeyPath)
        } catch (err) {
          reject(new Error(`无法读取跳板机私钥文件: ${jumpHost.privateKeyPath}`))
          return
        }
      }

      if (jumpPrivateKey) {
        connectConfig.privateKey = jumpPrivateKey
        if (jumpHost.passphrase) {
          connectConfig.passphrase = jumpHost.passphrase
        }
      } else if (jumpHost.password) {
        connectConfig.password = jumpHost.password
      }

      client.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
        finish([jumpHost.password || ''])
      })

      client.on('ready', () => {
        log.info(`JumpServer direct shell connected: ${directUsername}@${jumpHost.host}`)

        client.shell(
          { term: 'xterm-256color', cols: config.cols || 80, rows: config.rows || 24 },
          (err, stream) => {
            if (err) {
              client.end()
              reject(new Error(`打开 JumpServer Shell 失败: ${err.message}`))
              return
            }

            const instance: SshInstance = {
              client,
              stream,
              dataCallbacks: [],
              config,
              encoding
            }

            stream.on('data', (data: Buffer) => {
              let str: string
              if (encoding === 'utf-8') {
                str = data.toString('utf-8')
              } else {
                str = iconv.decode(data, encoding)
              }
              instance.dataCallbacks.forEach(callback => callback(str))
            })

            stream.on('close', () => {
              const current = this.instances.get(id)
              if (!current || current.client !== client) {
                log.info(`${id} JumpServer shell closed (stale/absent, ignore)`)
                return
              }
              log.info(`${id} JumpServer shell closed`)
              this.emitDisconnect({ id, reason: 'stream_closed' })
              client.end()
            })

            this.instances.set(id, instance)

            // Koko 就绪后自动发送目标 IP，触发资产搜索/直连
            if (config.host) {
              const sendTarget = () => stream.write(`${config.host}\r`)
              // 监听首次数据到达（Koko 菜单已渲染），再发送目标 IP
              const onFirstData = () => {
                stream.removeListener('data', onFirstData)
                setTimeout(sendTarget, 300)
              }
              stream.on('data', onFirstData)
            }

            resolve(id)
          }
        )
      })

      client.on('error', err => {
        if (attempt?.isCancelled) {
          log.info(`${id} JumpServer shell error after cancel, ignore:`, err.message)
          return
        }
        log.error(`JumpServer direct shell error:`, err)
        requestLocalNetworkAccessIfDenied(err, 'ssh-jumpserver')
        const friendlyMessage = getSshErrorMessage(err)
        reject(new Error(`连接 JumpServer 失败: ${friendlyMessage}`))
      })

      client.on('close', () => {
        const current = this.instances.get(id)
        if (!current || current.client !== client) {
          if (current && current.client !== client) {
            log.info(`JumpServer direct shell connection closed (stale client, ignore)`)
          }
          return
        }
        log.info(`JumpServer direct shell connection closed`)
        this.emitDisconnect({ id, reason: 'closed' })
        this.instances.delete(id)
      })

      if (attempt?.isCancelled) return
      client.connect(connectConfig)
    })
  }

  /**
   * 向 SSH 写入数据（使用配置的编码）
   */
  /**
   * 向 SSH 终端写入数据。
   *
   * @returns true 表示写入成功；false 表示目标实例不存在/stream 不可用
   *   （SSH 已断开或 channel 关闭）。Agent 工具路径需要检查返回值，false
   *   时把"窗格不存在"作为明确错误返回；用户击键路径忽略返回值即可。
   */
  write(id: string, data: string): boolean {
    const instance = this.instances.get(id)
    if (!instance?.stream) return false
    if (instance.encoding === 'utf-8') {
      instance.stream.write(data)
    } else {
      // 使用 iconv-lite 编码非 UTF-8 数据
      const encoded = iconv.encode(data, instance.encoding)
      instance.stream.write(encoded)
    }
    return true
  }

  /**
   * 调整 SSH 终端大小
   */
  resize(id: string, cols: number, rows: number): void {
    const instance = this.instances.get(id)
    if (instance?.stream) {
      instance.stream.setWindow(rows, cols, 0, 0)
    }
  }

  /**
   * 注册数据回调
   * 返回取消订阅函数
   */
  onData(id: string, callback: (data: string) => void): () => void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.dataCallbacks.push(callback)
      // 返回取消订阅函数
      return () => {
        const idx = instance.dataCallbacks.indexOf(callback)
        if (idx > -1) {
          instance.dataCallbacks.splice(idx, 1)
        }
      }
    }
    // 如果实例不存在，返回空函数
    return () => {}
  }

  /**
   * 检查 SSH 实例是否存在
   */
  hasInstance(id: string): boolean {
    return this.instances.has(id)
  }

  /**
   * 注册断开连接回调
   * 当 SSH 连接断开时（无论是正常断开还是异常断开）都会触发
   */
  onDisconnect(id: string, callback: (event: SshDisconnectEvent) => void): () => void {
    if (!this.disconnectCallbacks.has(id)) {
      this.disconnectCallbacks.set(id, [])
    }
    this.disconnectCallbacks.get(id)!.push(callback)
    
    // 返回取消订阅函数
    return () => {
      const callbacks = this.disconnectCallbacks.get(id)
      if (callbacks) {
        const idx = callbacks.indexOf(callback)
        if (idx > -1) {
          callbacks.splice(idx, 1)
        }
        if (callbacks.length === 0) {
          this.disconnectCallbacks.delete(id)
        }
      }
    }
  }

  /**
   * 触发断开连接事件
   */
  private emitDisconnect(event: SshDisconnectEvent): void {
    const callbacks = this.disconnectCallbacks.get(event.id)
    if (callbacks) {
      // 复制数组，因为回调可能会修改原数组
      const callbacksCopy = [...callbacks]
      for (const callback of callbacksCopy) {
        try {
          callback(event)
        } catch (e) {
          log.error(`Disconnect callback error:`, e)
        }
      }
      // 清理回调
      this.disconnectCallbacks.delete(event.id)
    }
  }

  /** 当前活跃 SSH 终端会话数（退出确认等场景的主进程兜底统计） */
  getActiveInstanceCount(): number {
    return this.instances.size
  }

  /**
   * 断开 SSH 连接
   *
   * 先从 Map 摘掉再收底层连接：旧 client 的异步 close/error 会被身份校验忽略。
   * 因此必须在此处显式 emitDisconnect——否则 reuseId 之后 UI 收不到断连，
   * 重连按钮不会出现（尤其是 reconnect 半路失败时）。
   *
   * 底层收尾放到下一轮事件循环，且用强拆而不是优雅 end()：对面不回断开确认时
   * end() 会堵住主进程，Windows 上整窗假死（停止、侧栏都点了没反应）。
   */
  disconnect(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      this.instances.delete(id)
      this.emitDisconnect({ id, reason: 'closed' })
      setImmediate(() => {
        forceCloseClient(instance.client)
        if (instance.jumpClient) forceCloseClient(instance.jumpClient)
      })
    }
  }

  /**
   * 断开所有 SSH 连接。
   * 仅用于进程退出等场景：不 emitDisconnect（UI 已在拆），也不走单条 disconnect 路径。
   */
  disposeAll(): void {
    this.instances.forEach((instance, id) => {
      forceCloseClient(instance.client)
      if (instance.jumpClient) forceCloseClient(instance.jumpClient)
      this.instances.delete(id)
    })
  }

  /**
   * 执行探测命令获取主机信息
   * 通过单独的 exec 通道执行命令，不会在终端中显示
   */
  async probe(id: string, timeout: number = 5000): Promise<string> {
    const instance = this.instances.get(id)
    if (!instance?.client) {
      throw new Error('SSH connection not found')
    }

    return new Promise((resolve) => {
      // 使用公共探测命令，用分号分隔在一次 exec 调用中执行
      const probeCommand = getUnixProbeCommands().join('; ')
      
      // 使用 exec 在单独的通道执行，不影响终端
      instance.client.exec(probeCommand, (err, stream) => {
        if (err) {
          log.error('Probe exec 失败:', err)
          resolve('error')
          return
        }
        
        let output = ''
        let resolved = false
        
        stream.on('data', (data: Buffer) => {
          output += data.toString()
        })
        
        stream.stderr.on('data', (data: Buffer) => {
          // 忽略 stderr，但记录日志
          log.info('Probe stderr:', data.toString())
        })
        
        stream.on('close', () => {
          if (!resolved) {
            resolved = true
            resolve(output.trim() || 'unknown')
          }
        })
        
        // 超时处理
        setTimeout(() => {
          if (!resolved) {
            resolved = true
            stream.close()
            resolve(output.trim() || 'timeout')
          }
        }, timeout)
      })
    })
  }

  /**
   * 获取 SSH 连接信息
   */
  getConfig(id: string): SshConfig | null {
    const instance = this.instances.get(id)
    return instance?.config || null
  }

  /**
   * 在 SSH 终端执行命令并收集输出
   * 通过检测 shell 提示符来判断命令完成
   */
  executeInTerminal(
    id: string,
    command: string,
    timeout: number = 30000
  ): Promise<ExecuteInTerminalResult> {
    return new Promise((resolve) => {
      const instance = this.instances.get(id)
      if (!instance?.stream) {
        log.error(`SSH 实例不存在: id=${id}, 现有实例: ${Array.from(this.instances.keys()).join(', ')}`)
        resolve({ status: 'no_instance', ptyId: id })
        return
      }

      // 保存 stream 引用，避免 TypeScript 的闭包分析问题
      const stream = instance.stream
      const startTime = Date.now()
      let output = ''
      let timeoutTimer: NodeJS.Timeout | null = null
      let resolved = false
      let commandStarted = false
      let _lastOutputTime = Date.now()
      let checkTimer: NodeJS.Timeout | null = null

      // 去除 ANSI 转义序列和控制字符（用于提示符检测）
      const stripAnsiAndControlChars = (str: string): string => {
        return stripAnsi(str)
          // eslint-disable-next-line no-control-regex
          .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
      }

      // 常见的 shell 提示符模式
      const promptPatterns = [
        /[$#%>❯➜»⟩›]\s*$/,                    // 常见结束符
        /\w+@[\w.-]+\s+[~/][\w/.-]*\s*%\s*$/,    // macOS zsh: user@host ~ %
        /\w+@[\w.-]+[^$#%]*[$#%]\s*$/,        // user@host 格式
        /\[\w+@[\w.-]+[^\]]*\]\s*[$#%]\s*$/,  // [user@host path]$ 格式
        /\w+\s*[$#%>❯➜»⟩›]\s*$/,             // 简单的 user$ 格式
        /[~/][\w/.-]*\s*[$#%>❯]\s*$/,         // 路径 + 提示符
        />\s*$/,                               // 简单的 > 提示符 (fish/powershell)
      ]

      // Shell 续行提示符（zsh/bash），这些不是命令完成的标志
      const continuationPromptPattern = /^(dquote|quote|bquote|cmdsubst|heredoc|pipe|then|do|else|elif|while|until|for|repeat|brace|subshell)(\s\w+)*>\s*$/

      const isPrompt = (text: string): boolean => {
        const cleanText = stripAnsiAndControlChars(text)
        const lines = cleanText.split(/[\r\n]/).filter(l => l.trim())
        const lastLine = lines[lines.length - 1] || ''
        const last80 = cleanText.slice(-80)

        // 排除 shell 续行提示符（如 dquote>），这些表示命令未完成
        if (continuationPromptPattern.test(lastLine.trim())) {
          return false
        }

        return promptPatterns.some(p => p.test(lastLine) || p.test(last80))
      }

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer)
        if (checkTimer) clearTimeout(checkTimer)
        const idx = instance.dataCallbacks.indexOf(outputHandler)
        if (idx !== -1) {
          instance.dataCallbacks.splice(idx, 1)
        }
      }

      const finish = () => {
        if (resolved) return
        resolved = true
        cleanup()

        // 清理输出
        let cleanOutput = output
        // 移除命令回显
        const commandLines = command.split('\n')
        for (const cmdLine of commandLines) {
          const escaped = cmdLine.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
          cleanOutput = cleanOutput.replace(new RegExp(`^.*${escaped}.*[\r\n]*`, 'm'), '')
        }
        // 移除末尾的提示符行
        cleanOutput = cleanOutput.replace(/[\r\n][^\r\n]*[$#%>❯➜»⟩›]\s*$/, '')
        // 清理多余的空行
        cleanOutput = cleanOutput.replace(/^\s*[\r\n]+/, '').replace(/[\r\n]+\s*$/, '')

        resolve({
          status: 'completed',
          output: cleanOutput,
          duration: Date.now() - startTime
        })
      }

      const outputHandler = (data: string) => {
        output = appendCappedTerminalOutput(output, data)
        _lastOutputTime = Date.now()

        // 命令开始后，检测提示符表示命令完成
        if (!commandStarted && output.includes(command.split('\n')[0])) {
          commandStarted = true
        }

        if (commandStarted) {
          // 使用延迟检测，等待输出稳定
          if (checkTimer) clearTimeout(checkTimer)
          checkTimer = setTimeout(() => {
            if (isPrompt(output)) {
              finish()
            }
          }, 300) // 300ms 延迟，等待输出稳定
        }
      }

      // 添加临时数据处理器
      instance.dataCallbacks.push(outputHandler)

      // 发送命令
      stream.write(command + '\r')

      // 超时处理：用 status:'timeout' 明确告诉调用方，
      // 不再往 output 里夹带"[命令执行超时]"魔法字符串
      timeoutTimer = setTimeout(() => {
        if (resolved) return
        resolved = true
        cleanup()
        resolve({
          status: 'timeout',
          output,
          duration: Date.now() - startTime
        })
      }, timeout)
    })
  }

  /**
   * 获取 SSH 终端状态（增强版）
   * 使用独立的 exec channel 执行命令检测远程进程状态
   * 不会影响主 shell 的显示
   */
  async getTerminalStatus(id: string): Promise<TerminalStatus> {
    const instance = this.instances.get(id)
    if (!instance) {
      return {
        isIdle: false,
        stateDescription: 'SSH 终端实例不存在'
      }
    }

    // 检查 stream 是否可用
    if (!instance.stream) {
      return {
        isIdle: false,
        stateDescription: 'SSH stream 不可用'
      }
    }

    // 尝试通过 exec channel 获取远程进程状态
    try {
      const processInfo = await this.execCommand(id, 'ps -o pid=,stat=,comm= -p $$ 2>/dev/null || echo "unknown"', 2000)
      
      if (processInfo && !processInfo.includes('unknown')) {
        // 解析 ps 输出，检查 shell 进程状态
        // S/S+ 表示睡眠（空闲），R 表示运行中
        const lines = processInfo.trim().split('\n')
        const lastLine = lines[lines.length - 1]
        const parts = lastLine.trim().split(/\s+/)
        
        if (parts.length >= 2) {
          const stat = parts[1]
          const comm = parts[2] || 'shell'
          
          // S, S+, Ss, Ss+ 等表示睡眠状态（空闲）
          // R, R+ 等表示运行状态
          const isIdle = stat.startsWith('S') || stat.startsWith('I')
          
          return {
            isIdle,
            shellPid: parseInt(parts[0]) || undefined,
            foregroundProcess: comm,
            stateDescription: isIdle 
              ? 'SSH 终端空闲（通过 exec channel 检测）' 
              : `SSH 终端忙碌，进程: ${comm}`
          }
        }
      }
    } catch (err) {
      // exec channel 失败，回退到基本检测
      log.info(`exec channel 状态检测失败: ${err}`)
    }

    // 回退方案：依赖 TerminalStateService 的状态追踪
    // 这里返回基本状态，让 TerminalAwarenessService 结合屏幕分析判断
    return {
      isIdle: true,
      stateDescription: 'SSH 终端（状态由屏幕分析确定）'
    }
  }

  /**
   * 通过独立的 exec channel 执行命令
   * 不会影响主 shell 的显示，适合用于状态检测
   */
  private execCommand(id: string, command: string, timeout: number = 5000): Promise<string> {
    return new Promise((resolve, reject) => {
      const instance = this.instances.get(id)
      if (!instance) {
        reject(new Error('SSH instance not found'))
        return
      }

      let output = ''
      let resolved = false

      // 设置超时
      const timer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          reject(new Error('exec timeout'))
        }
      }, timeout)

      // 使用 exec 在独立 channel 上执行命令
      instance.client.exec(command, (err, stream) => {
        if (err) {
          clearTimeout(timer)
          if (!resolved) {
            resolved = true
            reject(err)
          }
          return
        }

        stream.on('data', (data: Buffer) => {
          output += data.toString('utf-8')
        })

        stream.stderr.on('data', (data: Buffer) => {
          // 忽略 stderr，或者可以记录
          log.info(`exec stderr: ${data.toString('utf-8')}`)
        })

        stream.on('close', () => {
          clearTimeout(timer)
          if (!resolved) {
            resolved = true
            resolve(output)
          }
        })

        stream.on('error', (err: Error) => {
          clearTimeout(timer)
          if (!resolved) {
            resolved = true
            reject(err)
          }
        })
      })
    })
  }

  /**
   * 获取远程终端的当前工作目录
   * 通过独立的 exec channel 执行 pwd 命令，不会在终端界面显示
   */
  async getRemoteCwd(id: string): Promise<string | null> {
    log.info(`getRemoteCwd: 开始获取 SSH ${id} 的 CWD`)
    try {
      const output = await this.execCommand(id, 'pwd', 3000)
      const cwd = output.trim()
      log.info(`getRemoteCwd: SSH ${id} pwd 输出: "${cwd}"`)
      // 验证输出是否为有效路径
      if (cwd && cwd.startsWith('/')) {
        return cwd
      }
      log.info(`getRemoteCwd: SSH ${id} 输出不是有效路径`)
      return null
    } catch (err) {
      log.error(`getRemoteCwd: SSH ${id} 执行 pwd 失败:`, err)
      return null
    }
  }

  /**
   * 获取远程 shell 的子进程信息
   * 用于更精确地判断是否有命令正在执行
   */
  async getRemoteProcesses(id: string): Promise<{
    shellPid?: number
    children: { pid: number; comm: string; stat: string }[]
  } | null> {
    try {
      // 获取当前 shell 的 PID 和子进程
      const output = await this.execCommand(
        id,
        'echo "SHELL_PID=$$" && ps --ppid $$ -o pid=,stat=,comm= 2>/dev/null || ps -o pid=,stat=,comm= 2>/dev/null',
        3000
      )

      const lines = output.trim().split('\n')
      let shellPid: number | undefined
      const children: { pid: number; comm: string; stat: string }[] = []

      for (const line of lines) {
        if (line.startsWith('SHELL_PID=')) {
          shellPid = parseInt(line.split('=')[1])
        } else {
          const parts = line.trim().split(/\s+/)
          if (parts.length >= 2) {
            const pid = parseInt(parts[0])
            const comm = parts[2] || 'unknown'
            // 排除 ps 命令本身（它是我们用于检测的命令）
            if (!isNaN(pid) && comm !== 'ps') {
              children.push({
                pid,
                stat: parts[1],
                comm
              })
            }
          }
        }
      }

      return { shellPid, children }
    } catch {
      return null
    }
  }
}

