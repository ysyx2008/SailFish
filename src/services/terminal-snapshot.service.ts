/**
 * 终端状态快照与 Diff 服务
 * 管理终端状态的快照创建、存储和差异计算
 */
import type { TerminalScreenService, ScreenContent, CursorPosition } from './terminal-screen.service'

/**
 * 终端状态快照
 */
export interface TerminalSnapshot {
  /** 快照 ID */
  id: string
  /** 创建时间 */
  timestamp: number
  /** 当前工作目录 */
  cwd: string
  /** 可视区域内容 */
  visibleLines: string[]
  /** 光标位置 */
  cursor: CursorPosition
  /** 终端尺寸 */
  dimensions: {
    cols: number
    rows: number
  }
  /** 最后执行的命令 */
  lastCommand?: string
  /** 最后命令的退出码 */
  lastExitCode?: number
  /** 终端是否空闲 */
  isIdle: boolean
  /** 最近 N 行输出（用于快速对比） */
  recentLines: string[]
  /** 屏幕内容哈希（用于快速判断是否变化） */
  contentHash: string
}

/**
 * 终端状态差异
 */
export interface TerminalDiff {
  /** 是否有变化 */
  hasChanges: boolean
  /** CWD 是否变化 */
  cwdChanged: boolean
  /** 旧 CWD */
  cwdFrom?: string
  /** 新 CWD */
  cwdTo?: string
  /** 光标位置是否变化 */
  cursorChanged: boolean
  /** 旧光标位置 */
  cursorFrom?: CursorPosition
  /** 新光标位置 */
  cursorTo?: CursorPosition
  /** 新增的行 */
  newLines: string[]
  /** 删除的行（在可视区域内）*/
  removedLines: string[]
  /** 空闲状态是否变化 */
  idleChanged: boolean
  /** 最后执行的命令（如果有） */
  lastCommand?: string
  /** 退出码（如果有） */
  lastExitCode?: number
  /** 时间差（毫秒） */
  timeDelta: number
}

/**
 * 简单的内容哈希计算
 */
function calculateHash(lines: string[]): string {
  const content = lines.join('\n')
  let hash = 0
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i)
    hash = ((hash << 5) - hash) + char
    hash = hash & hash // Convert to 32bit integer
  }
  return hash.toString(16)
}

/**
 * 终端快照管理器
 */
export class TerminalSnapshotManager {
  private screenService: TerminalScreenService
  private snapshots: Map<string, TerminalSnapshot> = new Map()
  private snapshotHistory: TerminalSnapshot[] = []
  private maxHistoryLength: number
  private snapshotCounter = 0
  
  // 额外状态（从外部更新）
  private currentCwd = '~'
  private lastCommand?: string
  private lastExitCode?: number
  private isIdle = true

  constructor(screenService: TerminalScreenService, maxHistoryLength: number = 10) {
    this.screenService = screenService
    this.maxHistoryLength = maxHistoryLength
  }

  /**
   * 更新外部状态
   */
  updateExternalState(state: {
    cwd?: string
    lastCommand?: string
    lastExitCode?: number
    isIdle?: boolean
  }): void {
    if (state.cwd !== undefined) this.currentCwd = state.cwd
    if (state.lastCommand !== undefined) this.lastCommand = state.lastCommand
    if (state.lastExitCode !== undefined) this.lastExitCode = state.lastExitCode
    if (state.isIdle !== undefined) this.isIdle = state.isIdle
  }

  /**
   * 创建当前状态的快照
   */
  createSnapshot(name?: string): TerminalSnapshot {
    const screenContent = this.screenService.getScreenContent()
    const recentLines = this.screenService.getLastNLines(30)
    
    const snapshot: TerminalSnapshot = {
      id: name || `snapshot_${Date.now()}_${++this.snapshotCounter}`,
      timestamp: Date.now(),
      cwd: this.currentCwd,
      visibleLines: screenContent.visibleLines,
      cursor: screenContent.cursor,
      dimensions: screenContent.dimensions,
      lastCommand: this.lastCommand,
      lastExitCode: this.lastExitCode,
      isIdle: this.isIdle,
      recentLines,
      contentHash: calculateHash(recentLines)
    }

    // 存储到命名快照
    if (name) {
      this.snapshots.set(name, snapshot)
    }

    // 添加到历史
    this.snapshotHistory.push(snapshot)
    
    // 限制历史长度
    while (this.snapshotHistory.length > this.maxHistoryLength) {
      this.snapshotHistory.shift()
    }

    return snapshot
  }

  /**
   * 获取命名快照
   */
  getSnapshot(name: string): TerminalSnapshot | undefined {
    return this.snapshots.get(name)
  }

  /**
   * 删除命名快照
   */
  deleteSnapshot(name: string): boolean {
    return this.snapshots.delete(name)
  }

