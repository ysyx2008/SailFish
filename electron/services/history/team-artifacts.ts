/** 只按系统归属读取本团成果，不把文本路径或共享目录扫描结果当作登记。 */
import { resolveCanvasArtifactId, type CanvasData, type OrganizationArtifactView } from '@shared/types'
import type { SubAgentRecordStore } from './sub-agent-record-store'

export function readTeamArtifacts(
  store: SubAgentRecordStore,
  sessionId: string,
  team: { name: string; owner?: string },
): OrganizationArtifactView[] {
  const artifacts = new Map<string, OrganizationArtifactView>()
  const aliases = new Map<string, string>()
  const activeByMember = new Map<string, string>()
  const all = store.list(sessionId)
  const members = all.filter(({ state }) => state.parent === team.owner && state.team === team.name)
  // 负责人自己的汇总没有某个自团的成员身份，明确作为负责人共享成果单列。
  const leader = team.owner && members.length ? all.find(({ state }) => state.name === team.owner && state.lead) : undefined
  const producers = leader ? [...members, leader] : members
  const roleOf = (name: string) => name === leader?.state.name ? { producerRole: 'lead' as const } : {}
  const events = producers.flatMap(child => (store.readRecord(child)?.steps ?? []).map(step => ({ member: child.state.name, step })))
    .sort((a, b) => (a.step.timestamp ?? 0) - (b.step.timestamp ?? 0))
  for (const { member, step } of events) {
    const data = step.canvasData
    if (!data || step.success === false || data.action === 'close') continue
    const localId = resolveCanvasArtifactId(data)
    const alias = JSON.stringify([member, localId])
    const anchoredId = data.filePath
      ? resolveCanvasArtifactId({ renderer: data.renderer, filePath: data.filePath })
      : data.url ? resolveCanvasArtifactId({ renderer: data.renderer, url: data.url }) : undefined
    const target = data.action === 'update' && !data.artifactId && !data.filePath && !data.url
      ? activeByMember.get(member) : undefined
    const id = anchoredId ?? aliases.get(alias) ?? target
      ?? `team-artifact:${[sessionId, member, localId].map(encodeURIComponent).join(':')}`
    const previous = artifacts.get(id)
    if (data.action === 'update' && !previous && !data.filePath && !data.url) continue
    const merged: CanvasData = { ...previous?.data, ...data, action: 'open', artifactId: id, activate: false }
    // 文件从磁盘加载，避免把巨大的 HTML/Office 预览再通过 IPC 传一次。
    if (merged.filePath) delete merged.content
    delete merged.sourceStepId // 子成员的 step 不是主对话里的可跳转步骤。
    aliases.set(alias, id)
    activeByMember.set(member, id)
    artifacts.set(id, { member, kind: 'file', ...roleOf(member), data: merged })
  }
  for (const child of producers) {
    if (child.state.result?.trim()) {
      const id = `team-result:${sessionId}:${child.state.name}`
      artifacts.set(id, {
        member: child.state.name,
        kind: 'result',
        ...roleOf(child.state.name),
        data: { action: 'open', renderer: 'markdown', artifactId: id, title: child.state.name, content: child.state.result, activate: false },
      })
    }
  }
  return [...artifacts.values()]
}
