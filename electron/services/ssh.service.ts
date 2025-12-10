import { Client, ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import stripAnsi from 'strip-ansi'
import * as iconv from 'iconv-lite'

// 支持的字符编码（与前端保持一致）
export type SshEncoding = 
  | 'utf-8'      // UTF-8 (默认，支持所有语言)
  | 'gbk'        // 简体中文 (Windows)
  | 'gb2312'     // 简体中文
  | 'gb18030'    // 简体中文 (完整)
  | 'big5'       // 繁体中文
  | 'shift_jis'  // 日语
  | 'euc-jp'     // 日语 (Unix)
  | 'euc-kr'     // 韩语
  | 'iso-8859-1' // Latin-1 (西欧语言)
  | 'iso-8859-15'// Latin-9 (西欧语言，含欧元符号)
  | 'windows-1252' // Windows 西欧
  | 'koi8-r'     // 俄语
  | 'windows-1251' // 俄语 (Windows)

// 终端状态接口（与 pty.service.ts 保持一致）
export interface TerminalStatus {
  isIdle: boolean
  shellPid?: number
  foregroundPid?: number
  foregroundProcess?: string
  stateDescription?: string
}

// 跳板机配置
export interface JumpHostConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
  cols?: number
  rows?: number
  jumpHost?: JumpHostConfig  // 跳板机配置
  encoding?: SshEncoding     // 字符编码，默认 utf-8
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

  /**
   * 建立 SSH 连接（支持跳板机）
   */
  async connect(config: SshConfig): Promise<string> {
    const id = uuidv4()

    // 如果配置了跳板机，先通过跳板机建立连接
    if (config.jumpHost) {
      return this.connectViaJumpHost(id, config)
    }

    // 直接连接
    return this.directConnect(id, config)
  }

  /**
   * 直接建立 SSH 连接
   */
  private async directConnect(id: string, config: SshConfig, sock?: NodeJS.ReadableStream): Promise<string> {
    return new Promise((resolve, reject) => {
      const client = new Client()
      
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
              reject(err)
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

            // 监听关闭
            stream.on('close', () => {
              console.log(`SSH ${id} stream closed`)
              // 触发断开连接事件（stream 关闭通常意味着连接断开）
              this.emitDisconnect({ id, reason: 'stream_closed' })
              client.end()
            })

            this.instances.set(id, instance)
            resolve(id)
          }
        )
      })

      client.on('error', err => {
        console.error(`SSH ${id} error:`, err)
        // 触发断开连接事件
        this.emitDisconnect({ id, reason: 'error', error: err })
        this.instances.delete(id)
        reject(err)
      })

      client.on('close', () => {
        console.log(`SSH ${id} connection closed`)
        // 触发断开连接事件（如果还没触发过）
        this.emitDisconnect({ id, reason: 'closed' })
        this.instances.delete(id)
      })

      client.connect(connectConfig)
    })
  }

  /**
   * 通过跳板机建立 SSH 连接
   */
  private async connectViaJumpHost(id: string, config: SshConfig): Promise<string> {
    const jumpHost = config.jumpHost!
    
    return new Promise((resolve, reject) => {
      const jumpClient = new Client()

      // 准备跳板机私钥
      let jumpPrivateKey: string | Buffer | undefined
      if (jumpHost.authType === 'privateKey' && jumpHost.privateKeyPath) {
        try {
          jumpPrivateKey = fs.readFileSync(jumpHost.privateKeyPath)
        } catch (err) {
          reject(new Error(`无法读取跳板机私钥文件: ${jumpHost.privateKeyPath}`))
          return
        }
      }

      // 跳板机连接配置
      const jumpConnectConfig: {
        host: string
        port: number
        username: string
        password?: string
        privateKey?: string | Buffer
        passphrase?: string
        readyTimeout: number
        keepaliveInterval: number
      } = {
        host: jumpHost.host,
        port: jumpHost.port,
        username: jumpHost.username,
        readyTimeout: 30000,
        keepaliveInterval: 10000
      }

      if (jumpPrivateKey) {
        jumpConnectConfig.privateKey = jumpPrivateKey
        if (jumpHost.passphrase) {
          jumpConnectConfig.passphrase = jumpHost.passphrase
        }
      } else if (jumpHost.password) {
        jumpConnectConfig.password = jumpHost.password
      }

      jumpClient.on('ready', () => {
        console.log(`[SSH] Jump host connected: ${jumpHost.username}@${jumpHost.host}`)
        
        // 通过跳板机建立到目标服务器的隧道
        jumpClient.forwardOut(
          '127.0.0.1',
          0,
          config.host,
          config.port,
          async (err, stream) => {
            if (err) {
              console.error(`[SSH] Forward failed:`, err)
              jumpClient.end()
              reject(new Error(`通过跳板机建立隧道失败: ${err.message}`))
              return
            }

            try {
              // 在隧道上建立到目标服务器的 SSH 连接
              await this.directConnect(id, config, stream as unknown as NodeJS.ReadableStream)
              
              // 保存跳板机客户端引用，以便断开时一起清理
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
        console.error(`[SSH] Jump host error:`, err)
        reject(new Error(`连接跳板机失败: ${err.message}`))
      })

      jumpClient.on('close', () => {
        console.log(`[SSH] Jump host connection closed`)
        // 跳板机关闭时，也关闭目标连接
        const instance = this.instances.get(id)
        if (instance) {
          // 触发断开连接事件
          this.emitDisconnect({ id, reason: 'jump_host_closed' })
          instance.client.end()
          this.instances.delete(id)
        }
      })

      jumpClient.connect(jumpConnectConfig)
    })
  }

  /**
   * 向 SSH 写入数据（使用配置的编码）
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance?.stream) {
      if (instance.encoding === 'utf-8') {
        instance.stream.write(data)
      } else {
        // 使用 iconv-lite 编码非 UTF-8 数据
        const encoded = iconv.encode(data, instance.encoding)
        instance.stream.write(encoded)
      }
    }
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
          console.error(`[SshService] Disconnect callback error:`, e)
        }
      }
      // 清理回调
      this.disconnectCallbacks.delete(event.id)
    }
  }

  /**
   * 断开 SSH 连接
   */
  disconnect(id: string): void {
    const instance = this.instances.get(id)
    if (instance) {
      instance.client.end()
      // 如果有跳板机连接，也关闭它
      if (instance.jumpClient) {
        instance.jumpClient.end()
      }
      this.instances.delete(id)
    }
  }

  /**
   * 断开所有 SSH 连接
   */
  disposeAll(): void {
    this.instances.forEach((instance, id) => {
      instance.client.end()
      // 如果有跳板机连接，也关闭它
      if (instance.jumpClient) {
        instance.jumpClient.end()
      }
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
      // 探测命令：检测操作系统类型
      const probeCommand = 'uname -s 2>/dev/null || echo %OS%'
      
      // 使用 exec 在单独的通道执行，不影响终端
      instance.client.exec(probeCommand, (err, stream) => {
        if (err) {
          console.error('[SSH Probe] exec 失败:', err)
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
          console.log('[SSH Probe] stderr:', data.toString())
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
  ): Promise<{ output: string; duration: number }> {
    return new Promise((resolve) => {
      const instance = this.instances.get(id)
      if (!instance?.stream) {
        console.error(`[SshService] SSH 实例不存在: id=${id}, 现有实例: ${Array.from(this.instances.keys()).join(', ')}`)
        resolve({ output: `SSH 终端实例不存在 (id=${id})`, duration: 0 })
        return
      }

      // 保存 stream 引用，避免 TypeScript 的闭包分析问题
      const stream = instance.stream
      const startTime = Date.now()
      let output = ''
      let timeoutTimer: NodeJS.Timeout | null = null
      let resolved = false
      let commandStarted = false
      let lastOutputTime = Date.now()
      let checkTimer: NodeJS.Timeout | null = null

      // 去除 ANSI 转义序列和控制字符（用于提示符检测）
      const stripAnsiAndControlChars = (str: string): string => {
        return stripAnsi(str)
          .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '')
      }

      // 常见的 shell 提示符模式
      const promptPatterns = [
        /[$#%>❯➜»⟩›]\s*$/,                    // 常见结束符
        /\w+@[\w.-]+\s+[~\/][\w\/.-]*\s*%\s*$/,  // macOS zsh: user@host ~ %
        /\w+@[\w.-]+[^$#%]*[$#%]\s*$/,        // user@host 格式
        /\[\w+@[\w.-]+[^\]]*\]\s*[$#%]\s*$/,  // [user@host path]$ 格式
        /\w+\s*[$#%>❯➜»⟩›]\s*$/,             // 简单的 user$ 格式
        /[~\/][\w\/.-]*\s*[$#%>❯]\s*$/,       // 路径 + 提示符
        />\s*$/,                               // 简单的 > 提示符 (fish/powershell)
      ]

      const isPrompt = (text: string): boolean => {
        const cleanText = stripAnsiAndControlChars(text)
        const lines = cleanText.split(/[\r\n]/).filter(l => l.trim())
        const lastLine = lines[lines.length - 1] || ''
        const last80 = cleanText.slice(-80)
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
          output: cleanOutput,
          duration: Date.now() - startTime
        })
      }

      const outputHandler = (data: string) => {
        output += data
        lastOutputTime = Date.now()

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

      // 超时处理
      timeoutTimer = setTimeout(() => {
        if (!resolved) {
          resolved = true
          cleanup()
          resolve({
            output: output + '\n[命令执行超时]',
            duration: Date.now() - startTime
          })
        }
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
      console.log(`[SshService] exec channel 状态检测失败: ${err}`)
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
          console.log(`[SshService] exec stderr: ${data.toString('utf-8')}`)
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

