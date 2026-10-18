/**
 * L2 知识文档服务（Context Knowledge）
 *
 * 每个 contextId 对应一份结构化 Markdown 知识文档，
 * 自动注入 system prompt，单份长度可设。
 *
 * contextId 规则：
 *   - 本地终端: "local"
 *   - SSH 终端: "user@host"
 *   - 无终端模式: "personal"
 *
 * 更新：接在刚跑完的那场对话后面问（时机与请求由 Agent 侧负责），
 * 这里给出更新说明、把回复里的改动按段并回各份文档。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { getConfigService } from '../config.service'
import { createLogger } from '../../utils/logger'
import {
  DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS,
  clampContextKnowledgeMaxChars,
} from './context-knowledge-budget'
import { PERSONAL_MEMORY_STYLE } from './memory-style'
import { MEMORY_SECTION_DELETE_MARK, mergeMemoryPatch, parseMemoryBlocks } from './memory-patch'

const log = createLogger('ContextKnowledge')

export interface ContextKnowledgeOptions {
  /** 文档最大字符数（约等于 token 预算 × 2） */
  maxDocChars?: number
}

export {
  DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS,
  MIN_CONTEXT_KNOWLEDGE_MAX_CHARS,
  MAX_CONTEXT_KNOWLEDGE_MAX_CHARS,
  clampContextKnowledgeMaxChars,
} from './context-knowledge-budget'

const MAX_CONTEXT_ID_LENGTH = 128

export class ContextKnowledgeService {
  private storageDir: string
  private maxDocChars: number
  private cache: Map<string, string> = new Map()

  constructor(options?: ContextKnowledgeOptions) {
    this.storageDir = path.join(app.getPath('userData'), 'knowledge', 'context-docs')
    this.maxDocChars = clampContextKnowledgeMaxChars(
      options?.maxDocChars ?? DEFAULT_CONTEXT_KNOWLEDGE_MAX_CHARS
    )
    this.ensureDir()
    this.loadAll()
  }

  /**
   * 将 contextId 统一转换为安全的文件名/缓存 key
   */
  private normalizeId(contextId: string): string {
    const truncated = contextId.substring(0, MAX_CONTEXT_ID_LENGTH)
    return truncated.replace(/[^a-zA-Z0-9@._-]/g, '_')
  }

  private ensureDir(): void {
    if (!fs.existsSync(this.storageDir)) {
      fs.mkdirSync(this.storageDir, { recursive: true })
    }
  }

  private loadAll(): void {
    try {
      const files = fs.readdirSync(this.storageDir).filter(f => f.endsWith('.md'))
      for (const file of files) {
        const content = fs.readFileSync(path.join(this.storageDir, file), 'utf-8')
        const id = file.replace(/\.md$/, '')
        this.cache.set(id, content)
      }
    } catch (error) {
      log.warn('加载已有文档失败:', error)
    }
  }

  /**
   * 获取知识文档内容（用于注入 prompt）
   * 返回空字符串表示该 contextId 尚无知识文档
   */
  getDocument(contextId: string): string {
    return this.cache.get(this.normalizeId(contextId)) ?? ''
  }

  /** 磁盘上实际存着的内容；读不到返回 null（写盘失败时与内存里的不一致） */
  getPersistedDocument(contextId: string): string | null {
    try {
      return fs.readFileSync(path.join(this.storageDir, `${this.normalizeId(contextId)}.md`), 'utf-8')
    } catch {
      return null
    }
  }

  /**
   * 直接设置知识文档（用于用户手动编辑或初始化）
   */
  setDocument(contextId: string, content: string): void {
    const safeId = this.normalizeId(contextId)
    const truncated = content.length > this.maxDocChars
      ? content.substring(0, this.maxDocChars)
      : content
    this.cache.set(safeId, truncated)
    this.saveToDisk(safeId, truncated)
  }

