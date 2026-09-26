/**
 * Agent 系统提示构建器
 *
 * 设计原则：
 * - 每个 section builder 返回自包含的 Markdown 块（或空字符串）
 * - 不带前导/尾部空行，空行由 build() 的 join('\n\n') 统一控制
 * - 条件判断在方法内部完成，不在模板字符串里做三元表达式
 */
import * as fs from 'fs'
import * as path from 'path'
import type { AgentContext, HostProfileServiceInterface, ExecutionMode, ProactiveCompactStyle } from './types'
import { normalizeProactiveCompact } from '@shared/types'
import type { AgentMbtiType } from '../config.service'
import { getUserSkillService } from '../user-skill.service'
import { getWorkspacePath, getScratchPath } from './tools/file'
import { createLogger } from '../../utils/logger'
import { buildBrowserBridgePromptSection } from '../browser-bridge/prompt-section'
import { getBrowserBridgeService } from '../browser-bridge/browser-bridge.service'
import { wrapCompositionSection } from './context-composition'
import { t } from './i18n'
import { MAX_WAIT_SECONDS } from './background-watch'

const log = createLogger('PromptBuilder')
const IDENTITY_FILENAME = 'IDENTITY.md'
const SOUL_FILENAME = 'SOUL.md'

/**
 * 全局语言规则常量。
 *
 * 在 PromptBuilder 内部和子 Agent system prompt 共用，确保 byte-exact 一致以最大化
 * prompt cache 命中。任何修改必须同步到所有 LLM 请求的最前面一行。
 */
export const LANGUAGE_RULE = '**CRITICAL RULE: You MUST respond in the SAME language the user uses**'

/**
 * 缓存分隔符：分隔系统提示词中的稳定内容和动态内容
 * - Anthropic 适配器按此标记拆分，对稳定部分启用 prompt caching
 * - DeepSeek/OpenAI 自动前缀缓存天然匹配到此标记之前的公共前缀
 */
export const CACHE_BREAK_MARKER = '<!-- CACHE_BREAK -->'

/** 系统提示中「这场对话开着的技能」章节标题 */
export const LOADED_SKILLS_ROSTER_HEADING = '# 这场对话开着的技能'
/** 系统提示中已加载技能文档章节标题 */
export const SKILLS_CONTENT_HEADING = '# 技能文档'

export interface LoadedSkillRosterItem {
  id: string
  name: string
}

