/**
 * 无障碍树快照引擎
 * 
 * 基于 Playwright 的 locator.ariaSnapshot() 生成带 ref 编号的无障碍树。
 * AI 可以通过 ref（如 @e1, @e2）精确定位和操作页面元素，
 * 无需猜测 CSS 选择器。
 * 
 * 参考：agent-browser (vercel-labs/agent-browser) 的 snapshot 设计
 * 
 * 输出示例：
 * - heading "Example Domain" [ref=e1] [level=1]
 * - paragraph: Some text content
 * - button "Submit" [ref=e2]
 * - textbox "Email" [ref=e3]
 */

import type { Page } from 'playwright-core'

/** ref 映射：ref ID -> 定位信息 */
export interface RefMap {
  [ref: string]: {
    /** Playwright getByRole 选择器描述 */
    selector: string
    /** ARIA 角色 */
    role: string
    /** 可访问名称 */
    name?: string
    /** 当多个元素同角色同名称时的索引 */
    nth?: number
  }
}

/** 快照结果 */
export interface SnapshotResult {
  /** 格式化后的无障碍树文本 */
  tree: string
  /** ref 编号到元素定位的映射 */
  refs: RefMap
}

/** 快照选项 */
export interface SnapshotOptions {
  /** 只包含交互元素（button, link, textbox 等） */
  interactive?: boolean
  /** 最大树深度 */
  maxDepth?: number
  /** 移除无内容的结构元素 */
  compact?: boolean
  /** CSS 选择器限定范围 */
  selector?: string
}

// ref 计数器
let refCounter = 0

function resetRefs(): void {
  refCounter = 0
}

function nextRef(): string {
  return `e${++refCounter}`
}

/** 交互元素角色 - 应该获得 ref */
const INTERACTIVE_ROLES = new Set([
  'button',
  'link',
  'textbox',
  'checkbox',
  'radio',
  'combobox',
  'listbox',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'searchbox',
  'slider',
  'spinbutton',
  'switch',
  'tab',
  'treeitem',
])

/** 内容元素角色 - 有名称时获得 ref（用于文本提取） */
const CONTENT_ROLES = new Set([
  'heading',
  'cell',
  'gridcell',
  'columnheader',
  'rowheader',
  'listitem',
  'article',
  'region',
  'main',
  'navigation',
  'img',
])

/** 纯结构元素角色 - compact 模式下可过滤 */
const STRUCTURAL_ROLES = new Set([
  'generic',
  'group',
  'list',
  'table',
  'row',
  'rowgroup',
  'grid',
  'treegrid',
  'menu',
  'menubar',
  'toolbar',
  'tablist',
  'tree',
  'directory',
  'document',
  'application',
  'presentation',
  'none',
])

/**
 * 构建 Playwright getByRole 选择器描述
 */
