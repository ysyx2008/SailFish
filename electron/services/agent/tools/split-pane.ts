/**
 * 分屏管理工具执行器
 *
 * Agent 通过这些工具操作前端分屏布局：拆分、关闭、切换激活、列出窗格、原地重连。
 * 实际的状态变更发生在前端 Pinia store 中，由 split-pane-bridge 提供反向 IPC。
 *
 * 窗格标识约定：对 Agent 暴露的"窗格 id"统一为 ptyId（会话实例 id）。
 * **同一窗格 SSH 重连复用该 id**（只换底层连接）；新开窗格 / 新建连接仍分配新 id。
 * 前端布局树内部还有"paneId"（布局节点 id），它在 split 关闭兄弟触发层级压缩
 * （liftChildIntoParent）时会被替换，旧值失效。所以工具参数 pane_id 的语义就是
 * ptyId，manage_pane(action=list) 返回字段也只暴露 ptyId。
 *
 * Tab 定位约定：分屏 bridge 用稳定的 agentKey（终端 = tabId）反查 Agent 所在
 * tab，避免用户切走 tab 时误操作别人的布局。
 *
 * 命令路由约定：分屏后命令工具（execute_command 等）默认仍发到 Agent 当前默认
 * 操作窗格。要在其他窗格执行，请在工具参数里显式传 pane_id（值为目标窗格的
 * ptyId）。manage_pane 的 split / open / close / focus / list（自愈）在执行后
 * 会自动同步 Agent 的"当前默认窗格"。split 返回的 ptyId 与 list 里那扇窗相同。
 */
import { splitPaneBridge, type SplitPaneOp, type SplitPaneResult, type SplitTargetOp } from '../../split-pane-bridge.service'
import { getConfigService } from '../../config.service'
import { t } from '../i18n'
import type { ToolResult, ToolExecutorConfig } from './types'
import { ensurePaneConnected, ensureConnectedToolResult } from './pane-reconnect'

/** handler 返回的 panes 项形态（与 split-pane-handler.ts::collectPanes 保持一致） */
interface PaneInfo {
  ptyId: string
  /** 方位（左侧 / 右上…） */
  label: string
  /** 此刻连着哪台机器（会话名 / 登录地址 / 本地终端），随重连实时变化 */
  connectionName?: string
  isActive: boolean
  terminalType: string
  /**
   * 主进程 hasInstance：仅表示尚未观察到断开，不是远端健康探测。
   * TCP 未超时前远端刚重启仍可能为 true。
   */
  connected?: boolean
  /** 这一扇还在握手（新开或重连），此时不要再调 ensure_connected */
  connecting?: boolean
}

/**
 * 根据 handler 返回的剩余窗格列表，挑一个新的"当前操作 ptyId"。
 * 优先取 isActive 的那个（前端 closePane 已自动切焦点）；都没有就取第一个。
 */
function pickFallbackPtyId(panes: PaneInfo[] | undefined): string | undefined {
  if (!panes || panes.length === 0) return undefined
  return panes.find(p => p.isActive)?.ptyId || panes[0]?.ptyId
}

function ok(output: string, data?: unknown): ToolResult {
  return { success: true, output: data === undefined ? output : `${output}\n${JSON.stringify(data, null, 2)}` }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

async function callBridge(op: SplitPaneOp, ownerAgentKey?: string): Promise<SplitPaneResult> {
  return splitPaneBridge.exec(op, ownerAgentKey)
}

/**
 * 解析 Agent 给的 target 参数。
 *
 * 支持几种宽松写法（LLM 可能用任意一种）：
 * - 不传 → undefined → 走 inherit
 * - "inherit" / "local"
 * - "ssh:<sessionId>"
 * - { kind: "inherit" | "local" }
 * - { kind: "ssh", sessionId: "..." }
 */
function parseSplitTarget(raw: unknown): SplitTargetOp | undefined | { error: string } {
  if (raw === undefined || raw === null) return undefined

  if (typeof raw === 'string') {
    const s = raw.trim()
    if (!s || s === 'inherit') return { kind: 'inherit' }
    if (s === 'local') return { kind: 'local' }
    if (s.startsWith('ssh:')) {
      const sessionId = s.slice(4).trim()
      if (!sessionId) return { error: 'target "ssh:..." 缺少 sessionId' }
      return { kind: 'ssh', sessionId }
    }
    return { error: `target 字符串只支持 "inherit" / "local" / "ssh:<sessionId>"，收到 "${s}"` }
  }

  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>
    const kind = obj.kind
    if (kind === 'inherit') return { kind: 'inherit' }
    if (kind === 'local') return { kind: 'local' }
    if (kind === 'ssh') {
      const sessionId = obj.sessionId ?? obj.session_id
      if (typeof sessionId !== 'string' || !sessionId) {
        return { error: 'target.kind="ssh" 时必须提供 sessionId' }
      }
      return { kind: 'ssh', sessionId }
    }
  }

  return { error: 'target 格式无效' }
}

