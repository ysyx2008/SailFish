import type { ToolDefinition } from '../ai.service'

type BenchToolProperties = ToolDefinition['function']['parameters']['properties']

function tool(
  name: string,
  description: string,
  properties: BenchToolProperties,
  required: string[],
): ToolDefinition {
  return {
    type: 'function',
    function: {
      name,
      description,
      parameters: { type: 'object', properties, required },
    },
  }
}

/**
 * 冻住的工具清单：形状和份量像旗鱼助手真在发，内容不跟运行时工具表走。
 */
export const BENCH_TOOLS: ToolDefinition[] = [
  tool('exec', `【在本机执行 Shell 命令】通过本机 shell 执行命令字符串，支持管道/&&/重定向/脚本内联。不支持交互式命令(vim/nano/tmux)。

安全规则（命中标为 dangerous，strict/relaxed 需确认；free 放行）：
- 解释器内联代码（node -e / python -c / bash -c）会被标记为危险
- 包装器/调度器（sudo / env / docker / ssh / make / npx）会被标记为危险
- 如需运行脚本，直接用 exec 跑脚本文件

等待与转后台：wait_seconds 内结束返回完整结果，超时转后台返回 task_id。`, {
    command: { type: 'string', description: '要执行的 shell 命令' },
    cwd: { type: 'string', description: '本机工作目录（可选）' },
    wait_seconds: { type: 'number', description: '同步等待秒数（默认 60，最大 600）' },
    max_seconds: { type: 'number', description: '命令最长允许运行时间（默认 3600）' },
    skill_id: { type: 'string', description: '技能 ID（可选），注入该技能的环境变量' },
  }, ['command']),

  tool('await_exec', `等待 exec 转后台的任务结束、命中关键输出、或返回最新进度。
- 等任务结束：await_exec(task_id, wait_seconds: 60)
- 等关键日志：await_exec(task_id, pattern: "Listening on")
- 查看当前进度：await_exec(task_id, wait_seconds: 1)`, {
    task_id: { type: 'string', description: 'exec 转后台时返回的 task_id' },
    wait_seconds: { type: 'number', description: '最长等待秒数（默认 30，最大 600）' },
    pattern: { type: 'string', description: '可选正则，命中即返回' },
  }, ['task_id']),

  tool('read_file', '读取本地文件。支持文本、PDF、Word、WPS、图片。大文件先用 info_only 查信息，再按行范围读取。远程文件请用命令行。', {
    path: { type: 'string', description: '文件路径（绝对路径或相对于当前目录）' },
    info_only: { type: 'boolean', description: '仅获取文件信息，不读取内容' },
    start_line: { type: 'number', description: '起始行号（从1开始）' },
    end_line: { type: 'number', description: '结束行号（包含）' },
    max_lines: { type: 'number', description: '从开头读取的最大行数' },
    tail_lines: { type: 'number', description: '从末尾读取的行数' },
  }, ['path']),

  tool('file_search', '快速搜索本地文件名（基于系统索引）。多个关键词用空格分隔表示同时包含。仅搜文件名不搜内容，搜内容请用 grep。', {
    query: { type: 'string', description: '搜索关键词，空格分隔为 AND' },
    path: { type: 'string', description: '限制搜索目录（可选）' },
    type: { type: 'string', enum: ['file', 'dir', 'all'], description: '搜索类型' },
    limit: { type: 'number', description: '最大结果数量，默认 50' },
  }, ['query']),

  tool('search_knowledge', '搜索用户的知识库文档。搜索结果已包含文档内容，直接使用即可。', {
    query: { type: 'string', description: '简短的搜索词，1-3 个核心关键词' },
    limit: { type: 'integer', description: '返回结果数量，默认 5，范围 1-20' },
  }, ['query']),

  tool('get_knowledge_doc', '按文档 ID 精确获取知识库中的完整文档。用户通过 @docs 引用时使用。', {
    doc_id: { type: 'string', description: '文档 ID，从用户消息中的 doc_id:xxx 获取' },
  }, ['doc_id']),

  tool('web_search', '搜索互联网获取实时信息。返回标题、URL、摘要。若系统提示里的专用能力已覆盖所需数据，优先用专用工具。', {
    query: { type: 'string', description: '搜索查询词' },
    max_results: { type: 'number', description: '最大结果数（默认 5，最大 10）' },
  }, ['query']),

  tool('web_fetch', `按 URL 抓取一个具体网页，返回可读文本。
适用：用户给的链接、或 web_search 拿到候选后看详情。
不适用：需要登录的页面；PDF/图片/视频请改用 exec 下载后再 read_file。`, {
    url: { type: 'string', description: '要抓取的 http(s) URL' },
    timeout: { type: 'number', description: '总耗时上限（秒），默认 30，最大 60' },
  }, ['url']),

  tool('edit_file', '查找替换修改本地文件。使用前必须先 read_file。old_text 必须从读到的内容精确复制且唯一匹配。创建新文件请用 write_text_file。', {
    path: { type: 'string', description: '本地文件路径' },
    old_text: { type: 'string', description: '要替换的原始文本，须完全匹配' },
    new_text: { type: 'string', description: '替换后的新文本' },
    replace_all: { type: 'boolean', description: '替换所有匹配（默认 false）' },
  }, ['path', 'old_text', 'new_text']),

  tool('write_text_file', '写入或创建本地纯文本文件。部分修改请优先用 edit_file。目标已存在且要整文件重写时用 mode="overwrite"。', {
    path: { type: 'string', description: '本地文件路径' },
    mode: { type: 'string', enum: ['create', 'overwrite', 'append', 'insert', 'replace_lines', 'regex_replace'], description: '写入方式' },
    content: { type: 'string', description: '文件内容' },
    insert_at_line: { type: 'number', description: 'insert: 插入行号' },
    start_line: { type: 'number', description: 'replace_lines: 起始行号' },
    end_line: { type: 'number', description: 'replace_lines: 结束行号' },
    pattern: { type: 'string', description: 'regex_replace: 正则' },
    replacement: { type: 'string', description: 'regex_replace: 替换内容' },
    replace_all: { type: 'boolean', description: 'regex_replace: 替换全部' },
  }, ['path', 'mode']),

  tool('write_remote_text_file', '通过 SFTP 写入远程纯文本文件。路径不支持 ~。局部修改请用命令行 sed/awk。', {
    path: { type: 'string', description: '远程文件路径' },
    mode: { type: 'string', enum: ['create', 'overwrite', 'append'], description: '写入方式' },
    content: { type: 'string', description: '文件内容' },
  }, ['path', 'mode', 'content']),

  tool('sftp_put', '通过 SFTP 上传本地文件到远程主机。适合大文件或二进制。短文本配置仍首选 write_remote_text_file。', {
    local_path: { type: 'string', description: '本地源文件绝对路径' },
    remote_path: { type: 'string', description: '远程目标绝对路径' },
    overwrite: { type: 'boolean', description: '远程已存在时是否覆盖' },
    pane_id: { type: 'string', description: '指定 SSH 窗格 ptyId' },
  }, ['local_path', 'remote_path']),

  tool('sftp_get', '通过 SFTP 下载远程文件到本地。省略 local_path 时落到工作空间根目录。', {
    remote_path: { type: 'string', description: '远程源文件绝对路径' },
    local_path: { type: 'string', description: '本地目标路径（可选）' },
    pane_id: { type: 'string', description: '指定 SSH 窗格 ptyId' },
  }, ['remote_path']),

  tool('skill', `加载或卸载这场对话里的技能。系统自带的、用户自己写的、已连接的外部工具包都走这一条。
可用技能：excel, word, pdf, email, browser, calendar, todo, chart, personality, skill-manager`, {
    action: { type: 'string', enum: ['load', 'unload'], description: 'load 或 unload' },
    skill_id: { type: 'string', description: '技能 ID 或 mcp:<serverId>' },
  }, ['action', 'skill_id']),

  tool('ask_user', '向用户提问并等待回答。只在缺关键信息、无法继续时使用。', {
    question: { type: 'string', description: '要问用户的问题' },
    options: { type: 'array', items: { type: 'string' }, description: '可选的选项列表' },
  }, ['question']),

  tool('plan', '写下或更新当前任务的计划。复杂多步任务先规划再执行。', {
    action: { type: 'string', enum: ['write', 'update', 'complete'], description: '操作' },
    content: { type: 'string', description: '计划正文（write/update 时必填）' },
  }, ['action']),

  tool('recall', '取回更早一轮对话或刚收起来的原文。需要完整经历时用，不占日常上下文。', {
    task_id: { type: 'string', description: '任务 ID 或 archive_id' },
    detail: { type: 'string', enum: ['summary', 'full'], description: '摘要或全文' },
  }, ['task_id']),

  tool('search_history', '按关键词搜索历史对话记录。', {
    query: { type: 'string', description: '搜索词' },
    limit: { type: 'number', description: '最多返回条数，默认 10' },
  }, ['query']),

  tool('dispatch_agents', '分派轻量子任务并行执行。仅本机和助手模式可用。', {
    tasks: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          prompt: { type: 'string', description: '子任务说明' },
          type: { type: 'string', enum: ['explore', 'edit', 'research'], description: '子 Agent 类型' },
        },
        required: ['prompt'],
      },
      description: '子任务列表',
    },
    wait: { type: 'boolean', description: '是否同步等待全部完成' },
  }, ['tasks']),

  tool('wait_agents', '等待已分派的子 Agent 结束。', {
    agent_ids: { type: 'array', items: { type: 'string' }, description: '要等待的子 Agent ID' },
    timeout_seconds: { type: 'number', description: '最长等待秒数' },
  }, ['agent_ids']),

  tool('manage_pane', `管理终端窗格：list / open / split / close / focus。
open：打开一扇真终端。可选 target：不传或 local 开本机，ssh:<sessionId> 连已有会话。`, {
    action: { type: 'string', enum: ['list', 'open', 'split', 'close', 'focus'], description: '操作' },
    pane_id: { type: 'string', description: 'close/focus 时必填' },
    target: { type: 'string', description: 'open/split：local 或 ssh:<sessionId>' },
    direction: { type: 'string', enum: ['right', 'down'], description: 'split 方向' },
  }, ['action']),

  tool('list_ssh_sessions', '列出已配置或已连接的 SSH 会话，供 manage_pane 使用。', {}, []),

  tool('talk_to_user', '主动向用户发一条消息（桌面或已接通的即时通讯）。关切和唤醒要找人时走这一条。', {
    message: { type: 'string', description: '要发给用户的正文' },
    channel: { type: 'string', description: '可选渠道：desktop / dingtalk / feishu / wecom / slack / telegram' },
  }, ['message']),

  tool('context', '压缩或查看当前对话上下文。窗口将满时用来交接，释放空间。', {
    action: { type: 'string', enum: ['compact', 'status'], description: 'compact 压缩，status 查看用量' },
    hint: { type: 'string', description: '压缩时给模型的提示（可选）' },
  }, ['action']),

  tool('manage_memory', '更新长期知识文档（用户画像、主机备忘）。只记值得以后自动注入的高频事实。', {
    action: { type: 'string', enum: ['read', 'write'], description: '读或写' },
    scope: { type: 'string', description: '文档范围，如 personal 或主机标识' },
    content: { type: 'string', description: 'write 时的文档正文' },
  }, ['action', 'scope']),
]