function findMarkdownSectionBounds(content: string, heading: string): { start: number; end: number } | null {
  const start = content.indexOf(heading)
  if (start === -1) return null
  const rest = content.slice(start + heading.length)
  const nextMatch = rest.match(/\n\n# /)
  const end = nextMatch?.index !== undefined ? start + heading.length + nextMatch.index : content.length
  return { start, end }
}

function formatLoadedSkillLabel(skill: LoadedSkillRosterItem): string {
  return skill.name && skill.name !== skill.id ? `${skill.name}（${skill.id}）` : skill.id
}

export function buildLoadedSkillsRosterSection(skills: LoadedSkillRosterItem[]): string {
  const lines = [LOADED_SKILLS_ROSTER_HEADING, '']
  if (skills.length === 0) {
    lines.push('当前没有开着的技能。只认这一节，不要凭对话里有没有 load 过来猜。')
    return lines.join('\n')
  }
  lines.push('当前开着：')
  for (const skill of skills) {
    lines.push(`- ${formatLoadedSkillLabel(skill)}`)
  }
  lines.push('')
  lines.push('这是这场对话现在开着的全部技能（含用户点上的和重开带回来的）。不要只凭自己有没有 load 过判断。')
  return lines.join('\n')
}

/** 跟这一句一起发出的「现在开着」短注，避免模型拿上一轮回答当真相 */
export function buildLoadedSkillsThisTurnHint(skills: LoadedSkillRosterItem[]): string {
  const current = skills.length > 0
    ? skills.map(formatLoadedSkillLabel).join('、')
    : '无'
  return `这场对话当前开着的技能：${current}。以这一行为准，不要用上一轮的回答。`
}

export function buildSkillsContentSectionText(content?: string): string {
  const trimmed = content?.trim()
  if (!trimmed) return ''
  return `${SKILLS_CONTENT_HEADING}\n\n${trimmed}`
}

/**
 * 在已有 system prompt 中替换/插入「开着的技能」清单和技能文档。
 * 用于 prompt cache 复用时刷新，而不重建整段 system prompt。
 */
export function patchLoadedSkillsSectionsInSystemPrompt(
  systemPrompt: string,
  rosterSection: string,
  skillsContentSection: string,
): string {
  let next = systemPrompt
  const rosterBounds = findMarkdownSectionBounds(next, LOADED_SKILLS_ROSTER_HEADING)
  if (rosterBounds) {
    next = next.slice(0, rosterBounds.start) + rosterSection + next.slice(rosterBounds.end)
  } else {
    const skillsBounds = findMarkdownSectionBounds(next, SKILLS_CONTENT_HEADING)
    if (skillsBounds) {
      next = next.slice(0, skillsBounds.start) + rosterSection + '\n\n' + next.slice(skillsBounds.start)
    } else {
      next = `${next}\n\n${rosterSection}`
    }
  }

  const contentBounds = findMarkdownSectionBounds(next, SKILLS_CONTENT_HEADING)
  if (contentBounds) {
    if (!skillsContentSection) {
      let start = contentBounds.start
      if (start >= 2 && next.slice(start - 2, start) === '\n\n') start -= 2
      next = next.slice(0, start) + next.slice(contentBounds.end)
    } else {
      next = next.slice(0, contentBounds.start) + skillsContentSection + next.slice(contentBounds.end)
    }
  } else if (skillsContentSection) {
    const rosterAfter = findMarkdownSectionBounds(next, LOADED_SKILLS_ROSTER_HEADING)
    if (rosterAfter) {
      next = next.slice(0, rosterAfter.end) + '\n\n' + skillsContentSection + next.slice(rosterAfter.end)
    } else {
      next = `${next}\n\n${skillsContentSection}`
    }
  }
  return next
}
const HEARTBEAT_FILENAME = 'HEARTBEAT.md'

/** 进程启动时刻（进程内稳定，适合放在 system prompt Tier 1 前缀） */
const PROCESS_START_MS = Date.now() - Math.floor(process.uptime() * 1000)

/** 与 Agent.formatTimestamp 同形，不含方括号：2026-07-15 16:09 周三 */
function formatLocalDateTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())} ${weekdays[d.getDay()]}`
}

function readWorkspaceFile(filename: string): string {
  try {
    const filePath = path.join(getWorkspacePath(), filename)
    return fs.readFileSync(filePath, 'utf-8').trim()
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      log.warn(`Failed to read ${filename}:`, err)
    }
    return ''
  }
}

/**
 * 从 agent-workspace/IDENTITY.md 读取 Agent 身份描述
 */
export function readIdentityFile(): string {
  return readWorkspaceFile(IDENTITY_FILENAME)
}

/**
 * 从 agent-workspace/SOUL.md 读取 Agent 行为灵魂
 */
export function readSoulFile(): string {
  return readWorkspaceFile(SOUL_FILENAME)
}

/**
 * 从 agent-workspace/USER.md 读取用户画像
 */
export function readUserFile(): string {
  return readWorkspaceFile('USER.md')
}

/**
 * 从 agent-workspace/HEARTBEAT.md 读取自定义心跳唤醒指令
 */
export function readHeartbeatFile(): string {
  return readWorkspaceFile(HEARTBEAT_FILENAME)
}

/**
 * MBTI 风格描述映射
 */
const MBTI_STYLE_MAP: Record<Exclude<AgentMbtiType, null>, { name: string; style: string }> = {
  // 分析师型 (NT)
  INTJ: {
    name: '策略家',
    style: '你是一个策略分析型助手。回复风格特点：逻辑严谨、直接高效、注重长远规划。喜欢用结构化的方式解释问题，会主动指出潜在风险和优化空间。语气专业但不啰嗦。'
  },
  INTP: {
    name: '逻辑学家',
    style: '你是一个逻辑分析型助手。回复风格特点：追求精确、善于深度分析、喜欢探索原理。会详细解释技术原理和底层逻辑，对细节一丝不苟。语气客观理性，偶尔会分享有趣的技术知识。'
  },
  ENTJ: {
    name: '指挥官',
    style: '你是一个高效指挥型助手。回复风格特点：果断自信、目标导向、高效务实。善于快速制定执行计划，推动任务高效完成。语气坚定有力，喜欢用清晰的步骤和明确的指令。'
  },
  ENTP: {
    name: '辩论家',
    style: '你是一个创新探索型助手。回复风格特点：思维活跃、善于创新、喜欢挑战常规。经常提出多种解决方案，乐于探讨不同的可能性。语气轻松有趣，会用巧妙的比喻解释复杂概念。'
  },

  // 外交官型 (NF)
  INFJ: {
    name: '提倡者',
    style: '你是一个洞察引导型助手。回复风格特点：深思熟虑、富有洞察力、注重意义。善于理解用户的真实需求，给出周全的建议。语气温和但有深度，会关注任务的长远影响。'
  },
  INFP: {
    name: '调停者',
    style: '你是一个理想主义型助手。回复风格特点：富有同理心、追求完美、注重价值。会耐心倾听需求，给出贴心的解决方案。语气温暖真诚，偶尔会用诗意的方式描述技术之美。'
  },
  ENFJ: {
    name: '主人公',
    style: '你是一个热情鼓励型助手。回复风格特点：热情洋溢、善于激励、关注成长。会积极鼓励用户，帮助他们学习和进步。语气热情亲切，喜欢用"我们"来增强协作感。'
  },
  ENFP: {
    name: '竞选者',
    style: '你是一个热情创意型助手。回复风格特点：积极乐观、富有创意、鼓励探索。善于发现有趣的角度，让技术任务变得有趣。语气活泼开朗，会用生动的例子和类比来解释概念。'
  },

  // 哨兵型 (SJ)
  ISTJ: {
    name: '物流师',
    style: '你是一个可靠执行型助手。回复风格特点：条理清晰、注重细节、稳健务实。严格按照最佳实践执行任务，注重可靠性和稳定性。语气沉稳专业，喜欢用编号列表和清晰的步骤。'
  },
  ISFJ: {
    name: '守卫者',
    style: '你是一个细心守护型助手。回复风格特点：细心周到、耐心负责、注重安全。会仔细检查每个操作的安全性，提供详尽的说明。语气温和耐心，会贴心地提醒注意事项。'
  },
  ESTJ: {
    name: '总经理',
    style: '你是一个高效管理型助手。回复风格特点：组织有序、执行力强、注重效率。善于制定清晰的执行计划，确保任务按时完成。语气干脆直接，喜欢用明确的行动项和截止时间。'
  },
  ESFJ: {
    name: '执政官',
    style: '你是一个友善协作型助手。回复风格特点：友善热心、善于协调、注重和谐。会主动询问需求，确保解决方案符合期望。语气亲切友好，善于营造良好的协作氛围。'
  },

  // 探险家型 (SP)
  ISTP: {
    name: '鉴赏家',
    style: '你是一个实干技术型助手。回复风格特点：冷静务实、动手能力强、追求效率。喜欢直接上手解决问题，用最简洁的方式达成目标。语气简洁有力，不说废话，专注于实际操作。'
  },
  ISFP: {
    name: '探险家',
    style: '你是一个灵活艺术型助手。回复风格特点：灵活变通、追求美感、注重体验。善于找到优雅的解决方案，让代码既实用又美观。语气轻松自然，偶尔会欣赏代码的优雅之处。'
  },
  ESTP: {
    name: '企业家',
    style: '你是一个敏捷行动型助手。回复风格特点：反应敏捷、敢于冒险、追求刺激。喜欢快速尝试，从实践中学习和调整。语气充满活力，善于在紧急情况下保持冷静并快速决策。'
  },
  ESFP: {
    name: '表演者',
    style: '你是一个活力四射型助手。回复风格特点：乐观开朗、善于表达、享受过程。让技术工作变得有趣，善于用轻松的方式解决问题。语气幽默风趣，偶尔会开个技术玩笑活跃气氛。'
  }
}

/**
 * 构建系统提示的选项
 */
export interface BuildSystemPromptOptions {
  context: AgentContext
  hostProfileService?: HostProfileServiceInterface
  mbtiType?: AgentMbtiType
  knowledgeContext?: string
  knowledgeEnabled?: boolean
  /** 从历史对话中语义检索的相关对话 */
  conversationHistory?: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>
  /** L2 知识文档（结构化 Markdown，整份注入） */
  contextKnowledgeDoc?: string
  /** 用户自定义的 AI 规则 */
  aiRules?: string
  /** AI 名字（用户自定义，默认旗鱼） */
  agentName?: string
  /** 任务历史总结列表（L1 层） */
  taskSummaries?: string
  /** 语义预加载的相关任务摘要（L2 层） */
  relatedTaskDigests?: string
  /** 所有可用任务的ID列表（用于 recall 工具） */
  availableTaskIds?: Array<{ id: string; summary: string }>
  /** 执行模式 */
  executionMode?: ExecutionMode
  /** 当前已设置的关切列表摘要（注入提示词，供 Agent 知晓避免重复创建） */
  watchListSummary?: string
  /** 羁绊上下文（注入提示词，影响对话语气） */
  bondContext?: string
  /** 是否为诞生引导对话（首次使用） */
  isOnboarding?: boolean
  /** 已加载技能的文档内容（Markdown，技能加载时自动注入） */
  skillsContent?: string
  /** 这场对话当前开着的技能（用户点上的、重开带回来的、自己 load 的） */
  loadedSkillsRoster?: LoadedSkillRosterItem[]
  /** MCP 连接器目录（仅渐进披露 defer 模式提供，注入「可用的 MCP 连接器」一节） */
  mcpServerCatalog?: string
  /** 它有多主动地把已经用不上的过程先交接掉 */
  proactiveCompact?: ProactiveCompactStyle
}

/**
 * 系统提示构建器
 *
 * 将系统提示的构建逻辑封装为类，提高可维护性和可测试性。
 * build() 采用 section 数组模式：每个 section builder 返回自包含的
 * Markdown 块或空字符串，由 filter(Boolean).join('\\n\\n') 统一拼接，
 * 确保输出符合标准 Markdown 格式。
 */
export class PromptBuilder {
  private readonly context: AgentContext
  private readonly hostProfileService?: HostProfileServiceInterface
  private readonly mbtiType?: AgentMbtiType
  private readonly knowledgeContext?: string
  private readonly knowledgeEnabled?: boolean
  private readonly conversationHistory?: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>
  private readonly contextKnowledgeDoc?: string
  private readonly aiRules?: string
  private readonly agentName?: string
  private readonly taskSummaries?: string
  private readonly relatedTaskDigests?: string
  private readonly availableTaskIds?: Array<{ id: string; summary: string }>
  private readonly executionMode?: ExecutionMode
  private readonly watchListSummary?: string
  private readonly bondContext?: string
  private readonly isOnboarding: boolean
  private readonly skillsContent?: string
  private readonly loadedSkillsRoster: LoadedSkillRosterItem[]
  private readonly mcpServerCatalog?: string
  private readonly proactiveCompact: ProactiveCompactStyle

  private osType = ''
  private shellType = ''
  private isSshTerminal = false
  private isAssistant = false
  private writeFileTool = ''

  constructor(options: BuildSystemPromptOptions) {
    this.context = options.context
    this.hostProfileService = options.hostProfileService
    this.mbtiType = options.mbtiType
    this.knowledgeContext = options.knowledgeContext
    this.knowledgeEnabled = options.knowledgeEnabled
    this.conversationHistory = options.conversationHistory
    this.contextKnowledgeDoc = options.contextKnowledgeDoc
    this.aiRules = options.aiRules
    this.agentName = options.agentName
    this.taskSummaries = options.taskSummaries
    this.relatedTaskDigests = options.relatedTaskDigests
    this.availableTaskIds = options.availableTaskIds
    this.executionMode = options.executionMode
    this.watchListSummary = options.watchListSummary
    this.bondContext = options.bondContext
    this.isOnboarding = options.isOnboarding ?? false
    this.skillsContent = options.skillsContent
    this.loadedSkillsRoster = options.loadedSkillsRoster ?? []
    this.mcpServerCatalog = options.mcpServerCatalog
    this.proactiveCompact = normalizeProactiveCompact(options.proactiveCompact)
  }

  // ==================== 公开方法 ====================

  /**
   * 构建完整的系统提示
   *
   * 每个 section builder 返回自包含的 Markdown 块或空字符串，
   * 空字符串会被 filter(Boolean) 移除，各 section 之间由 join('\n\n') 统一分隔。
   */
  build(): string {
    this.computeDerivedState()

    // [缓存优化] sections 按缓存友好度分三层排列，最大化前缀缓存共享：
    //   Tier 1 — 全局稳定：所有终端/Agent 共享（身份、规则、技能列表）
    //   Tier 2 — 终端级：同一终端内稳定（主机环境、CWD、IM 通道）
    //   Tier 3 — 任务级：同一任务 ReAct 循环内稳定（知识、历史、Watch）
    // 同 API Key 下多个 Agent 并发时，Tier 1 的公共前缀可被所有请求共享缓存。
    //
    // 各段用 <!--sf-ctx:id--> 归因标记包裹（同 id 可多次出现），供上下文组成占比测量；发 API 前 strip。
    // 顺序必须与原先一致，避免破坏前缀缓存。

    const w = wrapCompositionSection

    // ── Tier 1: 全局稳定 ──
    const sections = [
      w('identity', this.buildLanguageRule()),
      w('identity', this.buildIdentitySection()),
      w('identity', this.buildUserProfileSection()),
    ]

    if (this.isOnboarding) {
      sections.push(w('identity', this.buildOnboardingSection()))
    } else {
      sections.push(w('identity', this.buildSoulSection()))
      sections.push(w('identity', this.buildBondSection()))
    }

    sections.push(
      w('rules', this.buildUserRulesSection()),
      w('identity', this.buildWorkspaceRule()),
      w('identity', this.buildCoreRules()),
      w('skills', getUserSkillService().buildSkillsSummary()),

      // ── Tier 2: 终端/主机级 ──
      w('environment', this.buildHostEnvironment()),
      w('environment', this.buildBrowserBridgeSection()),
      w('environment', this.buildMcpServersSection()),
      w('environment', this.buildWorkbenchPromptSection()),
      w('environment', this.buildSplitPanesSection()),
      w('environment', this.buildRemoteChannelContext()),
      w('environment', this.buildUnattendedSection()),

      // ── Tier 3: 任务级 ──
      w('knowledge', this.buildKnowledgeDocSection()),
      w('knowledge', this.buildConversationHistorySection()),
      w('environment', this.buildWatchListSection()),
      w('skills', this.buildLoadedSkillsRosterBlock()),
      w('skills', this.buildSkillsContentSection()),
      w('knowledge', this.buildKnowledgeContext()),
      w('knowledge', this.buildTaskMemorySection()),
      // [缓存优化] 动态内容（当前时间、token 用量）已禁用。
      // AI 需要时间时可通过执行 date 命令获取；上下文压力由 85% 警告消息兜底。
      // 如需恢复：取消注释下面两行，并取消 agent.ts updateContextPressure 中的系统提示词注入。
      // CACHE_BREAK_MARKER,
      // this.buildDynamicContext(),
    )

    return sections.filter(Boolean).join('\n\n')
  }

  // ==================== 静态方法（便捷访问） ====================

  /**
   * 格式化时间距离
   */
  static formatTimeAgo(timestamp: number): string {
    const now = Date.now()
    const ageMs = now - timestamp
    const ageHours = ageMs / (1000 * 60 * 60)
    const ageDays = ageHours / 24

    if (ageHours < 1) return '刚刚'
    if (ageHours < 24) return `${Math.floor(ageHours)}小时前`
    if (ageDays < 30) return `${Math.floor(ageDays)}天前`
    return `${Math.floor(ageDays / 30)}个月前`
  }

  /**
   * 获取 MBTI 风格提示
   */
  static getMbtiStylePrompt(mbti: AgentMbtiType): string {
    if (!mbti || !MBTI_STYLE_MAP[mbti]) {
      return ''
    }
    return MBTI_STYLE_MAP[mbti].style
  }

  /**
   * 获取所有 MBTI 类型信息（供前端使用）
   */
  static getAllMbtiTypes(): Array<{ type: string; name: string; style: string }> {
    return Object.entries(MBTI_STYLE_MAP).map(([type, info]) => ({
      type,
      name: info.name,
      style: info.style
    }))
  }

  // ==================== 私有方法：派生状态 ====================

  private computeDerivedState(): void {
    this.osType = this.context.systemInfo.os || 'unknown'
    this.shellType = this.context.systemInfo.shell || 'unknown'
    const terminalType = this.context.terminalType || 'local'
    this.isSshTerminal = terminalType === 'ssh'
    this.isAssistant = terminalType !== 'local' && terminalType !== 'ssh'
    this.writeFileTool = this.isSshTerminal ? 'write_remote_text_file' : 'write_text_file'
  }

  // ==================== 私有方法：顶层 Section ====================

  private buildLanguageRule(): string {
    return LANGUAGE_RULE
  }

  private buildIdentitySection(): string {
    const displayName = this.agentName?.trim() || '旗鱼（SailFish）AI Agent'
    const identity = readIdentityFile()
    const lines = [
      `你是${displayName}，一个能帮助用户完成各类任务的智能助手。`,
      `软件启动时间：${formatLocalDateTime(PROCESS_START_MS)}`,
      '每条用户消息开头的 [时间] 标记由系统自动注入，表示该消息的发送时间。',
    ]
    if (identity) {
      lines.push('', identity)
    }
    return lines.join('\n')
  }

  /**
   * 动态上下文（放在系统提示词末尾，避免破坏前缀缓存）
   *
   * DeepSeek/OpenAI 的自动前缀缓存按 token 序列匹配公共前缀，
   * 任何动态内容（如当前时间）如果出现在前面，会导致后续所有
   * 稳定内容的缓存全部失效。将动态内容集中到末尾可最大化缓存命中。
   */
  private buildDynamicContext(): string {
    const now = new Date()
    const currentTime = now.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      weekday: 'long',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    })
    return `当前时间：${currentTime}`
  }

  private buildSoulSection(): string {
    const mbtiStyle = PromptBuilder.getMbtiStylePrompt(this.mbtiType ?? null)
    const soul = readSoulFile()

    if (soul && mbtiStyle) {
      return `# 你的灵魂（重要！）\n\n${soul}\n\n## 风格参考（MBTI）\n\n${mbtiStyle}`
    }
    if (soul) {
      return `# 你的灵魂（重要！）\n\n${soul}`
    }
    if (mbtiStyle) {
      return `# 你的风格（重要！）\n\n${mbtiStyle}`
    }
    return ''
  }

  private buildOnboardingSection(): string {
    return t('onboarding.system_prompt')
  }

  private buildUserProfileSection(): string {
    const user = readUserFile()
    if (!user) return ''
    return `# 关于用户\n\n${user}`
  }

  private buildBondSection(): string {
    const bond = this.bondContext?.trim()
    if (!bond) return ''
    return `# 你与用户的羁绊\n\n${bond}`
  }

  private buildUserRulesSection(): string {
    const rules = this.aiRules?.trim()
    if (!rules) return ''
    return `# 用户自定义规则（必须遵守）\n\n${rules}`
  }

  private buildHostEnvironment(): string {
    return PromptBuilder.buildHostEnvironment(this.context, this.hostProfileService)
  }

  /** 工作台 UI 描述：仅透传 context.workbenchPrompt，不做 terminalType 推断 */
  private buildWorkbenchPromptSection(): string {
    return this.context.workbenchPrompt?.trim() ?? ''
  }

  /**
   * 构建主机环境章节（公开静态方法，供子 Agent 等其它 prompt 复用）。
   *
   * 输出根据 terminalType 切换格式：
   * - assistant 模式：精简列表，标题 `# 运行环境`
   * - local / ssh 模式：含终端类型与"命令必须匹配"提醒，标题 `# 主机环境（命令必须匹配）`
   *
   * 同一个父 Agent 内调用此方法的输出 byte-exact 一致——这是子 Agent system prompt
   * 复用前缀缓存的关键。修改本方法时务必保持纯函数特性（仅依赖 context 与 profile）。
   */
  static buildHostEnvironment(
    context: AgentContext,
    hostProfileService?: HostProfileServiceInterface
  ): string {
    const osType = context.systemInfo.os || 'unknown'
    const terminalType = context.terminalType || 'local'
    const isSshTerminal = terminalType === 'ssh'
    const isAssistant = terminalType !== 'local' && terminalType !== 'ssh'

    const hostId = context.hostId || 'local'
    const profile = hostProfileService ? hostProfileService.getProfile(hostId) : null

    // 终端 tab：优先用本次 context.systemInfo（来自 PTY 实际 spawn）；
    // 空 / unknown 时兜底 host profile（助手模式、旧 tab、探测已完成）。
    const fromContext = (context.systemInfo.shell || '').trim()
    const shellType =
      fromContext && fromContext !== 'unknown'
        ? fromContext
        : (profile?.shell || fromContext || 'unknown')

    const cwdLine = context.cwd
      ? isAssistant
        ? `命令默认执行目录：${context.cwd}`
        : `当前工作目录：${context.cwd}（系统实时获取，无需执行 pwd 验证）`
      : '当前工作目录：未成功获取'

    if (isAssistant) {
      const lines: string[] = [
        `- 操作系统: ${osType}`,
        `- Shell: ${shellType}`,
      ]
      if (profile?.username) lines.push(`- 当前用户: ${profile.username}`)
      if (profile?.homeDir) lines.push(`- 用户主目录: ${profile.homeDir}`)
      lines.push(`- ${cwdLine}`)
      return `# 运行环境\n\n${lines.join('\n')}`
    }

    const lines: string[] = [
      `- **终端类型**: ${isSshTerminal ? '🌐 SSH 远程终端' : '💻 本地终端'}`
    ]

    if (profile?.hostname) {
      lines.push(`- 主机名: ${profile.hostname}`)
    }
    if (profile?.username) {
      lines.push(`- 当前用户: ${profile.username}`)
    }

    lines.push(`- 操作系统: ${osType}`)
    lines.push(`- Shell: ${shellType}`)

    if (profile?.homeDir) {
      lines.push(`- 用户主目录: ${profile.homeDir}`)
    }
    if (profile?.installedTools && profile.installedTools.length > 0) {
      lines.push(`- 已安装工具: ${profile.installedTools.join(', ')}`)
    }
    lines.push(`- ${cwdLine}`)

    return `# 主机环境（命令必须匹配）\n\n${lines.join('\n')}`
  }

  /**
   * 构建子 Agent 的 system prompt（独立模式）。
   *
   * 设计目标：
   * - 子 Agent 与父 Agent 完全独立——不继承身份、人格、对话历史，避免幻觉
   * - 但**继承项目级稳定信息**：语言规则、运行环境、用户自定义 AI Rules
   * - byte-exact 一致：同一父 Agent 内所有子 Agent 的 system prompt 完全一致，命中 prompt cache
   *
   * 不在系统提示里点名"哪些工具不能调用"——schema 不暴露的工具 LLM 一般不会主动捏造，
   * 反复点名反而是诱导。
   */
  static buildSubAgentSystemPrompt(options: {
    typePromptPrefix?: string
    context: AgentContext
    aiRules?: string
    hostProfileService?: HostProfileServiceInterface
  }): string {
    const { context, aiRules, hostProfileService } = options
    const sections: string[] = [
      LANGUAGE_RULE,
      PromptBuilder.buildHostEnvironment(context, hostProfileService),
    ]

    const trimmedRules = aiRules?.trim()
    if (trimmedRules) {
      sections.push(`# 用户自定义规则（必须遵守）\n\n${trimmedRules}`)
    }

    sections.push('你是这场任务里的同事，负责把交代的事做完，向主人汇报。')
    const scratch = getScratchPath()
    sections.push([
      '## 工作契约',
      '- **数据真实性**：通过工具获取真实数据，禁止编造或推测工具结果',
      '- **失败如实上报**：任何工具返回 `Error:` 都要原样写进最终汇报；不允许私自换命令、改路径或绕路径"补救"完成同一目标——失败信息本身就是主人需要的关键信号',
      '- **结论结构化**：最终汇报需明确区分「做到了什么 / 没做到什么 / 为什么没做到」，简洁、按要点列出',
      '- **硬墙**：删除或覆写根目录与引导分区、格式化根目录或引导分区或 Windows 系统盘、改动凭据等会直接导致严重破坏的命令，在任何模式下都会被系统直接拒绝执行，并且不会向用户确认（不排除存在误报可能）。',
      `- **写删免确认**：只认绝对路径，且目标落在 \`${scratch}\` 或系统临时目录。相对路径、先 cd 再删、桌面等正式目录的删除一律当高危并被拦住，不会弹确认。被拦了如实上报。`,
      '- **只做自己的活**：只做交代给你的那一件，做完就汇报。不要接手整场，不要清别人的文件。',
      '- **做完清理现场**：除了要交付的产出物之外，任务过程中创建的所有临时文件，使用完毕后及时清除。',
    ].join('\n'))

    return sections.filter(Boolean).join('\n\n')
  }

  /**
   * 分屏多屏感知 section
   * 当 tab 处于分屏模式时，列出所有窗格的方位、当前连的机器、ptyId、激活状态、终端类型
   * 与最近输出末尾，让 AI 明确"看到"多个并存的终端，并能用 ptyId 精确定位调用 terminal 工具。
   *
   * 方位与机器身份必须同时出现：用户按方位说话（"右边那台"），按机器指认（"10.0.2.100"），
   * 缺一边就会对不上号（历史上只有方位时，模型会误答"我看不到右边的画面"）。
   */
  private buildSplitPanesSection(): string {
    const panes = this.context.panes
    if (!panes || panes.length === 0) return ''

    const lines: string[] = []
    lines.push(panes.length > 1 ? '# 多屏布局（分屏模式）' : '# 当前终端')
    lines.push('')
    lines.push(`当前 tab 包含 ${panes.length} 个并存的终端窗格。`
      + '终端类工具（execute_command / send_input / send_control_key / check_terminal_status / get_terminal_context）'
      + '默认在你启动时绑定的窗格执行；要在其他窗格执行，请在工具参数里传 `pane_id`，值为目标窗格的 ptyId（见下方列表）。')
    lines.push('')

    panes.forEach(pane => {
      const activeMark = pane.isActive ? '🟢 激活' : '⚪ 未激活'
      const typeMark = pane.terminalType === 'ssh' ? '🌐 SSH' : '💻 本地'
      const connection = pane.connectionName ? ` → ${pane.connectionName}` : ''
      lines.push(`- **${pane.label}**${connection}（pane_id 取值=\`${pane.ptyId}\`）: ${activeMark}, ${typeMark}`)
      const tail = (pane.terminalOutput || []).slice(-5).map(l => l.trim()).filter(Boolean)
      if (tail.length > 0) {
        lines.push('  最近输出：')
        tail.forEach(l => lines.push(`  > ${l}`))
      }
    })

    if (panes.some(p => p.connectionName)) {
      lines.push('')
      lines.push('每扇窗后面那个名字就是它**此刻连着的机器**（远程为会话名/登录地址，本机为本地终端），'
        + '与用户屏幕上该窗格顶部显示的标签一致。用户用方位（"左边/右边那台"）或机器名/IP 指代窗格时，'
        + '按上面的对应关系认出是哪扇窗，直接在那扇窗里执行——**不要**回答看不到画面，也不要另开连接或反问登录方式。')
      lines.push('该名字随重连/换会话实时变化；用户在窗里手动跳板到更深一层的机器你看不到，必要时在该窗内自行确认当前主机。')
    }

    if (this.context.activePaneId) {
      lines.push('')
      lines.push('注意："激活"标记仅表示前端 UI 焦点，跟命令默认执行的窗格无关。命令默认仍发到 Agent 启动时绑定的窗格——切换执行目标请显式传 `pane_id`。')
    }

    lines.push('')
    lines.push('**异构分屏**：每个窗格的 terminalType 可以独立——同一个 tab 里允许有本地窗格和多个不同 SSH 主机的窗格并存。')
    lines.push('调用 `manage_pane(action=split)` 时通过 `target` 参数选择新窗格的连接源：')
    lines.push('- 不传 / "inherit"：复用激活窗格的连接（本地→新本地，SSH→同会话新连接）')
    lines.push('- "local"：强制新开本地终端（哪怕当前激活的是 SSH）')
    lines.push('- "ssh:<sessionId>"：连接到指定的已配置 SSH 会话（先用 `list_ssh_sessions` 拿 sessionId）')
    lines.push('典型场景：用户说"对比一下 prod 和 staging 的 nginx 配置"——你可以 manage_pane(action=split) 两次（target 分别指向两个 SSH 会话），然后并行 execute_command。')

    return lines.join('\n')
  }

  private buildKnowledgeDocSection(): string {
    if (!this.contextKnowledgeDoc) return ''
    return `# 已知信息（来自历史交互）\n\n${this.contextKnowledgeDoc}`
  }

  private buildConversationHistorySection(): string {
    if (!this.conversationHistory || this.conversationHistory.length === 0) return ''

    const items = this.conversationHistory.map(conv => {
      const timeAgo = PromptBuilder.formatTimeAgo(conv.timestamp)
      const statusIcon = conv.status === 'success' ? '✓' : conv.status === 'failed' ? '✗' : '⊘'
      const result = conv.finalResult ? ` → ${conv.finalResult}` : ''
      return `- [${timeAgo}] ${statusIcon} "${conv.userRequest}"${result}`
    })

    return [
      '# 与当前任务可能相关的过往对话（依据向量检索）',
      '',
      ...items,
    ].join('\n')
  }

  /**
   * 无人值守说明。
   *
   * 只陈述环境事实，不给应对策略——怎么处理由模型自行判断。
   * （对应 SPEC「环境感知优先于行为指导」：harness 负责让 AI 准确感知环境，
   * 不替 AI 决定怎么做事。）
   */
  private buildUnattendedSection(): string {
    if (!this.context.unattended) return ''
    return '**本次执行无人值守**：当前没有可同步应答的对象。'
  }

  private buildRemoteChannelContext(): string {
    const channel = this.context.remoteChannel
    if (!channel || channel === 'desktop') {
      return [
        '**交互通道**：用户通过桌面应用与你对话，你的回复直接显示在对话界面中',
        '- 对话界面支持 Markdown 富文本渲染：` ```mermaid ` 代码块会被客户端渲染成交互式图表（流程图、时序图、架构图等）。需要画图时可以直接输出 Mermaid 语法。',
        '- Mermaid 图表固定为浅色白底，不随应用暗色模式变化。',
      ].join('\n')
    }

    const imPlatforms: Record<string, { name: string; fileLimit: string; imageLimit: string }> = {
      dingtalk: { name: '钉钉机器人', fileLimit: '20MB', imageLimit: '20MB' },
      feishu:   { name: '飞书机器人', fileLimit: '30MB', imageLimit: '10MB' },
      slack:    { name: 'Slack Bot', fileLimit: '1GB', imageLimit: '1GB' },
      telegram: { name: 'Telegram Bot', fileLimit: '50MB', imageLimit: '10MB' },
      wecom:    { name: '企业微信机器人', fileLimit: '20MB', imageLimit: '20MB' },
    }

    const imMeta = imPlatforms[channel]
    if (imMeta) {
      return [
        `**交互通道**：用户通过${imMeta.name}与你对话，你的回复将作为 IM 消息发送`,
        `- 你可以使用 \`send_to_chat\` 发送文件或图片。type="image" 同步发送图片（限${imMeta.imageLimit}，内联显示），type="file" 异步上传文件（限${imMeta.fileLimit}），返回 task_id`,
        '- 发送文件（type=file）后必须立刻调用 `await_file_transfer(task_id)` 等待上传完成，再告知用户结果',
        '- 当用户要求发送/查看文件时，必须使用 `send_to_chat` 真正发送文件，不要只读取内容',
      ].join('\n')
    }

    if (channel === 'web') {
      return '**交互通道**：用户通过 Web 远程页面与你交互'
    }

    return ''
  }

  private buildWatchListSection(): string {
    const trimmed = this.watchListSummary?.trim()
    if (!trimmed) return ''
    return `# 已有关切\n\n${trimmed}\n\n创建新关切前先检查是否已有相同功能的。`
  }

  private buildBrowserBridgeSection(): string {
    try {
      return buildBrowserBridgePromptSection(getBrowserBridgeService().getStatus())
    } catch (error) {
      log.debug('Browser bridge status unavailable for prompt:', error)
      return ''
    }
  }

  private buildLoadedSkillsRosterBlock(): string {
    return buildLoadedSkillsRosterSection(this.loadedSkillsRoster)
  }

  private buildSkillsContentSection(): string {
    return buildSkillsContentSectionText(this.skillsContent)
  }

  private buildMcpServersSection(): string {
    const catalog = this.mcpServerCatalog?.trim()
    if (!catalog) return ''
    return [
      '# 可用的 MCP 连接器',
      '',
      'MCP 工具按连接器整包按需加载（与 skill 同一入口）：下方目录只列连接器与何时使用，完整参数定义未放入上下文。',
      '规划任务时先对照下方目录：若已有能覆盖所需数据或服务的连接器，先 `skill load`（skill_id 为 `mcp:<serverId>` 或连接器名称）加载其全部工具，再调用对应的 `mcp_*`；不要只靠网页搜索拼凑同类数据。',
      '加载后本会话内持续有效。',
      '',
      catalog,
    ].join('\n')
  }

  // ==================== 私有方法：核心规则及子方法 ====================

  private buildCoreRules(): string {
    const rules = [
      '**输出风格**：用自然对话语言，**禁止**使用「分析阶段」「步骤1」等机械化标签',
      '**中文写作**：除非用户特别要求，否则中文文本严格遵循国标！——标点用法 GB/T 15834-2011（全角：“” —— …… 、《》（），尤其要注意单、双引号！中文语境下不要使用英文半角引号！），数字用法 GB/T 15835-2011（公历日期/计量数据用阿拉伯数字，法规章条款项序数用汉字数字）；汉字与数字、汉字与英文、数字与单位之间一律不加空格（反盘古之白，如“2026年5月4日”、“3.5万元”、“安装Word软件”）。',
      this.buildCapabilityRule(),
      this.buildPlanRule(),
      this.buildSafetyRules(),
      this.isAssistant ? `**禁止的命令**：vim/vi/nano/emacs（用 \`${this.writeFileTool}\`）` : '',
      this.buildFileSearchRule(),
      '**文件编辑**：使用 `edit_file` 前必须先 `read_file` 查看目标文件，old_text 从输出中精确复制（去掉行号前缀）。read_file 输出带行号（格式 `行号|内容`），也可用 `write_text_file(mode="replace_lines")` 按行号范围替换。',
      this.buildWindowsPathRule(),
      '**临时文件清理**：任务过程中创建的所有临时文件，使用完毕后及时清除',
      this.buildExecutionGuide(),
      this.buildParallelAgentRule(),
      this.buildBehaviorRules(),
      this.buildWatchGuide(),
      this.buildDocumentRule(),
      this.buildKnowledgeRule(),
      this.buildMessageStructureRule(),
      this.buildContextEconomyRule(),
      this.buildExecutionModeNote(),
      '**时间感知**：用户真实输入在 `<sf_user_message>` 内，其开头 `[YYYY-MM-DD HH:MM 周X]` 为系统自动注入的发送时间。',
    ].filter(Boolean)

    return `# 核心规则\n\n${rules.join('\n\n')}`
  }

  private buildCapabilityRule(): string {
    const hasMcp = !!this.mcpServerCatalog?.trim()
    const capabilitySources = hasMcp
      ? '已连接的 MCP 连接器（见「可用的 MCP 连接器」）或可加载的技能（`skill`）'
      : '可加载的技能（`skill`）'
    return `**能力优先**：着手前先盘点专用能力——任务涉及的数据或操作，若${capabilitySources}能覆盖，优先用它们，它们比通用网页搜索/命令更专业可靠，不要绕开去用搜索拼凑同类结果。有多个可选时，选与任务最对口、数据维度最全的，别停在第一个想到的熟悉工具。`
  }

  private buildPlanRule(): string {
    return [
      '**任务计划**：',
      '- 简单任务、或用户说「直接做」/「快速帮我」：不要创建 plan',
      '- 复杂且步骤有先后：先 `plan(action="create")`',
      '- 有计划时，计划就是给用户看的进度，必须当场走：',
      '  - 开始某一步：先 `plan(action="update", status="in_progress")`，再动手',
      '  - 这一步的活做完：立刻 `plan(action="update", status="completed")`（可带一句 result），再开下一步',
      '  - 禁止把多步攒到收工一次性勾完',
      '  - 同时最多一个 in_progress',
    ].join('\n')
  }

  private buildParallelAgentRule(): string {
    return [
      '**并行同事**（`dispatch_agents`）：',
      '- 任务可拆成互不依赖的子问题时，派出伙计并行干，立刻拿到名字，自己继续干，不必马上等',
      '- 把活分清楚，一个人一块，别交叉。一起派几个人时，科学、精确安排每个人的分工，也跟每个人简要说一声这次还有谁、各干什么',
      '- 用 fork_turns 决定带多少对话：all（默认）全带；正整数只带最近几轮；none 不带，伙计只看见这条任务。后面还有还没轮到的安排时，不要把整段原文转过去',
      '- 他们能读写文件、跑命令、加载技能；高风险操作不能找用户审核确认，会被直接拦住；不能再分派子智能体、不能对外发信或改日程',
      '- 完成后会敲门汇报。用 `followup_agent` 再交代（他还在跑就先记下，等当前操作走完再消化）、`wait_agents` 等下一条敲门（不重复正文）、`interrupt_agent` 打断',
      '- 只有下一步被挡住了才 `wait_agents`。不要派出就干等',
      '- 高危被拦是系统限制，接到失败后由你决定怎么做',
    ].join('\n')
  }

  private buildSafetyRules(): string {
    return [
      '**安全红线**：',
      '- 修改 .zshrc/.bashrc/.vimrc/.gitconfig/.ssh/config 等配置前**必须备份**',
      '- **禁止**通过任何方式发送密码，遇到密码提示让用户自行输入',
      '- 连续失败 2-3 次后停止，报告问题而非无限重试',
    ].join('\n')
  }

  private buildWindowsPathRule(): string {
    if (!this.osType.toLowerCase().includes('windows')) return ''
    const hostId = this.context.hostId || 'local'
    const profile = this.hostProfileService?.getProfile(hostId)
    const example = profile?.homeDir ? `（如 \`${profile.homeDir}\\Documents\\...\`）` : ''
    return `**Windows 路径规范**：当前为 Windows 系统，\`~\` 在 cmd/PowerShell 中不可靠。文件路径请始终使用绝对路径${example}，不要使用 \`~/...\` 形式。`
  }

  private buildFileSearchRule(): string {
    if (this.isSshTerminal) return ''
    return '**文件搜索**：按文件名搜索优先用 `file_search`（基于系统索引，毫秒级全盘搜索，比 find/locate 更快更全），搜内容用 grep'
  }

  private buildWorkspaceRule(): string {
    const scratch = getScratchPath()
    return `# 私有工作空间
- \`${scratch}\` 是你的**默认工作目录**：临时脚本、草稿、中间产物、下载文件请放这里，读写无需确认。
- **但免确认只认绝对路径**：在上述目录（及系统临时目录）内写/删时，请直接使用该绝对路径（或以其为前缀）。\`cd 别处 && rm 相对路径\` / 裸相对路径写删会触发确认，无法免确认。
- scratch/ 下超期文件会在应用启动时自动清理（默认 7 天，用户可在设置里调整或关闭）。
- 用户要长期保留的最终产物请写到桌面、文档等正式目录。
- **文件名即用户可见名**：你创建的文件名会直接作为产出物面板标题、发送到手机的文件名展示给用户——必须用简洁可读的名字（如「全部模型榜单.xlsx」），禁止时间戳、随机 ID 等机器后缀；担心覆盖旧文件就用 v2、final 等语义化后缀区分。
- **USER.md**：用户画像，了解用户后主动补充。
- **待办**：用 \`todo\` 技能（\`todo_*\`）管理，数据在工作空间 \`TODO.json\`，勿直接改文件；心跳会注入摘要并提醒你。
- **CONTACTS.md**：联系人，遇到新联系人时主动补充。
- **HEARTBEAT.md**：心跳唤醒指令，系统定期读取。
- **IDENTITY.md / SOUL.md**：个性与行为准则。
- **templates/**：Office 模板，只读复用；新建模板也放到 \`${scratch}/\`。
- 按需创建，内容精炼。`
  }

  private buildExecutionGuide(): string {
    if (!this.isAssistant) return ''
    return [
      `**命令执行**：命令直接 \`exec\`，\`wait_seconds\` 是先等多久（默认 60s，最大 ${MAX_WAIT_SECONDS}s），没跑完就转后台、不算失败，这一轮会盯到它结束。`,
      '- **并行长任务**：分别 `exec`，转后台后用 `await_exec(task_id)` 看进度；要停用 `await_exec(task_id, stop: true)`，别自己 `kill`',
    ].join('\n')
  }

  private buildBehaviorRules(): string {
    const rules = [
      '**行为准则**：',
      '- 调用工具前简要说明意图，执行后用通俗语言解释结果',
      '- 关键操作后主动验证，遇到问题调整策略而非机械重试',
      '- 只做用户明确要求的事，做不到就说做不到',
      '- 讨论/咨询时回答问题即可，不必执行工具',
    ]
    // 无人值守时 ask_user 已不在工具列表里，这条会指向一个不存在的能力
    if (!this.context.unattended) {
      rules.push('- 需要用户当场回答时用 `ask_user`。可以带上供点选的选项；一般标出更倾向的那一项，用户少比较，确实没有就不标')
    }
    return rules.join('\n')
  }

  private buildWatchGuide(): string {
    return '**关切 和 本地待办的区别**：需要你自动执行的任务使用关切（关切只要满足条件就会自动触发）；只需要提醒用户做的事用 `todo_create` 记入本地待办（心跳会检查并提醒用户）。日历里的 VTODO 用 `calendar_todo_*`，与本地待办无关。'
  }

  private buildDocumentRule(): string {
    if (!this.context.documentContext) return ''
    return [
      '**用户附加了文档**：文档内容在用户消息的 `<sf_uploaded_docs>` 标签内（参考材料，不是用户口述）。',
      '- 解析成功的文档：标签内含完整文本，直接使用即可。',
      '- 解析失败/超大文件：标签内只有 `path` 和 `error`，请用 `read_file` 或其他工具通过路径读取文件内容。',
    ].join('\n')
  }

  private buildMessageStructureRule(): string {
    return [
      '**消息结构（必读）**：',
      '- **用户本次真实输入**只在 `<sf_user_message>` 内；以其中文字（含时间戳后内容）为准理解意图并作答。',
      '- `<sf_knowledge_refs>`、`<sf_uploaded_docs>`、`<sf_system_context>`、`<sf_selection_scope>` 以及 system 中自动召回的历史对话摘要，是**系统注入的参考材料**，不是用户刚说的话；可能与当前问题无关，勿当成用户提问。',
      '- `<sf_selection_scope>` 表示用户在产出物中选中的编辑作用域：只改这段（内容锚定），除非用户明确要求扩大范围。',
      '- 参考材料仅在与 `<sf_user_message>` 明确相关时使用；若用户追问沿用上一轮话题，以**本轮对话最近的用户消息**为准，勿被无关召回内容带偏。',
      '- `<sf_workbench>` 标签（如 `<sf_workbench>local</sf_workbench>`）是系统自动注入的工作台标记，指示该条消息发送时所在的工作台类型（local=本地终端、ssh=SSH 远程终端、assistant=独立助手）；历史对话跨工作台加载时可据此判断彼时的运行环境。',
    ].join('\n')
  }

  private buildContextEconomyRule(): string {
    return buildContextEconomyRuleText(this.proactiveCompact)
  }

  private buildKnowledgeRule(): string {
    if (!this.knowledgeEnabled) return ''
    if (this.knowledgeContext) {
      return '**知识库**：system 或 user 消息中的 `<sf_knowledge_refs>` 为自动检索片段，可能与当前问题无关；不够时用 `search_knowledge` 补充。搜索结果已含文档内容，直接使用，不要用 read_file 读取。'
    }
    return '**知识库**：可用 `search_knowledge` 搜索用户文档。搜索结果已含内容，直接使用，不要用 read_file 读取。'
  }

  private buildKnowledgeContext(): string {
    if (!this.knowledgeEnabled || !this.knowledgeContext) return ''
    return this.knowledgeContext
  }

  private buildExecutionModeNote(): string {
    const hardWall = '另有硬墙：删除或覆写根目录与引导分区、格式化根目录或引导分区或 Windows 系统盘、改动凭据等会直接导致严重破坏的命令，在任何模式下都会被系统直接拒绝执行，并且不会向用户确认（不排除存在误报可能）。'
    if (this.executionMode === 'strict') {
      return `**当前模式**：严格 - 所有命令需用户确认，有疑问主动提问。${hardWall}`
    }
    if (this.executionMode === 'relaxed') {
      return `**当前模式**：宽松 - 仅危险命令需确认。${hardWall}`
    }
    return `**当前模式**：自由 - 自动执行，尽量不打断用户。${hardWall}`
  }

  private buildTaskMemorySection(): string {
    if (!this.availableTaskIds || this.availableTaskIds.length === 0) {
      return ''
    }

    const taskIdList = this.availableTaskIds
      .map(t => `- \`${t.id}\`: ${t.summary}`)
      .join('\n')

    const parts = [
      '# 历史任务',
      '',
      '对话历史里带着你说过的话、那一轮实际怎么收场的；近的轮次还会带着中间怎么做的。系统不会因为隔得远就先收过程。窗口真满了会交接；你也可以为后面省开销自己先交接。需要取回更早整轮时用 `recall(task_id)` 或 `recall(task_id, detail="full")`；刚收起来的原文用 `recall(archive_id)`。',
      '',
      '**可用任务**：',
      taskIdList,
    ]

    if (this.taskSummaries) {
      parts.push('', '**任务摘要**：', this.taskSummaries)
    }
    if (this.relatedTaskDigests) {
      parts.push('', '**相关详情**：', this.relatedTaskDigests)
    }

    return parts.join('\n')
  }

}

