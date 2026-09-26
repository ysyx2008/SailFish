/**
 * Agent 工具定义
 */
import type { ToolDefinition } from '../ai.service'
import type { McpService } from '../mcp.service'
import type { PluginRegistry } from '../plugin/registry'
import type { McpToolSession } from './mcp-tool-session'
import { toMcpSkillId } from '../mcp-progressive-constants'
import { getSkillsSummary } from './skills/registry'
import { getUserSkillService } from '../user-skill.service'
import { getConfigService } from '../config.service'
import { isConfigured as isWebSearchConfigured } from '../web-search/index'
import { jinaAvailable as isJinaReaderAvailable } from '../web-fetch.service'
import type { AgentExecutionPhase } from './types'
import { t } from './i18n'
import { MAX_WAIT_SECONDS } from './background-watch'
import { getStreamPlaceholder } from './tool-metadata'
import { resolveContextAction } from './tools/context'
import { describeAwaitExecCall, describeExecCall } from './tools/exec'

// 重新导出 ToolDefinition 类型供技能模块使用
export type { ToolDefinition }

import type { TerminalType, RemoteChannel } from '@shared/types'
import { ASSISTANT_WORKBENCH_AGENT_TOOLS } from '@sailfish/workbench-assistant/agent-tools'
import { getAllTerminalTools } from './skills/terminal/tools'

/** @deprecated Use TerminalType from @shared/types */
export type AgentMode = TerminalType

/**
 * 流式预卡片展示配置
 *
 * pre-card 和执行器 addStep 都通过 formatStreamPreCardFromMeta /
 * formatToolCallPrefixFromMeta 消费这些字段，对齐变成代码级机械保证
 *（详见 tool-metadata.ts）。
 *
 * 两种模式：
 * - 「声明式」（推荐）：填 titleKey + titleField + progressFields，覆盖绝大多数场景
 * - 「自定义渲染」：极少数复杂工具（如 dispatch_agents 要根据子任务数量构造文案）
 *   填 customRender，本字段优先级最高，命中后忽略 title* 字段
 *
 * 两种模式都支持 progressFields 共同的字符数尾缀。
 */
export interface ToolStreamDisplay {
  /**
   * 标题前缀的 i18n 键，或根据 args 动态返回 i18n 键的函数。
   * 复杂工具（如 write_text_file 按 mode 切换标题）写函数；简单工具直接写 string。
   */
  titleKey?: string | ((args: Record<string, unknown>) => string)
  /**
   * args 里取哪个字段作为副标题（path / command / query 等）。
   * AI 还没流到此字段时会用占位符兜底，避免长字段流式期间卡片不出现。
   * 不指定则只显示标题前缀（如 get_terminal_context 这类无参工具）。
   */
  titleField?: string
  /**
   * 哪些字段累计字符数尾缀（如 content / markdown / old_text）。
   * 用于让 AI 流式输出长字段时用户能看到字符数在跳动。
   */
  progressFields?: string[]
  /**
   * 自定义渲染函数（可选），返回**前缀**（不含字符数尾缀）。
   * 命中后忽略 titleKey/titleField，但 progressFields / customProgress 仍生效（统一加在末尾）。
   * 返回 null 表示当前 args 还不足以构造（如 dispatch_agents 的 tasks 数组还没到），
   * 让调用方保留上一次缓存内容，避免"闪一下又消失"。
   */
  customRender?: (args: Record<string, unknown>) => string | null
  /**
   * 自定义字符数计算（可选），用于 progressFields 表达不了的嵌套字段累计场景
   *（如 dispatch_agents 的 tasks[].prompt + tasks[].description）。
   * 返回 0 或 < 100 时不显示尾缀；progressFields 与 customProgress 同时存在时会累加。
   */
  customProgress?: (args: Record<string, unknown>) => number
}

/**
 * 工具元数据
 *
 * 这里是 Agent 基类决策时**唯一**应该读到的"具体工具差异"。
 * 任何"基类按工具名 switch / 硬编码工具名集合"的代码都应改为读这里的字段，
 * 见 SPEC.md「工具元数据驱动模型」。
 */
export interface ToolMeta {
  /** 支持的运行模式（不指定则支持所有模式） */
  supportedModes?: AgentMode[]

  /** 流式预卡片展示配置（不指定则用通用兜底「调用: {toolName}」） */
  streamDisplay?: ToolStreamDisplay

  /**
   * 流式参数早校验（可选）：在 tool_call 参数还在流式生成时，用已到达的 partial args
   * 检测「注定失败」的情形，返回非空错误串即中止当前生成并把该工具定稿为失败，
   * 避免等整段长参数（如 content）流完才在执行阶段报错。
   *
   * 返回 null 表示暂无法判定或校验通过；返回 string 为给模型的错误信息。
   * 第二个参数是尚未结束的原始 JSON 串：tryParsePartialJson 会给未闭合字符串补引号，
   * 校验方必须自行判断字段是否真的写完，不能把半截路径当成完整目标。
   * 抽象层只读此元数据，不感知具体工具名（OOP 边界）。
   */
  streamValidate?: (args: Record<string, unknown>, rawPartial: string) => string | null

  /** 是否可与其他工具并行执行（默认 false：串行执行；副作用工具默认安全） */
  parallelizable?: boolean

  /** 执行此工具时的 Agent 执行阶段（默认 'executing_command'） */
  phase?: AgentExecutionPhase

  /**
   * 工具白名单 / 幂等键的字段子集（默认全 args 参与生成 key）。
   * 例如 execute_command 只取 ['command']，让"同一条命令"的不同上下文共享白名单。
   */
  idempotencyKey?: string[]

  /** 生命周期标志：影响 Agent 全局状态判断 */
  lifecycle?: {
    /** 调用此工具表示 onboarding 引导完成（如 personality_craft） */
    marksOnboardingComplete?: boolean
    /** 此工具的 tool_call 后会阻塞等待用户输入（如 ask_user） */
    blocksUntilUserInput?: boolean
  }

  /**
   * 伙计能不能用。默认能用。false = 仅主人可见，执行时也会硬拦。
   * 规划锁预留同一套过滤钩子，本次不实现锁本身。
   */
  allowedForSubAgent?: boolean

  /**
   * 伙计看到的工具说明。处境和主人不同时写这一份，避免共用说明骗人。
   */
  descriptionForSubAgent?: string

  /**
   * 动手范围。pane = 对着看得见的那扇窗干活（跑命令、动那台的文件）。
   * 执行时按这扇窗当初打开的连接认主机；没声明则不算对主机动手。
   */
  hostScope?: 'pane'

  /**
   * 参数角色：用于历史摘要等场景"知道哪个字段是重点"
   */
  argRole?: {
    /**
     * 此 args 的"主命令"字段，单行历史摘要显示这个字段的值。
     * 如 execute_command/exec 的 'command'。
     */
    summaryLine?: string
  }
}

/**
 * 带元数据的工具定义
 *
 * 注：发送给 LLM 之前 `getAgentTools()` 会把 `_meta` 字段剥掉（见本文件末尾的 cleanTools）。
 */
export interface ToolDefinitionWithMeta extends ToolDefinition {
  _meta?: ToolMeta
}

// ============================================================================
// streamDisplay customRender 辅助函数
// ============================================================================

/**
 * write_text_file / write_remote_text_file 的预卡片标题渲染。
 * 按 mode 切换 6 种文案；path 未到时占位符兜底；不含字符数尾缀（progressFields 单独负责）。
 */
