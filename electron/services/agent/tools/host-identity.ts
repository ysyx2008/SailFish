/**
 * 窗格 → 主机身份。
 *
 * 准的只有「这扇窗当初打开的是哪条连接」：本机 → local，远程 → user@host。
 * 提示符、窗里再 ssh、用户自己跳，都不认。
 */
import { getMetaByName } from '../tool-metadata'
import { resolveTargetPtyId } from './utils'
import type { ToolExecutorConfig } from './types'

export interface HostIdentityDeps {
  getTerminalType: (id: string) => 'local' | 'ssh' | null
  getSshConfig?: (id: string) => { host?: string; username?: string } | null
}

export function hostIdFromConnection(
  type: 'local' | 'ssh' | null | undefined,
  ssh?: { host?: string; username?: string } | null
): string | undefined {
  if (type === 'local') return 'local'
  if (type === 'ssh') {
    return `${ssh?.username || 'unknown'}@${ssh?.host || 'unknown'}`
  }
  return undefined
}

export function resolveHostIdForPty(
  ptyId: string | undefined,
  deps: HostIdentityDeps
): string | undefined {
  if (!ptyId) return undefined
  const type = deps.getTerminalType(ptyId)
  if (type === 'local') return 'local'
  if (type === 'ssh') {
    return hostIdFromConnection('ssh', deps.getSshConfig?.(ptyId))
  }
  return undefined
}

/**
 * 会对看得见的那扇窗动手的工具，执行时记下「这是哪台」。
 * 只认元数据 hostScope === 'pane'，不按工具名分支。
 */
export function notePaneHostOperationIfNeeded(
  toolName: string,
  args: Record<string, unknown>,
  defaultPtyId: string | undefined,
  executor: ToolExecutorConfig,
  toolCallId?: string
): void {
  if (!executor.noteHostOperation) return
  const meta = getMetaByName(executor.getToolCatalog?.(), toolName)
  if (meta?.hostScope !== 'pane') return

  const ptyId = resolveTargetPtyId(args, defaultPtyId ?? '') || undefined
  const hostId = resolveHostIdForPty(ptyId, {
    getTerminalType: (id) => executor.terminalService.getTerminalType(id),
    getSshConfig: executor.getSshConfig,
  })
  if (!hostId) return
  executor.noteHostOperation(hostId, { toolCallId })
}

/** 这场对话默认写/读哪份记忆。助手永远是个人，不再误用本机。 */
export function sessionKnowledgeHostId(input: {
  terminalType?: string
  hostId?: string
}): string {
  if (input.terminalType === 'assistant') return 'personal'
  return input.hostId || 'personal'
}

export function composeKnowledgeDocuments(
  docs: ReadonlyArray<{ contextId: string; content: string }>
): string {
  const nonempty = docs.filter(d => d.content.trim())
  if (nonempty.length === 0) return ''
  if (nonempty.length === 1) return nonempty[0].content
  return nonempty.map(d => `### ${knowledgeDocHeading(d.contextId)}\n\n${d.content}`).join('\n\n')
}

export function collectOpenPaneHostIds(
  ptyIds: readonly (string | undefined)[],
  deps: HostIdentityDeps
): string[] {
  return uniqueHosts(
    ptyIds
      .map(id => resolveHostIdForPty(id, deps))
      .filter((id): id is string => Boolean(id))
  )
}

function knowledgeDocHeading(contextId: string): string {
  if (contextId === 'personal') return '用户'
  if (contextId === 'local') return '本机'
  return `主机 ${contextId}`
}

export interface KnowledgeUpdateTargets {
  /** 是否更新个人记忆 */
  personal: boolean
  /** 要更新的主机身份（不含 personal） */
  hostIds: string[]
}

/**
 * 这场任务该写哪些记忆。
 * 助手：个人必写；被动手过的主机另写。
 * 终端页：写这场绑的那台 + 分屏里另外动手过的台。
 */
export function resolveKnowledgeUpdateTargets(input: {
  terminalType?: string
  sessionHostId: string
  operatedHostIds: readonly string[]
}): KnowledgeUpdateTargets {
  const operated = uniqueHosts(input.operatedHostIds)
  if (input.terminalType === 'assistant') {
    return { personal: true, hostIds: operated.filter(id => id !== 'personal') }
  }
  const session = input.sessionHostId || 'personal'
  const hostIds = uniqueHosts([
    ...(session !== 'personal' ? [session] : []),
    ...operated,
  ]).filter(id => id !== 'personal')
  return {
    personal: session === 'personal',
    hostIds,
  }
}

export function uniqueHosts(ids: readonly string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const id of ids) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}
