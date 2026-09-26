/**
 * 工具元数据消费层（formatter / lookup helpers）
 *
 * 这是 Agent 基类访问"具体工具差异"的**唯一通道**。任何想"按工具名做行为分支"
 * 的代码都应改为读 `ToolMeta` 字段（在工具自己的 `_meta` 上声明），通过本文件提供的
 * helper 完成查询/渲染，从而保持 Agent 抽象基类对具体工具完全无感。
 *
 * 对应 SPEC.md「工具元数据驱动模型」一节。
 *
 * 现有 helper：
 * - getStreamPlaceholder()                  "path 未到达时"的占位符文案
 * - buildStreamProgressSuffix(args, fs)     字符数尾缀
 * - formatStreamPreCardFromMeta(meta, args) 预卡片完整内容（前缀 + 尾缀），无 meta 时返回 null
 * - formatToolCallPrefixFromMeta(meta, args) 仅前缀，供执行器 addStep 使用
 * - buildPreToolCallDisplay(toolName, partialArgs, meta) 流式回调入口，含 partial JSON 解析与默认兜底
 * - getMetaByName(tools, name)              从工具列表里按名查 meta
 * - tryParsePartialJson(partial)            容错解析流式中尚未结束的 JSON 字符串
 * - isJsonStringFieldComplete(partial, key) 原始流里某个字符串字段的值是否已闭合
 */
import type { ToolDefinition } from '../ai.service'
import type { ToolDefinitionWithMeta, ToolMeta, ToolStreamDisplay } from './tools'
import { t, type TranslationKey } from './i18n'

/**
 * 流式预创建卡片中"path 还没流到"时的占位符。
 * path 到达后会被真实路径替换，用户先看到卡片出现、再看到路径填入。
 */
export function getStreamPlaceholder(): string {
  return t('agent.stream_pending_field')
}

/**
 * 计算指定字符串字段累计长度，构造实时进度尾缀，如 ` · 1234 字符`。
 *
 * 文件写入/编辑类工具的 path 是一次性短输出，主要内容藏在看不见的 content/markdown/
 * old_text 里。path 输出完后卡片主文本不再变化，用户会以为卡住；追加一个随 AI 流持续
 * 增长的字符数，让"还在工作"这件事可见。
 *
 * 统一使用字符数（不切换 KB）：数字位数多、每次更新跳动幅度大，能传达强烈的"在动"信号。
 * 不足 100 字符时返回空串，避免 path 刚流完就开始抖动。
 */
export function buildStreamProgressSuffix(parsed: Record<string, unknown>, fields: string[]): string {
  if (fields.length === 0) return ''
  let chars = 0
  for (const f of fields) {
    const v = parsed[f]
    if (typeof v === 'string') chars += v.length
  }
  if (chars < 100) return ''
  return ` · ${chars} ${t('file.chars')}`
}

/**
 * 解析 streamDisplay.titleKey（可能是 string 或 (args) => string）成最终 i18n 键。
 */
function resolveTitleKey(
  titleKey: NonNullable<ToolStreamDisplay['titleKey']>,
  args: Record<string, unknown>
): TranslationKey {
  // titleKey 由各工具声明，运行时就是翻译表里的键；动态函数返回的也是键名
  return (typeof titleKey === 'function' ? titleKey(args) : titleKey) as TranslationKey
}

/**
 * 仅渲染前缀（标题 + 副标题），不附加进度尾缀。
 *
 * 用途：执行器 addStep 的 content 第一段。执行器可在此前缀后追加运行时信息
 *（如 excel 的「（N 个 Sheet）」），但 prefix 部分必须经过本函数生成，
 * 才能保证和流式 pre-card 的对齐契约不漂移。
 *
 * customRender 优先于声明式 titleKey/titleField；customRender 返回 null 时
 * 整体也返回 null（args 还不足以构造，调用方保留上次缓存或走兜底）。
 *
 * 返回 null 表示该工具未声明 streamDisplay 或暂时构造不出来，
 * 调用方应自行决定 fallback 文案。
 */
