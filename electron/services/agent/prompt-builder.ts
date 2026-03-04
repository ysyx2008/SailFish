/**
 * Agent 系统提示构建器
 *
 * 设计原则：
 * - 每个 section builder 返回自包含的 Markdown 块（或空字符串）
 * - 不带前导/尾部空行，空行由 build() 的 join('\n\n') 统一控制
 * - 条件判断在方法内部完成，不在模板字符串里做三元表达式
 */
import type { AgentContext, HostProfileServiceInterface, ExecutionMode } from './types'
import type { AgentMbtiType } from '../config.service'
import { getUserSkillService } from '../user-skill.service'
import { getWorkspacePath } from './tools/file'

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
  /** 用户自定义个性定义（优先级高于 MBTI） */
  personalityText?: string
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
  private readonly personalityText?: string
  private readonly agentName?: string
  private readonly taskSummaries?: string
  private readonly relatedTaskDigests?: string
  private readonly availableTaskIds?: Array<{ id: string; summary: string }>
  private readonly executionMode?: ExecutionMode
  private readonly watchListSummary?: string
  private readonly bondContext?: string

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
    this.personalityText = options.personalityText
    this.agentName = options.agentName
    this.taskSummaries = options.taskSummaries
    this.relatedTaskDigests = options.relatedTaskDigests
    this.availableTaskIds = options.availableTaskIds
    this.executionMode = options.executionMode
    this.watchListSummary = options.watchListSummary
    this.bondContext = options.bondContext
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

    return [
      this.buildLanguageRule(),
      this.buildIdentitySection(),
      this.buildPersonalitySection(),
      this.buildBondSection(),
      this.buildUserRulesSection(),
      this.buildHostEnvironment(),
      this.buildKnowledgeDocSection(),
      this.buildConversationHistorySection(),
      this.buildRemoteChannelContext(),
      this.buildWatchListSection(),
      this.buildWorkflowSection(),
      this.buildToolConstraints(),
      this.buildCoreRules(),
      this.buildKnowledgeContext(),
      getUserSkillService().buildSkillsSummary(),
      this.buildTaskMemorySection(),
    ].filter(Boolean).join('\n\n')
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

  /**
   * 构建上下文管理章节（AI 自我认知）
   */
  static buildContextManagementSection(): string {
    return [
      '# 运行环境',
      '',
      '你运行在 ReAct 循环中，工具调用会追加到上下文（有容量上限，见末尾"上下文状态"）。',
      '',
      '**记忆层次**：当前对话 → 任务记忆（`recall`）→ 压缩归档（`recall_compressed`）',
      '',
      '**上下文管理**：用量超 70% 时用 `compress_context` 压缩较早内容（归档可找回）；任务完成后用 `manage_memory` 调整历史任务压缩级别或丢弃。',
    ].join('\n')
  }

  // ==================== 私有方法：派生状态 ====================

  private computeDerivedState(): void {
    this.osType = this.context.systemInfo.os || 'unknown'
    this.shellType = this.context.systemInfo.shell || 'unknown'
    const terminalType = this.context.terminalType || 'local'
    this.isSshTerminal = terminalType === 'ssh'
    this.isAssistant = terminalType !== 'local' && terminalType !== 'ssh'
    this.writeFileTool = this.isSshTerminal ? 'write_remote_file' : 'write_local_file'
  }

  // ==================== 私有方法：顶层 Section ====================

  private buildLanguageRule(): string {
    return '**CRITICAL RULE: You MUST respond in the SAME language the user uses. If user writes in English, reply in English. If user writes in Japanese, reply in Japanese. If user writes in Chinese, reply in Chinese.**'
  }

  private buildIdentitySection(): string {
    const displayName = this.agentName?.trim() || '旗鱼（SailFish）AI Agent'
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
    const cwdLine = this.context.cwd
      ? `当前工作目录：${this.context.cwd}（系统实时获取，无需执行 pwd 验证）`
      : '当前工作目录：未成功获取'

    return [
      `你是${displayName}，一个能帮助用户完成各类任务的智能助手。`,
      `当前时间：${currentTime}`,
      cwdLine,
    ].join('\n')
  }

  private buildPersonalitySection(): string {
    const mbtiStyle = PromptBuilder.getMbtiStylePrompt(this.mbtiType ?? null)
    const personality = this.personalityText?.trim()

    if (personality && mbtiStyle) {
      return `# 你的灵魂（重要！）\n\n${personality}\n\n## 风格参考（MBTI）\n\n${mbtiStyle}`
    }
    if (personality) {
      return `# 你的灵魂（重要！）\n\n${personality}`
    }
    if (mbtiStyle) {
      return `# 你的风格（重要！）\n\n${mbtiStyle}`
    }
    return ''
  }

  private buildBondSection(): string {
    const bond = this.bondContext?.trim()
    if (!bond) return ''
    return `# 你与用户的羁绊\n\n${bond}`
  }

  private buildUserRulesSection(): string {
    const rules = this.aiRules?.trim()
    if (!rules) return ''
    return `# 用户自定义规则（重要！必须遵守）\n\n${rules}`
  }

  private buildHostEnvironment(): string {
    const lines: string[] = [
      `- **终端类型**: ${this.isSshTerminal ? '🌐 SSH 远程终端' : '💻 本地终端'}`
    ]

    const profile = this.context.hostId && this.hostProfileService
      ? this.hostProfileService.getProfile(this.context.hostId)
      : null
    if (profile?.hostname) {
      lines.push(`- 主机名: ${profile.hostname}`)
    }

    lines.push(`- 操作系统: ${this.osType}`)
    lines.push(`- Shell: ${this.shellType}`)

    if (profile?.installedTools && profile.installedTools.length > 0) {
      lines.push(`- 已安装工具: ${profile.installedTools.join(', ')}`)
    }

    return `# 主机环境\n\n${lines.join('\n')}`
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
      '# 相关历史（自动检索）',
      '',
      '以下是与当前任务可能相关的过往交互，供参考：',
      '',
      ...items,
    ].join('\n')
  }

  private buildRemoteChannelContext(): string {
    const channel = this.context.remoteChannel
    if (!channel || channel === 'desktop') return ''

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
        `- 你可以使用 \`send_to_chat\` 发送文件或图片。type="image" 发送图片（限${imMeta.imageLimit}，内联显示），type="file" 发送文件（限${imMeta.fileLimit}）`,
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

  private buildWorkflowSection(): string {
    return [
      '# 工作方式',
      '',
      '- **调用工具前**：用 1 句话说明你要做什么',
      '- **工具执行后**：用通俗语言解释结果和发现',
      '- **关键操作后**：主动验证结果，不假设成功',
      '- **遇到问题时**：动态调整策略，而非机械重试',
    ].join('\n')
  }

  private buildToolConstraints(): string {
    if (this.isSshTerminal) {
      return [
        '# SSH 终端约束',
        '',
        '- `read_file`、`edit_file`、`write_local_file` **不可用**（只能操作本地文件）',
        '- 读取远程文件用 `cat`/`head`/`tail`，写入用 `write_remote_file` 或 `echo`/`cat <<EOF`',
        '- 终端状态需根据屏幕内容自行判断（看提示符、Password:、进度等）',
      ].join('\n')
    }
    return '# 工具提示\n\n- 按文件名搜索优先用 `file_search`（毫秒级），搜内容用 grep'
  }

  // ==================== 私有方法：核心规则及子方法 ====================

  private buildCoreRules(): string {
    const rules = [
      `**环境**：${this.osType} / ${this.shellType}，命令必须匹配此环境`,
      '**输出风格**：用自然对话语言，**禁止**使用「分析阶段」「步骤1」等机械化标签',
      this.buildPlanRule(),
      this.buildSafetyRules(),
      `**禁止的命令**：vim/vi/nano/emacs（用 \`${this.writeFileTool}\`）、tmux/screen、mc/ranger`,
      this.buildFileSearchRule(),
      this.buildLongContentRule(),
      '**临时文件清理**：任务过程中创建的所有临时文件（脚本、配置、中间产物等），使用完毕后一般应当及时清除，不要在系统中留下垃圾',
      this.buildWorkspaceRule(),
      this.buildExecutionGuide(),
      this.buildSshStatusRule(),
      this.buildBehaviorRules(),
      this.buildWatchGuide(),
      this.buildDocumentRule(),
      this.buildKnowledgeRule(),
      this.buildExecutionModeNote(),
    ].filter(Boolean)

    return `# 核心规则\n\n${rules.join('\n\n')}`
  }

  private buildPlanRule(): string {
    return [
      '**任务计划**：',
      '- 1-3 步的简单任务：直接执行，不要创建 plan',
      '- 4+ 步骤且有依赖关系：使用 `plan(action="create")`，执行时用 `plan(action="update")` 更新状态',
      '- 用户说"直接做"/"快速帮我"：不要创建 plan',
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

  private buildFileSearchRule(): string {
    return ''
  }

  private buildLongContentRule(): string {
    return [
      '**长内容处理**：',
      `- 超过 200 字符禁止用 echo/printf，用 \`${this.writeFileTool}\` 写入 /tmp 再执行`,
      '- 长文本分析结果直接在对话中回复，不要发送到终端',
    ].join('\n')
  }

  private buildWorkspaceRule(): string {
    return `**私有工作空间**：\`${getWorkspacePath()}\` 是你的私有数据目录，读写无需用户确认。
- **TODO.md**：待办事项（含创建日期、截止时间、完成状态）。定期唤醒时自动读取并提醒用户。"帮我记着/提醒我" → 写 TODO；"你自己去执行" → 创建关切。已完成的定期清理。
- **CONTACTS.md**：联系人信息（姓名 + 角色/联系方式），遇到新联系人时主动补充。
- 以上文件按需创建，内容精炼以节约 tokens。`
  }

  private buildExecutionGuide(): string {
    if (this.isAssistant) {
      return [
        '**命令执行**：短命令直接 `exec`，长命令加 `timeout`（默认 60s，最大 600s）。超时 ≠ 失败。',
        '- **并行长任务**：`exec("cmd > /tmp/out.log 2>&1 & echo $!", timeout=5)` 获取 PID → 独立 exec 轮询 `sleep N && tail -20 /tmp/out.log && ps -p PID || echo done` → `kill PID` 终止',
      ].join('\n')
    }

    return [
      '**长耗时命令**：执行 → `wait` 等待 → `check_terminal_status` 确认，超时不代表失败',
      '- 等待时可以说点有趣的话，比如："去喝杯咖啡☕马上回来"、"编译中，先摸会儿鱼🐟"、"让子弹飞一会儿🎬"',
    ].join('\n')
  }

  private buildSshStatusRule(): string {
    if (!this.isSshTerminal) return ''
    return [
      '**SSH 终端状态判断**（根据屏幕内容）：',
      '- 看到 `$` 或 `#` 提示符 → 可执行新命令',
      '- 看到 `Password:` → 暂停，让用户输入',
      '- 看到 `(y/n)` → 根据情况回复或询问用户',
      '- 看到 `--More--` 或 `(END)` → 发送 `q` 退出',
    ].join('\n')
  }

  private buildBehaviorRules(): string {
    return [
      '**行为准则**：',
      '- 只做用户明确要求的事，做不到就说做不到',
      '- 讨论/咨询时回答问题即可，不必执行工具',
      '- 需要确认时**必须用 `ask_user`**，不要只在消息里问然后等回复',
    ].join('\n')
  }

  private buildWatchGuide(): string {
    return '**关切**：关切 = AI 自动执行，日程 = 只提醒。"每天帮我做X"/"文件变了执行Z" → 关切。'
  }

  private buildDocumentRule(): string {
    if (!this.context.documentContext) return ''
    return [
      '**【重要】关于用户上传的文档**：用户已上传文档，文档完整内容在用户消息的 `<sf_uploaded_docs>` 标签内，直接使用即可，一般不需要用 read_file 读取。',
    ].join('\n')
  }

  private buildKnowledgeRule(): string {
    if (!this.knowledgeEnabled) return ''
    if (this.knowledgeContext) {
      return '**知识库**：上方已预加载相关内容，不够时用 `search_knowledge` 补充。搜索结果已含文档内容，直接使用，不要用 read_file 读取。'
    }
    return '**知识库**：可用 `search_knowledge` 搜索用户文档。搜索结果已含内容，直接使用，不要用 read_file 读取。'
  }

  private buildKnowledgeContext(): string {
    if (!this.knowledgeEnabled || !this.knowledgeContext) return ''
    return this.knowledgeContext
  }

  private buildExecutionModeNote(): string {
    if (this.executionMode === 'strict') {
      return '**当前模式**：严格 - 所有命令需用户确认，有疑问主动提问'
    } else if (this.executionMode === 'relaxed') {
      return '**当前模式**：宽松 - 仅危险命令需确认'
    }
    return '**当前模式**：自由 - 自动执行，尽量不打断用户'
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
      '对话历史中包含：最近 1 个任务的完整对话，之后 2 个任务的压缩对话（含工具摘要），再之后 3 个任务的精简对话（仅请求和回复）。更早任务仅在下方列出摘要，需要详情用 `recall(id)` 或 `recall(id, detail="full")`。',
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
  personalityText?: string,
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
    personalityText,
    agentName,
    taskSummaries,
    relatedTaskDigests,
    availableTaskIds,
    watchListSummary,
    bondContext
  })
  return builder.build()
}
