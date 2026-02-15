/**
 * IM Session Manager - 管理 IM 用户会话
 *
 * 每个 IM 用户（或群聊）对应一个独立会话，包含：
 * - 独立的 PTY 终端
 * - 独立的对话历史
 * - 独立的 Agent 运行状态
 */

import type { IMSession, IMPlatform, IMServiceDependencies } from './types'
import * as crypto from 'crypto'

/** 默认清理检查间隔（毫秒） */
const DEFAULT_CLEANUP_INTERVAL_MS = 5 * 60 * 1000

export class SessionManager {
  private sessions = new Map<string, IMSession>()
  private deps: IMServiceDependencies | null = null
  private cleanupTimer: ReturnType<typeof setInterval> | null = null
  private sessionTimeoutMs = 60 * 60 * 1000 // 默认 60 分钟
  private cleanupIntervalMs = DEFAULT_CLEANUP_INTERVAL_MS

  setDependencies(deps: IMServiceDependencies) {
    this.deps = deps
  }

  setSessionTimeout(minutes: number) {
    this.sessionTimeoutMs = minutes * 60 * 1000
  }

  /**
   * 设置清理检查间隔
   * @param minutes 检查间隔（分钟），最小 1 分钟
   */
  setCleanupInterval(minutes: number) {
    this.cleanupIntervalMs = Math.max(1, minutes) * 60 * 1000
  }

  /**
   * 启动定期清理
   */
  startCleanup() {
    this.stopCleanup()
    this.cleanupTimer = setInterval(() => this.cleanupIdleSessions(), this.cleanupIntervalMs)
  }

  stopCleanup() {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = null
    }
  }

  /**
   * 生成会话 key（平台 + 用户/群聊 ID）
   */
  private makeSessionKey(platform: IMPlatform, userId: string, chatType: 'single' | 'group', chatId?: string): string {
    if (chatType === 'group' && chatId) {
      return `${platform}:group:${chatId}`
    }
    return `${platform}:user:${userId}`
  }

  /**
   * 获取或创建会话
   */
  getOrCreate(
    platform: IMPlatform,
    userId: string,
    userName: string,
    chatType: 'single' | 'group',
    chatId?: string,
    replyContext?: any
  ): IMSession {
    const key = this.makeSessionKey(platform, userId, chatType, chatId)
    let session = this.sessions.get(key)

    if (session) {
      session.lastActiveAt = Date.now()
      // 更新回复上下文（sessionWebhook 等可能变化）
      if (replyContext) {
        session.replyContext = replyContext
      }
      return session
    }

    session = {
      id: crypto.randomUUID(),
      platform,
      userId,
      userName,
      chatType,
      chatId,
      ptyId: null,
      isRunning: false,
      history: [],
      pendingConfirm: null,
      executionMode: 'relaxed',
      lastActiveAt: Date.now(),
      textBuffer: '',
      currentStepId: null,
      replyContext: replyContext || {}
    }

    this.sessions.set(key, session)
    return session
  }

  /**
   * 为会话确保 PTY 终端存在
   */
  async ensurePty(session: IMSession): Promise<string> {
    if (!this.deps) throw new Error('Dependencies not set')

    // 检查现有 PTY 是否还活着
    if (session.ptyId && this.deps.ptyService.hasInstance(session.ptyId)) {
      return session.ptyId
    }

    // 创建新 PTY
    const ptyId = await this.deps.ptyService.create()
    session.ptyId = ptyId
    return ptyId
  }

  /**
   * 获取指定平台的活跃会话数
   */
  getActiveCount(platform?: IMPlatform): number {
    if (!platform) return this.sessions.size
    let count = 0
    for (const session of this.sessions.values()) {
      if (session.platform === platform) count++
    }
    return count
  }

  /**
   * 获取所有会话
   */
  getAllSessions(): IMSession[] {
    return Array.from(this.sessions.values())
  }

  /**
   * 清理空闲会话
   */
  private async cleanupIdleSessions() {
    const now = Date.now()
    const toRemove: string[] = []

    for (const [key, session] of this.sessions.entries()) {
      // 跳过正在运行的会话
      if (session.isRunning) continue

      if (now - session.lastActiveAt > this.sessionTimeoutMs) {
        await this.disposeSessionResources(session)
        toRemove.push(key)
      }
    }

    for (const key of toRemove) {
      this.sessions.delete(key)
    }

    if (toRemove.length > 0) {
      console.log(`[IM] Cleaned up ${toRemove.length} idle sessions`)
    }
  }

  /**
   * 释放单个会话的 PTY 和 Agent 资源
   * cleanupAgent 和 dispose 分别 try-catch，确保一个失败不影响另一个
   */
  private async disposeSessionResources(session: IMSession) {
    if (!session.ptyId || !this.deps) return

    try {
      this.deps.agentService.cleanupAgent(session.ptyId)
    } catch (err) {
      console.error(`[IM] cleanupAgent failed for pty ${session.ptyId}:`, err)
    }

    try {
      this.deps.ptyService.dispose(session.ptyId)
    } catch (err) {
      console.error(`[IM] ptyService.dispose failed for pty ${session.ptyId}:`, err)
    }
  }

  /**
   * 清理所有会话（尽力而为，不会因单个失败而中断）
   */
  async disposeAll() {
    this.stopCleanup()
    for (const session of this.sessions.values()) {
      await this.disposeSessionResources(session)
    }
    this.sessions.clear()
  }
}