function writeTextFilePrefix(args: Record<string, unknown>): string {
  const path = typeof args.path === 'string' ? args.path : getStreamPlaceholder()
  const mode = typeof args.mode === 'string' ? args.mode : 'create'
  const insertAtLine = typeof args.insert_at_line === 'number' ? args.insert_at_line : undefined
  const startLine = typeof args.start_line === 'number' ? args.start_line : undefined
  const endLine = typeof args.end_line === 'number' ? args.end_line : undefined
  const replaceAll = typeof args.replace_all === 'boolean' ? args.replace_all : true
  switch (mode) {
    case 'overwrite': return `${t('file.overwrite')}: ${path}`
    case 'append': return `${t('file.append')}: ${path}`
    case 'insert':
      return insertAtLine !== undefined
        ? `${t('file.insert_at_line', { line: insertAtLine })}: ${path}`
        : `${t('file.create')}: ${path}`
    case 'replace_lines':
      return startLine !== undefined && endLine !== undefined
        ? `${t('file.replace_lines', { start: startLine, end: endLine })}: ${path}`
        : `${t('file.create')}: ${path}`
    case 'regex_replace':
      return `${t('file.regex_replace', { scope: replaceAll ? t('file.regex_scope_all') : t('file.regex_scope_first') })}: ${path}`
    case 'create':
    default:
      return `${t('file.create')}: ${path}`
  }
}

/**
 * dispatch_agents 的预卡片渲染。
 * 内容格式必须与 tools/sub-agent.ts 执行器 addStep 的 content 对齐：
 *   t('dispatch.running', { count, type })
 * tasks 数组还没到或为空时返回 null（上层调用方保留缓存）。
 */
function dispatchAgentsPrefix(args: Record<string, unknown>): string | null {
  const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
  if (rawTasks.length === 0) return null
  return t('dispatch.running', { count: rawTasks.length })
}

/**
 * read_file 的预卡片标题切换：info_only=true 时显示"读取文件 (仅查询信息)"，否则"读取文件"。
 * 提到顶层避免每次 getAgentTools 调用都生成新的函数引用（影响 toEqual 比较与 prompt cache）。
 */
function readFileTitleKey(args: Record<string, unknown>): string {
  return (args as { info_only?: unknown }).info_only === true
    ? 'file.reading_info_only'
    : 'file.reading'
}

function contextToolTitleKey(args: Record<string, unknown>): string {
  return resolveContextAction(args) === 'compress'
    ? 'agent.compact_tool_step'
    : 'context_tool.check_step'
}

/**
 * dispatch_agents 的字符数累计：tasks[].prompt + tasks[].description 嵌套字段。
 * 用 customProgress 暴露给 formatStreamPreCardFromMeta，让用户看到子任务指令在持续增长。
 */
function dispatchAgentsCharCount(args: Record<string, unknown>): number {
  const rawTasks = Array.isArray(args.tasks) ? (args.tasks as unknown[]) : []
  let chars = 0
  for (const task of rawTasks) {
    if (!task || typeof task !== 'object') continue
    const rec = task as { prompt?: unknown; description?: unknown }
    if (typeof rec.prompt === 'string') chars += rec.prompt.length
    if (typeof rec.description === 'string') chars += rec.description.length
  }
  return chars
}

/**
 * 动态构建 skill 工具定义（合并 load_skill + unload_skill；目录含已连接 MCP）
 */
function buildSkillTool(mcpService?: McpService): ToolDefinitionWithMeta {
  const disabledIds = new Set(getConfigService().get('disabledBuiltinSkills') || [])
  const skills = getSkillsSummary().filter(s => !disabledIds.has(s.id))
  const userSkills = getUserSkillService().getEnabledSkills()
  const catalogLines = [
    ...skills.map(s => `- ${s.id}: ${s.description}`),
    ...userSkills.map(s => `- ${s.id}: ${s.description || s.name}`)
  ]
  const skillsCompact = catalogLines.length > 0 ? catalogLines.join('\n') : '暂无'
  const skillIds = [...skills.map(s => `"${s.id}"`), ...userSkills.map(s => `"${s.id}"`)].join(', ') || '暂无'

  const mcpLines: string[] = []
  const mcpIdHints: string[] = []
  if (mcpService?.shouldDeferTools()) {
    for (const status of mcpService.getServerStatuses()) {
      const skillId = toMcpSkillId(status.id)
      mcpIdHints.push(`"${skillId}"`)
      // 目录细节在 system prompt；此处只给 id + 名称，避免 skill description 过胖
      mcpLines.push(`- ${status.name}（${skillId}）：MCP，先 skill load 再调 mcp_*`)
    }
  }
  const mcpBlock = mcpLines.length > 0
    ? `\n\n已连接 MCP（同样用 load/unload，skill_id 形如 mcp:<serverId>）：\n${mcpLines.join('\n')}`
    : ''
  const idHint = mcpIdHints.length > 0
    ? `${skillIds}, ${mcpIdHints.join(', ')}`
    : skillIds

  return {
    type: 'function',
    function: {
      name: 'skill',
      description: `加载或卸载这场对话里的技能。系统自带的、用户自己写的、已连接的外部工具包都走这一条。加载后整场对话有效；卸掉只影响这场对话，不删除技能库。涉及相关领域时先加载再执行。

⚠️ 创建/更新/删除/安装技能 → 必须先 load skill-manager，严禁用 write_text_file 直接写 SKILL.md
⚠️ MCP：对照系统提示「可用的 MCP 连接器」目录，用 skill load mcp:<id>（或连接器名称）整包加载后再调 mcp_*；不要只靠网页搜索。

可用技能：
${skillsCompact}${mcpBlock}`,
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['load', 'unload'],
            description: '操作类型：load（加载）或 unload（卸载）。unload 只卸这场对话，不删库。'
          },
          skill_id: {
            type: 'string',
            description: `技能 ID 或 mcp:<serverId>，可选值: ${idHint}`
          }
        },
        required: ['action', 'skill_id']
      }
    },
    _meta: { parallelizable: true }
  }
}

/**
 * 动态构建 web_search 工具定义（仅在已配置时返回）
 */
function buildWebSearchTool(): ToolDefinitionWithMeta[] {
  if (!isWebSearchConfigured()) return []
  return [{
    type: 'function',
    function: {
      name: 'web_search',
      description: `搜索互联网获取实时信息。需要查找最新资料、验证事实、获取在线内容时使用。返回搜索结果列表（标题、URL、摘要）。

调用前先确认：若系统提示中列出的专用能力（MCP 连接器/技能）已覆盖所需数据，应用对应专用工具查询，本工具仅作通用检索与补充验证。`,
      parameters: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: '搜索查询词'
          },
          max_results: {
            type: 'number',
            description: '最大结果数（默认 5，最大 10）'
          }
        },
        required: ['query']
      }
    },
    _meta: {
      parallelizable: true,
      // 流式预卡片：标题用 i18n（zh: 网页搜索 / en: Web search），副标题取 query
      streamDisplay: { titleKey: 'web.search', titleField: 'query' }
    }
  }]
}

/**
 * 动态构建 web_fetch 工具定义
 *
 * 始终注入（不依赖任何配置就能用 Mozilla Readability 处理静态页面）。
 * 如果用户在 web-search 配了 Jina key，description 里强调"能读 SPA"——
 * 让 LLM 知道现在也能搞定飞书 API 文档 / Notion 公开页这类 JS 渲染的页面。
 */
