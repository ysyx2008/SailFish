/**
 * 统一终端服务
 * 抽象 PTY 和 SSH 终端的公共接口，让 Agent 可以同时处理两种终端
 */

import type { PtyService, CommandResult, TerminalStatus } from './pty.service'
import type { SshService } from './ssh.service'
import { getTerminalStateService, type TerminalStateService } from './terminal-state.service'

/**
 * 统一终端接口
 * 定义 PTY 和 SSH 终端共有的操作
 */
export interface UnifiedTerminalInterface {
  /** 向终端写入数据 */
  write(id: string, data: string): void
  
  /** 注册数据回调，返回取消订阅函数 */
  onData(id: string, callback: (data: string) => void): () => void
  
  /** 在终端执行命令并收集输出 */
  executeInTerminal(id: string, command: string, timeout?: number): Promise<{ output: string; duration: number }>
  
  /** 获取终端状态 */
  getTerminalStatus(id: string): Promise<TerminalStatus>
  
  /** 检查终端实例是否存在 */
  hasInstance(id: string): boolean
  
  /** 获取终端类型 */
  getTerminalType(id: string): 'local' | 'ssh' | null
}

/**
 * 统一终端服务
 * 封装 PtyService 和 SshService，提供统一的接口
 */
export class UnifiedTerminalService implements UnifiedTerminalInterface {
  private ptyService: PtyService
  private sshService: SshService
  private terminalStateService: TerminalStateService

  constructor(ptyService: PtyService, sshService: SshService) {
    this.ptyService = ptyService
    this.sshService = sshService
    this.terminalStateService = getTerminalStateService()
  }

  /**
   * 获取终端类型
   */
  getTerminalType(id: string): 'local' | 'ssh' | null {
    // 先从 terminalStateService 查询（最可靠）
    const state = this.terminalStateService.getState(id)
    if (state) {
      return state.type
    }
    
    // 回退：直接检查实例
    if (this.ptyService.hasInstance(id)) {
      return 'local'
    }
    if (this.sshService.hasInstance(id)) {
      return 'ssh'
    }
    return null
  }

  /**
   * 检查终端实例是否存在
   */
  hasInstance(id: string): boolean {
    return this.ptyService.hasInstance(id) || this.sshService.hasInstance(id)
  }

  /**
   * 向终端写入数据
   */
  write(id: string, data: string): void {
    const type = this.getTerminalType(id)
    if (type === 'ssh') {
      this.sshService.write(id, data)
    } else {
      this.ptyService.write(id, data)
    }
  }

  /**
   * 注册数据回调
   * 返回取消订阅函数
   */
  onData(id: string, callback: (data: string) => void): () => void {
    const type = this.getTerminalType(id)
    if (type === 'ssh') {
      return this.sshService.onData(id, callback)
    } else {
      return this.ptyService.onData(id, callback)
    }
  }

  /**
   * 在终端执行命令并收集输出
   */
  async executeInTerminal(
    id: string, 
    command: string, 
    timeout: number = 30000
  ): Promise<{ output: string; duration: number }> {
    const type = this.getTerminalType(id)
    if (type === 'ssh') {
      return this.sshService.executeInTerminal(id, command, timeout)
    } else {
      return this.ptyService.executeInTerminal(id, command, timeout)
    }
  }

  /**
   * 获取终端状态
   */
  async getTerminalStatus(id: string): Promise<TerminalStatus> {
    const type = this.getTerminalType(id)
    if (type === 'ssh') {
      return this.sshService.getTerminalStatus(id)
    } else {
      return this.ptyService.getTerminalStatus(id)
    }
  }

  /**
   * 获取原始 PtyService（用于需要特定功能的场景）
   */
  getPtyService(): PtyService {
    return this.ptyService
  }

  /**
   * 获取原始 SshService（用于需要特定功能的场景）
   */
  getSshService(): SshService {
    return this.sshService
  }
}

// 单例管理
let unifiedTerminalServiceInstance: UnifiedTerminalService | null = null

export function getUnifiedTerminalService(): UnifiedTerminalService | null {
  return unifiedTerminalServiceInstance
}

export function initUnifiedTerminalService(
  ptyService: PtyService,
  sshService: SshService
): UnifiedTerminalService {
  unifiedTerminalServiceInstance = new UnifiedTerminalService(ptyService, sshService)
  return unifiedTerminalServiceInstance
}