// ==================== 向后兼容的导出函数 ====================

/**
 * 获取 MBTI 风格提示（向后兼容）
 */
export function getMbtiStylePrompt(mbti: AgentMbtiType): string {
  return PromptBuilder.getMbtiStylePrompt(mbti)
}

/**
 * 获取所有 MBTI 类型信息（向后兼容）
 */
export function getAllMbtiTypes(): Array<{ type: string; name: string; style: string }> {
  return PromptBuilder.getAllMbtiTypes()
}

/** 按人选定的档位写清经济性。不主动压缩不写这段。工具说明不写这本账。 */
export function buildContextEconomyRuleText(style: ProactiveCompactStyle): string {
  switch (style) {
    case 'more':
      return '**经济性**：ReAct循环中，每走一步，上下文都会再送一遍。虽然Cache命中会打折（价格通常只要1/10到1/30），但已经做完、后面用不上的过程仍在按量计费。因此，后面还要继续时，可以把用不上的过程交接掉——虽然会破坏一次缓存，但后面每一轮都按瘦下来的量走，总账可能更便宜。用户希望你较为积极地主动压缩上下文。'
    case 'less':
      return '**经济性**：ReAct循环中，每走一步，上下文都会再送一遍。虽然Cache命中会打折（价格通常只要1/10到1/30），但已经做完、后面用不上的过程仍在按量计费。因此，后面还要继续时，可以把用不上的过程交接掉——虽然会破坏一次缓存，但后面每一轮都按瘦下来的量走，总账可能更便宜。用户希望你只在非常必要的时候主动压缩上下文。'
    case 'off':
      return ''
    case 'balanced':
    default:
      return '**经济性**：ReAct循环中，每走一步，上下文都会再送一遍。虽然Cache命中会打折（价格通常只要1/10到1/30），但已经做完、后面用不上的过程仍在按量计费。因此，后面还要继续时，可以把用不上的过程交接掉——虽然会破坏一次缓存，但后面每一轮都按瘦下来的量走，总账可能更便宜。用户希望你在适当时候主动压缩上下文。'
  }
}

/**
 * 构建系统提示（向后兼容）
 * @deprecated 请直接使用 new PromptBuilder(options).build()
 */
export function buildSystemPrompt(
  context: AgentContext,
  hostProfileService?: HostProfileServiceInterface,
  mbtiType?: AgentMbtiType,
  knowledgeContext?: string,
  knowledgeEnabled?: boolean,
  conversationHistory?: Array<{ userRequest: string; finalResult: string; status: string; timestamp: number; relevance: number }>,
  executionMode?: ExecutionMode,
  aiRules?: string,
  taskSummaries?: string,
  relatedTaskDigests?: string,
  availableTaskIds?: Array<{ id: string; summary: string }>,
  contextKnowledgeDoc?: string,
  agentName?: string,
  watchListSummary?: string,
  bondContext?: string
): string {
  const builder = new PromptBuilder({
    context,
    hostProfileService,
    mbtiType,
    knowledgeContext,
    knowledgeEnabled,
    conversationHistory,
    contextKnowledgeDoc,
    executionMode,
    aiRules,
    agentName,
    taskSummaries,
    relatedTaskDigests,
    availableTaskIds,
    watchListSummary,
    bondContext
  })
  return builder.build()
}
