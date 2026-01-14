/**
 * Agent 系统提示构建器
 * 
 * OOP 重构版本：将纯函数封装为 PromptBuilder 类
 * 注意：重构不改变任何提示词内容，只是代码组织形式的改变
 */
import type { AgentContext, HostProfileServiceInterface, ExecutionMode } from './types'
import type { AgentMbtiType } from '../config.service'
import type { KnowledgeService } from '../knowledge'
import { getSkillsSummary } from './skills/registry'
import { getUserSkillService } from '../user-skill.service'

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
  /** 从知识库获取的主机记忆 */
  hostMemories?: string[]
  /** 用户自定义的 AI 规则 */
  aiRules?: string
  /** 任务历史总结列表（L1 层） */
  taskSummaries?: string
  /** 语义预加载的相关任务摘要（L2 层） */
  relatedTaskDigests?: string
  /** 所有可用任务的ID列表（用于 recall_task 工具） */
  availableTaskIds?: Array<{ id: string; summary: string }>
  /** 执行模式 */
  executionMode?: ExecutionMode
}

/**
 * 系统提示构建器
 * 
 * 将系统提示的构建逻辑封装为类，提高可维护性和可测试性
 * 注意：输出内容与原始 buildSystemPrompt 函数完全一致
 */
export class PromptBuilder {
  private readonly context: AgentContext
  private readonly hostProfileService?: HostProfileServiceInterface
  private readonly mbtiType?: AgentMbtiType
  private readonly knowledgeContext?: string
  private readonly knowledgeEnabled?: boolean
  private readonly hostMemories?: string[]
  private readonly aiRules?: string
  private readonly taskSummaries?: string
  private readonly relatedTaskDigests?: string
  private readonly availableTaskIds?: Array<{ id: string; summary: string }>
  private readonly executionMode?: ExecutionMode

  constructor(options: BuildSystemPromptOptions) {
    this.context = options.context
    this.hostProfileService = options.hostProfileService
    this.mbtiType = options.mbtiType
    this.knowledgeContext = options.knowledgeContext
    this.knowledgeEnabled = options.knowledgeEnabled
    this.hostMemories = options.hostMemories
    this.aiRules = options.aiRules
    this.taskSummaries = options.taskSummaries
    this.relatedTaskDigests = options.relatedTaskDigests
    this.availableTaskIds = options.availableTaskIds
    this.executionMode = options.executionMode
  }

  // ==================== 公开方法 ====================

  /**
   * 构建完整的系统提示
   * 注意：输出与原始 buildSystemPrompt 函数完全一致
   */
  build(): string {
    // MBTI 风格提示
    const mbtiStyle = PromptBuilder.getMbtiStylePrompt(this.mbtiType ?? null)
    const styleSection = mbtiStyle 
      ? `\n\n## 你的风格（重要！）\n${mbtiStyle}\n\n**注意：请始终保持上述风格回复，即使历史对话中的风格有所不同。**\n` 
      : ''
    
    // 用户自定义规则
    const userRulesSection = this.aiRules && this.aiRules.trim()
      ? `\n\n## 用户自定义规则（重要！必须遵守）\n\n用户设置了以下规则，你必须严格遵守：\n\n${this.aiRules.trim()}\n`
      : ''
    
    // 当前本地时间（用于角色认知）
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
    
    // 优先使用 context.systemInfo（来自当前终端 tab，是准确的）
    const osType = this.context.systemInfo.os || 'unknown'
    const shellType = this.context.systemInfo.shell || 'unknown'
    const terminalType = this.context.terminalType || 'local'
    const isSshTerminal = terminalType === 'ssh'
    
    // 构建主机信息
    const hostContext = this.buildHostContext(osType, shellType, isSshTerminal)

    // 文档上下文
    let documentSection = ''
    let documentRule = ''
    if (this.context.documentContext) {
      documentSection = `\n\n${this.context.documentContext}`
      documentRule = `
- **【重要】关于用户上传的文档**：用户已上传文档，文档**完整内容**已经包含在本对话的上下文末尾（标记为"用户上传的参考文档"）。
  - **直接使用上下文中的文档内容**，不需要也不应该使用 read_file 工具读取
  - 文档内容就在下方，你可以直接引用和分析`
    }

    // 知识库上下文
    let knowledgeSection = ''
    let knowledgeRule = ''
    if (this.knowledgeEnabled) {
      if (this.knowledgeContext) {
        knowledgeSection = `\n\n${this.knowledgeContext}`
        knowledgeRule = `
- **【重要】你有知识库**：你可以访问用户保存的知识库文档，以及记忆的信息。
  - 上面的"相关知识库内容"部分包含了与当前问题相关的预加载内容
  - 如果预加载内容不够详细，使用 \`search_knowledge\` 工具搜索更多信息
  - **知识库搜索结果已经包含文档内容，直接使用即可，不要用 read_file 去读取知识库文档**
  - 主动引用知识库中的相关内容，告诉用户答案来源于知识库`
      } else {
        // 知识库启用但没有预加载内容时，提醒 Agent 可以使用工具查询
        knowledgeRule = `
- **知识库工具**：用户有知识库，你可以使用 \`search_knowledge\` 工具搜索用户保存的文档和笔记。
  - **搜索结果已包含文档内容片段，直接使用即可，不要用 read_file 读取**`
      }
    }

    // 根据操作系统类型选择示例
    const isWindows = osType.toLowerCase().includes('windows')
    
    // 任务示例暂时禁用以节约 token，方法代码保留以备后用
    // const simpleTaskExample = this.buildSimpleTaskExample(isWindows)

    return `**CRITICAL RULE: You MUST respond in the SAME language the user uses. If user writes in English, reply in English. If user writes in Japanese, reply in Japanese. If user writes in Chinese, reply in Chinese.**

你是旗鱼终端（SFTerm）的 AI Agent 助手。当前时间：${currentTime}
${styleSection}
${userRulesSection}
${hostContext}
## 工作方式
- **调用工具前**：用 1 句话说明你要做什么
- **工具执行后**：用通俗语言解释结果和发现
- **关键操作后**：主动验证结果，不假设成功
- **遇到问题时**：动态调整策略，而非机械重试
${this.buildToolConstraints(isSshTerminal, isWindows)}
${this.buildCoreRules(osType, shellType, isSshTerminal, documentRule, knowledgeRule)}
${documentSection}
${knowledgeSection}
${getUserSkillService().buildSkillsSummary()}
${this.buildTaskMemorySection()}`
  }