export async function splitTerminalTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const direction = (args as { direction?: unknown }).direction
  if (direction !== 'horizontal' && direction !== 'vertical') {
    return fail('direction 必须是 "horizontal" 或 "vertical"')
  }

  const parsedTarget = parseSplitTarget(args.target)
  if (parsedTarget && typeof parsedTarget === 'object' && 'error' in parsedTarget) {
    return fail(parsedTarget.error)
  }
  const target = parsedTarget as SplitTargetOp | undefined

  const result = await callBridge({ type: 'split', direction, target }, ownerAgentKey)
  if (!result.ok) return fail(result.error || '分屏失败')

  const data = result.data as { ptyId?: string; newPaneId?: string; panes?: PaneInfo[] } | undefined
  const ptyId = data?.ptyId || data?.newPaneId
  if (ptyId) {
    config?.setCurrentPtyId?.(ptyId)
  }

  const targetDesc = target?.kind === 'ssh'
    ? `（连接到 SSH 会话 ${target.sessionId}）`
    : target?.kind === 'local'
      ? '（新开本地终端）'
      : ''

  return ok(
    `已创建${direction === 'horizontal' ? '左右' : '上下'}分屏${targetDesc}。后续在新窗格执行命令请传入 pane_id=${ptyId || '见返回数据'}（与 list 里那扇窗的编号相同）。`,
    result.data
  )
}

export async function openTerminalTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const parsedTarget = parseSplitTarget(args.target ?? 'local')
  if (parsedTarget && typeof parsedTarget === 'object' && 'error' in parsedTarget) {
    return fail(parsedTarget.error)
  }
  const target = (parsedTarget as SplitTargetOp | undefined) ?? { kind: 'local' }

  const result = await callBridge({ type: 'open', target }, ownerAgentKey)
  if (!result.ok) return fail(result.error || '打开终端失败')

  const data = result.data as { ptyId?: string; panes?: PaneInfo[] } | undefined
  const ptyId = data?.ptyId
  if (ptyId) {
    config?.setCurrentPtyId?.(ptyId)
  }

  const targetDesc = target.kind === 'ssh'
    ? `已连接 SSH 会话 ${target.sessionId}`
    : '已打开本地终端'
  return ok(
    `${targetDesc}。这是用户看得见的真终端。从你的下一步开始，工具清单里会有终端工具（execute_command、send_input、wait 等），之前没有这些工具，是因为窗还没打开。后续命令请用 execute_command（pane_id=${ptyId || '见返回数据'}），不要再用 exec 在幕后执行。`,
    result.data
  )
}

/**
 * 列出所有已配置的 SSH 会话，供 Agent 调用 manage_pane(action=split) 时选择目标。
 *
 * 不返回密码 / 私钥路径等敏感字段，只暴露足够 Agent 决策的元信息。
 */
export async function listSshSessionsTool(): Promise<ToolResult> {
  const sessions = getConfigService().getSshSessions()
  const safe = sessions.map(s => ({
    sessionId: s.id,
    name: s.name,
    host: s.host,
    port: s.port,
    username: s.username,
    group: s.groupId || s.group
  }))
  return ok(
    `共 ${safe.length} 个已配置的 SSH 会话。先 manage_pane(action=open, target="ssh:<sessionId>") 打开真终端；已有终端再开一扇用 split。sessionId 写法：\n  - 字符串形式：target: "ssh:<sessionId>"\n  - 对象形式：target: { kind: "ssh", sessionId: "<sessionId>" }`,
    safe
  )
}