function buildWebFetchTool(): ToolDefinitionWithMeta {
  const hasJina = isJinaReaderAvailable()
  // 拆成 base + jinaHint 两段：仅 jinaHint 随 Jina key 配置切换。
  // 注意：这并不能减少 prompt cache 失效——LLM provider 看 tool schema 是原子的，
  // 任何字节变化都会导致 cache miss。这样拆只是为了代码可读性（明确"哪部分变"）。
  // 切换 Jina key 频率极低，一次 cache miss 是可接受的成本。
  const baseDescription = `按 URL 抓取一个具体网页，返回 LLM 可读的文本/markdown。

适用场景：
- 已经知道想看哪个 URL（用户给的链接、或 web_search 拿到候选后想看详情）
- 阅读 API 文档、博客文章、技术文档、维基、新闻等
- 与 web_search 互补：search 给候选列表，fetch 看具体一篇

不适用：
- 需要登录的页面（通常会拿到登录墙，不是目标内容；注意辨别）
- PDF / 图片 / 视频等二进制 → 改用 exec 下载到本地后再 read_file

只需传 url；timeout 通常不必指定（默认 30 秒）。`
  const jinaHint = hasJina
    ? '\n\n当前提取后端：Jina Reader（已配置 API key）——SPA 渲染的页面也能读，如飞书 API 文档、Notion 公开页、现代 SaaS docs。'
    : '\n\n当前提取后端：本地 Readability——静态页面 OK，但 JS 渲染的 SPA（如飞书 API 文档、Notion 公开页）通常拿不到内容；如需读 SPA 请提示用户在 设置 → 联网搜索 配置 Jina API key。'
  const description = baseDescription + jinaHint

  return {
    type: 'function',
    function: {
      name: 'web_fetch',
      description,
      parameters: {
        type: 'object',
        properties: {
          url: {
            type: 'string',
            description: '要抓取的 http(s) URL'
          },
          timeout: {
            type: 'number',
            description: '总耗时上限（秒），默认 30，最大 60'
          }
        },
        required: ['url']
      }
    },
    _meta: {
      parallelizable: true,
      streamDisplay: { titleKey: 'web.fetch.short', titleField: 'url' }
    }
  }
}

/**
 * 工具获取选项
 */
export interface GetAgentToolsOptions {
  /** Agent 运行模式，用于过滤不适用的工具 */
  mode?: AgentMode
  /** 请求来源通道（用于条件性加载 IM 专属工具） */
  remoteChannel?: RemoteChannel
  /**
   * 是否带上历史任务记忆管理。查看/压缩从一开始就在；
   * 记忆管理仍按水位打开，避免一开始就摆出「丢任务」这扇门。
   */
  includeContextTools?: boolean
  /**
   * 本次执行无人值守：没有可同步应答的对象。
   * 为真时，会阻塞等待用户输入的工具不会出现在列表里——环境里不存在的能力不该假装存在。
   */
  unattended?: boolean
  /** MCP 渐进披露会话（defer 时提供已 load 子集） */
  mcpToolSession?: McpToolSession
}

/**
 * 窗格类工具（manage_pane / list_ssh_sessions）的说明按形态分版。
 *
 * 助手页与终端页对「能不能关掉最后一扇窗」的规矩正好相反，两条并排摆着模型得先猜
 * 自己算哪一种。裁剪只依据形态——它在一次会话里不变，说明才不会变成变量把前缀缓存
 * 每轮打掉（见 SPEC「给模型看的说明必须与它当下的处境一致」）。
 */
interface PaneToolDescriptions {
  open: string
  close: string
  sshUsage: string
}

/** 本机与远程终端共用一版：眼前都已经有一扇窗，差别只在连着谁 */
const TERMINAL_PANE_DESC: PaneToolDescriptions = {
  open: '- open：不分屏、直接连一台真终端。可选 target：不传/local 开本机、ssh:<sessionId>（先 list_ssh_sessions）。已有终端时再开一扇。',
  close: '- close：关掉一扇（必填 pane_id=ptyId）。不能关掉最后一扇。',
  sshUsage: '用途：当你想连接到某台已配置的服务器时，先调本工具拿 sessionId，再调 manage_pane(action="open", target="ssh:<sessionId>") 开一扇连过去（要并排对比就用 split）。无需用户手工切换或输入凭证。',
}

/**
 * 直接以运行形态为键，不另起一套分类词汇——形态的真相源是 AgentMode。
 * 新增一种形态时这张表会缺 key、当场编译不过，逼人明确决定它该看哪一版说明。
 *
 * `unspecified` 是没指明形态时的保守版本（两边规矩都留着），不是第四种形态。
 */
const PANE_TOOL_DESC: Record<AgentMode | 'unspecified', PaneToolDescriptions> = {
  local: TERMINAL_PANE_DESC,
  ssh: TERMINAL_PANE_DESC,
  assistant: {
    open: '- open：不分屏、直接连一台真终端。可选 target：不传/local 开本机、ssh:<sessionId>（先 list_ssh_sessions）。没有终端时用这个请终端入座（左边终端、右边这场对话）；正在看文件时开终端，文件让开进清单。已有终端时再开一扇。',
    close: '- close：关掉一扇（必填 pane_id=ptyId）。可以关掉最后一扇，终端离座、回到对话独占，不自动把文件请回来。',
    sshUsage: '用途：当你想连接到某台已配置的服务器时，先调本工具拿 sessionId，再调 manage_pane(action="open", target="ssh:<sessionId>") 请真终端入座（没有终端时用 open；已有终端再开一扇可用 split）。无需用户手工切换或输入凭证。',
  },
  unspecified: {
    open: '- open：不分屏、直接连一台真终端。可选 target：不传/local 开本机、ssh:<sessionId>（先 list_ssh_sessions）。助手没有终端时用这个请终端入座（左边终端、右边这场对话）；正在看文件时开终端，文件让开进清单。已有终端时再开一扇。',
    close: '- close：关掉一扇（必填 pane_id=ptyId）。终端页不能关最后一扇；助手可以关最后一扇，终端离座、回到对话独占，不自动把文件请回来。',
    sshUsage: '用途：当你想连接到某台已配置的服务器时，先调本工具拿 sessionId，再调 manage_pane(action="open", target="ssh:<sessionId>") 请真终端入座（助手没有终端时用 open；已有终端再开一扇可用 split）。无需用户手工切换或输入凭证。',
  },
}

/**
 * 获取可用工具定义
 * @param mcpService 可选的 MCP 服务，用于动态加载 MCP 工具
 * @param options 可选配置，如终端类型
 * @param pluginRegistry 可选的插件注册表，用于加载插件工具
 */
