import { Client, ClientChannel } from 'ssh2'
import { v4 as uuidv4 } from 'uuid'
import * as fs from 'fs'
import stripAnsi from 'strip-ansi'

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
}

interface SshInstance {
  client: Client
  jumpClient?: Client  // 跳板机客户端（如果通过跳板机连接）
  stream: ClientChannel | null
  dataCallbacks: ((data: string) => void)[]
  config: SshConfig
}

export class SshService {
  private instances: Map<string, SshInstance> = new Map()

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

      const instance: SshInstance = {
        client,
        stream: null,
        dataCallbacks: [],
        config
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

            // 监听数据
            stream.on('data', (data: Buffer) => {
              const str = data.toString('utf-8')
              instance.dataCallbacks.forEach(callback => callback(str))
            })

            // 监听关闭
            stream.on('close', () => {
              console.log(`SSH ${id} stream closed`)
              client.end()
            })

            this.instances.set(id, instance)
            resolve(id)
          }
        )
      })

      client.on('error', err => {
        console.error(`SSH ${id} error:`, err)
        this.instances.delete(id)
        reject(err)
      })

      client.on('close', () => {
        console.log(`SSH ${id} connection closed`)
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
          instance.client.end()
          this.instances.delete(id)
        }
      })

      jumpClient.connect(jumpConnectConfig)
    })
  }

  /**
   * 向 SSH 写入数据
   */
  write(id: string, data: string): void {
    const instance = this.instances.get(id)
    if (instance?.stream) {
      instance.stream.write(data)
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
   * 通过执行一个组合命令来探测远程主机的操作系统类型
   */
  async probe(id: string, timeout: number = 5000): Promise<string> {
    const instance = this.instances.get(id)
    if (!instance?.stream) {
      throw new Error('SSH connection not found or stream not available')
    }

    return new Promise((resolve) => {
      let output = ''
      let resolved = false
      
      // 生成一个唯一的结束标记
      const endMarker = `__PROBE_END_${Date.now()}__`
      
      // 探测命令：先尝试检测是Windows还是Unix系统
      // Windows 会有 %OS% 变量，Unix 系统会有 uname
      const probeCommand = `echo "---PROBE_START---" && (uname -s 2>/dev/null || echo %OS%) && echo "${endMarker}"\n`
      
      const dataHandler = (data: string) => {
        output += data
        // 检查是否收到结束标记
        if (output.includes(endMarker)) {
          resolved = true
          // 移除这个临时处理器
          const idx = instance.dataCallbacks.indexOf(dataHandler)
          if (idx > -1) {
            instance.dataCallbacks.splice(idx, 1)
          }
          resolve(output)
        }
      }
      
      // 添加临时数据处理器
      instance.dataCallbacks.push(dataHandler)
      
      // 发送探测命令
      instance.stream.write(probeCommand)
      
      // 超时处理
      setTimeout(() => {
        if (!resolved) {
          const idx = instance.dataCallbacks.indexOf(dataHandler)
          if (idx > -1) {
            instance.dataCallbacks.splice(idx, 1)
          }
          resolve(output || 'timeout')
        }
      }, timeout)
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
   * 获取 SSH 终端状态
   * SSH 终端无法像本地 PTY 那样通过进程检测状态
   * 需要依赖 TerminalStateService 的状态追踪
   */
  async getTerminalStatus(id: string): Promise<TerminalStatus> {
    const instance = this.instances.get(id)
    if (!instance) {
      return {
        isIdle: false,
        stateDescription: 'SSH 终端实例不存在'
      }
    }

    // SSH 终端无法直接获取远程进程状态
    // 依赖 TerminalStateService 的状态追踪（通过 currentExecution 判断）
    // 这里返回基本状态，让 TerminalAwarenessService 做进一步判断
    
    // 检查 stream 是否可用
    if (!instance.stream) {
      return {
        isIdle: false,
        stateDescription: 'SSH stream 不可用'
      }
    }

    // 对于 SSH 终端，默认返回"可能空闲"状态
    // 实际的空闲判断由 TerminalAwarenessService 结合屏幕分析完成
    return {
      isIdle: true,
      stateDescription: 'SSH 终端（状态由屏幕分析确定）'
    }
  }
}