export async function closePaneTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  // 工具参数名 pane_id 保留向后兼容；同时容忍历史/同义字段名（pty_id / paneId / ptyId）。
  // 实际值就是目标窗格的 ptyId——store 内部对未知 id 也会按 ptyId 兜底查找。
  const ptyId = (args as { pane_id?: unknown }).pane_id
    ?? (args as { pty_id?: unknown }).pty_id
    ?? (args as { paneId?: unknown }).paneId
    ?? (args as { ptyId?: unknown }).ptyId
  if (typeof ptyId !== 'string' || !ptyId) {
    return fail('pane_id 必须为字符串（值为目标窗格的 ptyId）')
  }
  const result = await callBridge({ type: 'close', ptyId }, ownerAgentKey)
  if (!result.ok) return fail(result.error || '关闭窗格失败')

  // 如果关掉的就是 Agent 当前操作的窗格，自动把 currentPtyId 切到剩余某个，
  // 让后续 execute_command 等工具不必显式传 pane_id 也能继续工作。
  // 用 getCurrentPtyId（真实 pane ptyId），不用 ownerAgentKey（tabId，不含于 panes 列表）。
  const data = result.data as { panes?: PaneInfo[]; mode?: string } | undefined
  const remaining = data?.panes
  const currentPtyId = config?.getCurrentPtyId?.()
  if (!remaining || remaining.length === 0) {
    config?.setCurrentPtyId?.('')
    return ok(
      '已关闭最后一扇终端，工作台已回到对话。若还要让用户看见命令，请先 manage_pane(action=open) 再 execute_command。',
      result.data
    )
  }
  if (currentPtyId && !remaining.some(p => p.ptyId === currentPtyId)) {
    const newPtyId = pickFallbackPtyId(remaining)
    if (newPtyId) {
      config?.setCurrentPtyId?.(newPtyId)
      return ok(
        `已关闭窗格，当前操作焦点已自动切换到剩余窗格（ptyId=${newPtyId}）。后续命令默认在新焦点执行。`,
        result.data
      )
    }
  }
  return ok('已关闭窗格', result.data)
}

export async function focusPaneTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  // 工具参数名 pane_id 保留向后兼容；实际值=目标窗格的 ptyId。
  const ptyId = (args as { pane_id?: unknown }).pane_id
    ?? (args as { pty_id?: unknown }).pty_id
    ?? (args as { paneId?: unknown }).paneId
    ?? (args as { ptyId?: unknown }).ptyId
  if (typeof ptyId !== 'string' || !ptyId) {
    return fail('pane_id 必须为字符串（值为目标窗格的 ptyId）')
  }
  const result = await callBridge({ type: 'focus', ptyId }, ownerAgentKey)
  if (!result.ok) return fail(result.error || '切换激活窗格失败')

  // 同步更新 Agent 的"当前默认操作 ptyId"——focus_pane 的语义就是切换操作焦点：
  // 既影响 UI，也影响后续命令工具的默认目标。Agent 不必每次都显式传 pane_id。
  // store.setActivePaneInTab 成功后激活窗格就是入参对应的那个，直接信任 isActive 取回 ptyId。
  const data = result.data as { panes?: PaneInfo[] } | undefined
  const newPtyId = data?.panes?.find(p => p.isActive)?.ptyId
  if (newPtyId) {
    config?.setCurrentPtyId?.(newPtyId)
  }
  return ok(
    `已切换激活窗格${newPtyId ? `（当前操作焦点 ptyId=${newPtyId}）` : ''}。后续 execute_command 等工具默认在该窗格执行；如需在其他窗格执行可继续传 pane_id 显式指定（值为目标窗格的 ptyId）。`,
    result.data
  )
}