export function formatToolCallPrefixFromMeta(
  meta: ToolMeta | undefined,
  args: Record<string, unknown>
): string | null {
  const display = meta?.streamDisplay
  if (!display) return null
  // 自定义渲染优先（complex 工具如 dispatch_agents 用得到）
  if (display.customRender) {
    return display.customRender(args)
  }
  if (!display.titleKey) return null
  const title = t(resolveTitleKey(display.titleKey, args))
  if (!display.titleField) return title
  const v = args[display.titleField]
  const subtitle = typeof v === 'string' ? v : getStreamPlaceholder()
  return `${title}: ${subtitle}`
}

/**
 * 完整预卡片内容（前缀 + 字符数尾缀）。
 *
 * 用途：流式 pre-card。返回 null 表示该工具未声明 streamDisplay 或暂时构造不出来，
 * 调用方应使用通用兜底（`调用: {toolName}`）。
 *
 * 字符数来源：progressFields 累计 +（如有）customProgress 累计；总和 ≥ 100 才追加尾缀。
 */
export function formatStreamPreCardFromMeta(
  meta: ToolMeta | undefined,
  args: Record<string, unknown>
): string | null {
  const prefix = formatToolCallPrefixFromMeta(meta, args)
  if (prefix === null) return null
  const display = meta?.streamDisplay
  let chars = 0
  if (display?.progressFields) {
    for (const f of display.progressFields) {
      const v = args[f]
      if (typeof v === 'string') chars += v.length
    }
  }
  if (display?.customProgress) {
    chars += display.customProgress(args)
  }
  const suffix = chars < 100 ? '' : ` · ${chars} ${t('file.chars')}`
  return prefix + suffix
}

/**
 * 在工具列表里按名查 ToolMeta。
 * 工具列表中既可能是 `ToolDefinition`，也可能是 `ToolDefinitionWithMeta`，
 * 本函数兼容处理；找不到（如 MCP / plugin 工具未声明 meta）返回 undefined。
 */
export function getMetaByName(
  tools: readonly ToolDefinition[] | undefined,
  toolName: string
): ToolMeta | undefined {
  if (!tools) return undefined
  for (const tool of tools) {
    if (tool.function.name === toolName) {
      return (tool as ToolDefinitionWithMeta)._meta
    }
  }
  return undefined
}

/**
 * 把流式到达的 partial tool_call arguments JSON 前缀容错地解析成对象。
 *
 * 实现思路：按结构（不做任何字段名匹配）扫描引号/括号，先把未闭合的字符串和容器
 * 补齐成合法 JSON，再 JSON.parse。任何异常或结构残缺都返回 null，调用方负责保留
 * 上一次成功结果，避免显示回退。
 */
export function tryParsePartialJson(partial: string): Record<string, unknown> | null {
  if (!partial) return null
  const trimmed = partial.trimStart()
  if (!trimmed.startsWith('{')) return null
  // 从完整 partial 开始，失败就从尾部剥一个字符再试。每次尝试都对当前的 core 独立
  // 扫描并按 LIFO 补闭合括号——嵌套 [{ 必须先补 } 再补 ]，这一点是原实现里
  // `while(bracket)` + `while(brace)` 线性补全处理不了的。
  // 剥到原串一半停止（保护性上限：partial chunk 通常很短，O(n²) 足够）
  const minCoreLen = Math.max(1, Math.floor(partial.length / 2))
  for (let coreLen = partial.length; coreLen >= minCoreLen; coreLen--) {
    const core = partial.slice(0, coreLen)
    const attempt = closePartial(core)
    if (attempt === null) continue
    try {
      const obj = JSON.parse(attempt) as unknown
      if (typeof obj === 'object' && obj !== null && !Array.isArray(obj)) {
        return obj as Record<string, unknown>
      }
    } catch {
      // 继续剥
    }
  }
  return null
}

