/**
 * 工作台工具
 * - introspection（list_artifacts）：状态在渲染进程，经 workbench-bridge 查询
 * - 维护（manage_workbench_artifacts）：通过 canvasData step 推送 open/close，
 *   走与文件写入工具相同的链路，随历史持久化、重开会话可恢复
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { workbenchBridge } from '../../workbench-bridge.service'
import { getTerminalStateService } from '../../terminal-state.service'
import { previewArtifactFromFile } from '../../artifact-file-preview'
import type { CanvasData, CanvasRendererType } from '@shared/types'
import type { ToolExecutorConfig, ToolResult } from './types'

function ok(output: string, data?: unknown): ToolResult {
  return {
    success: true,
    output: data === undefined ? output : `${output}\n${JSON.stringify(data, null, 2)}`
  }
}

function fail(error: string): ToolResult {
  return { success: false, output: '', error }
}

function expandTilde(filePath: string): string {
  if (filePath === '~') return os.homedir()
  if (filePath.startsWith('~/') || filePath.startsWith('~\\')) {
    return path.join(os.homedir(), filePath.slice(2))
  }
  return filePath
}

function resolveLocalPath(rawPath: string, ptyId?: string): string {
  let p = expandTilde(rawPath.trim())
  if (!path.isAbsolute(p)) {
    const cwd = expandTilde(ptyId ? getTerminalStateService().getCwd(ptyId) : '~')
    p = path.resolve(cwd, p)
  }
  return p
}

/** 面板已经能预览的文件 → 渲染器（打开后 contentFromFile，恢复时按 filePath 重建） */
function rendererForExtension(filePath: string): CanvasRendererType | undefined {
  if (/\.(md|markdown)$/i.test(filePath)) return 'markdown'
  if (/\.html?$/i.test(filePath)) return 'html'
  if (/\.(docx|wps|wpt)$/i.test(filePath)) return 'document'
  if (/\.(xlsx|et)$/i.test(filePath)) return 'spreadsheet'
  return undefined
}

export async function listWorkbenchArtifactsTool(executor: ToolExecutorConfig): Promise<ToolResult> {
  const ownerAgentKey = executor.agentId
  if (!ownerAgentKey) {
    return fail('list_workbench_artifacts 需要桌面助手 Agent 上下文')
  }

  const result = await workbenchBridge.exec({ type: 'list_artifacts' }, ownerAgentKey)
  if (!result.ok) {
    return fail(result.error || '查询产出物面板失败')
  }

  const snapshot = result.data as { panelVisible?: boolean; artifacts?: unknown[] } | undefined
  const count = Array.isArray(snapshot?.artifacts) ? snapshot!.artifacts!.length : 0
  const visible = snapshot?.panelVisible === true
  const summary = visible
    ? `产出物面板已展开，共 ${count} 个文件类 artifact。`
    : count > 0
      ? `产出物面板当前未展开，但仍有 ${count} 个已注册 artifact。`
      : '产出物面板未展开，尚无文件类 artifact。'

  return ok(summary, result.data)
}

/**
 * 维护产出物面板：打开本地文件 / URL 实时预览 / 关闭已有产出物。
 * 通过 canvasData step 推送（与文件写入工具同链路），随历史持久化，重开会话可恢复。
 */
export async function manageWorkbenchArtifactsTool(
  executor: ToolExecutorConfig,
  args: Record<string, unknown>,
  ptyId?: string
): Promise<ToolResult> {
  const action = String(args.action || '').trim()
  const rawPath = typeof args.path === 'string' ? args.path : ''
  const rawUrl = typeof args.url === 'string' ? args.url.trim() : ''
  if (action !== 'open' && action !== 'close') {
    return fail(`不支持的 action：${action}（仅 open / close）`)
  }
  if (!rawPath && !rawUrl) return fail('缺少参数 path 或 url')

  // URL 型产出物（browser renderer）：live 预览本地 dev server 等
  if (rawUrl) {
    if (!/^https?:\/\//i.test(rawUrl)) {
      return fail(`url 仅支持 http/https：${rawUrl}`)
    }
    const canvasData: CanvasData = {
      action: action as 'open' | 'close',
      renderer: 'browser',
      url: rawUrl,
      title: typeof args.title === 'string' && args.title.trim() ? args.title.trim() : rawUrl
    }
    executor.addStep({
      type: 'tool_result',
      content: action === 'open'
        ? `已在产出物面板打开预览：${rawUrl}`
        : `已从产出物面板移除预览：${rawUrl}`,
      toolName: 'manage_workbench_artifacts',
      canvasData
    })
    return ok(action === 'open' ? `已在产出物面板打开 ${rawUrl}` : `已从产出物面板关闭 ${rawUrl}`)
  }

  const filePath = resolveLocalPath(rawPath, ptyId)

  if (action === 'close') {
    // 关闭按 filePath 匹配，renderer 仅为类型占位（推断不出时用 markdown 占位，不影响匹配）
    const canvasData: CanvasData = {
      action: 'close',
      renderer: rendererForExtension(filePath) ?? 'markdown',
      filePath
    }
    executor.addStep({
      type: 'tool_result',
      content: `已从产出物面板移除：${path.basename(filePath)}`,
      toolName: 'manage_workbench_artifacts',
      canvasData
    })
    return ok(`已从产出物面板关闭 ${filePath}`)
  }

  // action === 'open'
  const renderer = rendererForExtension(filePath)
  if (!renderer) {
    return fail(
      `不支持在面板内预览该类型文件（${path.basename(filePath)}）。` +
      `目前支持预览：Markdown、HTML、Word（.docx）、Excel（.xlsx）。` +
      `PPT / PDF / 图片等文件可让用户用系统程序打开，或通过 exec 调用命令行工具处理。`
    )
  }
  if (!fs.existsSync(filePath)) {
    return fail(`文件不存在：${filePath}（请传绝对路径，或先创建文件）`)
  }

  let content: string
  try {
    content = await previewArtifactFromFile(filePath, renderer)
  } catch (err) {
    return fail(`生成预览失败：${err instanceof Error ? err.message : String(err)}`)
  }

  const title = typeof args.title === 'string' && args.title.trim()
    ? args.title.trim()
    : path.basename(filePath)

  const canvasData: CanvasData = {
    action: 'open',
    renderer,
    title,
    content,
    filePath,
    // content 即磁盘文件内容：历史持久化时剥离，恢复时按 filePath 读回
    contentFromFile: true
  }
  executor.addStep({
    type: 'tool_result',
    content: `已在产出物面板打开：${title}`,
    toolName: 'manage_workbench_artifacts',
    canvasData
  })
  return ok(`已在产出物面板打开 ${filePath}`)
}
