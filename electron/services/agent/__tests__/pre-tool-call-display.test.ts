/**
 * buildPreToolCallDisplay 单元测试
 *
 * 保护"流式 tool_call 预创建卡片"这个 UX 承诺不在后续重构中再次丢失：
 * - commit 4aeabb1a 曾把"正在生成 {tool} 参数 XX 字符"反馈误删，导致 write_text_file
 *   这类长内容工具流式时卡片停滞不动，用户以为卡住（见 agent/SPEC.md "UX 承诺"）。
 * - 本测试从公开契约层面固定：哪些工具在流式阶段就要有预卡片、长参数工具何时开始
 *   追加字符数尾缀、尾缀格式长什么样。
 *
 * 工具元数据驱动重构后：buildPreToolCallDisplay 接受 ToolMeta 参数，
 * 测试通过把工具列表注册表里对应工具的 _meta 取出来传入。本测试用一个简单的
 * registry helper 模拟运行时按工具名查 meta 的行为（与 agent.ts 实际做法一致）。
 *
 * 纯函数测试，无需 mock。
 */
import { describe, it, expect, vi } from 'vitest'

// 与 agent.test.ts 一致：agent.ts 的上层 import 链会拉起 electron 和 im.service，
// 必须先 mock 掉才能在非 Electron 环境加载模块。
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

vi.mock('../../im/im.service', () => ({
  getIMService: vi.fn().mockReturnValue(null)
}))

// user-skill 服务在初始化时会写盘，测试环境屏蔽掉
vi.mock('../../user-skill.service', () => ({
  getUserSkillService: () => ({ getEnabledSkills: () => [] })
}))

vi.mock('../../config.service', () => ({
  getConfigService: () => ({ get: () => undefined })
}))

vi.mock('../../web-search/index', () => ({
  isConfigured: () => false,
  // web-fetch.service 通过 getApiKey('jina') 检测是否走 Jina Reader 增强
  getApiKey: () => '',
}))

import { buildPreToolCallDisplay as rawBuildPreToolCallDisplay, getMetaByName } from '../tool-metadata'
import type { ToolDefinition } from '../../ai.service'
import { getAgentTools } from '../tools'
import { getAllTerminalTools } from '../skills/terminal/tools'
import { wordTools } from '../skills/word/tools'
import { excelTools } from '../skills/excel/tools'

/**
 * 测试用工具注册表：直接静态 import 各 tool 定义文件得到带 _meta 的工具列表。
 * 真实运行时 agent.ts 通过 `getMetaByName(this.getAvailableTools(), name)` 查 meta，
 * 测试这里用同样的 helper 在静态构造好的列表上查。
 *
 * 这样测试纯粹聚焦 metadata 渲染契约，不需要拉起完整 Agent / Service 栈。
 */
// 同时拿 assistant 和 ssh 两种模式的工具，把 write_text_file / write_remote_text_file 都覆盖到
const allTools: ToolDefinition[] = [
  ...getAgentTools(undefined, { mode: 'assistant' }),
  ...getAgentTools(undefined, { mode: 'ssh' }),
  ...getAllTerminalTools(),
  ...wordTools,
  ...excelTools
]

function buildPreToolCallDisplay(toolName: string, partialArgs: string): string | null {
  const meta = getMetaByName(allTools, toolName)
  return rawBuildPreToolCallDisplay(toolName, partialArgs, meta)
}