/**
 * 扫描 core 中的未闭合字符串与括号，按 LIFO 补上闭合形成一段可能合法的 JSON；
 * core 本身若不以 `{` 开头则返回 null。
 */
function closePartial(core: string): string | null {
  if (!core || !core.trimStart().startsWith('{')) return null
  let inString = false
  let escape = false
  const stack: string[] = []
  for (let i = 0; i < core.length; i++) {
    const c = core[i]
    if (escape) { escape = false; continue }
    if (inString) {
      if (c === '\\') escape = true
      else if (c === '"') inString = false
      continue
    }
    if (c === '"') inString = true
    else if (c === '{') stack.push('}')
    else if (c === '[') stack.push(']')
    else if (c === '}' || c === ']') stack.pop()
  }
  let s = core
  if (inString) s += '"'
  while (stack.length > 0) s += stack.pop()
  return s
}

/**
 * 流式 JSON 里某个字符串字段的值是否已经闭合（原始串里已有结束引号）。
 *
 * tryParsePartialJson 会给未闭合字符串补引号，解析结果里的 path 看起来像完整路径，
 * 其实可能只是还在往外吐的前缀。早失败校验必须用本函数看原始流，不能看补全后的对象。
 */
export function isJsonStringFieldComplete(partial: string, field: string): boolean {
  if (!partial) return false

  let inString = false
  let escape = false
  let nextStringIsKey = true
  let readingKey = false
  let key = ''
  let currentKey: string | null = null

  for (let i = 0; i < partial.length; i++) {
    const c = partial[i]
    if (escape) {
      escape = false
      continue
    }

    if (inString) {
      if (c === '\\') {
        escape = true
        continue
      }
      if (c === '"') {
        inString = false
        if (readingKey) {
          currentKey = key
          readingKey = false
        } else if (currentKey === field) {
          return true
        }
        continue
      }
      if (readingKey) key += c
      continue
    }

    if (c === '"') {
      inString = true
      if (nextStringIsKey) {
        readingKey = true
        key = ''
        nextStringIsKey = false
      }
      continue
    }

    if (c === '{' || c === ',') {
      nextStringIsKey = true
      continue
    }
    if (c === ':') {
      nextStringIsKey = false
    }
  }

  return false
}

/**
 * 流式 tool_call 预创建卡片入口（透明原则的实现层）。
 *
 * 行为分四种情况：
 * 1. partial JSON 无法解析 → 返回 null（上层保留上次缓存）
 * 2. 工具声明了 streamDisplay 但当前 args 还构造不出来（如 dispatch_agents 的
 *    tasks 数组还没到，customRender 返回 null）→ 返回 null（上层保留上次缓存）
 * 3. 工具声明了 streamDisplay 且渲染成功 → 富信息渲染结果
 * 4. 工具未声明 streamDisplay → 通用兜底「调用: {toolName}」
 *    （透明原则的核心：所有工具默认都有预卡片）
 *
 * 关键区别：场景 2 vs 4——前者要保留上次"已经构造好的富信息"，避免从富信息
 * 退化到通用兜底；后者从一开始就是通用兜底，没有富信息可保留。
 *
 * @param toolName    AI 流式中的工具名
 * @param partialArgs 当前已到达的 args 字符串（可能不完整）
 * @param meta        来自 ToolDefinition._meta 的元数据，调用方负责按 toolName 查表
 */
export function buildPreToolCallDisplay(
  toolName: string,
  partialArgs: string,
  meta: ToolMeta | undefined
): string | null {
  const parsed = tryParsePartialJson(partialArgs)
  if (!parsed) return null
  // 工具声明了 streamDisplay：尝试富信息渲染
  if (meta?.streamDisplay) {
    return formatStreamPreCardFromMeta(meta, parsed)
  }
  // 未声明 streamDisplay 的工具走通用兜底（透明原则默认值）
  return `${t('status.calling')}: ${toolName}`
}
