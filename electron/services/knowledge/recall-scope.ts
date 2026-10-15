/**
 * 每一场对话自己的档案范围。没设过就跟设置走；设成空字符串表示这场要看全库。
 */

import { normalizeFolder } from './catalog'

const byAgent = new Map<string, string>()

export function setAgentRecallFolder(agentId: string, folder: string): string {
  const normalized = folder.trim() ? normalizeFolder(folder) : ''
  if (!normalized) byAgent.set(agentId, '')
  else byAgent.set(agentId, normalized)
  return normalized
}

/** undefined：这场没指定过。字符串（含空）是指定过的范围。 */
export function getAgentRecallFolder(agentId: string | undefined): string | undefined {
  if (!agentId) return undefined
  return byAgent.has(agentId) ? byAgent.get(agentId) : undefined
}

export function clearAgentRecallFoldersForTest(): void {
  byAgent.clear()
}
