/**
 * tool-display.ts 单元测试
 *
 * 锁定 tool_call / tool_result 步骤在 UI 层的过滤策略，防止后续重构破坏「调试模式 OFF
 * 时的简化呈现」与「失败 / 富内容步骤始终展示」两条 UX 承诺。
 */
import { describe, it, expect } from 'vitest'
import {
  shouldShowToolResultStep,
  TOOLS_WITH_DEDICATED_STEP_TYPE,
  ALWAYS_SHOW_RESULT_TOOLS,
} from './tool-display'

describe('shouldShowToolResultStep', () => {
  describe('非 tool_call/tool_result 的步骤永远展示', () => {
    it('plan_updated step 在非调试模式下也展示（专用 step type 是 UX 主体）', () => {
      expect(
        shouldShowToolResultStep({ type: 'plan_updated', toolName: 'plan' }, false)
      ).toBe(true)
    })

    it('asking step 永远展示', () => {
      expect(
        shouldShowToolResultStep({ type: 'asking', toolName: 'ask_user' }, false)
      ).toBe(true)
    })

    it('thinking / message 等步骤永远展示', () => {
      expect(shouldShowToolResultStep({ type: 'thinking' }, false)).toBe(true)
      expect(shouldShowToolResultStep({ type: 'message' }, false)).toBe(true)
      expect(shouldShowToolResultStep({ type: 'final_result' }, false)).toBe(true)
    })
  })

  describe('TOOLS_WITH_DEDICATED_STEP_TYPE：plan / ask_user / wait', () => {
    it('plan 的 tool_call 在非调试模式下隐藏（让位给 plan_* 专用卡）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: true },
          false
        )
      ).toBe(false)
    })

    it('plan 的 tool_result 在非调试模式下隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: true },
          false
        )
      ).toBe(false)
    })

    it('plan 在调试模式下完整展示（保留排查链路）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: true },
          true
        )
      ).toBe(true)
    })

    it('plan 失败时仍始终展示（success === false 优先级最高）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'plan', success: false },
          false
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'plan', success: false },
          false
        )
      ).toBe(true)
    })

    it('集合内容和文档约定一致', () => {
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('plan')).toBe(true)
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('ask_user')).toBe(true)
      expect(TOOLS_WITH_DEDICATED_STEP_TYPE.has('wait')).toBe(true)
    })
  })

  describe('失败步骤（success === false）始终展示', () => {
    it('execute_command 失败时 tool_result 展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'execute_command', success: false },
          false
        )
      ).toBe(true)
    })

    it('read_file 失败时展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'read_file', success: false },
          false
        )
      ).toBe(true)
    })

    it('未知工具失败时展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'mystery_tool', success: false },
          false
        )
      ).toBe(true)
    })
  })

  describe('富内容字段（hasRichPayload）始终展示', () => {
    it('携带 images 的步骤始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'read_file',
            success: true,
            images: ['data:image/png;base64,...'],
          },
          false
        )
      ).toBe(true)
    })

    it('携带 webSearchResults 的步骤始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'web_search',
            success: true,
            webSearchResults: [{ title: 'r', url: 'u' }],
          },
          false
        )
      ).toBe(true)
    })

    it('dispatch_agents 的 tool_call 携带 subAgents 时始终展示', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_call',
            toolName: 'dispatch_agents',
            success: true,
            subAgents: [{ id: 'sa1', status: 'running' }],
          },
          false
        )
      ).toBe(true)
    })

    it('空数组不算富内容', () => {
      expect(
        shouldShowToolResultStep(
          {
            type: 'tool_result',
            toolName: 'read_file',
            success: true,
            images: [],
            webSearchResults: [],
            subAgents: [],
          },
          false
        )
      ).toBe(false)
    })
  })

  describe('ALWAYS_SHOW_RESULT_TOOLS：少数 tool_result 仍需独立展示', () => {
    it('dispatch_agents 的成功回执平时不展示，调试模式和失败仍展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'dispatch_agents', success: true },
          false
        )
      ).toBe(false)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'dispatch_agents', success: true },
          true
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'dispatch_agents', success: false },
          false
        )
      ).toBe(true)
    })

    it('talk_to_user 的 tool_result 在非调试模式下展示（发送正文用户必看）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'talk_to_user', success: true },
          false
        )
      ).toBe(true)
    })

    it('集合内容和文档约定一致', () => {
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('dispatch_agents')).toBe(false)
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('talk_to_user')).toBe(true)
      expect(ALWAYS_SHOW_RESULT_TOOLS.has('remember_info')).toBe(false)
    })
  })

  describe('默认行为：成功 tool_result 隐藏，tool_call 仍展示', () => {
    it.each([
      'edit_file',
      'write_text_file',
      'execute_command',
      'read_file',
      'web_fetch',
      'browser_click',
      'browser_goto',
      'browser_type',
      'mcp_filesystem_read_file',
    ])('%s 的 tool_result 成功时隐藏', (toolName) => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName, success: true },
          false
        )
      ).toBe(false)
    })

    it('edit_file 的 tool_call 成功时仍展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'edit_file', success: true },
          false
        )
      ).toBe(true)
    })

    it('browser_type 失败时 tool_result 仍展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'browser_type', success: false },
          false
        )
      ).toBe(true)
    })
  })

  describe('调试模式：所有 tool_call / tool_result 都展示', () => {
    it('execute_command 成功时也展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'execute_command', success: true },
          true
        )
      ).toBe(true)
    })

    it('edit_file 成功时 tool_result 也展示（调试模式可见完整链路）', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'edit_file', success: true },
          true
        )
      ).toBe(true)
    })
  })

  describe('未登记工具：tool_call 展示，成功 tool_result 默认隐藏', () => {
    it('未知工具的 tool_call 展示', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', toolName: 'mystery_tool', success: true },
          false
        )
      ).toBe(true)
    })

    it('未知工具的 tool_result 成功时隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', toolName: 'mystery_tool', success: true },
          false
        )
      ).toBe(false)
    })

    it('toolName 缺失时 tool_call 展示、成功 tool_result 隐藏', () => {
      expect(
        shouldShowToolResultStep(
          { type: 'tool_call', success: true },
          false
        )
      ).toBe(true)
      expect(
        shouldShowToolResultStep(
          { type: 'tool_result', success: true },
          false
        )
      ).toBe(false)
    })
  })
})
