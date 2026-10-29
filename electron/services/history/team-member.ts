/** 仅加载用户选中的真实成员，不读取成员对话或扫描工作目录。 */
import type { SubAgentResult } from '@shared/types'
import { childToSubAgentResult, toolStepsFromRecords } from '../agent/sub-agent-roster'
import type { SubAgentRecordStore } from './sub-agent-record-store'

export async function readTeamMember(store: SubAgentRecordStore, sessionId: string, name: string): Promise<SubAgentResult | undefined> {
  const child = await store.find(sessionId, name)
  if (!child) return undefined
  const steps = toolStepsFromRecords(await store.readSteps(child))
  return { ...childToSubAgentResult({ ...child.state, steps }), role: child.state.role, prompt: child.state.shownPrompt ?? child.state.prompt }
}