function buildSelector(role: string, name?: string): string {
  if (name) {
    const escapedName = name.replace(/"/g, '\\"')
    return `getByRole('${role}', { name: "${escapedName}", exact: true })`
  }
  return `getByRole('${role}')`
}

/**
 * 获取行的缩进层级
 */
function getIndentLevel(line: string): number {
  const match = line.match(/^(\s*)/)
  return match ? Math.floor(match[1].length / 2) : 0
}

/** 角色+名称计数器，用于检测重复 */
interface RoleNameTracker {
  counts: Map<string, number>
  refsByKey: Map<string, string[]>
  getKey(role: string, name?: string): string
  getNextIndex(role: string, name?: string): number
  trackRef(role: string, name: string | undefined, ref: string): void
  getDuplicateKeys(): Set<string>
}

function createRoleNameTracker(): RoleNameTracker {
  const counts = new Map<string, number>()
  const refsByKey = new Map<string, string[]>()
  return {
    counts,
    refsByKey,
    getKey(role: string, name?: string): string {
      return `${role}:${name ?? ''}`
    },
    getNextIndex(role: string, name?: string): number {
      const key = this.getKey(role, name)
      const current = counts.get(key) ?? 0
      counts.set(key, current + 1)
      return current
    },
    trackRef(role: string, name: string | undefined, ref: string): void {
      const key = this.getKey(role, name)
      const refs = refsByKey.get(key) ?? []
      refs.push(ref)
      refsByKey.set(key, refs)
    },
    getDuplicateKeys(): Set<string> {
      const duplicates = new Set<string>()
      for (const [key, refs] of refsByKey) {
        if (refs.length > 1) {
          duplicates.add(key)
        }
      }
      return duplicates
    },
  }
}

/**
 * 移除非重复元素的 nth 索引（保持简洁）
 */
function removeNthFromNonDuplicates(refs: RefMap, tracker: RoleNameTracker): void {
  const duplicateKeys = tracker.getDuplicateKeys()
  for (const [_ref, data] of Object.entries(refs)) {
    const key = tracker.getKey(data.role, data.name)
    if (!duplicateKeys.has(key)) {
      delete refs[_ref].nth
    }
  }
}

/**
 * 获取页面的增强无障碍树快照
 */
export async function getSnapshot(
  page: Page,
  options: SnapshotOptions = {}
): Promise<SnapshotResult> {
  resetRefs()
  const refs: RefMap = {}

  // 使用 Playwright 的 ariaSnapshot API 获取无障碍树
  const locator = options.selector
    ? page.locator(options.selector)
    : page.locator(':root')

  let ariaTree: string
  try {
    ariaTree = await locator.ariaSnapshot({ timeout: 10000 })
  } catch (error) {
    return {
      tree: '(无法获取页面无障碍树)',
      refs: {},
    }
  }

  if (!ariaTree) {
    return {
      tree: '(空页面)',
      refs: {},
    }
  }

  // 解析并增强无障碍树
  const enhancedTree = processAriaTree(ariaTree, refs, options)

  return { tree: enhancedTree, refs }
}

/**
 * 处理 ARIA 无障碍树：添加 ref 编号并应用过滤
 */
function processAriaTree(
  ariaTree: string,
  refs: RefMap,
  options: SnapshotOptions
): string {
  const lines = ariaTree.split('\n')
  const result: string[] = []
  const tracker = createRoleNameTracker()

  // 交互元素模式：只保留可交互元素
  if (options.interactive) {
    for (const line of lines) {
      const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
      if (!match) continue

      const [, , role, name, suffix] = match
      const roleLower = role.toLowerCase()

      if (INTERACTIVE_ROLES.has(roleLower)) {
        const ref = nextRef()
        const nth = tracker.getNextIndex(roleLower, name)
        tracker.trackRef(roleLower, name, ref)
        refs[ref] = {
          selector: buildSelector(roleLower, name),
          role: roleLower,
          name,
          nth,
        }

        let enhanced = `- ${role}`
        if (name) enhanced += ` "${name}"`
        enhanced += ` [ref=${ref}]`
        if (nth > 0) enhanced += ` [nth=${nth}]`
        if (suffix && suffix.includes('[')) enhanced += suffix

        result.push(enhanced)
      }
    }

    removeNthFromNonDuplicates(refs, tracker)
    return result.join('\n') || '(无可交互元素)'
  }

  // 正常模式：保留所有元素，给交互和内容元素添加 ref
  for (const line of lines) {
    const processed = processLine(line, refs, options, tracker)
    if (processed !== null) {
      result.push(processed)
    }
  }

  removeNthFromNonDuplicates(refs, tracker)

  // compact 模式：移除空结构元素
  if (options.compact) {
    return compactTree(result.join('\n'))
  }

  return result.join('\n')
}

/**
 * 处理单行：添加 ref，根据选项过滤
 */
function processLine(
  line: string,
  refs: RefMap,
  options: SnapshotOptions,
  tracker: RoleNameTracker
): string | null {
  const depth = getIndentLevel(line)

  // 深度限制
  if (options.maxDepth !== undefined && depth > options.maxDepth) {
    return null
  }

  // 匹配 ARIA 行：- role "name" [attrs]
  const match = line.match(/^(\s*-\s*)(\w+)(?:\s+"([^"]*)")?(.*)$/)
  if (!match) {
    // 非元素行（文本内容等），interactive 模式下跳过
    return options.interactive ? null : line
  }

  const [, prefix, role, name, suffix] = match
  const roleLower = role.toLowerCase()

  const isInteractive = INTERACTIVE_ROLES.has(roleLower)
  const isContent = CONTENT_ROLES.has(roleLower)
  const isStructural = STRUCTURAL_ROLES.has(roleLower)

  // compact 模式：跳过无名的纯结构元素
  if (options.compact && isStructural && !name) {
    return null
  }

  // 交互元素或有名称的内容元素才加 ref
  const shouldHaveRef = isInteractive || (isContent && name)

  if (shouldHaveRef) {
    const ref = nextRef()
    const nth = tracker.getNextIndex(roleLower, name)
    tracker.trackRef(roleLower, name, ref)

    refs[ref] = {
      selector: buildSelector(roleLower, name),
      role: roleLower,
      name,
      nth,
    }

    let enhanced = `${prefix}${role}`
    if (name) enhanced += ` "${name}"`
    enhanced += ` [ref=${ref}]`
    if (nth > 0) enhanced += ` [nth=${nth}]`
    if (suffix) enhanced += suffix

    return enhanced
  }

  return line
}

/**
 * compact 模式：移除没有 ref 子元素的空结构分支
 */
function compactTree(tree: string): string {
  const lines = tree.split('\n')
  const result: string[] = []

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]

    // 有 ref 的行一定保留
    if (line.includes('[ref=')) {
      result.push(line)
      continue
    }

    // 有文本内容的行保留
    if (line.includes(':') && !line.endsWith(':')) {
      result.push(line)
      continue
    }

    // 检查是否有包含 ref 的子元素
    const currentIndent = getIndentLevel(line)
    let hasRelevantChildren = false

    for (let j = i + 1; j < lines.length; j++) {
      const childIndent = getIndentLevel(lines[j])
      if (childIndent <= currentIndent) break
      if (lines[j].includes('[ref=')) {
        hasRelevantChildren = true
        break
      }
    }

    if (hasRelevantChildren) {
      result.push(line)
    }
  }

  return result.join('\n')
}