export async function listPanesTool(
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const result = await callBridge({ type: 'list' }, ownerAgentKey)
  if (!result.ok) return fail(result.error || '列出窗格失败')

  const data = result.data as { panes?: PaneInfo[]; tabId?: string; mode?: string } | undefined
  const panes = data?.panes
  const currentPtyId = config?.getCurrentPtyId?.()
  let healedTo: string | undefined
  if (currentPtyId && panes && panes.length > 0 && !panes.some(p => p.ptyId === currentPtyId)) {
    healedTo = pickFallbackPtyId(panes)
    if (healedTo) {
      config?.setCurrentPtyId?.(healedTo)
    }
  }

  // connected：主进程 hasInstance，不是远端健康检查
  const enrichedPanes = (panes || []).map(p => ({
    ...p,
    connected: Boolean(config?.terminalService?.hasInstance(p.ptyId))
  }))
  const enriched = { ...data, panes: enrichedPanes }

  const healedNote = healedTo
    ? `（默认操作窗格已失效，已自动切换到 ptyId=${healedTo}）。`
    : ''

  return ok(
    `当前窗格列表${healedNote}。字段 label 是用户屏幕上的方位（左侧/右上…），connectionName 是该窗此刻连着的机器（用户屏幕上该窗格顶部就显示这个名字）——用户说"右边那台"或直接报机器名/IP 时按这两个字段对上是哪扇窗。字段 connected 仅表示主进程尚未观察到断开（非远端健康探测）。字段 connecting 为 true 表示这一扇正在握手，不要再调 ensure_connected。SSH 已断且未在握手时才调用 manage_pane(action=ensure_connected) 原地重连（成功后是新 shell）。窗格标识用 ptyId——给 pane_id 传该值即可。`,
    enriched
  )
}

export async function managePaneTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const action = (args as { action?: unknown }).action
  if (typeof action !== 'string' || !action) {
    return fail('action 必填：list | open | split | close | focus | ensure_connected')
  }

  switch (action) {
    case 'list':
      return listPanesTool(ownerAgentKey, config)
    case 'open':
      return openTerminalTool(args, ownerAgentKey, config)
    case 'split':
      return splitTerminalTool(args, ownerAgentKey, config)
    case 'close':
      return closePaneTool(args, ownerAgentKey, config)
    case 'focus':
      return focusPaneTool(args, ownerAgentKey, config)
    case 'ensure_connected':
      return ensureConnectedTool(args, ownerAgentKey, config)
    default:
      return fail(`未知 action="${action}"，支持：list | open | split | close | focus | ensure_connected`)
  }
}

export async function ensureConnectedTool(
  args: Record<string, unknown>,
  ownerAgentKey?: string,
  config?: ToolExecutorConfig
): Promise<ToolResult> {
  const rawPaneId = (args as { pane_id?: unknown }).pane_id
    ?? (args as { pty_id?: unknown }).pty_id
    ?? (args as { paneId?: unknown }).paneId
    ?? (args as { ptyId?: unknown }).ptyId

  const bridgeKey = ownerAgentKey || config?.agentId
  let ptyId = typeof rawPaneId === 'string' && rawPaneId ? rawPaneId : config?.getCurrentPtyId?.()

  const listed = await callBridge({ type: 'list' }, bridgeKey)
  const panes = (listed.data as { panes?: PaneInfo[] } | undefined)?.panes || []

  if (!ptyId) {
    ptyId = panes.find(p => p.isActive)?.ptyId || panes[0]?.ptyId
  }

  if (!ptyId) {
    return fail('没有可重连的窗格（pane_id 未提供且当前 tab 无窗格）')
  }

  const pane = panes.find(p => p.ptyId === ptyId)
  if (pane && pane.terminalType === 'local') {
    return fail(t('error.ssh_reconnect_failed') + '（本地终端不支持 ensure_connected；本期仅 SSH）')
  }
  if (pane?.connecting) {
    return ok(t('pane.ensure_already_connecting', { paneId: ptyId }))
  }

  const outcome = await ensurePaneConnected(ptyId, config, { skipIfConnected: true })
  return ensureConnectedToolResult(outcome)
}
