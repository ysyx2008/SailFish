/**
 * 派专家、专家在群里说话。专家在运行上就是伙计，用同一个花名册。
 */
import type { AgentConfig, ToolExecutorConfig, ToolResult } from './types'
import { MAX_LIVE_CHILDREN, type SpawnTask } from '../sub-agent-roster'
import { MAX_TEAM_SIZE, MIN_TEAM_SIZE, TEAM_LEADER, WAKES_PER_CHECKPOINT } from '../expert-team'
import { parseForkTurns, type ForkTurns } from '../sanitize-parent-messages'
import { dispatchStepView, spawnDeps, workspaceOf } from './sub-agent'
import { expertDispatchTitle } from '../tools'
import { createLogger } from '../../../utils/logger'
import { t } from '../i18n'

const log = createLogger('Expert')

type ParsedExpert = SpawnTask & { role: string; forkTurns: ForkTurns }

function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

export function parseDispatchExperts(args: Record<string, unknown>): { experts: ParsedExpert[]; team?: string } | { error: string } {
  const raw = args.experts
  if (!Array.isArray(raw) || raw.length === 0) {
    return { error: 'experts 必须是非空数组，每位包含 role、description 和 prompt' }
  }
  const forkTurns = parseForkTurns(args.fork_turns)
  if ('error' in forkTurns) return { error: forkTurns.error }

  const experts: ParsedExpert[] = []
  for (let i = 0; i < raw.length; i++) {
    const item = raw[i] as Record<string, unknown> | undefined
    const role = optionalText(item?.role)
    if (!role) return { error: `第 ${i + 1} 位专家缺少 role（专家角色）` }
    if (typeof item?.prompt !== 'string' || item.prompt.trim() === '') {
      return { error: `第 ${i + 1} 位专家缺少 prompt（详细指令）` }
    }
    const name = optionalText(item.name)
    if (name === TEAM_LEADER) return { error: `「${TEAM_LEADER}」留给派出专家团的你，专家不能叫这个名字` }
    experts.push({
      name,
      role,
      description: optionalText(item.description) ?? name ?? role,
      prompt: item.prompt,
      forkTurns,
    })
  }

  const team = optionalText(args.team)
  if (team && (experts.length < MIN_TEAM_SIZE || experts.length > MAX_TEAM_SIZE)) {
    return {
      error: `没派：一个专家团 ${MIN_TEAM_SIZE} 到 ${MAX_TEAM_SIZE} 位专家，这次 ${experts.length} 位。`
        + (experts.length < MIN_TEAM_SIZE
          ? '一位专家没有可交接的人，不带 team 就是单独派。'
          : `可以拆成几个团，或改派伙计（dispatch_agents）。`),
    }
  }
  return { experts, team }
}

function formatSpawned(names: string[], executor: ToolExecutorConfig, team?: string): string {
  const roster = executor.getSubAgentRoster!()!
  const list = names
    .map(n => roster.get(n))
    .filter(c => !!c)
    .map(c => t('expert.list_item', { name: c!.name, role: c!.role ?? '', description: c!.description }))
    .join('\n')
  const head = team
    ? t('expert.spawned_team', { team, count: names.length, list, limit: WAKES_PER_CHECKPOINT })
    : t('expert.spawned', { count: names.length, list })
  return [
    head,
    t('dispatch.capacity', { live: roster.liveCount(), room: roster.room() }),
    t('dispatch.overview_at', { path: workspaceOf(roster).overviewPath }),
  ].join('\n')
}

export async function dispatchExperts(
  args: Record<string, unknown>,
  _config: AgentConfig,
  executor: ToolExecutorConfig,
): Promise<ToolResult> {
  const roster = executor.getSubAgentRoster?.()
  if (!roster) return { success: false, output: '', error: 'dispatch_experts 需要主人花名册（内部错误）' }

  const parsed = parseDispatchExperts(args)
  if ('error' in parsed) return { success: false, output: '', error: parsed.error }
  const { experts, team } = parsed
  if (experts.length > roster.room()) {
    return {
      success: false,
      output: '',
      error: t('dispatch.over_fuse', { max: MAX_LIVE_CHILDREN, live: roster.liveCount(), room: roster.room(), count: experts.length }),
    }
  }

  const progressStep = executor.addStep({
    type: 'tool_call',
    content: expertDispatchTitle(experts.length, team),
    toolName: 'dispatch_experts',
    toolArgs: {
      experts: experts.map(e => ({ name: e.name, role: e.role, description: e.description })),
      ...(team ? { team } : {}),
    },
    riskLevel: 'safe',
    success: true,
    subAgents: [],
  })

  const ownedNames = new Set<string>()
  const deps = spawnDeps(executor, progressStep.id, ownedNames)
  if ('error' in deps) return { success: false, output: '', error: deps.error }

  const names = roster.spawn(experts, deps, { team })
  const teamName = roster.teamOf(names[0])?.name
  const workspace = workspaceOf(roster)
  workspace.writeOverview(roster.list())
  const created = teamName ? roster.getTeam(teamName) : undefined
  if (created) {
    workspace.writeTeamChat(created)
    workspace.writeTeamTranscript(created)
  }

  executor.updateStep(progressStep.id, {
    content: expertDispatchTitle(names.length, teamName),
    ...dispatchStepView(roster, new Set(names)),
  })

  log.info(`Dispatched ${names.length} experts${teamName ? ` as team ${teamName}` : ''}: ${names.join(', ')}`)
  return { success: true, output: formatSpawned(names, executor, teamName) }
}

export async function teamSay(args: Record<string, unknown>, executor: ToolExecutorConfig): Promise<ToolResult> {
  const seat = executor.teamSeat
  if (!seat) return { success: false, output: '', error: t('expert.say_denied') }
  const message = typeof args.message === 'string' ? args.message.trim() : ''
  if (!message) return { success: false, output: '', error: '需要 message' }
  const to = Array.isArray(args.to)
    ? (args.to as unknown[]).filter((n): n is string => typeof n === 'string' && n.trim() !== '').map(n => n.trim())
    : typeof args.to === 'string' && args.to.trim() ? [args.to.trim()] : []

  const result = seat.say(to, message)
  if (!result.ok) {
    const error = result.members
      ? t('expert.say_unknown', { names: to.filter(n => !result.members!.includes(n)).join('、'), members: result.members.join('、') })
      : result.error
    return { success: false, output: '', error }
  }
  const parts = [t('expert.say_ok')]
  if (result.woke.length) parts.push(t('expert.say_woke', { names: result.woke.join('、') }))
  if (result.queued.length) parts.push(t('expert.say_queued', { names: result.queued.join('、') }))
  if (result.skipped.length) parts.push(t('expert.say_skipped', { names: result.skipped.join('、') }))
  if (result.toLeader) parts.push(t('expert.say_leader'))
  if (result.checkpointReached) parts.push(t('expert.say_checkpoint', { limit: WAKES_PER_CHECKPOINT }))
  return { success: true, output: parts.join('') }
}
