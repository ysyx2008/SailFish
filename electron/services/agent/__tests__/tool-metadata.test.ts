/**
 * tool-metadata helpers 单元测试
 *
 * 这些 helper 是 Agent 基类访问"具体工具差异"的唯一通道，承诺：
 * - getStreamPlaceholder：返回 i18n 化的占位符
 * - buildStreamProgressSuffix：累计指定字段字符数 ≥100 才追加，格式固定
 * - formatToolCallPrefixFromMeta：解析 titleKey + titleField，副标题缺失用占位符
 * - formatStreamPreCardFromMeta：前缀 + 进度尾缀拼接，meta 缺失返回 null（调用方走兜底）
 * - getMetaByName：从工具列表里查 _meta
 */
import { describe, it, expect, vi } from 'vitest'

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

import {
  getStreamPlaceholder,
  buildStreamProgressSuffix,
  formatToolCallPrefixFromMeta,
  formatStreamPreCardFromMeta,
  getMetaByName,
  isJsonStringFieldComplete,
  tryParsePartialJson
} from '../tool-metadata'
import type { ToolDefinition } from '../../ai.service'
import type { ToolDefinitionWithMeta, ToolMeta } from '../tools'

describe('tool-metadata helpers', () => {
  describe('getStreamPlaceholder', () => {
    it('返回 i18n 化的"生成中…"占位符', () => {
      expect(getStreamPlaceholder()).toBe('生成中…')
    })
  })

  describe('buildStreamProgressSuffix', () => {
    it('字段数组为空时不追加尾缀（即使 args 有值）', () => {
      expect(buildStreamProgressSuffix({ x: 'a'.repeat(500) }, [])).toBe('')
    })

    it('累计字符数不足 100 不追加（避免 path 刚流完就抖动）', () => {
      expect(buildStreamProgressSuffix({ content: 'x'.repeat(50) }, ['content'])).toBe('')
    })

    it('累计字符数达到 100 开始追加，格式固定 " · N 字符"', () => {
      expect(buildStreamProgressSuffix({ content: 'x'.repeat(100) }, ['content'])).toBe(' · 100 字符')
    })

    it('多字段累加（edit_file 的 old_text + new_text 一起算）', () => {
      const args = { old_text: 'a'.repeat(60), new_text: 'b'.repeat(60) }
      expect(buildStreamProgressSuffix(args, ['old_text', 'new_text'])).toBe(' · 120 字符')
    })

    it('非字符串字段不计入', () => {
      const args = { content: 'x'.repeat(150), extra: 999, list: ['a', 'b'] }
      expect(buildStreamProgressSuffix(args, ['content', 'extra', 'list'])).toBe(' · 150 字符')
    })

    it('字段不存在时按 0 处理', () => {
      expect(buildStreamProgressSuffix({}, ['content'])).toBe('')
    })
  })

  describe('formatToolCallPrefixFromMeta', () => {
    it('meta 未声明 streamDisplay 时返回 null（调用方走兜底）', () => {
      expect(formatToolCallPrefixFromMeta(undefined, {})).toBeNull()
      expect(formatToolCallPrefixFromMeta({}, {})).toBeNull()
    })

    it('静态 titleKey + titleField 时正常渲染"标题: 副标题"', () => {
      const meta: ToolMeta = { streamDisplay: { titleKey: 'file.create', titleField: 'path' } }
      expect(formatToolCallPrefixFromMeta(meta, { path: '/tmp/a.txt' })).toBe('新建文件: /tmp/a.txt')
    })

    it('titleField 在 args 缺失时用占位符', () => {
      const meta: ToolMeta = { streamDisplay: { titleKey: 'file.create', titleField: 'path' } }
      expect(formatToolCallPrefixFromMeta(meta, {})).toBe('新建文件: 生成中…')
    })

    it('titleField 不是字符串时也用占位符', () => {
      const meta: ToolMeta = { streamDisplay: { titleKey: 'file.create', titleField: 'path' } }
      expect(formatToolCallPrefixFromMeta(meta, { path: 123 })).toBe('新建文件: 生成中…')
    })

    it('动态 titleKey 函数：根据 args 切换 i18n 键', () => {
      const meta: ToolMeta = {
        streamDisplay: {
          titleKey: (args) =>
            (args as { mode?: string }).mode === 'overwrite' ? 'file.overwrite' : 'file.create',
          titleField: 'path'
        }
      }
      expect(formatToolCallPrefixFromMeta(meta, { path: '/tmp/a', mode: 'overwrite' }))
        .toBe('覆盖写入文件: /tmp/a')
      expect(formatToolCallPrefixFromMeta(meta, { path: '/tmp/a' }))
        .toBe('新建文件: /tmp/a')
    })

    it('未指定 titleField 时只渲染标题（适合无参工具）', () => {
      const meta: ToolMeta = { streamDisplay: { titleKey: 'file.create' } }
      expect(formatToolCallPrefixFromMeta(meta, {})).toBe('新建文件')
    })
  })

  describe('formatStreamPreCardFromMeta', () => {
    it('meta 未声明 streamDisplay 时返回 null', () => {
      expect(formatStreamPreCardFromMeta(undefined, {})).toBeNull()
    })

    it('短内容只展示前缀', () => {
      const meta: ToolMeta = {
        streamDisplay: { titleKey: 'file.create', titleField: 'path', progressFields: ['content'] }
      }
      expect(formatStreamPreCardFromMeta(meta, { path: '/tmp/a', content: 'short' }))
        .toBe('新建文件: /tmp/a')
    })

    it('长内容追加字符数尾缀', () => {
      const meta: ToolMeta = {
        streamDisplay: { titleKey: 'file.create', titleField: 'path', progressFields: ['content'] }
      }
      expect(formatStreamPreCardFromMeta(meta, { path: '/tmp/a', content: 'x'.repeat(200) }))
        .toBe('新建文件: /tmp/a · 200 字符')
    })

    it('path 还没流到 + 长内容已部分到达：占位符 + 字符数（验证主要 UX 承诺）', () => {
      const meta: ToolMeta = {
        streamDisplay: { titleKey: 'file.create', titleField: 'path', progressFields: ['content'] }
      }
      expect(formatStreamPreCardFromMeta(meta, { content: 'x'.repeat(300) }))
        .toBe('新建文件: 生成中… · 300 字符')
    })
  })

  describe('getMetaByName', () => {
    const tools: ToolDefinition[] = [
      {
        type: 'function',
        function: { name: 'tool_a', description: 'A', parameters: { type: 'object', properties: {} } },
        _meta: { parallelizable: true }
      } as ToolDefinitionWithMeta,
      {
        type: 'function',
        function: { name: 'tool_b', description: 'B', parameters: { type: 'object', properties: {} } }
      },
      {
        type: 'function',
        function: { name: 'tool_c', description: 'C', parameters: { type: 'object', properties: {} } },
        _meta: { phase: 'reading' }
      } as ToolDefinitionWithMeta
    ]

    it('能查到带 _meta 的工具', () => {
      expect(getMetaByName(tools, 'tool_a')).toEqual({ parallelizable: true })
    })

    it('工具存在但没 _meta 时返回 undefined', () => {
      expect(getMetaByName(tools, 'tool_b')).toBeUndefined()
    })

    it('工具不在列表里返回 undefined（MCP / plugin 工具的常见情况）', () => {
      expect(getMetaByName(tools, 'unknown_tool')).toBeUndefined()
    })

    it('tools 列表为 undefined 时返回 undefined', () => {
      expect(getMetaByName(undefined, 'tool_a')).toBeUndefined()
    })
  })

  describe('isJsonStringFieldComplete', () => {
    it('字段值尚未闭合时返回 false（即使补全解析能得到前缀）', () => {
      const raw = '{"mode":"create","path":"D:\\\\fake-stream-prefix\\\\dir'
      expect(isJsonStringFieldComplete(raw, 'path')).toBe(false)
      expect(tryParsePartialJson(raw)?.path).toBe('D:\\fake-stream-prefix\\dir')
    })

    it('字段值已闭合时返回 true，后续 content 还在流也不影响', () => {
      const raw = '{"mode":"create","path":"D:\\\\fake-stream-prefix\\\\a.txt","content":"hello'
      expect(isJsonStringFieldComplete(raw, 'path')).toBe(true)
    })

    it('字段尚未出现时返回 false', () => {
      expect(isJsonStringFieldComplete('{"mode":"create"', 'path')).toBe(false)
    })

    it('content 正文里出现 path 字样不误判', () => {
      const raw = '{"content":"please use \\"path\\": \\"/tmp/x\\"","path":"/tmp/y'
      expect(isJsonStringFieldComplete(raw, 'path')).toBe(false)
    })
  })

  describe('tryParsePartialJson', () => {
    const bigTasks = (n: number) =>
      '{"tasks": [' + Array.from({ length: n }, (_, i) =>
        `{"description": "读第 ${i} 个文件", "prompt": "读 /repo/file-${i}.ts，用一句话说明它干什么"}`
      ).join(', ')

    it('嵌套数组里剥掉半截的键名后仍能解析', () => {
      const parsed = tryParsePartialJson(bigTasks(3) + ', {"descri')
      expect(parsed?.tasks).toHaveLength(4)
      expect((parsed?.tasks as unknown[])[3]).toEqual({})
    })

    it('尾巴落在转义符中间时剥掉它再解析', () => {
      expect(tryParsePartialJson('{"content": "abc\\')?.content).toBe('abc')
      expect(tryParsePartialJson('{"content": "abc\\u4e')?.content).toBe('abc')
    })

    it('开头就坏掉的长参数很快放弃，不随长度平方变慢', () => {
      const broken = '{"batch">\n<｜｜DSML｜｜: "none", ' + bigTasks(400).slice(1)
      const started = performance.now()
      for (let i = 0; i < 20; i++) expect(tryParsePartialJson(broken)).toBeNull()
      expect(performance.now() - started).toBeLessThan(500)
    })

    it('几百个伙计的派活单流到一半也能解析', () => {
      const parsed = tryParsePartialJson(bigTasks(400) + ', {"description": "读第')
      expect((parsed?.tasks as unknown[]).length).toBe(401)
    })
  })
})
