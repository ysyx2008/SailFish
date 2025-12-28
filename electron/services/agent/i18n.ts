/**
 * Agent 模块国际化翻译
 * 用于 tool-executor.ts 等后端模块的 UI 显示文本
 */

import { ConfigService } from '../config.service'

// 翻译键类型
type TranslationKey = keyof typeof translations['zh-CN']

// 翻译文本
const translations = {
  'zh-CN': {
    // 工具名称
    'tool.execute_command': '执行命令',
    'tool.check_terminal_status': '检查终端状态',
    'tool.get_terminal_context': '获取终端上下文',
    'tool.send_control_key': '发送控制键',
    'tool.send_input': '发送输入',
    'tool.read_file': '读取文件',
    'tool.write_file': '写入文件',
    'tool.remember_info': '记住信息',
    'tool.search_knowledge': '搜索知识库',
    'tool.get_knowledge_doc': '获取知识库文档',
    'tool.ask_user': '询问用户',
    'tool.create_plan': '创建计划',
    'tool.update_plan': '更新计划',
    'tool.clear_plan': '清除计划',
    'tool.wait': '等待',

    // 执行状态
    'status.executing': '执行命令',
    'status.timed_execution': '定时执行',
    'status.command_blocked': '命令被阻止',
    'status.terminal_busy': '终端忙碌中，需要等待',
    'status.terminal_not_allowed': '终端状态不允许执行',
    'status.user_rejected': '用户拒绝执行此命令',
    'status.command_running': '命令仍在执行中',
    'status.command_timeout': '命令执行超时',
    'status.command_complete': '命令执行完成',
    'status.command_failed': '命令执行失败',
    'status.command_started': '命令已启动',
    
    // 终端状态
    'terminal.checking_status': '检查终端状态',
    'terminal.status': '终端状态',
    'terminal.status_detection_failed': '状态检测失败',
    'terminal.idle': '空闲，可以执行命令',
    'terminal.busy': '忙碌',
    'terminal.running': '正在执行',
    'terminal.waiting_input': '等待输入',
    'terminal.may_stuck': '可能卡死（长时间无输出）',
    'terminal.check_output': '查看输出判断',
    'terminal.output_lines': '输出 {count} 行',
    'terminal.no_output': '(无输出)',
    'terminal.can_execute': '可执行命令',
    'terminal.cannot_execute': '需要先响应当前输入',
    'terminal.type_ssh': 'SSH 远程终端',
    'terminal.type_local': '本地终端',
    'terminal.ssh_status_hint': 'SSH 终端状态需要根据输出内容判断',
    'terminal.check_by_output': '请根据下方终端输出判断',

    // 等待输入类型
    'input.password': '等待密码输入',
    'input.confirmation': '等待确认',
    'input.selection': '等待选择',
    'input.pager': '分页器模式 (按 q 退出, 空格翻页)',
    'input.editor': '编辑器模式 (无法通过 Agent 操作)',
    'input.prompt': '等待输入',
    'input.custom': '等待自定义输入',
    'input.suggested_response': '建议响应',

    // 输出类型
    'output.progress': '进度输出',
    'output.compilation': '编译输出',
    'output.test': '测试输出',
    'output.log_stream': '日志流',
    'output.error': '错误输出',
    'output.table': '表格输出',
    'output.eta': '预计剩余',
    'output.error_count': '错误数',
    'output.tests_passed': '通过',
    'output.tests_failed': '失败',

    // 生成进度
    'progress.generating': '生成中...',
    'progress.generating_args': '正在生成 {toolName} 参数...',
    'progress.chars': '{count} 字符',

    // Agent 执行状态
    'agent.waiting_confirm': '等待用户确认: {toolName}',
    'agent.preparing_tool': '准备执行工具...',
    'agent.retry_network': '网络请求失败 ({error})，正在重试 ({attempt}/2)...',
    'agent.loop_detected': '检测到执行循环，已自动停止。请尝试用不同方式描述任务。',
    'agent.no_content': 'AI 没有返回任何内容。',
    'agent.no_content_reasons': '可能的原因：\n• 当前模型可能不支持工具调用（Function Calling）\n• 请尝试使用支持 Function Calling 的模型，如 GPT-4、Claude 或 DeepSeek-Chat',
    'agent.plan_incomplete': '计划中还有 {count} 个步骤未完成：\n{steps}\n\n请继续执行这些步骤，并使用 update_plan 更新状态。所有步骤完成后才能给出总结。',
    'agent.execution_error': '执行出错: {error}',
    'agent.tool_error': '错误: {error}',
    'agent.task_complete': '任务完成',
    'agent.unknown_error': '未知错误',
    'agent.interrupt_writing': '正在写入文件，打断可能导致文件损坏',
    'agent.interrupt_command': '正在执行命令，打断可能导致操作不完整',
    'agent.context_ack_single': '好的，我已了解之前的任务执行情况，会结合这个上下文来处理当前任务。',
    'agent.context_ack_multi': '好的，我已了解之前 {count} 个任务的执行情况，会结合这些上下文来处理当前任务。',
    'agent.no_response': 'AI 未返回任何内容',
    
    // 内容压缩
    'compress.lines_omitted': '... [省略 {count} 行] ...',
    'compress.truncated': '... [截断，原长度: {length} 字符]',
    'compress.reply_truncated': '... [回复已截断]',
    'compress.tool_result': '[工具结果] {content}',
    'compress.memory_folding_header': '[系统提示：对话历史已被智能压缩，以下是关键信息摘要]',
    'compress.key_records': '**关键记录**：',
    'compress.ask_for_details': '如需了解更多历史细节，请询问用户。',

    // 历史任务上下文
    'context.tool': '工具',
    'context.args': '参数',
    'context.content': '内容',
    'context.result': '结果',
    'context.task_num': '任务 {num}',
    'context.user_request': '用户请求',
    'context.execution_steps': '执行步骤',
    'context.history_header': '📋 **之前的对话历史（共 {count} 个任务）：**',
    'context.history_footer': '以上是之前的执行记录，请结合这些上下文来处理当前任务。',
    'context.history_summary_header': '📋 **之前的对话历史（AI 摘要）：**',
    'context.history_summary_footer': '请结合以上上下文处理当前任务。',
    'context.summary_prompt': `你是一个技术分析助手。以下是用户之前的 {count} 个任务执行记录，请提炼出关键信息摘要，帮助理解对话上下文。

**要求**：
1. 总结每个任务做了什么
2. 提炼关键的执行结果和发现
3. 标注哪些任务成功、哪些失败或被中止
4. 保留对后续任务可能有用的信息（如发现的路径、配置、问题等）
5. 输出控制在 {tokenLimit} 个 token 以内

---
{context}
---

请用以下格式输出摘要：

**对话摘要**:
[简要总结之前做了什么]

**关键发现**:
[执行过程中发现的重要信息]

**当前状态**:
[系统/任务的当前状态]`,

    // 文件操作
    'file.reading': '读取文件',
    'file.reading_info_only': '读取文件 (仅查询信息)',
    'file.read_success': '文件读取成功',
    'file.read_failed': '文件读取失败',
    'file.file_info': '文件信息',
    'file.file_too_large': '文件过大',
    'file.writing': '写入文件',
    'file.overwrite': '覆盖写入文件',
    'file.append': '追加写入文件',
    'file.create': '新建文件',
    'file.insert_at_line': '在第 {line} 行插入内容',
    'file.replace_lines': '替换第 {start}-{end} 行',
    'file.regex_replace': '正则替换 ({scope})',
    'file.regex_scope_all': '全部',
    'file.regex_scope_first': '首个',
    'file.result_overwritten': '文件已覆盖',
    'file.result_created': '文件已创建',
    'file.result_remote_created': '远程文件已创建',
    'file.result_remote_appended': '内容已追加到远程文件',
    'file.result_remote_written': '远程文件已写入',
    'file.result_appended': '内容已追加到',
    'file.writing_remote': '正在写入文件: {path} ({size} KB)...',
    'file.too_large_error': '文件过大 ({size} MB)，超过完整读取限制 (500KB)。请使用以下方式之一：\n1. 设置 info_only=true 查看文件信息\n2. 使用 start_line 和 end_line 读取指定行范围\n3. 使用 max_lines 读取前N行\n4. 使用 tail_lines 读取最后N行',
    'file.info_header': '文件信息',
    'file.info_path': '路径',
    'file.info_size': '大小',
    'file.info_size_value': '{sizeMB} MB ({sizeBytes} 字节)',
    'file.info_lines': '总行数',
    'file.info_lines_value': '{count} 行',
    'file.info_estimated': '(估算值)',
    'file.info_suggestion': '建议',
    'file.info_suggestion_large': '文件较大，建议使用以下方式读取特定部分：\n  - `start_line` 和 `end_line`: 读取指定行范围\n  - `max_lines`: 读取前N行（如 `max_lines: 100`）\n  - `tail_lines`: 读取最后N行（如 `tail_lines: 50`）',
    'file.info_suggestion_small': '文件大小在限制内，可以完整读取',
    'file.info_preview': '文件预览（前10行）',
    'file.result_inserted': '已在第 {line} 行插入 {count} 行内容',
    'file.result_replaced_lines': '已替换第 {start}-{end} 行（共 {deleteCount} 行）为 {newCount} 行新内容',
    'file.result_regex_replaced': '已替换 {count} 处匹配内容',
    'file.writing_progress': '正在写入文件...',
    'file.write_success': '文件写入成功',
    'file.write_failed': '文件写入失败',
    'file.user_rejected_write': '用户拒绝写入文件',
    'file.establishing_sftp': '正在建立 SFTP 连接...',
    'file.remote_write_failed': '远程文件写入失败',
    'file.full_read': '完整读取',
    'file.actual_read': '实际读取: {lines} 行, {chars} 字符',
    'file.read_line_range': '读取行范围: {start}-{end}',
    'file.read_first_n': '读取前 {count} 行',
    'file.read_last_n': '读取最后 {count} 行',
    'file.end_of_file': '末尾',

    // 时间格式
    'time.minutes_seconds': '{minutes}分{seconds}秒',
    'time.seconds': '{seconds}秒',
    'time.minutes': '{minutes}分钟',

    // 计划步骤
    'plan.step_prefix': '步骤 {index}',

    // 控制键
    'control.send_key': '发送控制键',
    'control.key_sent': '已发送',
    'control.key_sent_result': '控制键已发送',
    'control.key_sent_output': '已发送 {key}。',
    'control.key_sent_with_output': '已发送 {key}。\n\n终端最新输出:\n{output}',
    'control.send_failed': '发送失败',

    // 发送输入
    'input.send': '发送输入',
    'input.sent': '已发送',
    'input.waiting_for': '等待{type}',
    'input.sent_output': '已发送输入 {input}。',
    'input.sent_with_output': '已发送输入 {input}。\n\n终端最新输出:\n{output}',
    'input.send_failed': '发送失败',

    // 获取上下文
    'context.get_output': '获取终端输出',

    // 密码相关
    'password.enter_in_terminal': '请在终端中输入密码',
    'password.prompt': '提示',
    'password.waiting_long': '已等待较长时间，请尽快输入或按 Ctrl+C 取消',
    'password.sudo_timeout': 'sudo 命令执行超时',
    'password.verification_complete': '密码验证完成',

    // MCP 工具
    'mcp.calling_tool': '[MCP] 调用工具',
    'mcp.tool_success': '[MCP] 工具执行成功',
    'mcp.tool_failed': '[MCP] 工具执行失败',
    'mcp.error': '[MCP] 错误',

    // 提示信息
    'hint.long_running_command': '这是一个长耗时命令，超时不代表失败。建议使用 wait 工具等待一段时间后再检查状态。',
    'hint.command_cannot_execute': '无法执行',
    'hint.security_blocked': '该命令被安全策略阻止执行',
    'hint.command_empty': '命令不能为空',
    'hint.wait_terminal': '终端正在执行其他命令，无法立即执行新命令。',
    'hint.wait_suggestions': '建议：\n1. 使用 wait 工具等待当前命令完成（如 60-120 秒）\n2. 使用 check_terminal_status 检查终端状态\n3. 如果需要中断当前命令，使用 send_control_key("ctrl+c")',
    'hint.cannot_execute_reason': '无法执行命令',

    // 错误提示
    'error.execution_failed': '执行失败。请分析错误信息，考虑更换方法或向用户请求帮助。',
    'error.transient': '这是一个暂时性错误，可以稍后重试。',
    'error.permission': '权限不足。建议：1) 检查文件/目录权限；2) 尝试使用 sudo（如果合适）；3) 确认用户是否有相应权限。',
    'error.not_found': '资源不存在。建议：1) 检查路径是否正确；2) 使用 ls 或 find 确认文件位置；3) 检查命令是否已安装。',
    'error.timeout': '命令执行超时，但可能仍在运行中。建议：1) 先用 check_terminal_status 确认是否还在执行；2)  再用 get_terminal_context 查看终端最新输出，了解执行进度；3) 如果确实卡住了再用 send_control_key 发送 Ctrl+C。',
    'error.knowledge_not_available': '知识库未启用，无法保存记忆',

    // 记忆功能
    'memory.remember': '记住信息',
    'memory.remembered': '已记住',
    'memory.remembered_knowledge': '已记住 (知识库, 共 {count} 条记忆)',
    'memory.cannot_save': '无法保存: 知识库未启用',
    'memory.skip_dynamic': '跳过 (纯动态数据)',
    'memory.skip_duplicate': '跳过 (与已有记忆重复)',
    'memory.merged': '记忆已合并更新',
    'memory.replaced': '记忆已更新替换',

    // 知识库搜索
    'knowledge.search': '搜索知识库',
    'knowledge.not_initialized': '知识库服务未初始化',
    'knowledge.not_enabled': '知识库未启用',
    'knowledge.no_results': '未找到相关内容',
    'knowledge.found_results': '找到 {count} 条相关内容 ({chars} 字符)',
    'knowledge.search_failed': '搜索失败',
    'knowledge.getting_doc': '获取文档: {id}',
    'knowledge.doc_not_found': '文档不存在: {id}',
    'knowledge.doc_retrieved': '已获取文档 {filename} ({chars} 字符)',
    'knowledge.get_doc_failed': '获取文档失败',

    // 等待功能
    'wait.planned': '⏱️ 计划等待 {total}，剩余 {remaining}',
    'wait.progress': '⏱️ 计划等待 {total}，剩余 {remaining} ({progress}%)',
    'wait.new_message': '📨 收到新消息！已等待 {elapsed}，原计划还剩 {remaining}',
    'wait.stopped': '🛑 好的，停下来了。已等待 {elapsed}',
    'wait.complete': '✅ 等待完成，共等待 {total}',

    // 计划功能
    'plan.create': '创建计划',
    'plan.update': '更新计划',
    'plan.cleared': '计划已归档',
    'plan.auto_cleared': '旧计划已自动归档',
    'plan.no_active_plan_to_clear': '当前没有活动的计划需要归档',

    // 定时执行
    'timed.command_executed': '命令执行了 {seconds} 秒 ({chars} 字符)',

    // 通用错误
    'error.unknown': '未知错误',
    'error.request_error': '请求错误: {message}',
    'error.request_aborted': '请求已中止',
    'error.api_request_failed': 'AI API 请求失败: {status} - {data}',
    'error.operation_aborted': '操作已中止',
    'error.tool_param_parse_failed': '工具参数解析失败',
    'error.unknown_tool': '未知工具: {name}',
    'error.mcp_not_initialized': 'MCP 服务未初始化',
    'error.invalid_mcp_tool_name': '无效的 MCP 工具名称: {name}',
    'error.mcp_server_not_connected': 'MCP 服务器 {server} 未连接',
    'error.user_rejected_command': '用户拒绝执行该命令',
    'error.command_timeout_with_hint': '命令执行超时。{suggestion}',
    'error.command_still_running': '命令仍在后台执行中。建议：\n1. 使用 wait 工具等待一段时间（如 60-180 秒）\n2. 然后使用 check_terminal_status 确认执行状态\n3. 使用 get_terminal_context 查看最新输出',
    'error.recovery_hint': '{error}\n\n💡 恢复建议: {suggestion}',
    'error.check_terminal_status': '命令执行超时。请检查终端状态。',
    'error.get_terminal_output_failed': '获取终端输出失败: {error}',
    'error.terminal_output_empty': '(终端输出为空)',

    // 控制键错误
    'error.control_key_required': '必须指定要发送的控制键',
    'error.control_key_not_supported': '不支持的控制键: {key}',

    // 输入错误
    'error.input_text_required': '必须指定要发送的文本',
    'error.input_text_too_long': '输入文本过长（最大 1000 字符），请使用 write_file 工具处理大量内容',

    // 文件错误
    'error.file_path_required': '文件路径不能为空',
    'error.file_exists_cannot_create': '文件已存在，无法创建: {path}。如需覆盖请使用 mode=\'overwrite\'',
    'error.sftp_not_initialized': 'SFTP 服务未初始化，无法写入远程文件。请检查 SSH 连接状态。',
    'error.ssh_config_unavailable': '无法获取 SSH 连接配置，无法写入远程文件。',
    'error.invalid_write_mode': '无效的写入模式: {mode}，支持的模式: {modes}',
    'error.content_required_for_mode': '{mode} 模式需要提供 content 参数',
    'error.insert_content_required': 'insert 模式需要提供 content 参数',
    'error.insert_line_required': 'insert 模式需要提供有效的 insert_at_line 参数（从1开始）',
    'error.replace_content_required': 'replace_lines 模式需要提供 content 参数',
    'error.replace_start_line_required': 'replace_lines 模式需要提供有效的 start_line 参数（从1开始）',
    'error.replace_end_line_required': 'replace_lines 模式需要提供有效的 end_line 参数（必须 >= start_line）',
    'error.regex_pattern_required': 'regex_replace 模式需要提供 pattern 参数',
    'error.regex_replacement_required': 'regex_replace 模式需要提供 replacement 参数',
    'error.ssh_mode_not_supported': 'SSH 远程终端不支持 {mode} 模式，仅支持 overwrite、create 和 append。如需局部修改，请使用 execute_command 执行 sed/awk 等命令',
    'error.ssh_content_required': 'SSH 远程文件写入需要提供 content 参数',
    'error.file_not_exists_for_insert': '文件不存在，无法执行插入操作',
    'error.file_not_exists_for_replace': '文件不存在，无法执行行替换操作',
    'error.start_line_exceeds_total': '起始行 {start} 超出文件总行数 {total}',
    'error.file_not_exists_for_regex': '文件不存在，无法执行正则替换操作',
    'error.invalid_regex_pattern': '无效的正则表达式: {pattern}',
    'error.regex_no_match': '未找到匹配的内容: {pattern}',

    // 记忆错误
    'error.info_required': '信息不能为空',
    'error.cannot_save_unknown_host': '无法保存：主机ID未知',
    'error.query_required': '查询内容不能为空',
    'error.knowledge_not_initialized': '知识库服务未初始化',
    'error.knowledge_not_enabled': '知识库未启用，请在设置中开启',

    // 等待/询问错误
    'error.wait_seconds_positive': '等待秒数必须是正数',
    'error.question_required': '问题不能为空',
    'error.user_reply_timeout': '等待用户回复超时（5分钟）。你可以：1) 再次询问用户；2) 采用合理的默认方案；3) 向用户说明需要更多信息才能继续。',

    // 计划错误
    'error.plan_title_required': '计划标题不能为空',
    'error.plan_steps_required': '计划步骤不能为空',
    'error.plan_steps_max': '计划步骤最多 10 个',
    'error.plan_exists': '已存在计划"{title}"，请先完成当前计划或使用 update_plan 更新步骤状态',
    'error.plan_exists_use_clear': '已存在进行中的计划"{title}"。如需重新规划，请先使用 clear_plan 清除当前计划',
    'error.step_index_positive': '步骤索引必须是非负整数',
    'error.invalid_plan_status': '无效的状态，可选值: {statuses}',
    'error.no_active_plan': '当前没有执行中的计划，请先使用 create_plan 创建计划',
    'error.step_index_out_of_range': '步骤索引超出范围，计划共有 {count} 个步骤（索引 0-{max}）',

    // 成功消息
    'success.dynamic_data_skip': '此信息为纯动态数据，不适合长期记忆',
    'success.info_saved_to_knowledge': '信息已保存到知识库 (当前主机共 {count} 条记忆)',
    'success.no_knowledge_found': '知识库中未找到与查询相关的内容',

    // 等待相关
    'wait.user_message': '用户发来消息："{message}"\n\n已等待 {elapsed}，原计划还剩 {remaining}。\n请根据用户消息决定下一步：如果用户说不用等了/快好了，可以立即检查终端状态；如果用户说还要等/没那么快，可以再次调用 wait 继续等待。',
    'wait.aborted': '操作已中止，等待了 {elapsed}。',
    'wait.finished': '已等待 {total}，继续执行。现在你可以检查终端状态或继续其他操作。',

    // 询问相关
    'ask.waiting_reply': '⏳ 等待回复中...',
    'ask.cancelled': '🛑 已取消',
    'ask.waiting_remaining': '⏳ 等待回复中...（剩余 {remaining}）',
    'ask.received': '✅ {response}',
    'ask.empty': '(空)',
    'ask.user_replied': '用户回复：{response}\n\n请根据用户的回复继续执行任务。',
    'ask.user_no_content': '(用户未提供内容)',
    'ask.timeout': '⏰ 等待超时',
    'ask.using_default': '用户未在 5 分钟内回复，使用默认值：{default}\n\n请使用默认值继续执行任务。',

    // 命令执行
    'command.initial_output': '初始输出:\n{output}\n\n💡 {hint}',
    'command.no_output': '命令执行了 {seconds} 秒，但没有输出内容。',

    // 其他
    'misc.yes': '是',
    'misc.no': '否',
    'misc.duration': '耗时',
    'misc.characters': '字符',
    'misc.seconds': '秒',
    
    // AI 思考
    'ai.thinking': '思考中...',
    'ai.thinking_with_emoji': '🤔 **思考中...**\n\n> ',
    'ai.preparing': '正在准备...',
  },
  'en-US': {
    // Tool names
    'tool.execute_command': 'Execute Command',
    'tool.check_terminal_status': 'Check Terminal Status',
    'tool.get_terminal_context': 'Get Terminal Context',
    'tool.send_control_key': 'Send Control Key',
    'tool.send_input': 'Send Input',
    'tool.read_file': 'Read File',
    'tool.write_file': 'Write File',
    'tool.remember_info': 'Remember Info',
    'tool.search_knowledge': 'Search Knowledge',
    'tool.get_knowledge_doc': 'Get Knowledge Doc',
    'tool.ask_user': 'Ask User',
    'tool.create_plan': 'Create Plan',
    'tool.update_plan': 'Update Plan',
    'tool.clear_plan': 'Clear Plan',
    'tool.wait': 'Wait',

    // Execution status
    'status.executing': 'Executing',
    'status.timed_execution': 'Timed execution',
    'status.command_blocked': 'Command blocked',
    'status.terminal_busy': 'Terminal busy, please wait',
    'status.terminal_not_allowed': 'Terminal state not allowed',
    'status.user_rejected': 'User rejected this command',
    'status.command_running': 'Command still running',
    'status.command_timeout': 'Command execution timeout',
    'status.command_complete': 'Command completed',
    'status.command_failed': 'Command execution failed',
    'status.command_started': 'Command started',

    // Terminal status
    'terminal.checking_status': 'Checking terminal status',
    'terminal.status': 'Terminal status',
    'terminal.status_detection_failed': 'Status detection failed',
    'terminal.idle': 'Idle, ready for commands',
    'terminal.busy': 'Busy',
    'terminal.running': 'Running',
    'terminal.waiting_input': 'Waiting for input',
    'terminal.may_stuck': 'May be stuck (no output for a long time)',
    'terminal.check_output': 'Check output to determine',
    'terminal.output_lines': '{count} lines of output',
    'terminal.no_output': '(no output)',
    'terminal.can_execute': 'Can execute commands',
    'terminal.cannot_execute': 'Need to respond to current input first',
    'terminal.type_ssh': 'SSH Remote Terminal',
    'terminal.type_local': 'Local Terminal',
    'terminal.ssh_status_hint': 'SSH terminal status needs to be determined by output content',
    'terminal.check_by_output': 'Please check the terminal output below to determine',

    // Input wait types
    'input.password': 'Waiting for password input',
    'input.confirmation': 'Waiting for confirmation',
    'input.selection': 'Waiting for selection',
    'input.pager': 'Pager mode (press q to quit, space to scroll)',
    'input.editor': 'Editor mode (cannot operate via Agent)',
    'input.prompt': 'Waiting for input',
    'input.custom': 'Waiting for custom input',
    'input.suggested_response': 'Suggested response',

    // Output types
    'output.progress': 'Progress output',
    'output.compilation': 'Compilation output',
    'output.test': 'Test output',
    'output.log_stream': 'Log stream',
    'output.error': 'Error output',
    'output.table': 'Table output',
    'output.eta': 'ETA',
    'output.error_count': 'Error count',
    'output.tests_passed': 'Passed',
    'output.tests_failed': 'Failed',

    // Generation progress
    'progress.generating': 'Generating...',
    'progress.generating_args': 'Generating {toolName} args...',
    'progress.chars': '{count} chars',

    // Agent execution status
    'agent.waiting_confirm': 'Waiting for confirmation: {toolName}',
    'agent.preparing_tool': 'Preparing to execute tool...',
    'agent.retry_network': 'Network request failed ({error}), retrying ({attempt}/2)...',
    'agent.loop_detected': 'Execution loop detected, stopped automatically. Please try describing the task differently.',
    'agent.no_content': 'AI returned no content.',
    'agent.no_content_reasons': 'Possible reasons:\n• The current model may not support tool calling (Function Calling)\n• Please try using a model that supports Function Calling, such as GPT-4, Claude, or DeepSeek-Chat',
    'agent.plan_incomplete': '{count} steps in the plan are incomplete:\n{steps}\n\nPlease continue executing these steps and use update_plan to update status. Provide summary only after all steps are completed.',
    'agent.execution_error': 'Execution error: {error}',
    'agent.tool_error': 'Error: {error}',
    'agent.task_complete': 'Task completed',
    'agent.unknown_error': 'Unknown error',
    'agent.interrupt_writing': 'Writing file, interruption may corrupt the file',
    'agent.interrupt_command': 'Executing command, interruption may leave operation incomplete',
    'agent.context_ack_single': 'Got it, I understand the previous task context and will use it to handle the current task.',
    'agent.context_ack_multi': 'Got it, I understand the context of the previous {count} tasks and will use it to handle the current task.',
    'agent.no_response': 'AI returned no response',
    
    // Content compression
    'compress.lines_omitted': '... [{count} lines omitted] ...',
    'compress.truncated': '... [truncated, original length: {length} chars]',
    'compress.reply_truncated': '... [reply truncated]',
    'compress.tool_result': '[Tool result] {content}',
    'compress.memory_folding_header': '[System: Conversation history has been intelligently compressed, here is the key information summary]',
    'compress.key_records': '**Key Records**:',
    'compress.ask_for_details': 'Ask the user for more historical details if needed.',

    // History task context
    'context.tool': 'Tool',
    'context.args': 'Args',
    'context.content': 'Content',
    'context.result': 'Result',
    'context.task_num': 'Task {num}',
    'context.user_request': 'User Request',
    'context.execution_steps': 'Execution Steps',
    'context.history_header': '📋 **Previous Conversation History ({count} tasks):**',
    'context.history_footer': 'The above is the previous execution record. Please use this context to handle the current task.',
    'context.history_summary_header': '📋 **Previous Conversation History (AI Summary):**',
    'context.history_summary_footer': 'Please use the above context to handle the current task.',
    'context.summary_prompt': `You are a technical analysis assistant. Below are {count} previous task execution records from the user. Please extract key information summary to help understand the conversation context.

**Requirements**:
1. Summarize what each task did
2. Extract key execution results and findings
3. Mark which tasks succeeded, failed, or were aborted
4. Keep information that may be useful for subsequent tasks (e.g., discovered paths, configurations, issues)
5. Keep output within {tokenLimit} tokens

---
{context}
---

Please output the summary in the following format:

**Conversation Summary**:
[Brief summary of what was done before]

**Key Findings**:
[Important information discovered during execution]

**Current Status**:
[Current state of system/tasks]`,

    // File operations
    'file.reading': 'Reading file',
    'file.reading_info_only': 'Reading file (info only)',
    'file.read_success': 'File read success',
    'file.read_failed': 'File read failed',
    'file.file_info': 'File info',
    'file.file_too_large': 'File too large',
    'file.writing': 'Writing file',
    'file.overwrite': 'Overwriting file',
    'file.append': 'Appending to file',
    'file.create': 'Creating file',
    'file.insert_at_line': 'Inserting at line {line}',
    'file.replace_lines': 'Replacing lines {start}-{end}',
    'file.regex_replace': 'Regex replace ({scope})',
    'file.regex_scope_all': 'all',
    'file.regex_scope_first': 'first',
    'file.result_overwritten': 'File overwritten',
    'file.result_created': 'File created',
    'file.result_remote_created': 'Remote file created',
    'file.result_remote_appended': 'Content appended to remote file',
    'file.result_remote_written': 'Remote file written',
    'file.result_appended': 'Content appended to',
    'file.writing_remote': 'Writing file: {path} ({size} KB)...',
    'file.too_large_error': 'File too large ({size} MB), exceeds full read limit (500KB). Please use one of the following:\n1. Set info_only=true to view file info\n2. Use start_line and end_line to read specific line range\n3. Use max_lines to read first N lines\n4. Use tail_lines to read last N lines',
    'file.info_header': 'File Info',
    'file.info_path': 'Path',
    'file.info_size': 'Size',
    'file.info_size_value': '{sizeMB} MB ({sizeBytes} bytes)',
    'file.info_lines': 'Total Lines',
    'file.info_lines_value': '{count} lines',
    'file.info_estimated': '(estimated)',
    'file.info_suggestion': 'Suggestion',
    'file.info_suggestion_large': 'File is large, consider reading specific parts:\n  - `start_line` and `end_line`: read specific line range\n  - `max_lines`: read first N lines (e.g. `max_lines: 100`)\n  - `tail_lines`: read last N lines (e.g. `tail_lines: 50`)',
    'file.info_suggestion_small': 'File size is within limit, can read fully',
    'file.info_preview': 'File Preview (first 10 lines)',
    'file.result_inserted': 'Inserted {count} lines at line {line}',
    'file.result_replaced_lines': 'Replaced lines {start}-{end} ({deleteCount} lines) with {newCount} new lines',
    'file.result_regex_replaced': 'Replaced {count} matches',
    'file.writing_progress': 'Writing file...',
    'file.write_success': 'File write success',
    'file.write_failed': 'File write failed',
    'file.user_rejected_write': 'User rejected file write',
    'file.establishing_sftp': 'Establishing SFTP connection...',
    'file.remote_write_failed': 'Remote file write failed',
    'file.full_read': 'Full read',
    'file.actual_read': 'Actually read: {lines} lines, {chars} chars',
    'file.read_line_range': 'Read line range: {start}-{end}',
    'file.read_first_n': 'Read first {count} lines',
    'file.read_last_n': 'Read last {count} lines',
    'file.end_of_file': 'end',

    // Time format
    'time.minutes_seconds': '{minutes}m{seconds}s',
    'time.seconds': '{seconds}s',
    'time.minutes': '{minutes}m',

    // Plan step
    'plan.step_prefix': 'Step {index}',

    // Control key
    'control.send_key': 'Send control key',
    'control.key_sent': 'Sent',
    'control.key_sent_result': 'Control key sent',
    'control.key_sent_output': 'Sent {key}.',
    'control.key_sent_with_output': 'Sent {key}.\n\nLatest terminal output:\n{output}',
    'control.send_failed': 'Send failed',

    // Send input
    'input.send': 'Send input',
    'input.waiting_for': 'Waiting for {type}',
    'input.sent': 'Sent',
    'input.sent_output': 'Sent input {input}.',
    'input.sent_with_output': 'Sent input {input}.\n\nLatest terminal output:\n{output}',
    'input.send_failed': 'Send failed',

    // Get context
    'context.get_output': 'Get terminal output',

    // Password related
    'password.enter_in_terminal': 'Please enter password in terminal',
    'password.prompt': 'Prompt',
    'password.waiting_long': 'Waited for a long time, please enter or press Ctrl+C to cancel',
    'password.sudo_timeout': 'sudo command execution timeout',
    'password.verification_complete': 'Password verification complete',

    // MCP tools
    'mcp.calling_tool': '[MCP] Calling tool',
    'mcp.tool_success': '[MCP] Tool execution success',
    'mcp.tool_failed': '[MCP] Tool execution failed',
    'mcp.error': '[MCP] Error',

    // Hints
    'hint.long_running_command': 'This is a long-running command, timeout does not mean failure. Consider using wait tool to wait and then check status.',
    'hint.command_cannot_execute': 'Cannot execute',
    'hint.security_blocked': 'This command is blocked by security policy',
    'hint.command_empty': 'Command cannot be empty',
    'hint.wait_terminal': 'Terminal is executing another command, cannot execute new command immediately.',
    'hint.wait_suggestions': 'Suggestions:\n1. Use wait tool to wait for current command (e.g. 60-120 seconds)\n2. Use check_terminal_status to check terminal status\n3. Use send_control_key("ctrl+c") to interrupt if needed',
    'hint.cannot_execute_reason': 'Cannot execute command',

    // Error hints
    'error.execution_failed': 'Execution failed. Please analyze the error and consider alternative methods or ask user for help.',
    'error.transient': 'This is a transient error, you can retry later.',
    'error.permission': 'Permission denied. Suggestions: 1) Check file/directory permissions; 2) Try using sudo (if appropriate); 3) Confirm user has required permissions.',
    'error.not_found': 'Resource not found. Suggestions: 1) Check if the path is correct; 2) Use ls or find to confirm file location; 3) Check if the command is installed.',
    'error.timeout': 'Command execution timeout, but may still be running. Suggestions: 1) Use check_terminal_status to confirm if still executing; 2) Use get_terminal_context to check latest terminal output; 3) Use send_control_key to send Ctrl+C if really stuck.',
    'error.knowledge_not_available': 'Knowledge base not enabled, cannot save memory',

    // Memory
    'memory.remember': 'Remember info',
    'memory.remembered': 'Remembered',
    'memory.remembered_knowledge': 'Remembered (Knowledge base, {count} memories)',
    'memory.cannot_save': 'Cannot save: Knowledge base not enabled',
    'memory.skip_dynamic': 'Skipped (dynamic data only)',
    'memory.skip_duplicate': 'Skipped (duplicate memory)',
    'memory.merged': 'Memory merged and updated',
    'memory.replaced': 'Memory replaced',

    // Knowledge search
    'knowledge.search': 'Search knowledge',
    'knowledge.not_initialized': 'Knowledge service not initialized',
    'knowledge.not_enabled': 'Knowledge base not enabled',
    'knowledge.no_results': 'No relevant content found',
    'knowledge.found_results': 'Found {count} relevant items ({chars} characters)',
    'knowledge.search_failed': 'Search failed',
    'knowledge.getting_doc': 'Getting document: {id}',
    'knowledge.doc_not_found': 'Document not found: {id}',
    'knowledge.doc_retrieved': 'Retrieved document {filename} ({chars} characters)',
    'knowledge.get_doc_failed': 'Failed to get document',

    // Wait
    'wait.planned': '⏱️ Planned wait {total}, remaining {remaining}',
    'wait.progress': '⏱️ Planned wait {total}, remaining {remaining} ({progress}%)',
    'wait.new_message': '📨 New message! Waited {elapsed}, originally {remaining} remaining',
    'wait.stopped': '🛑 OK, stopped. Waited {elapsed}',
    'wait.complete': '✅ Wait complete, total {total}',

    // Plan
    'plan.create': 'Create plan',
    'plan.update': 'Update plan',
    'plan.cleared': 'Plan archived',
    'plan.auto_cleared': 'Old plan auto-archived',
    'plan.no_active_plan_to_clear': 'No active plan to archive',

    // Timed execution
    'timed.command_executed': 'Command executed for {seconds} seconds ({chars} characters)',

    // General errors
    'error.unknown': 'Unknown error',
    'error.request_error': 'Request error: {message}',
    'error.request_aborted': 'Request aborted',
    'error.api_request_failed': 'AI API request failed: {status} - {data}',
    'error.operation_aborted': 'Operation aborted',
    'error.tool_param_parse_failed': 'Tool parameter parse failed',
    'error.unknown_tool': 'Unknown tool: {name}',
    'error.mcp_not_initialized': 'MCP service not initialized',
    'error.invalid_mcp_tool_name': 'Invalid MCP tool name: {name}',
    'error.mcp_server_not_connected': 'MCP server {server} not connected',
    'error.user_rejected_command': 'User rejected command execution',
    'error.command_timeout_with_hint': 'Command execution timeout. {suggestion}',
    'error.command_still_running': 'Command still running in background. Suggestions:\n1. Use wait tool to wait (60-180 seconds)\n2. Use check_terminal_status to confirm status\n3. Use get_terminal_context to view latest output',
    'error.recovery_hint': '{error}\n\n💡 Recovery hint: {suggestion}',
    'error.check_terminal_status': 'Command execution timeout. Please check terminal status.',
    'error.get_terminal_output_failed': 'Failed to get terminal output: {error}',
    'error.terminal_output_empty': '(Terminal output is empty)',

    // Control key errors
    'error.control_key_required': 'Must specify control key to send',
    'error.control_key_not_supported': 'Unsupported control key: {key}',

    // Input errors
    'error.input_text_required': 'Must specify text to send',
    'error.input_text_too_long': 'Input text too long (max 1000 characters), please use write_file tool for large content',

    // File errors
    'error.file_path_required': 'File path cannot be empty',
    'error.file_exists_cannot_create': 'File already exists, cannot create: {path}. Use mode=\'overwrite\' to overwrite',
    'error.sftp_not_initialized': 'SFTP service not initialized, cannot write remote file. Please check SSH connection.',
    'error.ssh_config_unavailable': 'Cannot get SSH connection config, cannot write remote file.',
    'error.invalid_write_mode': 'Invalid write mode: {mode}, supported modes: {modes}',
    'error.content_required_for_mode': '{mode} mode requires content parameter',
    'error.insert_content_required': 'insert mode requires content parameter',
    'error.insert_line_required': 'insert mode requires valid insert_at_line parameter (starting from 1)',
    'error.replace_content_required': 'replace_lines mode requires content parameter',
    'error.replace_start_line_required': 'replace_lines mode requires valid start_line parameter (starting from 1)',
    'error.replace_end_line_required': 'replace_lines mode requires valid end_line parameter (must be >= start_line)',
    'error.regex_pattern_required': 'regex_replace mode requires pattern parameter',
    'error.regex_replacement_required': 'regex_replace mode requires replacement parameter',
    'error.ssh_mode_not_supported': 'SSH remote terminal does not support {mode} mode, only overwrite, create and append are supported. For partial modifications, use execute_command with sed/awk',
    'error.ssh_content_required': 'SSH remote file write requires content parameter',
    'error.file_not_exists_for_insert': 'File does not exist, cannot perform insert operation',
    'error.file_not_exists_for_replace': 'File does not exist, cannot perform line replacement',
    'error.start_line_exceeds_total': 'Start line {start} exceeds total lines {total}',
    'error.file_not_exists_for_regex': 'File does not exist, cannot perform regex replacement',
    'error.invalid_regex_pattern': 'Invalid regex pattern: {pattern}',
    'error.regex_no_match': 'No matching content found: {pattern}',

    // Memory errors
    'error.info_required': 'Info cannot be empty',
    'error.cannot_save_unknown_host': 'Cannot save: Unknown host ID',
    'error.query_required': 'Query cannot be empty',
    'error.knowledge_not_initialized': 'Knowledge service not initialized',
    'error.knowledge_not_enabled': 'Knowledge base not enabled, please enable in settings',

    // Wait/ask errors
    'error.wait_seconds_positive': 'Wait seconds must be positive',
    'error.question_required': 'Question cannot be empty',
    'error.user_reply_timeout': 'User reply timeout (5 minutes). You can: 1) Ask user again; 2) Use a reasonable default; 3) Explain that more info is needed.',

    // Plan errors
    'error.plan_title_required': 'Plan title cannot be empty',
    'error.plan_steps_required': 'Plan steps cannot be empty',
    'error.plan_steps_max': 'Plan steps maximum is 10',
    'error.plan_exists': 'Plan "{title}" already exists, please complete current plan or use update_plan to update status',
    'error.plan_exists_use_clear': 'Active plan "{title}" exists. To re-plan, use clear_plan to clear current plan first',
    'error.step_index_positive': 'Step index must be non-negative integer',
    'error.invalid_plan_status': 'Invalid status, options: {statuses}',
    'error.no_active_plan': 'No active plan, please use create_plan to create one first',
    'error.step_index_out_of_range': 'Step index out of range, plan has {count} steps (index 0-{max})',

    // Success messages
    'success.dynamic_data_skip': 'This info is purely dynamic data, not suitable for long-term memory',
    'success.info_saved_to_knowledge': 'Info saved to knowledge base (current host has {count} memories)',
    'success.no_knowledge_found': 'No relevant content found in knowledge base',

    // Wait related
    'wait.user_message': 'User message: "{message}"\n\nWaited {elapsed}, originally {remaining} remaining.\nDecide next step based on user message: if user says no need to wait/almost done, check terminal status immediately; if user says keep waiting/not that fast, call wait again.',
    'wait.aborted': 'Operation aborted, waited {elapsed}.',
    'wait.finished': 'Waited {total}, continuing. You can now check terminal status or continue other operations.',

    // Ask related
    'ask.waiting_reply': '⏳ Waiting for reply...',
    'ask.cancelled': '🛑 Cancelled',
    'ask.waiting_remaining': '⏳ Waiting for reply... ({remaining} remaining)',
    'ask.received': '✅ {response}',
    'ask.empty': '(empty)',
    'ask.user_replied': 'User replied: {response}\n\nPlease continue task based on user\'s reply.',
    'ask.user_no_content': '(User did not provide content)',
    'ask.timeout': '⏰ Timeout',
    'ask.using_default': 'User did not reply within 5 minutes, using default: {default}\n\nPlease continue task with default value.',

    // Command execution
    'command.initial_output': 'Initial output:\n{output}\n\n💡 {hint}',
    'command.no_output': 'Command executed for {seconds} seconds but no output.',

    // Misc
    'misc.yes': 'Yes',
    'misc.no': 'No',
    'misc.duration': 'Duration',
    'misc.characters': 'characters',
    'misc.seconds': 'seconds',
    
    // AI thinking
    'ai.thinking': 'Thinking...',
    'ai.thinking_with_emoji': '🤔 **Thinking...**\n\n> ',
    'ai.preparing': 'Preparing...',
  }
} as const