  /**
   * 获取快照历史
   */
  getHistory(limit?: number): TerminalSnapshot[] {
    if (limit && limit > 0) {
      return this.snapshotHistory.slice(-limit)
    }
    return [...this.snapshotHistory]
  }

  /**
   * 获取最新的快照
   */
  getLatestSnapshot(): TerminalSnapshot | undefined {
    return this.snapshotHistory[this.snapshotHistory.length - 1]
  }

  /**
   * 计算两个快照之间的差异
   */
  calculateDiff(oldSnapshot: TerminalSnapshot, newSnapshot: TerminalSnapshot): TerminalDiff {
    const diff: TerminalDiff = {
      hasChanges: false,
      cwdChanged: false,
      cursorChanged: false,
      newLines: [],
      removedLines: [],
      idleChanged: false,
      timeDelta: newSnapshot.timestamp - oldSnapshot.timestamp
    }

    // 检查 CWD 变化
    if (oldSnapshot.cwd !== newSnapshot.cwd) {
      diff.cwdChanged = true
      diff.cwdFrom = oldSnapshot.cwd
      diff.cwdTo = newSnapshot.cwd
      diff.hasChanges = true
    }

    // 检查光标变化
    if (oldSnapshot.cursor.x !== newSnapshot.cursor.x || 
        oldSnapshot.cursor.y !== newSnapshot.cursor.y) {
      diff.cursorChanged = true
      diff.cursorFrom = oldSnapshot.cursor
      diff.cursorTo = newSnapshot.cursor
      diff.hasChanges = true
    }

    // 检查空闲状态变化
    if (oldSnapshot.isIdle !== newSnapshot.isIdle) {
      diff.idleChanged = true
      diff.hasChanges = true
    }

    // 计算行差异（简单实现：基于 Set 对比）
    const oldLinesSet = new Set(oldSnapshot.recentLines)
    const newLinesSet = new Set(newSnapshot.recentLines)

    // 新增的行
    for (const line of newSnapshot.recentLines) {
      if (!oldLinesSet.has(line) && line.trim()) {
        diff.newLines.push(line)
      }
    }

    // 删除的行
    for (const line of oldSnapshot.recentLines) {
      if (!newLinesSet.has(line) && line.trim()) {
        diff.removedLines.push(line)
      }
    }

    if (diff.newLines.length > 0 || diff.removedLines.length > 0) {
      diff.hasChanges = true
    }

    // 记录最后的命令和退出码
    if (newSnapshot.lastCommand && newSnapshot.lastCommand !== oldSnapshot.lastCommand) {
      diff.lastCommand = newSnapshot.lastCommand
    }
    if (newSnapshot.lastExitCode !== undefined) {
      diff.lastExitCode = newSnapshot.lastExitCode
    }

    return diff
  }

  /**
   * 与上一个快照比较
   */
  compareWithPrevious(): TerminalDiff | null {
    if (this.snapshotHistory.length < 2) {
      return null
    }

    const oldSnapshot = this.snapshotHistory[this.snapshotHistory.length - 2]
    const newSnapshot = this.snapshotHistory[this.snapshotHistory.length - 1]

    return this.calculateDiff(oldSnapshot, newSnapshot)
  }

  /**
   * 创建快照并与上一个比较
   */
  snapshotAndCompare(): { snapshot: TerminalSnapshot; diff: TerminalDiff | null } {
    const snapshot = this.createSnapshot()
    const diff = this.compareWithPrevious()
    return { snapshot, diff }
  }

  /**
   * 快速检查内容是否变化（不创建完整快照）
   */
  hasContentChanged(): boolean {
    const latestSnapshot = this.getLatestSnapshot()
    if (!latestSnapshot) return true

    const currentLines = this.screenService.getLastNLines(30)
    const currentHash = calculateHash(currentLines)

    return currentHash !== latestSnapshot.contentHash
  }

  /**
   * 获取自上次快照以来的新输出
   */
  getNewOutputSinceLastSnapshot(): string[] {
    const latestSnapshot = this.getLatestSnapshot()
    if (!latestSnapshot) {
      return this.screenService.getLastNLines(30)
    }

    const currentLines = this.screenService.getLastNLines(30)
    const oldLinesSet = new Set(latestSnapshot.recentLines)

    return currentLines.filter(line => !oldLinesSet.has(line) && line.trim())
  }

  /**
   * 清除所有快照
   */
  clearAll(): void {
    this.snapshots.clear()
    this.snapshotHistory = []
  }

  /**
   * 清除历史（保留命名快照）
   */
  clearHistory(): void {
    this.snapshotHistory = []
  }
}

/**
 * 创建快照管理器的工厂函数
 */
export function createSnapshotManager(
  screenService: TerminalScreenService,
  maxHistoryLength?: number
): TerminalSnapshotManager {
  return new TerminalSnapshotManager(screenService, maxHistoryLength)
}