  // ==================== 静态方法（便捷访问） ====================

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

  // ==================== 私有方法：各章节构建 ====================

  /**
   * 构建工具约束说明（精简版，只说明约束，不重复工具描述）
   */
  private buildToolConstraints(isSshTerminal: boolean, isWindows: boolean): string {
    const sections: string[] = []

    // SSH 特殊约束
    if (isSshTerminal) {
      sections.push(`## ⚠️ SSH 终端约束
- \`read_file\`、\`edit_file\`、\`write_local_file\` **不可用**（只能操作本地文件）
- 读取远程文件用 \`cat\`/\`head\`/\`tail\`，写入用 \`write_remote_file\` 或 \`echo\`/\`cat <<EOF\`
- 终端状态需根据屏幕内容自行判断（看提示符、Password:、进度等）`)
    } else {
      sections.push(`## 工具使用提示
- \`file_search\` 只搜文件名（基于系统索引），不搜内容；已知目录用 \`ls\`/\`find\` 更准确
- \`write_remote_file\` 不可用（仅 SSH 终端可用）`)
    }

    // 技能系统
    sections.push(`## 技能扩展
通过 \`load_skill\` 按需加载额外能力，加载后当前会话持续有效。
${this.buildSkillsSection()}`)

    return sections.join('\n\n')
  }