describe('buildPreToolCallDisplay', () => {
  describe('shell 命令类工具', () => {
    it('execute_command 取 command 字段渲染为"执行命令: {cmd}"', () => {
      const out = buildPreToolCallDisplay(
        'execute_command',
        '{"command": "ls -la"}'
      )
      expect(out).toBe('执行命令: ls -la')
    })

    it('exec 同样取 command 字段', () => {
      const out = buildPreToolCallDisplay(
        'exec',
        '{"command": "npm test"}'
      )
      expect(out).toBe('执行命令: npm test')
    })

    it('exec 附了人话说明时，预卡和执行器落卡一样带上说明', () => {
      const out = buildPreToolCallDisplay(
        'exec',
        '{"command": "npm run build", "description": "构建前端"}'
      )
      expect(out).toBe('执行命令（构建前端）: npm run build')
    })

    it('shell 命令不追加字符数尾缀（命令本身在流，用户能感知）', () => {
      // 即使 command 很长，也不应该出现 "· N 字符" 尾缀
      const longCmd = 'echo ' + 'a'.repeat(500)
      const out = buildPreToolCallDisplay(
        'execute_command',
        JSON.stringify({ command: longCmd })
      )
      expect(out).not.toContain('字符')
      expect(out).not.toContain('chars')
      expect(out).toBe(`执行命令: ${longCmd}`)
    })

    it('partial JSON 中 command 还没流到时返回 null（无法解析的 partial）', () => {
      const out = buildPreToolCallDisplay('execute_command', '{"command')
      expect(out).toBeNull()
    })

    it('空对象 {} 走占位符兜底（透明原则：工具名命中即显示卡片）', () => {
      // OOP 重构前对 execute_command 的 {} 返回 null（要求 command 字段必到）；
      // 重构后统一走 titleField 占位符语义，"{}"也立刻有占位卡片
      const out = buildPreToolCallDisplay('execute_command', '{}')
      expect(out).toBe('执行命令: 生成中…')
    })

    it('容错解析：流式中字符串未闭合也能取出已有 command 前缀', () => {
      // AI 流到一半："{"command": "ls -l
      const out = buildPreToolCallDisplay('execute_command', '{"command": "ls -l')
      expect(out).toBe('执行命令: ls -l')
    })
  })

  describe('write_text_file — mode 切换', () => {
    it('未带 mode 默认按 create 渲染', () => {
      // mode 在 schema 中位于 content 之后，长内容流式时未到达是常态
      const out = buildPreToolCallDisplay(
        'write_text_file',
        '{"path": "/tmp/a.txt"}'
      )
      expect(out).toBe('新建文件: /tmp/a.txt')
    })

    it('mode=overwrite 渲染为"覆盖写入文件"', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        '{"path": "/tmp/a.txt", "mode": "overwrite"}'
      )
      expect(out).toBe('覆盖写入文件: /tmp/a.txt')
    })

    it('mode=append 渲染为"追加写入文件"', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        '{"path": "/tmp/a.txt", "mode": "append"}'
      )
      expect(out).toBe('追加写入文件: /tmp/a.txt')
    })

    it('mode=insert 带 insert_at_line', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        '{"path": "/tmp/a.txt", "mode": "insert", "insert_at_line": 10}'
      )
      expect(out).toContain('/tmp/a.txt')
      expect(out).toMatch(/第\s*10\s*行/)
    })

    it('mode=replace_lines 带 start_line/end_line', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        '{"path": "/tmp/a.txt", "mode": "replace_lines", "start_line": 1, "end_line": 5}'
      )
      expect(out).toContain('/tmp/a.txt')
      expect(out).toContain('1-5')
    })

    it('path 尚未流到时用占位符立即显示卡片（避免 AI 不按 schema 顺序时卡片迟迟不出现）', () => {
      // AI 先流了 mode 字段，path 还没到
      const out = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ mode: 'overwrite' })
      )
      expect(out).toBe('覆盖写入文件: 生成中…')
    })

    it('工具名刚命中、arguments 还是空对象 {} 时也要显示占位卡片', () => {
      // tryParsePartialJson('{}') 成功返回 {}，应当立即显示"新建文件: 生成中…"
      const out = buildPreToolCallDisplay('write_text_file', '{}')
      expect(out).toBe('新建文件: 生成中…')
    })

    it('path 到达后占位符自动被真实路径替换', () => {
      // 模拟连续两次流式调用
      const before = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ content: 'x'.repeat(200) })
      )
      const after = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'x'.repeat(200) })
      )
      expect(before).toContain('生成中…')
      expect(before).not.toContain('/tmp/a.txt')
      expect(after).toContain('/tmp/a.txt')
      expect(after).not.toContain('生成中…')
    })
  })

  describe('write_text_file — 实时字符数尾缀（核心 UX 承诺）', () => {
    it('content 不足 100 字符不显示尾缀，避免 path 刚流完就抖动', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'a'.repeat(50) })
      )
      expect(out).toBe('新建文件: /tmp/a.txt')
      expect(out).not.toContain('字符')
    })

    it('content 达到 100 字符即开始显示字符数尾缀', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'a'.repeat(100) })
      )
      expect(out).toBe('新建文件: /tmp/a.txt · 100 字符')
    })

    it('字符数随 content 变化而变化（即"跳动"的关键）', () => {
      const out1 = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'x'.repeat(200) })
      )
      const out2 = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'x'.repeat(350) })
      )
      expect(out1).toContain('200 字符')
      expect(out2).toContain('350 字符')
      expect(out1).not.toEqual(out2)
    })

    it('始终使用字符单位，不切 KB（数字位数多跳动幅度大）', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'x'.repeat(5000) })
      )
      expect(out).toContain('5000 字符')
      expect(out).not.toContain('KB')
    })

    it('尾缀格式为 " · N 字符"（中间分隔符明显）', () => {
      const out = buildPreToolCallDisplay(
        'write_text_file',
        JSON.stringify({ path: '/tmp/a.txt', content: 'x'.repeat(150) })
      )
      expect(out).toMatch(/ · 150 字符$/)
    })

    it('容错解析：content 字符串未闭合时也能累计已流到的字符数', () => {
      // 模拟 AI 正在流 content：`{"path": "/tmp/a.txt", "content": "AAAA...`（未闭合）
      const partial = '{"path": "/tmp/a.txt", "content": "' + 'A'.repeat(300)
      const out = buildPreToolCallDisplay('write_text_file', partial)
      expect(out).toContain('/tmp/a.txt')
      expect(out).toContain('字符')
    })
  })

  describe('write_remote_text_file', () => {
    it('和 write_text_file 共享同一套渲染逻辑', () => {
      const out = buildPreToolCallDisplay(
        'write_remote_text_file',
        JSON.stringify({ path: '/etc/nginx.conf', mode: 'overwrite', content: 'x'.repeat(200) })
      )
      expect(out).toBe('覆盖写入文件: /etc/nginx.conf · 200 字符')
    })
  })

  describe('edit_file', () => {
    it('按 path 渲染"编辑文件: {path}"', () => {
      const out = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({ path: '/tmp/a.txt' })
      )
      expect(out).toBe('编辑文件: /tmp/a.txt')
    })

    it('字符数累计 old_text + new_text（两段都是长文本）', () => {
      const out = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({
          path: '/tmp/a.txt',
          old_text: 'x'.repeat(60),
          new_text: 'y'.repeat(60)
        })
      )
      // 60 + 60 = 120 超过 100 阈值，尾缀应出现
      expect(out).toBe('编辑文件: /tmp/a.txt · 120 字符')
    })

    it('old_text + new_text 之和不足 100 字符不显示尾缀', () => {
      const out = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({
          path: '/tmp/a.txt',
          old_text: 'x'.repeat(40),
          new_text: 'y'.repeat(40)
        })
      )
      expect(out).toBe('编辑文件: /tmp/a.txt')
    })

    it('AI 先流 old_text 时卡片立刻显示占位符，不用等 path 到达', () => {
      // 这是用户报告的真实场景：AI 不按 schema 顺序，先发长字段 old_text，
      // 卡片必须立刻出现、字符数必须开始跳动，否则用户会以为卡住
      const out = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({ old_text: 'x'.repeat(200) })
      )
      expect(out).toBe('编辑文件: 生成中… · 200 字符')
    })

    it('path 到达后占位符自动被替换，字符数尾缀保留', () => {
      const before = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({ old_text: 'x'.repeat(150) })
      )
      const after = buildPreToolCallDisplay(
        'edit_file',
        JSON.stringify({ path: '/tmp/a.txt', old_text: 'x'.repeat(200) })
      )
      expect(before).toBe('编辑文件: 生成中… · 150 字符')
      expect(after).toBe('编辑文件: /tmp/a.txt · 200 字符')
    })
  })

  describe('dispatch_agents（并行子任务）', () => {
    it('tasks 数组还没出现时返回 null（还没到信息量够用的阶段）', () => {
      const out = buildPreToolCallDisplay('dispatch_agents', '{}')
      expect(out).toBeNull()
    })

    it('空 tasks 数组 [] 返回 null', () => {
      const out = buildPreToolCallDisplay(
        'dispatch_agents',
        JSON.stringify({ tasks: [] })
      )
      expect(out).toBeNull()
    })

    it('单个子任务渲染为执行器对齐格式', () => {
      // 与 tools/sub-agent.ts 执行器 addStep 的 content 格式严格对齐
      const out = buildPreToolCallDisplay(
        'dispatch_agents',
        JSON.stringify({
          tasks: [{ description: 'analyze code', prompt: 'read file X and summarize' }]
        })
      )
      expect(out).toBe('派出 1 个伙计')
    })

    it('多个子任务显示人数', () => {
      const out = buildPreToolCallDisplay(
        'dispatch_agents',
        JSON.stringify({
          tasks: [
            { description: 't1', prompt: 'p1' },
            { description: 't2', prompt: 'p2' }
          ]
        })
      )
      expect(out).toBe('派出 2 个伙计')
    })

    it('prompt + description 累计达到 100 字符追加字符数尾缀', () => {
      const out = buildPreToolCallDisplay(
        'dispatch_agents',
        JSON.stringify({
          tasks: [{ description: 'short', prompt: 'x'.repeat(150) }]
        })
      )
      // 5 + 150 = 155 ≥ 100
      expect(out).toBe('派出 1 个伙计 · 155 字符')
    })

    it('多个子任务的 prompt 汇总后一起计数（体现所有指令都在增长）', () => {
      const out = buildPreToolCallDisplay(
        'dispatch_agents',
        JSON.stringify({
          tasks: [
            { description: 't1', prompt: 'a'.repeat(80) },
            { description: 't2', prompt: 'b'.repeat(80) }
          ]
        })
      )
      // 80 + 80 + 2 + 2 = 164
      expect(out).toContain('164 字符')
    })

    it('容错：正在流式第二个子任务 prompt 时也能部分渲染', () => {
      // AI 刚流到 `tasks: [{完整第一个}, {description:"t2", prompt:"流到一半...`
      const partial =
        '{"tasks": [{"description": "t1", "prompt": "done"}, {"description": "t2", "prompt": "' +
        'x'.repeat(200)
      const out = buildPreToolCallDisplay('dispatch_agents', partial)
      // 第二个任务 prompt 容错闭合后会包含已到达的 200 个 'x'
      expect(out).toContain('派出 2 个伙计')
      expect(out).toContain('字符')
    })
  })

  describe('word_from_markdown（Word 技能：长 markdown 内容）', () => {
    it('path 已到、markdown 还未到时立刻显示卡片', () => {
      const out = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ path: '/tmp/report.docx' })
      )
      expect(out).toBe('生成 Word 文档: /tmp/report.docx')
    })

    it('path 还没流到时用占位符立刻显示（避免长 markdown 流式期间空窗）', () => {
      // 用户报告：AI 先流 markdown 内容，path 后到，否则什么都看不见
      const out = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ markdown: 'x'.repeat(200) })
      )
      expect(out).toBe('生成 Word 文档: 生成中… · 200 字符')
    })

    it('markdown 达到 100 字符开始追加字符数尾缀', () => {
      const out = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ path: '/tmp/a.docx', markdown: 'a'.repeat(100) })
      )
      expect(out).toBe('生成 Word 文档: /tmp/a.docx · 100 字符')
    })

    it('markdown 不足 100 字符不显示尾缀，避免 path 刚流完就抖动', () => {
      const out = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ path: '/tmp/a.docx', markdown: 'short' })
      )
      expect(out).toBe('生成 Word 文档: /tmp/a.docx')
    })

    it('字符数随 markdown 持续增长而跳动', () => {
      const out1 = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ path: '/tmp/a.docx', markdown: 'x'.repeat(200) })
      )
      const out2 = buildPreToolCallDisplay(
        'word_from_markdown',
        JSON.stringify({ path: '/tmp/a.docx', markdown: 'x'.repeat(800) })
      )
      expect(out1).toContain('200 字符')
      expect(out2).toContain('800 字符')
      expect(out1).not.toEqual(out2)
    })

    it('容错解析：markdown 字符串未闭合时也能累计已流到的字符数', () => {
      // AI 流 markdown 到一半：`{"path": "/tmp/a.docx", "markdown": "AAAA...`（未闭合）
      const partial =
        '{"path": "/tmp/a.docx", "markdown": "' + 'A'.repeat(300)
      const out = buildPreToolCallDisplay('word_from_markdown', partial)
      expect(out).toContain('/tmp/a.docx')
      expect(out).toContain('字符')
    })
  })

  describe('excel_from_markdown（Excel 技能：长 markdown 内容）', () => {
    it('path 已到、markdown 还未到时立刻显示卡片', () => {
      const out = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ path: '/tmp/data.xlsx' })
      )
      expect(out).toBe('生成 Excel 文件: /tmp/data.xlsx')
    })

    it('path 还没流到时用占位符立刻显示（避免长 markdown 流式期间空窗）', () => {
      const out = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ markdown: 'x'.repeat(200) })
      )
      expect(out).toBe('生成 Excel 文件: 生成中… · 200 字符')
    })

    it('markdown 达到 100 字符开始追加字符数尾缀', () => {
      const out = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ path: '/tmp/a.xlsx', markdown: 'a'.repeat(100) })
      )
      expect(out).toBe('生成 Excel 文件: /tmp/a.xlsx · 100 字符')
    })

    it('markdown 不足 100 字符不显示尾缀', () => {
      const out = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ path: '/tmp/a.xlsx', markdown: '| col |' })
      )
      expect(out).toBe('生成 Excel 文件: /tmp/a.xlsx')
    })

    it('字符数随 markdown 持续增长而跳动', () => {
      const out1 = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ path: '/tmp/a.xlsx', markdown: 'x'.repeat(200) })
      )
      const out2 = buildPreToolCallDisplay(
        'excel_from_markdown',
        JSON.stringify({ path: '/tmp/a.xlsx', markdown: 'x'.repeat(800) })
      )
      expect(out1).toContain('200 字符')
      expect(out2).toContain('800 字符')
      expect(out1).not.toEqual(out2)
    })

    it('容错解析：markdown 字符串未闭合时也能累计已流到的字符数', () => {
      const partial =
        '{"path": "/tmp/a.xlsx", "markdown": "' + 'A'.repeat(300)
      const out = buildPreToolCallDisplay('excel_from_markdown', partial)
      expect(out).toContain('/tmp/a.xlsx')
      expect(out).toContain('字符')
    })
  })

  describe('read_file', () => {
    it('取 path 字段渲染为"读取文件: {path}"', () => {
      const out = buildPreToolCallDisplay(
        'read_file',
        JSON.stringify({ path: '/tmp/a.txt' })
      )
      expect(out).toBe('读取文件: /tmp/a.txt')
    })

    it('info_only=true 渲染为"读取文件 (仅查询信息): {path}"', () => {
      const out = buildPreToolCallDisplay(
        'read_file',
        JSON.stringify({ path: '/tmp/a.txt', info_only: true })
      )
      expect(out).toBe('读取文件 (仅查询信息): /tmp/a.txt')
    })

    it('path 还没流到时用占位符（工具名命中即显示，避免空窗）', () => {
      const out = buildPreToolCallDisplay('read_file', '{}')
      expect(out).toBe('读取文件: 生成中…')
    })

    it('容错解析：流式中 path 未闭合也能取出已有前缀', () => {
      const out = buildPreToolCallDisplay('read_file', '{"path": "/tmp/a')
      expect(out).toBe('读取文件: /tmp/a')
    })
  })

  describe('未声明 streamDisplay 的工具走"调用: {toolName}"通用兜底（透明原则默认开）', () => {
    it('file_search（短参数信息检索类，未声明 streamDisplay）展示通用兜底', () => {
      // OOP 重构前为这类工具不显示卡片（违反透明原则）；
      // 重构后基类按统一兜底「调用: {toolName}」处理，保证流式期间用户能看到 Agent 在做什么
      const out = buildPreToolCallDisplay('file_search', JSON.stringify({ query: 'foo' }))
      expect(out).toBe('调用: file_search')
    })

    it('未知工具（如 MCP / plugin 工具）也走通用兜底', () => {
      const out = buildPreToolCallDisplay('totally_unknown_tool', '{"foo": "bar"}')
      expect(out).toBe('调用: totally_unknown_tool')
    })

    it('未知工具 + 空对象 {} 同样有兜底', () => {
      const out = buildPreToolCallDisplay('totally_unknown_tool', '{}')
      expect(out).toBe('调用: totally_unknown_tool')
    })
  })

  describe('容错边界', () => {
    it('空字符串返回 null（partial JSON 还没开始）', () => {
      expect(buildPreToolCallDisplay('execute_command', '')).toBeNull()
    })

    it('非 JSON 对象返回 null（不可解析）', () => {
      expect(buildPreToolCallDisplay('execute_command', 'not json')).toBeNull()
    })
  })
})