export function getAgentTools(mcpService?: McpService, options?: GetAgentToolsOptions, pluginRegistry?: PluginRegistry): ToolDefinition[] {
  // 本机命令（child_process.spawn）。可见性由 _meta.supportedModes 决定：本地终端眼前已是本机窗，不另给。
  // 终端窗里的命令由 terminal 技能的 execute_command 提供。
  const execIntro = `【在本机执行 Shell 命令】通过本机 shell 执行命令字符串，支持管道/&&/重定向/脚本内联。不支持交互式命令(vim/nano/tmux)。`
  const execDangerousExamples = `- 解释器内联代码（node -e / python -c / bash -c / zsh -c / perl -e / ruby -e / php -r 等）会被标记为危险
  —— 这类代码无法静态审计，真正高风险场景请切严格模式
- 包装器/调度器（sudo / env / docker / ssh / make / npx 等）会被标记为危险
  —— 这些 cmd 会转手执行别的命令，违反"直接调用"的不变量
- 如需运行脚本，直接用 exec 跑脚本文件：exec("node script.js")、exec("python a.py")
- find -exec / -delete、tar --to-command、git rebase --exec 等结构性 flag 会被标记为危险`
  const execWaitAndUsage = `**等待与转后台**：
- wait_seconds 内结束返回完整结果；没结束就转后台（返回 task_id），这一轮会盯到它结束、结果自动送回，不用专门再等
- 常驻命令（服务、监听）设 service: true，否则这一轮会一直等它
- 看进度、等某句日志、停掉：用 await_exec
- 启动服务示例：exec("npm run dev", wait_seconds: 5, service: true)，再 await_exec(task_id, pattern: "Listening on") 确认`
  const execDescriptionForParent = `${execIntro}

**安全规则（命中标为 dangerous，strict/relaxed 需确认；free 放行）**：
${execDangerousExamples}

${execWaitAndUsage}`
  const execDescriptionForSubAgent = `${execIntro}

**安全规则（伙计没有签字通道）**：
- 命中 dangerous 或 blocked 一律拦住，不会问人签字。这是系统限制，不是暂时失败
- scratch 及系统临时目录里，用绝对路径的普通写删可以直接做
- 相对路径、先 cd 再删、桌面等正式目录的删除一律被拦
${execDangerousExamples}

${execWaitAndUsage}`

  const execTool: ToolDefinitionWithMeta = {
        type: 'function',
        function: {
          name: 'exec',
          description: execDescriptionForParent,
          parameters: {
            type: 'object',
            properties: {
              description: {
                type: 'string',
                description: '这条命令是干什么的，十来个字的人话（如「构建前端」「同步订单表」），显示在进度卡片上给用户看'
              },
              command: {
                type: 'string',
                description: '要执行的 shell 命令'
              },
              cwd: {
                type: 'string',
                description: '本机工作目录（可选）'
              },
              wait_seconds: {
                type: 'number',
                description: `先等多少秒（默认 60，最大 ${MAX_WAIT_SECONDS}），没结束就转后台`
              },
              max_seconds: {
                type: 'number',
                description: '命令最长允许运行时间（默认 3600 即 1 小时，最大 86400 即 24 小时）。到点会被 SIGKILL，防止僵尸进程'
              },
              service: {
                type: 'boolean',
                description: '常驻命令（服务、监听）设 true：不盯、结束不回报。有终点的别设'
              },
              skill_id: {
                type: 'string',
                description: '技能 ID（可选）。指定后会自动将该技能配置的 API Key 等 env 注入到子进程，无需明文传递 key'
              }
            },
            required: ['command']
          }
        },
        _meta: {
          supportedModes: ['assistant', 'ssh'],
          idempotencyKey: ['command'],
          argRole: { summaryLine: 'command' },
          streamDisplay: { customRender: describeExecCall },
          descriptionForSubAgent: execDescriptionForSubAgent
        }
      }

  const awaitExecTool: ToolDefinitionWithMeta = {
        type: 'function',
        function: {
          name: 'await_exec',
          description: `对 exec 转后台的命令：等结束、等某句输出、看最新进度，或停掉。
- 等日志：await_exec(task_id, pattern: "Listening on")，命中即返回
- 看进度：await_exec(task_id, wait_seconds: 1)
- 停掉：await_exec(task_id, stop: true)，连子进程一起；只能停这场对话自己起的
- 忘了标常驻：await_exec(task_id, service: true)
返回：已结束给全量输出和 exit_code；仍在跑给最近 8KB 输出。task_id 不对或结束超过 5 分钟会报错`,
          parameters: {
            type: 'object',
            properties: {
              task_id: {
                type: 'string',
                description: 'exec 转后台时返回的 task_id（如 "exec-1"）'
              },
              wait_seconds: {
                type: 'number',
                description: `最长等多少秒（默认 30，最大 ${MAX_WAIT_SECONDS}），结束或命中 pattern 提前返回`
              },
              pattern: {
                type: 'string',
                description: '可选正则（JS 语法，多行模式）。一旦命中立即返回，便于"等服务启动"等场景。如 "Listening on" 或 "error:"'
              },
              service: {
                type: 'boolean',
                description: '设 true 改标成常驻：不盯、结束不回报'
              },
              stop: {
                type: 'boolean',
                description: '设 true 停掉它，停完告诉用户停了什么、为什么'
              }
            },
            required: ['task_id']
          }
        },
        _meta: {
          supportedModes: ['assistant', 'ssh'],
          parallelizable: true,  // 可同时 await 多个 task_id
          streamDisplay: { customRender: describeAwaitExecCall }
        }
      }

  const { open: paneOpenDesc, close: paneCloseDesc, sshUsage: sshUsageDesc } =
    PANE_TOOL_DESC[options?.mode ?? 'unspecified']

  // 内置工具（所有模式通用）。伙计能否使用看 ToolMeta.allowedForSubAgent，不靠列表前缀。
  const builtinTools: ToolDefinition[] = [
    execTool,
    {
      type: 'function',
      function: {
        name: 'read_file',
        description: `读取本地文件。支持文本、PDF、Word(.doc/.docx)、WPS 文字/表格(.wps/.wpt/.et/.ett)、图片(jpg/png/gif/bmp/webp/ico，自动注入视觉上下文)。自动检测二进制文件。大文件先用 info_only 查信息，再按行范围读取。远程文件请用命令行。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '文件路径（绝对路径或相对于当前目录）'
            },
            info_only: {
              type: 'boolean',
              description: '仅获取文件信息（大小、行数等），不读取内容'
            },
            start_line: { type: 'number', description: '起始行号（从1开始）' },
            end_line: { type: 'number', description: '结束行号（包含）' },
            max_lines: { type: 'number', description: '从开头读取的最大行数' },
            tail_lines: { type: 'number', description: '从末尾读取的行数' }
          },
          required: ['path']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant', 'ssh'],
        parallelizable: true,
        // 标题按 info_only 切换："读取文件" vs "读取文件 (仅查询信息)"，path 字段做副标题
        streamDisplay: { titleKey: readFileTitleKey, titleField: 'path' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'file_search',
        description: `快速搜索本地文件名（基于系统索引，毫秒级）。多个关键词用空格分隔表示文件名需同时包含所有关键词（AND 关系，不要求连续，不区分大小写）。例如 "员工 奖惩" 可命中 "员工奖惩管理.docx" 和 "2024员工奖惩明细.xlsx"。仅搜文件名不搜内容，搜内容请用 grep。`,
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '搜索关键词。多个关键词用空格分隔表示同时包含（AND，不要求顺序与连续），如 "员工 奖惩" 命中 "员工奖惩管理.docx"。也支持通配符 * ?'
            },
            path: {
              type: 'string',
              description: '限制搜索目录（可选，不指定则全盘搜索）'
            },
            type: {
              type: 'string',
              enum: ['file', 'dir', 'all'],
              description: '搜索类型：file（仅文件）、dir（仅目录）、all（全部，默认）'
            },
            limit: {
              type: 'number',
              description: '最大结果数量，默认 50'
            }
          },
          required: ['query']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant', 'ssh'],
        parallelizable: true,
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'search_knowledge',
        description: '搜索用户的知识库文档。搜索结果已包含文档内容，直接使用即可。',
        parameters: {
          type: 'object',
          properties: {
            query: {
              type: 'string',
              description: '简短的搜索词，1-3个核心关键词即可，避免堆砌'
            },
            limit: {
              type: 'integer',
              description: '返回结果数量（整数），默认 5，范围 1-20'
            }
          },
          required: ['query']
        }
      },
      _meta: { parallelizable: true }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'get_knowledge_doc',
        description: '按文档 ID 精确获取知识库中的完整文档内容。当用户通过 @docs 引用了特定文档时（消息中会显示 doc_id:xxx），使用此工具获取完整内容。',
        parameters: {
          type: 'object',
          properties: {
            doc_id: {
              type: 'string',
              description: '文档 ID，从用户消息中的 doc_id:xxx 获取'
            }
          },
          required: ['doc_id']
        }
      },
      _meta: { parallelizable: true }
    } as ToolDefinitionWithMeta,
    ...buildWebSearchTool(),
    // web_fetch：始终注入（无配置就用本地 Readability，配了 Jina 自动升级）
    // 紧跟 web_search 之后，与子 Agent 白名单顺序对齐，保持"父=子前缀"
    buildWebFetchTool(),
    // ==================== edit 子 Agent 额外允许的工具 ====================
    {
      type: 'function',
      function: {
        name: 'edit_file',
        description: `查找替换修改本地文件（修改首选工具）。使用前必须先 read_file 查看文件，old_text 必须从 read_file 输出中精确复制（不含行号前缀）。old_text 必须在文件中唯一匹配，匹配多处时提供更多上下文使其唯一。创建新文件请用 write_text_file。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            old_text: {
              type: 'string',
              description: '要替换的原始文本，必须与文件内容完全匹配（包括空白和换行）'
            },
            new_text: {
              type: 'string',
              description: '替换后的新文本'
            },
            replace_all: {
              type: 'boolean',
              description: '替换所有匹配（默认 false，仅替换唯一匹配）'
            }
          },
          required: ['path', 'old_text', 'new_text']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant', 'ssh'],
        phase: 'writing_file',
        // 白名单键只取 path：同一文件的任意编辑操作共享「本次允许」
        idempotencyKey: ['path'],
        // 同 write_text_file：path 未到时占位符兜底，old_text + new_text 累计字符数尾缀
        streamDisplay: {
          titleKey: 'file.edit',
          titleField: 'path',
          progressFields: ['old_text', 'new_text']
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'write_text_file',
        description: `写入或创建本地纯文本文件。部分修改请优先用 edit_file。大文件分段写入（先 create 再 append）。重要文件请先备份。目标已存在且要整文件重写时请用 mode="overwrite"；mode="create" 若目标已存在则按覆盖处理（确认规则与覆盖相同）。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '本地文件路径（绝对路径或相对于当前目录）'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append', 'insert', 'replace_lines', 'regex_replace'],
              description: '写入方式（必填，无默认）：create=新建（目标已存在则按覆盖处理）；overwrite=整文件覆盖重写；append=末尾追加；insert=指定行插入；replace_lines=按行号范围替换；regex_replace=正则替换'
            },
            content: {
              type: 'string',
              description: '文件内容（覆盖/追加/插入/行替换模式必填）'
            },
            insert_at_line: { type: 'number', description: 'insert: 插入行号（从1开始）' },
            start_line: { type: 'number', description: 'replace_lines: 起始行号' },
            end_line: { type: 'number', description: 'replace_lines: 结束行号' },
            pattern: { type: 'string', description: 'regex_replace: 正则表达式' },
            replacement: { type: 'string', description: 'regex_replace: 替换内容（支持 $1 $2）' },
            replace_all: { type: 'boolean', description: 'regex_replace: 替换全部（默认 true）' }
          },
          required: ['path', 'mode']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant', 'ssh'],
        phase: 'writing_file',
        // 白名单键只取 path：同一路径的任意写入操作共享「本次允许」
        idempotencyKey: ['path'],
        // 流式预卡片：mode 切换 6 种文案，path 占位符兜底，content 累计字符数尾缀。
        // customRender 只负责前缀，progressFields 在外层统一加尾缀。
        streamDisplay: {
          customRender: writeTextFilePrefix,
          progressFields: ['content']
        }
      }
    } as ToolDefinitionWithMeta,
    // ==================== 父 Agent 专用工具 ====================
    // await_exec 放在子 Agent 白名单之后，保持子 Agent 工具列表是父列表的连续前缀。
    awaitExecTool,
    {
      type: 'function',
      function: {
        name: 'write_remote_text_file',
        description: `通过 SFTP 写入远程纯文本文件。大文件分段写入（先 create 再 append）。路径不支持 ~。局部修改请用命令行 sed/awk。目标已存在且要整文件重写时请用 mode="overwrite"；mode="create" 若目标已存在则按覆盖处理（确认规则与覆盖相同）。`,
        parameters: {
          type: 'object',
          properties: {
            path: {
              type: 'string',
              description: '远程文件路径'
            },
            mode: {
              type: 'string',
              enum: ['create', 'overwrite', 'append'],
              description: '写入方式（必填，无默认）：create=新建（目标已存在则按覆盖处理）；overwrite=整文件覆盖重写；append=末尾追加'
            },
            content: {
              type: 'string',
              description: '文件内容'
            }
          },
          required: ['path', 'mode', 'content']
        }
      },
      _meta: {
        supportedModes: ['ssh'],
        phase: 'writing_file',
        hostScope: 'pane',
        // 白名单键只取 path：同一路径的任意远程写入操作共享「本次允许」
        idempotencyKey: ['path'],
        // 与 write_text_file 共享同一套预卡片渲染（mode 切换文案、path 占位符、字符数尾缀）
        streamDisplay: {
          customRender: writeTextFilePrefix,
          progressFields: ['content']
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'sftp_put',
        description: `通过 SFTP 上传本地文件到远程主机。

适用场景（write_remote_text_file 不擅长的）：
- 大文件 / 二进制（write_remote_text_file 要把整个内容塞进 tool_args，token 灾难且二进制不支持）
- 已有本地工件（构建产物、用 write_text_file 拼好的多文件批量推送）

短文本配置 / 脚本（< 2KB）依然首选 write_remote_text_file，无需先在本地落盘。

行为：远程已存在时除非 overwrite=true 否则报错；上传成功后不再回写终端，避免污染输出。

**窗格选择**：本工具只能针对 SSH 窗格执行。当前默认窗格是 SSH 时直接用；是本地终端时必须先 manage_pane(action=list) 找到 SSH 窗格的 ptyId（或用 manage_pane action=split 创建一个），再通过 pane_id 指定。`,
        parameters: {
          type: 'object',
          properties: {
            local_path: {
              type: 'string',
              description: '本地源文件绝对路径'
            },
            remote_path: {
              type: 'string',
              description: '远程目标文件绝对路径（不支持 ~ 展开，需用绝对路径）'
            },
            overwrite: {
              type: 'boolean',
              description: '远程已存在时是否覆盖（默认 false，存在则报错）'
            },
            pane_id: {
              type: 'string',
              description: '【分屏专用·可选】指定操作哪个 SSH 窗格。值=manage_pane(action=list) 返回的窗格 ptyId。不传则用 Agent 当前默认窗格——若默认窗格不是 SSH 会报错。'
            }
          },
          required: ['local_path', 'remote_path']
        }
      },
      _meta: {
        // local 模式 tab 通过 pane_id 指向 SSH 窗格也能用；assistant 模式无终端，工具不可用
        supportedModes: ['local', 'ssh'],
        phase: 'writing_file',
        hostScope: 'pane',
        streamDisplay: {
          titleKey: 'sftp.upload',
          titleField: 'remote_path'
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'sftp_get',
        description: `通过 SFTP 下载远程文件到本地。

典型用法：把远程日志/数据/二进制拉到本地 agent workspace，再用 read_file / grep 等本地工具深度分析——比 cat 大文件灌进上下文省 token，比终端命令更适合二进制。

local_path 省略时自动落到 agent workspace 根目录（文件名同 remote 的 basename），后续 read_file 可直接读。
local_path 填相对路径时也归一到 workspace 内；填绝对路径才落到任意位置。

**窗格选择**：本工具只能针对 SSH 窗格执行。当前默认窗格是 SSH 时直接用；是本地终端时必须先 manage_pane(action=list) 找到 SSH 窗格的 ptyId（或用 manage_pane action=split 创建一个），再通过 pane_id 指定。`,
        parameters: {
          type: 'object',
          properties: {
            remote_path: {
              type: 'string',
              description: '远程源文件绝对路径'
            },
            local_path: {
              type: 'string',
              description: '本地目标路径（可选）。省略 → workspace/<basename>；相对路径 → workspace/<相对路径>；绝对路径 → 原样使用'
            },
            pane_id: {
              type: 'string',
              description: '【分屏专用·可选】指定从哪个 SSH 窗格下载。值=manage_pane(action=list) 返回的窗格 ptyId。不传则用 Agent 当前默认窗格——若默认窗格不是 SSH 会报错。'
            }
          },
          required: ['remote_path']
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh'],
        hostScope: 'pane',
        streamDisplay: {
          titleKey: 'sftp.download',
          titleField: 'remote_path'
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'ask_user',
        description: `向用户提问并等待回复。可以带上供点选的选项。一般标出更倾向的那一项，用户少比较；确实没有就不标，提问照样出去。用户仍可自己打字。调用后暂停直到用户回复。`,
        parameters: {
          type: 'object',
          properties: {
            question: {
              type: 'string',
              description: '要向用户提出的问题'
            },
            options: {
              type: 'array',
              items: { type: 'string' },
              minItems: 2,
              maxItems: 10,
              description: '供点选的选项。有的话至少 2 个、最多 10 个。带上选项时，一般同时标出更倾向的那一项'
            },
            allow_multiple: { type: 'boolean', description: '允许多选（默认 false）' },
            default_value: { type: 'string', description: 'options 里更倾向的那一项。一般有，超时未回复时用它；确实没有就不填' },
            timeout: { type: 'number', description: '超时秒数（默认 120，最短 1，最长 600）' }
          },
          required: ['question']
        }
      },
      _meta: {
        // 此工具的 tool_call 后会阻塞等待用户输入（task-memory 据此识别"任务在等待确认"）
        lifecycle: { blocksUntilUserInput: true },
        allowedForSubAgent: false,
      }
    } as ToolDefinitionWithMeta,
    // ==================== Plan 工具（合并 create/update/clear） ====================
    {
      type: 'function',
      function: {
        name: 'plan',
        description: `管理任务执行计划。4+ 步骤且有依赖关系时使用，简单任务不需要。

**action**：
- create: 创建计划（需 title + steps）
- update: 更新步骤状态（需 step_index + status）
- pause: 暂停计划，停止自动推进，等待用户指示后再继续（可选 reason）
- resume: 恢复已暂停的计划，继续执行
- clear: 归档计划（可选 reason）`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['create', 'update', 'pause', 'resume', 'clear'],
              description: '操作类型'
            },
            title: { type: 'string', description: 'create: 计划标题' },
            steps: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  title: { type: 'string', description: '步骤标题' },
                  description: { type: 'string', description: '步骤说明（可选）' }
                },
                required: ['title']
              },
              description: 'create: 步骤列表'
            },
            step_index: { type: 'number', description: 'update: 步骤索引（从 0 开始）' },
            status: {
              type: 'string',
              enum: ['pending', 'in_progress', 'completed', 'failed', 'skipped'],
              description: 'update: 步骤状态'
            },
            result: { type: 'string', description: 'update: 步骤结果说明（可选）' },
            reason: { type: 'string', description: 'pause/clear: 暂停或归档原因（可选）' }
          },
          required: ['action']
        }
      },
      _meta: { allowedForSubAgent: false }
    } as ToolDefinitionWithMeta,
    buildSkillTool(mcpService),
    // ==================== 这场回忆（上一件事 / 刚收起来的原文） ====================
    {
      type: 'function',
      function: {
        name: 'recall',
        description: `回忆这场对话里不在眼前的内容。上一件已做完的事、刚被压缩收起来的原文，都从这里取。翻别的对话请用 search_history。

- 任务号（task_id）：取该任务。默认摘要（命令、路径、错误、关键发现），detail="full" 给完整执行步骤。
- 归档号（archive_id）：取压缩时收走的原文。
- 两个都不带（只带 detail 也算）：列出这场里还能取什么。
- 两个都给：请只给一个。
- 取任务必须带 task_id；取归档必须带 archive_id。

上下文中的「任务历史」列出可回忆的任务号；压缩成功后会告诉你归档号。`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: '任务 ID。与 archive_id 二选一'
            },
            archive_id: {
              type: 'string',
              description: '压缩归档 ID（如 "ca-1"）。与 task_id 二选一'
            },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '取任务时的详细程度，默认 summary。取归档时忽略'
            },
            step_index: {
              type: 'number',
              description: '取任务且 detail=full 时可指定步骤索引（从 0 开始）'
            }
          }
        }
      },
      _meta: { parallelizable: true }
    } as ToolDefinitionWithMeta,
    // ==================== 历史搜索工具 ====================
    {
      type: 'function',
      function: {
        name: 'search_history',
        description: `搜索跨会话的历史对话记录（recall 只查当前会话）。支持两种模式：keyword（关键字匹配，默认）和 semantic（语义搜索，用自然语言描述要找什么）。keyword 模式需提供 keyword/start_date/end_date 至少一个；semantic 模式需提供 keyword 作为语义查询。detail: summary（默认）仅任务和结果，full 含工具调用记录。`,
        parameters: {
          type: 'object',
          properties: {
            keyword: { type: 'string', description: '搜索关键字或语义查询（semantic 模式下用自然语言描述）' },
            mode: {
              type: 'string',
              enum: ['keyword', 'semantic'],
              description: '搜索模式：keyword=关键字匹配（默认），semantic=向量语义搜索'
            },
            start_date: { type: 'string', description: '开始时间（YYYY-MM-DD 或 YYYY-MM-DD HH:mm）' },
            end_date: { type: 'string', description: '结束时间' },
            detail: {
              type: 'string',
              enum: ['summary', 'full'],
              description: '输出级别。summary=仅任务和结果；full=额外包含工具调用记录。默认 summary'
            },
            limit: {
              type: 'number',
              description: '返回结果数量，默认 10，最大 30'
            }
          },
          required: []
        }
      }
    },
    // ==================== 并行子 Agent ====================
    {
      type: 'function',
      function: {
        name: 'dispatch_agents',
        description: `派出这场任务里的同事（伙计）并行干活。立刻返回每个人的名字。`,
        parameters: {
          type: 'object',
          properties: {
            tasks: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  name: { type: 'string', description: '招呼他的短名字（可选，不填则从 description 生成）' },
                  description: { type: 'string', description: '任务简述（一句话，用于进度展示）' },
                  prompt: { type: 'string', description: '详细任务指令' },
                  fork_turns: {
                    type: 'string',
                    description: '带多少对话。默认 all。none=不带，all=全带，正整数字符串（如 1、3）=只带最近几轮。'
                  }
                },
                required: ['description', 'prompt']
              },
              description: '子任务列表（1-10 个）'
            },
            max_concurrent: {
              type: 'number',
              description: '最大同时开工数（默认 5，范围 1-10）'
            }
          },
          required: ['tasks']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        allowedForSubAgent: false,
        streamDisplay: {
          customRender: dispatchAgentsPrefix,
          customProgress: dispatchAgentsCharCount
        }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'followup_agent',
        description: `向已派出的伙计再交代一句。他还在跑就先记下，等当前这条命令或这一轮走完再消化，不会掐断正在跑的操作；已经做完就在同一条线上继续。急着停用 interrupt_agent。`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'dispatch_agents 返回的名字' },
            message: { type: 'string', description: '要补充的交代' }
          },
          required: ['name', 'message']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        allowedForSubAgent: false,
        streamDisplay: { titleKey: 'tool.followup_agent', titleField: 'name' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'wait_agents',
        description: `等下一条敲门（不传 names 则等任何一个还活着的）。有人回来或超时就返回，不等全部做完。只报谁回来了、谁还在做，不重复正文——正文在敲门里。只有下一步被挡住了才等，派出后先干自己的。`,
        parameters: {
          type: 'object',
          properties: {
            names: {
              type: 'array',
              items: { type: 'string' },
              description: '要等的名字；省略则等所有还活着的伙计'
            },
            timeout: {
              type: 'number',
              description: '超时秒数（默认 120，范围 1-600）'
            }
          }
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        allowedForSubAgent: false,
        streamDisplay: { titleKey: 'tool.wait_agents' }
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'interrupt_agent',
        description: `打断一个还在跑的伙计。`,
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '要打断的名字' }
          },
          required: ['name']
        }
      },
      _meta: {
        supportedModes: ['local', 'assistant'],
        allowedForSubAgent: false,
        streamDisplay: { titleKey: 'tool.interrupt_agent', titleField: 'name' }
      }
    } as ToolDefinitionWithMeta,
    // ==================== 分屏管理（仅终端 Agent 可用） ====================
    {
      type: 'function',
      function: {
        name: 'manage_pane',
        description: `管理当前会话的终端窗格与连通。用 action 区分操作：

- list：列出窗格（ptyId / label / isActive / terminalType / connected / connecting）。connected 仅表示主进程尚未观察到断开，不是远端健康探测。connecting 为 true 表示这一扇正在握手，不要再调 ensure_connected。
${paneOpenDesc}
- split：再开一扇（须已有终端）。必填 direction=horizontal|vertical；可选 target：不传/inherit 复用激活窗格、local、ssh:<sessionId>。成功后返回的 ptyId 就是之后 execute_command / focus / close 用的编号，与 list 里那扇窗相同。
${paneCloseDesc}
- focus：切焦点并切换 Agent 默认操作窗格（必填 pane_id）。
- ensure_connected：确保 SSH 窗格连通；已通则幂等；正在连接则立刻返回、不要再调；已断且未在握手才原地重连（成功=新 shell）。可选 pane_id。

窗格唯一标识是 ptyId（SSH 重连 reuseId 保持不变）。分屏或再开一扇成功后返回的编号就是这个值，给 execute_command 等传 pane_id 时直接用，不必再 list。
窗里的命令用 execute_command 打进指定或当前那扇窗。
SSH 断线：ensure_connected 或依赖用时懒重连（结果会告知，不自动重跑命令）；勿叫用户点按钮。
典型：list_ssh_sessions → manage_pane(action=open, target="ssh:…") → execute_command。`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['list', 'open', 'split', 'close', 'focus', 'ensure_connected'],
              description: '要执行的窗格操作'
            },
            direction: {
              type: 'string',
              enum: ['horizontal', 'vertical'],
              description: 'action=split 时必填：horizontal=左右、vertical=上下'
            },
            target: {
              type: 'string',
              description: 'action=open/split 可选：inherit / local / ssh:<sessionId>'
            },
            pane_id: {
              type: 'string',
              description: 'action=close/focus 必填；ensure_connected 可选。值为目标窗格 ptyId'
            }
          },
          required: ['action']
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh', 'assistant'],
        // streaming-tool-executor 只看工具名：合并后整体不可并行（list 失去并行是可接受代价）
        parallelizable: false,
        allowedForSubAgent: false,
      }
    } as ToolDefinitionWithMeta,
    {
      type: 'function',
      function: {
        name: 'list_ssh_sessions',
        description: `列出用户已配置好的 SSH 会话清单（不含密码 / 私钥等敏感字段），返回每个会话的 sessionId、name、host、port、username、group、lastUsedAt。

${sshUsageDesc}

适用场景：
- 多机巡检 / 灰度对比（dev/staging/prod 平铺为多窗格）
- 跨主机故障排查
- 用户说"在 xxx 服务器上看一下..."时，对照本清单找到对应 sessionId`,
        parameters: {
          type: 'object',
          properties: {}
        }
      },
      _meta: {
        supportedModes: ['local', 'ssh', 'assistant'],
        parallelizable: true,
        allowedForSubAgent: false,
      }
    } as ToolDefinitionWithMeta,

    // ==================== 发消息给用户 ====================
    {
      type: 'function',
      function: {
        name: 'talk_to_user',
        description: `向用户发送 IM 消息或应用内推送通知，不会直接展示在桌面对话中。用于后台主动触达用户（如关切触发、唤醒、定时提醒、后台任务完成通知等）。`,
        parameters: {
          type: 'object',
          properties: {
            message: {
              type: 'string',
              description: '要发送给用户的消息内容'
            },
            title: {
              type: 'string',
              description: '消息标题（可选，一般为你的名字，指定后以卡片形式发送）'
            }
          },
          required: ['message']
        }
      },
      _meta: {
        streamDisplay: { titleKey: 'im.tool_send_notification', titleField: 'message' },
        allowedForSubAgent: false,
      }
    } as ToolDefinitionWithMeta,

  ]

  // 根据运行模式过滤工具
  let filteredTools: ToolDefinition[] = builtinTools
  if (options?.mode) {
    filteredTools = builtinTools.filter(tool => {
      const meta = (tool as ToolDefinitionWithMeta)._meta
      // 没有 _meta 或没有 supportedModes 的工具支持所有模式
      if (!meta?.supportedModes) return true
      // 检查当前模式是否在支持列表中
      return meta.supportedModes.includes(options.mode!)
    })
  }

  // IM 通道专属工具：所有 IM 平台均可发送文件和图片
  const imPlatformMeta: Record<string, { name: string; fileLimit: string; imageLimit: string }> = {
    dingtalk: { name: '钉钉', fileLimit: '20MB', imageLimit: '20MB' },
    feishu:   { name: '飞书', fileLimit: '30MB', imageLimit: '10MB' },
    slack:    { name: 'Slack', fileLimit: '1GB', imageLimit: '1GB' },
    telegram: { name: 'Telegram', fileLimit: '50MB', imageLimit: '10MB' },
    wecom:    { name: '企业微信', fileLimit: '20MB', imageLimit: '20MB' },
    wechat:   { name: '微信', fileLimit: '20MB', imageLimit: '20MB' },
  }
  const imMeta = options?.remoteChannel ? imPlatformMeta[options.remoteChannel] : undefined
  if (imMeta) {
    filteredTools.push({
      type: 'function',
      function: {
        name: 'send_to_chat',
        description: `发送本地文件或图片到当前${imMeta.name}聊天。
- image：同步发送，立即返回结果。
- file：异步上传，返回 task_id，需调用 await_file_transfer 等待结果。

**限制**：文件 ≤${imMeta.fileLimit}，图片 ≤${imMeta.imageLimit}，一次一个文件。`,
        parameters: {
          type: 'object',
          properties: {
            file_path: {
              type: 'string',
              description: '文件的绝对路径'
            },
            type: {
              type: 'string',
              enum: ['file', 'image'],
              description: '发送类型：image（图片，内联显示）或 file（文件附件，异步上传）。默认 file'
            },
            file_name: {
              type: 'string',
              description: 'type=file 时可选，自定义文件名'
            }
          },
          required: ['file_path']
        }
      },
      _meta: { allowedForSubAgent: false }
    } as ToolDefinitionWithMeta)

    filteredTools.push({
      type: 'function',
      function: {
        name: 'await_file_transfer',
        description: `等待 send_to_chat(type=file) 返回的异步上传任务完成。
- 任务完成（成功/失败）立即返回。
- 若 wait_seconds 内仍在上传，返回 isRunning=true，可再次调用继续等待。
- 整个上传只要有数据在流动就不会中断，wait_seconds 仅控制本次调用的阻塞时长。`,
        parameters: {
          type: 'object',
          properties: {
            task_id: {
              type: 'string',
              description: 'send_to_chat 返回的 task_id（格式 ft-N）'
            },
            wait_seconds: {
              type: 'number',
              description: '本次最多等待秒数（1-300，默认 30）'
            }
          },
          required: ['task_id']
        }
      },
      _meta: { allowedForSubAgent: false }
    } as ToolDefinitionWithMeta)
  }

  // 查看/压缩 + 取回归档从一开始就在。记忆管理仍按水位打开。
  filteredTools.push(...getAlwaysOnContextTools())
  if (options?.includeContextTools) {
    filteredTools.push(...getMemoryManagementTools())
  }

  if (options?.mode === 'assistant') {
    filteredTools.push(...(ASSISTANT_WORKBENCH_AGENT_TOOLS as unknown as ToolDefinitionWithMeta[]))
    // 终端工具组随「终端」技能装上：这场有了终端才有，开窗入口 manage_pane 一直在
  }

  // 终端工作台（local / ssh）：注入 PTY 终端工具（execute_command 等）
  // 工具由 terminal 工作台贡献，等价于 assistant 工作台贡献 list_workbench_artifacts 等
  if (options?.mode === 'local' || options?.mode === 'ssh') {
    filteredTools.push(...(getAllTerminalTools() as ToolDefinitionWithMeta[]))
  }

  // 注意：保留 _meta 字段，让 Agent 基类能通过 getMetaByName 查到工具的元数据
  // （phase / parallelizable / streamDisplay 等运行时决策都依赖此元数据）。
  // 真正发给 LLM 之前由 stripToolMeta 在调用方剥离，避免浪费 token。
  // 添加插件工具
  if (pluginRegistry) {
    filteredTools.push(...pluginRegistry.getToolDefinitions())
  }

  // MCP：始终渐进披露（skill load mcp:…）；已 load server 的 schema 追加末尾
  if (mcpService?.shouldDeferTools()) {
    const loadedServers = options?.mcpToolSession?.getLoadedServerIds() ?? []
    const loadedDefs = mcpService.getToolDefinitionsByServerIds(loadedServers)
    filteredTools = [...filteredTools, ...loadedDefs]
  }

  if (options?.unattended) return filterUnattendedTools(filteredTools)

  return filteredTools
}

/**
 * 移除会阻塞等待用户输入的工具（无人值守时用）。
 *
 * 工具清单是环境描述的一部分——这个环境里确实没有可应答的人，就不该让该能力出现。
 * 判据取 `_meta.lifecycle.blocksUntilUserInput`，不硬编码工具名：将来任何新增的
 * 「阻塞等人回答」工具自动适用。
 *
 * 独立导出是因为工具有多个来源：`getAgentTools` 覆盖内置 / 插件 / MCP，而技能加载的
 * 工具在 `SkillSession` 合并之后才成形，需要在最终列表上再过一次。
 */
export function filterUnattendedTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.filter(
    tool => !(tool as ToolDefinitionWithMeta)._meta?.lifecycle?.blocksUntilUserInput
  )
}

/**
 * 伙计工具清单：只看元数据，不认工具名。默认能用。
 */
export function filterSubAgentTools(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools
    .filter(tool => (tool as ToolDefinitionWithMeta)._meta?.allowedForSubAgent !== false)
    .map(tool => {
      const alt = (tool as ToolDefinitionWithMeta)._meta?.descriptionForSubAgent
      if (!alt) return tool
      return {
        ...tool,
        function: { ...tool.function, description: alt }
      }
    })
}

/**
 * 剥离 ToolDefinition 上的 `_meta` 字段，得到可以安全发给 LLM 的形态。
 *
 * Agent 内部工具列表（`getAgentTools()` 返回值）保留 `_meta` 用于运行时决策；
 * 在真正调用 AI Service 之前调用本函数清理，避免把内部元数据当作 token 发出去。
 */
export function stripToolMeta(tools: readonly ToolDefinition[]): ToolDefinition[] {
  return tools.map(tool => {
    const { _meta, ...clean } = tool as ToolDefinitionWithMeta
    void _meta
    return clean as ToolDefinition
  })
}

/**
 * 查看/压缩：从一开始就在。取回归档已并进 recall。
 */
function getAlwaysOnContextTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'context',
        description: `查看或压缩当前对话占用的上下文。

- check：只回报已用 / 上限 / 剩余（估算，含本轮新增）。不附带该不该压的判断。
- compress：把较早的过程收成交接小结并归档，可用 recall(archive_id) 取回。

该不该自己压，以系统说明里的取向为准。查的时候只给你报数。

compress 的 summary 是写给未来的你自己的——压缩后你将基于它和最近的对话继续完成任务，必须包含：
1. 任务目标：用户最初要求做什么（一句话）
2. 当前进度：已完成哪些步骤、进行到哪一步（有次序的写清数字，如"已处理 30/57，第 31 份进行中"）
3. 关键结论：到目前为止的结论、发现、重要数据；评审/分析类任务逐项保留要点；涉及的文件保留完整路径
4. 下一步：接下来要立即执行的动作

只保留对完成任务有用的信息（工具原始输出、重复内容、试错过程不写）；已保存到文件的指针（路径）必须原样保留，不得改写。`,
        parameters: {
          type: 'object',
          properties: {
            action: {
              type: 'string',
              enum: ['check', 'compress'],
              description: 'check 查看用量；compress 压缩较早过程。省略且未写 summary 时按 check。'
            },
            summary: {
              type: 'string',
              description: 'compress 时必填。被压缩内容的小结（写给未来的自己）：任务目标、当前进度（含数字）、关键结论/数据/文件完整路径、下一步'
            },
            keep_recent: {
              type: 'number',
              description: 'compress 时可选。保留最近多少组消息（assistant + tool 响应）不压缩，默认 4'
            }
          }
        }
      },
      _meta: {
        streamDisplay: { titleKey: contextToolTitleKey },
        allowedForSubAgent: false,
      }
    } as ToolDefinitionWithMeta
  ]
}

function getMemoryManagementTools(): ToolDefinition[] {
  return [
    {
      type: 'function',
      function: {
        name: 'manage_memory',
        description: `管理历史任务记忆。suggestions 设置压缩级别（0=完整 1=工具摘要 2=请求+回复 3=结构化摘要 4=一句话），discard 丢弃不需要的任务。`,
        parameters: {
          type: 'object',
          properties: {
            suggestions: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  task_id: { type: 'string', description: '任务 ID' },
                  level: { type: 'number', description: '压缩级别（0-4）' },
                  reason: { type: 'string', description: '设置该级别的简要原因' }
                },
                required: ['task_id', 'level']
              },
              description: '对历史任务的压缩级别建议'
            },
            discard: {
              type: 'array',
              items: { type: 'string' },
              description: '要完全丢弃的任务 ID 列表'
            }
          }
        }
      }
    } as ToolDefinitionWithMeta
  ]
}