  /**
   * 构建核心规则（精简版）
   */
  private buildCoreRules(osType: string, shellType: string, isSshTerminal: boolean, documentRule: string, knowledgeRule: string): string {
    const writeFileTool = isSshTerminal ? 'write_remote_file' : 'write_local_file'
    
    return `## 核心规则
**环境**：${osType} / ${shellType}，命令必须匹配此环境

**输出风格**：用自然对话语言，**禁止**使用「分析阶段」「步骤1」等机械化标签

**任务计划**：
- 1-3 步的简单任务：直接执行，不要创建 plan
- 4+ 步骤且有依赖关系：使用 \`create_plan\`，执行时用 \`update_plan\` 更新状态
- 用户说"直接做"/"快速帮我"：不要创建 plan

**安全红线**：
- 修改 .zshrc/.bashrc/.vimrc/.gitconfig/.ssh/config 等配置前**必须备份**
- **禁止**通过任何方式发送密码，遇到密码提示让用户自行输入
- 连续失败 2-3 次后停止，报告问题而非无限重试

**禁止的命令**：vim/vi/nano/emacs（用 \`${writeFileTool}\`）、tmux/screen、mc/ranger

**长内容处理**：
- 超过 200 字符禁止用 echo/printf，用 \`${writeFileTool}\` 写入 /tmp 再执行
- 长文本分析结果直接在对话中回复，不要发送到终端

**长耗时命令**：执行 → \`wait\` 等待 → \`check_terminal_status\` 确认，超时不代表失败
${isSshTerminal ? `
**SSH 终端状态判断**（根据屏幕内容）：
- 看到 \`$\` 或 \`#\` 提示符 → 可执行新命令
- 看到 \`Password:\` → 暂停，让用户输入
- 看到 \`(y/n)\` → 根据情况回复或询问用户
- 看到 \`--More--\` 或 \`(END)\` → 发送 \`q\` 退出` : ''}

**行为准则**：
- 只做用户明确要求的事，做不到就说做不到
- 讨论/咨询时回答问题即可，不必执行工具
- 需要确认时**必须用 \`ask_user\`**，不要只在消息里问然后等回复
${documentRule}
${knowledgeRule}
${this.buildExecutionModeNote()}`
  }

  /**
   * 构建执行模式说明
   */
  private buildExecutionModeNote(): string {
    if (this.executionMode === 'strict') {
      return '**当前模式**：严格 - 所有命令需用户确认，有疑问主动提问'
    } else if (this.executionMode === 'relaxed') {
      return '**当前模式**：宽松 - 仅危险命令需确认'
    } else {
      return '**当前模式**：自由 - 自动执行，尽量不打断用户'
    }
  }

  /**
   * 构建任务记忆章节
   */
  private buildTaskMemorySection(): string {
    if (!this.availableTaskIds || this.availableTaskIds.length === 0) {
      return ''
    }

    let section = `\n## 历史任务
可用 \`recall_task(id)\` 获取摘要，\`deep_recall(id)\` 获取完整输出。
**可用ID**：${this.availableTaskIds.map(t => `\`${t.id}\`(${t.summary})`).join('、')}`

    if (this.taskSummaries) {
      section += `\n**任务摘要**：\n${this.taskSummaries}`
    }
    if (this.relatedTaskDigests) {
      section += `\n**相关详情**：\n${this.relatedTaskDigests}`
    }

    return section
  }

  /**
   * 构建主机环境信息
   */
  private buildHostContext(osType: string, shellType: string, isSshTerminal: boolean): string {
    let hostContext = `## 主机环境
- **终端类型**: ${isSshTerminal ? '🌐 SSH 远程终端' : '💻 本地终端'}
- 操作系统: ${osType}
- Shell: ${shellType}`
    
    // 如果有主机档案，补充额外信息（但不覆盖系统类型）
    if (this.context.hostId && this.hostProfileService) {
      const profile = this.hostProfileService.getProfile(this.context.hostId)
      if (profile) {
        if (profile.hostname) {
          hostContext = `## 主机环境
- 主机名: ${profile.hostname}
- 操作系统: ${osType}
- Shell: ${shellType}`
        }
        if (profile.installedTools && profile.installedTools.length > 0) {
          hostContext += `\n- 已安装工具: ${profile.installedTools.join(', ')}`
        }
      }
    }

    // 添加主机记忆（来自知识库）
    if (this.hostMemories && this.hostMemories.length > 0) {
      hostContext += '\n\n## 已知信息（来自历史交互）'
      for (const memory of this.hostMemories.slice(0, 15)) {  // 最多显示 15 条
        hostContext += `\n- ${memory}`
      }
    }

    return hostContext
  }

  /**
   * 构建技能扩展章节（精简版）
   */
  private buildSkillsSection(): string {
    const skills = getSkillsSummary()
    if (skills.length === 0) {
      return '暂无可用技能。'
    }
    return `可用技能：${skills.map(s => `\`${s.id}\`(${s.name})`).join('、')}
涉及相关领域时先 \`load_skill("技能ID")\` 加载。`
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

/**
 * 构建系统提示（向后兼容）
 */
export function buildSystemPrompt(
  context: AgentContext,
  hostProfileService?: HostProfileServiceInterface,
  mbtiType?: AgentMbtiType,
  knowledgeContext?: string,
  knowledgeEnabled?: boolean,
  hostMemories?: string[],
  executionMode?: ExecutionMode,
  aiRules?: string,
  taskSummaries?: string,
  relatedTaskDigests?: string,
  availableTaskIds?: Array<{ id: string; summary: string }>
): string {
  const builder = new PromptBuilder({
    context,
    hostProfileService,
    mbtiType,
    knowledgeContext,
    knowledgeEnabled,
    hostMemories,
    executionMode,
    aiRules,
    taskSummaries,
    relatedTaskDigests,
    availableTaskIds
  })
  return builder.build()
}
