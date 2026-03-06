/**
 * Data Normalize Layer
 *
 * 所有从磁盘读取的持久化数据都应经过对应的 normalize 函数，
 * 确保新增字段在老数据中有合理的默认值，避免 undefined 导致运行时崩溃。
 *
 * 原则：
 *   - 只补齐缺失字段，不修改已有值
 *   - 保持幂等：normalize(normalize(x)) === normalize(x)
 *   - 不执行数据转换或迁移，那是 migration 的职责
 */

import type { HostProfile } from '@shared/types'
import type { AgentRecord } from '@shared/types'
import type { WatchDefinition } from '../services/watch/types'
import type {
  TerminalSettings,
  KeyboardShortcuts,
} from '../services/config.service'

// ==================== HostProfile ====================

export function normalizeHostProfile(raw: Record<string, unknown>): HostProfile {
  return {
    hostId: (raw.hostId as string) || '',
    hostname: (raw.hostname as string) || '',
    username: (raw.username as string) || '',
    os: (raw.os as string) || '',
    osVersion: (raw.osVersion as string) || '',
    shell: (raw.shell as string) || '',
    packageManager: raw.packageManager as string | undefined,
    installedTools: Array.isArray(raw.installedTools) ? raw.installedTools : [],
    homeDir: raw.homeDir as string | undefined,
    currentDir: raw.currentDir as string | undefined,
    notes: Array.isArray(raw.notes) ? raw.notes : undefined,
    lastProbed: typeof raw.lastProbed === 'number' ? raw.lastProbed : 0,
    lastUpdated: typeof raw.lastUpdated === 'number' ? raw.lastUpdated : 0,
  }
}

// ==================== TerminalSettings ====================

const defaultTerminalSettings: TerminalSettings = {
  fontSize: 14,
  fontFamily: '"Cascadia Code", "Fira Code", "JetBrains Mono", Consolas, monospace',
  cursorBlink: true,
  cursorStyle: 'block',
  scrollback: 10000,
  localEncoding: 'auto',
  commandHighlight: true,
}

export function normalizeTerminalSettings(raw: Record<string, unknown>): TerminalSettings {
  return {
    fontSize: typeof raw.fontSize === 'number' ? raw.fontSize : defaultTerminalSettings.fontSize,
    fontFamily: typeof raw.fontFamily === 'string' ? raw.fontFamily : defaultTerminalSettings.fontFamily,
    cursorBlink: typeof raw.cursorBlink === 'boolean' ? raw.cursorBlink : defaultTerminalSettings.cursorBlink,
    cursorStyle: (['block', 'underline', 'bar'] as const).includes(raw.cursorStyle as any)
      ? raw.cursorStyle as TerminalSettings['cursorStyle']
      : defaultTerminalSettings.cursorStyle,
    scrollback: typeof raw.scrollback === 'number' ? raw.scrollback : defaultTerminalSettings.scrollback,
    localEncoding: typeof raw.localEncoding === 'string' ? raw.localEncoding : defaultTerminalSettings.localEncoding,
    commandHighlight: typeof raw.commandHighlight === 'boolean' ? raw.commandHighlight : defaultTerminalSettings.commandHighlight,
  }
}

// ==================== WatchDefinition ====================

export function normalizeWatchDefinition(raw: WatchDefinition): WatchDefinition {
  return {
    ...raw,
    enabled: typeof raw.enabled === 'boolean' ? raw.enabled : true,
    triggers: Array.isArray(raw.triggers) ? raw.triggers : [],
    prompt: raw.prompt || '',
    skills: Array.isArray(raw.skills) ? raw.skills : undefined,
    execution: raw.execution || { type: 'local' as const, timeout: 300 },
    output: raw.output || { type: 'log' as const },
    priority: raw.priority || 'normal',
    createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : 0,
    updatedAt: typeof raw.updatedAt === 'number' ? raw.updatedAt : 0,
  }
}

// ==================== AgentRecord ====================

export function normalizeAgentRecord(raw: AgentRecord): AgentRecord {
  return {
    ...raw,
    steps: Array.isArray(raw.steps) ? raw.steps : [],
    duration: typeof raw.duration === 'number' ? raw.duration : 0,
    status: raw.status || 'completed',
    terminalType: raw.terminalType || 'local',
    timestamp: typeof raw.timestamp === 'number' ? raw.timestamp : 0,
    userTask: raw.userTask || '',
  }
}

// ==================== KeyboardShortcuts ====================

export function normalizeKeyboardShortcuts(
  raw: Record<string, unknown>,
  defaults: KeyboardShortcuts,
): KeyboardShortcuts {
  const result = { ...defaults } as Record<string, string>
  for (const key of Object.keys(defaults)) {
    if (typeof (raw as Record<string, unknown>)[key] === 'string') {
      result[key] = (raw as Record<string, unknown>)[key] as string
    }
  }
  return result as unknown as KeyboardShortcuts
}