  /**
   * 删除知识文档
   */
  deleteDocument(contextId: string): void {
    const safeId = this.normalizeId(contextId)
    this.cache.delete(safeId)
    const filePath = path.join(this.storageDir, `${safeId}.md`)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
    } catch (error) {
      log.warn('删除文档失败:', error)
    }
  }

  /**
   * 获取所有 contextId 列表
   */
  listContextIds(): string[] {
    return Array.from(this.cache.keys())
  }

  /** 单份 L2 知识文档最大字符数（与 setDocument / LLM 提示一致，供设置页展示） */
  getMaxDocChars(): number {
    return this.maxDocChars
  }

  /** 改上限只影响之后的更新和保存，不立刻裁已有文档 */
  setMaxDocChars(value: unknown): number {
    this.maxDocChars = clampContextKnowledgeMaxChars(value)
    return this.maxDocChars
  }

  /**
   * 接在一场对话后面发的记忆更新说明。
   *
   * @param contextIds 这次能写的几份（由调用方按规则定）
   * @param visibleText 那场对话开头已经带着的文字；某份的最新版本已原样在里面就不再附
   */
  buildRefreshInstruction(contextIds: readonly string[], visibleText: string): string {
    const max = this.maxDocChars
    const targetLines: string[] = []
    const attached: string[] = []
    for (const id of contextIds) {
      const doc = this.getDocument(id)
      const size = doc.trim() ? `当前 ${doc.length} 字` : '目前为空'
      targetLines.push(`- ${id}：${this.describeScope(id)}${size}，上限 ${max} 字。`)
      if (doc.trim() && !visibleText.includes(doc.trim())) {
        attached.push(`<current id="${id}">\n${doc.trim()}\n</current>`)
      }
    }

    const hasPersonal = contextIds.includes('personal')
    const hasHost = contextIds.some(id => id !== 'personal')
    const style = [
      hasPersonal
        ? PERSONAL_MEMORY_STYLE
        : '',
      hasHost ? '主机的记忆按主题分段，每段一个标题，段内用条目列事实。' : '',
    ].filter(Boolean).join('')

    return [
      '（这一步只更新记忆，不执行任何操作，也不回复用户。）',
      '每份记忆会整篇放进之后对话的开头，就像本场开头的「已知信息」。根据上面这场对话，更新下面这几份：',
      targetLines.join('\n'),
      attached.length > 0
        ? `下面这几份的最新内容不在本场开头（或开头那版之后又改过）：\n\n${attached.join('\n\n')}`
        : '',
      '值得记的，是之后的对话里会反复用到的事实。一次性的操作结果、临时状态（占用率、进程号之类）、命令输出原文、操作过程，放进去只会每次占着篇幅。已经记过的不必再写；和现有内容对不上的，以这场对话里新的说法为准，把旧的改掉。拿不准该归哪一份的，不写。',
      `写法：${style}`,
      `交法：只交改动了的段落，每份放在 <memory id="…"> 和 </memory> 之间，id 用上面列出的。每段以标题行开头：标题和现有某段一样，就整段替换那一段；不一样，就作为新的一段接在末尾；要删掉一段，写它的标题，下面只写「${MEMORY_SECTION_DELETE_MARK}」。没交的段落、没交的记忆都原样保留。改完超过上限的那一份不会保存。哪份都不用改时，只回复 NO_CHANGE。`,
    ].filter(Boolean).join('\n\n')
  }

  /**
   * 把模型回复里的改动并回各份记忆。
   * 只认给定的那几份；合并后超过上限、或改动无法落脚的那份不保存。
   * @returns 实际改动了的 contextId
   */
  applyRefreshResponse(response: string, contextIds: readonly string[]): string[] {
    const updated: string[] = []
    for (const [id, patch] of parseMemoryBlocks(response)) {
      if (!contextIds.includes(id)) {
        log.warn(`记忆更新交来了不在本次范围内的「${id}」，忽略`)
        continue
      }
      const current = this.getDocument(id)
      const merged = mergeMemoryPatch(current, patch)
      if (merged === null) {
        log.warn(`记忆「${id}」的改动没有段落标题，无法并入，忽略`)
        continue
      }
      if (merged.length > this.maxDocChars) {
        log.warn(`记忆「${id}」改完 ${merged.length} 字，超过上限 ${this.maxDocChars}，这次不保存`)
        continue
      }
      if (merged === current) continue
      this.setDocument(id, merged)
      updated.push(id)
    }
    return updated
  }

  // ==================== 内部方法 ====================

  private saveToDisk(safeId: string, content: string): void {
    try {
      const tempPath = path.join(this.storageDir, `${safeId}.md.tmp`)
      const finalPath = path.join(this.storageDir, `${safeId}.md`)
      fs.writeFileSync(tempPath, content, 'utf-8')
      fs.renameSync(tempPath, finalPath)
    } catch (error) {
      log.error('写入失败:', error)
    }
  }

  private describeScope(contextId: string): string {
    if (contextId === 'personal') {
      return '关于用户本人：身份与职责、长期在做的事、生活、偏好与约定，以及换哪台机器都成立的事实；某台机器上的配置不放这里。'
    }
    if (contextId === 'local') {
      return '本机这条连接：这台机器的配置、软件版本、关键路径、服务架构等，只放这台机器上的事实。'
    }
    return `远程连接 ${contextId}：这台机器的配置、软件版本、关键路径、服务架构等，只放这条连接上的事实；对话里转到别的机器上做的事不算这台的。`
  }
}

// ==================== 单例 ====================

let instance: ContextKnowledgeService | null = null

export function getContextKnowledgeService(): ContextKnowledgeService {
  if (!instance) {
    instance = new ContextKnowledgeService({
      maxDocChars: getConfigService().get('contextKnowledgeMaxChars')
    })
  }
  return instance
}