// 当前语言缓存
let cachedLocale: 'zh-CN' | 'en-US' | null = null
let configService: ConfigService | null = null

/**
 * 设置 ConfigService 实例（在应用启动时调用）
 */
export function setConfigService(service: ConfigService): void {
  configService = service
}

/**
 * 获取当前语言
 */
function getLocale(): 'zh-CN' | 'en-US' {
  if (configService) {
    const locale = configService.getLanguage()
    return locale === 'en-US' ? 'en-US' : 'zh-CN'
  }
  return cachedLocale || 'zh-CN'
}

/**
 * 更新语言缓存
 */
export function updateLocale(locale: 'zh-CN' | 'en-US'): void {
  cachedLocale = locale
}

/**
 * 获取翻译文本
 * @param key 翻译键
 * @param params 替换参数，如 { count: 10 }
 */
export function t(key: TranslationKey, params?: Record<string, string | number>): string {
  const locale = getLocale()
  let text: string = translations[locale][key] || translations['zh-CN'][key] || key
  
  // 替换参数
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      text = text.replace(`{${k}}`, String(v))
    }
  }
  
  return text
}

/**
 * 获取所有翻译键
 */
export function getTranslationKeys(): TranslationKey[] {
  return Object.keys(translations['zh-CN']) as TranslationKey[]
}