/**
 * 解析 @ref 字符串，返回 ref ID
 * 支持格式：@e1, ref=e1, e1
 */
export function parseRef(input: string): string | null {
  if (input.startsWith('@')) {
    return input.slice(1)
  }
  if (input.startsWith('ref=')) {
    return input.slice(4)
  }
  if (/^e\d+$/.test(input)) {
    return input
  }
  return null
}

/**
 * 根据 ref 获取 Playwright Locator
 * 如果输入不是 ref 格式，返回 null（调用方应使用原始选择器）
 */
export function resolveRef(
  page: Page,
  selector: string,
  refs: RefMap
): ReturnType<Page['locator']> | null {
  const refId = parseRef(selector)
  if (!refId) return null

  const refData = refs[refId]
  if (!refData) return null

  // 使用 getByRole 构建精确 locator
  const options: { name?: string; exact?: boolean } = {}
  if (refData.name) {
    options.name = refData.name
    options.exact = true
  }

  let locator = page.getByRole(refData.role as any, options)

  // 如果有 nth 索引（重复元素），使用 nth 定位
  if (refData.nth !== undefined) {
    locator = locator.nth(refData.nth)
  }

  return locator
}

/**
 * 获取快照统计信息
 */
export function getSnapshotStats(
  tree: string,
  refs: RefMap
): {
  lines: number
  chars: number
  estimatedTokens: number
  totalRefs: number
  interactiveRefs: number
} {
  const interactiveRefs = Object.values(refs).filter(r =>
    INTERACTIVE_ROLES.has(r.role)
  ).length

  return {
    lines: tree.split('\n').length,
    chars: tree.length,
    estimatedTokens: Math.ceil(tree.length / 4),
    totalRefs: Object.keys(refs).length,
    interactiveRefs,
  }
}
