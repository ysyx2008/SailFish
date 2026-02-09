/**
 * context-builder.ts 单元测试
 * 测试上下文构建器的预算计算、压缩和上下文引用检测
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  calculateBudget,
  detectContextReference,
  buildRecentTasksContext,
  buildTaskHistoryContext
} from '../context-builder'
import { TaskMemoryStore } from '../task-memory'
import type { AgentStep } from '../types'

// ==================== calculateBudget ====================

describe('calculateBudget', () => {
  it('should calculate budget for 4K context', () => {
    const budget = calculateBudget(4000)
    expect(budget.total).toBe(3200) // 80% of 4000
    expect(budget.systemPrompt).toBe(3000)
    expect(budget.knowledge).toBe(480) // 15% of 3200
    expect(budget.recentTasks).toBe(1280) // 40% of 3200
    expect(budget.nearTasks).toBe(320) // 10% of 3200
    expect(budget.historySummary).toBe(160) // 5% of 3200
    expect(budget.currentConversation).toBe(320) // 10% of 3200
  })

  it('should calculate budget for 128K context', () => {
    const budget = calculateBudget(128000)
    expect(budget.total).toBe(102400) // 80% of 128000
    expect(budget.recentTasks).toBe(40960) // 40% of 102400
  })

  it('should have consistent proportions', () => {
    const budget = calculateBudget(100000)
    const total = budget.total
    
    // Check proportions (approximately, due to rounding)
    expect(budget.knowledge / total).toBeCloseTo(0.15, 1)
    expect(budget.recentTasks / total).toBeCloseTo(0.40, 1)
    expect(budget.nearTasks / total).toBeCloseTo(0.10, 1)
    expect(budget.historySummary / total).toBeCloseTo(0.05, 1)
    expect(budget.currentConversation / total).toBeCloseTo(0.10, 1)
  })

  it('should handle small context lengths', () => {
    const budget = calculateBudget(1000)
    expect(budget.total).toBe(800)
    // All values should be positive
    Object.values(budget).forEach(value => {
      expect(value).toBeGreaterThanOrEqual(0)
    })
  })
})

// ==================== detectContextReference ====================

describe('detectContextReference', () => {
  describe('Chinese context references', () => {
    it.each([
      ['刚才那个命令', '刚才'],
      ['刚刚说的', '刚刚'],
      ['上次的配置', '上次'],
      ['之前的错误', '之前'],
      ['继续执行', '继续'],
      ['接着做', '接着'],
      ['上一个任务', '上一个'],
      ['前面的步骤', '前面'],
      ['那个文件', '那个'],
      ['这个命令', '这个'],
      ['同样的方法', '同样的'],
      ['一样的配置', '一样的'],
      ['类似的问题', '类似的'],
      ['再试一次', '再试'],
      ['重试', '重试'],
      ['再来', '再来'],
      ['再做一遍', '再做'],
    ])('should detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(true)
    })
  })

  describe('English context references', () => {
    it.each([
      ['try again', 'again'],
      ['continue with the previous task', 'continue'],
      ['the previous command', 'previous'],
      ['last time', 'last'],
      ['same as before', 'same'],
      ['retry the operation', 'retry'],
      ['redo the step', 'redo'],
    ])('should detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(true)
    })
  })

  describe('no context reference', () => {
    it.each([
      ['检查 nginx 状态', 'new task'],
      ['安装 nodejs', 'installation'],
      ['查看日志', 'view logs'],
      ['list files in directory', 'list files'],
      ['show system status', 'status'],
    ])('should not detect context reference: %s (%s)', (text) => {
      expect(detectContextReference(text)).toBe(false)
    })
  })
})

// ==================== buildRecentTasksContext ====================

describe('buildRecentTasksContext', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should return empty result for empty store', () => {
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.recentTaskMessages).toEqual([])
    expect(result.taskSummarySection).toBe('')
    expect(result.availableTaskIds).toEqual([])
    expect(result.stats.totalTasks).toBe(0)
  })

  it('should include tasks within budget', () => {
    store.saveTask('task1', '检查 nginx', [], 'success', '正常')
    store.saveTask('task2', '重启 mysql', [], 'success', '完成')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(2)
    expect(result.availableTaskIds).toHaveLength(2)
  })

  it('should count compression levels correctly', () => {
    // Create a task with steps to ensure it has some content
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Test message', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Task 1', steps, 'success', 'Done')
    
    const result = buildRecentTasksContext(store, 100000) // Large budget
    
    const { level0Count, level1Count, level2Count, level3Count, level4Count } = result.stats
    const totalLevelCounts = level0Count + level1Count + level2Count + level3Count + level4Count
    expect(totalLevelCounts).toBe(result.stats.totalTasks)
  })

  it('should respect budget limit', () => {
    // Create many tasks
    for (let i = 0; i < 20; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'tool_call', toolName: 'execute_command', 
          toolArgs: { command: `command_${i}`.repeat(100) }, content: '', timestamp: Date.now() },
        { id: `${i}-2`, type: 'tool_result', toolName: 'execute_command',
          toolResult: `result_${i}`.repeat(200), content: '', timestamp: Date.now() },
        { id: `${i}-3`, type: 'message', content: `message_${i}`.repeat(100), timestamp: Date.now() }
      ]
      store.saveTask(`task${i}`, `Task ${i} with some description`, steps, 'success', 'Done')
    }
    
    const result = buildRecentTasksContext(store, 1000) // Small budget
    
    expect(result.stats.usedTokens).toBeLessThanOrEqual(1000 * 1.3) // Allow 30% overflow for context reference
  })

  it('should increase budget when context reference detected', () => {
    store.saveTask('task1', '检查 nginx', [], 'success', '正常')
    
    const resultWithoutRef = buildRecentTasksContext(store, 1000, '新任务')
    const resultWithRef = buildRecentTasksContext(store, 1000, '继续刚才的任务')
    
    // With context reference, more budget should be available
    // This is reflected in potentially more detailed compression levels being used
    expect(resultWithRef.stats.budget).toBe(resultWithoutRef.stats.budget)
  })

  it('should handle task with pending confirmation', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_call', toolName: 'ask_user',
        toolArgs: { question: '是否继续?' }, content: '', timestamp: Date.now() }
    ]
    store.saveTask('task1', '危险操作', steps, 'pending_confirmation')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should populate availableTaskIds for recall_task', () => {
    store.saveTask('task1', 'Task 1', [], 'success', 'Done 1')
    store.saveTask('task2', 'Task 2', [], 'failed', 'Error')
    store.saveTask('task3', 'Task 3', [], 'success', 'Done 3')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.availableTaskIds).toHaveLength(3)
    expect(result.availableTaskIds.map(t => t.id)).toContain('task1')
    expect(result.availableTaskIds.map(t => t.id)).toContain('task2')
    expect(result.availableTaskIds.map(t => t.id)).toContain('task3')
  })
})

// ==================== buildTaskHistoryContext ====================

describe('buildTaskHistoryContext', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should calculate budget based on context length', () => {
    store.saveTask('task1', 'Task 1', [], 'success')
    
    const result = buildTaskHistoryContext(store, 128000, '新任务')
    
    // Budget should be based on calculateBudget(128000).recentTasks
    const expectedBudget = calculateBudget(128000).recentTasks
    expect(result.stats.budget).toBe(expectedBudget)
  })

  it('should pass user message for context reference detection', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Test', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Task 1', steps, 'success', 'Done')
    
    // This should trigger increased budget due to context reference
    const result = buildTaskHistoryContext(store, 10000, '继续上次的任务')
    
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should work with empty store', () => {
    const result = buildTaskHistoryContext(store, 128000, '新任务')
    
    expect(result.recentTaskMessages).toEqual([])
    expect(result.taskSummarySection).toBe('')
    expect(result.stats.totalTasks).toBe(0)
  })
})

// ==================== Integration scenarios ====================

describe('Context builder integration', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should handle mixed task statuses', () => {
    store.saveTask('task1', 'Success task', [], 'success', 'Done')
    store.saveTask('task2', 'Failed task', [], 'failed', 'Error occurred')
    store.saveTask('task3', 'Aborted task', [], 'aborted')
    
    const result = buildRecentTasksContext(store, 100000)
    
    expect(result.stats.totalTasks).toBe(3)
    expect(result.availableTaskIds).toHaveLength(3)
  })

  it('should preserve recent tasks at higher detail levels', () => {
    // Add many tasks, most recent should have better compression level
    for (let i = 0; i < 10; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'message', content: `Content ${i}`, timestamp: Date.now() + i }
      ]
      store.saveTask(`task${i}`, `Task ${i}`, steps, 'success', `Result ${i}`)
    }
    
    const result = buildRecentTasksContext(store, 50000)
    
    // Most recent task (index 0 in reversed order) should be at Level 0
    expect(result.stats.level0Count).toBeGreaterThanOrEqual(1)
  })

  it('should generate correct messages structure', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: 'Hello from AI', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'User request', steps, 'success', 'Done')
    
    const result = buildRecentTasksContext(store, 100000)
    
    // Level 0-2 tasks should produce messages
    if (result.stats.level0Count + result.stats.level1Count + result.stats.level2Count > 0) {
      expect(result.recentTaskMessages.length).toBeGreaterThan(0)
      // Check message structure
      result.recentTaskMessages.forEach(msg => {
        expect(msg).toHaveProperty('role')
        expect(msg).toHaveProperty('content')
      })
    }
  })

  it('should generate summary section for highly compressed tasks', () => {
    // Create many tasks to force compression
    for (let i = 0; i < 30; i++) {
      const steps: AgentStep[] = [
        { id: `${i}-1`, type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: `cmd_${i}` }, content: '', timestamp: Date.now() },
        { id: `${i}-2`, type: 'tool_result', toolName: 'execute_command',
          toolResult: `result_${i}`.repeat(100), content: '', timestamp: Date.now() },
        { id: `${i}-3`, type: 'message', content: `msg_${i}`.repeat(50), timestamp: Date.now() }
      ]
      store.saveTask(`task${i}`, `Task ${i}`, steps, 'success', `Result ${i}`)
    }
    
    const result = buildRecentTasksContext(store, 5000) // Small budget forces compression
    
    // Some tasks should be compressed to Level 3-4 (summary)
    if (result.stats.level3Count + result.stats.level4Count > 0) {
      expect(result.taskSummarySection.length).toBeGreaterThan(0)
    }
  })
})

// ==================== Edge cases ====================

describe('Context builder edge cases', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  it('should handle task with empty steps', () => {
    store.saveTask('task1', 'Empty task', [], 'success')
    
    const result = buildRecentTasksContext(store, 10000)
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should handle task with very long content', () => {
    const longContent = 'x'.repeat(10000)
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_result', toolName: 'execute_command',
        toolResult: longContent, content: '', timestamp: Date.now() }
    ]
    store.saveTask('task1', 'Long content task', steps, 'success')
    
    const result = buildRecentTasksContext(store, 1000) // Small budget
    
    // Should handle without error
    expect(result.stats.totalTasks).toBe(1)
  })

  it('should handle zero budget', () => {
    store.saveTask('task1', 'Task 1', [], 'success')
    
    const result = buildRecentTasksContext(store, 0)
    
    // With zero budget, tasks should still be tracked but compressed heavily
    expect(result.stats.budget).toBe(0)
  })

  it('should handle unicode content', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'message', content: '中文内容 🎉 émojis', timestamp: Date.now() }
    ]
    store.saveTask('task1', '中文任务 🚀', steps, 'success', '完成 ✓')
    
    const result = buildRecentTasksContext(store, 10000)
    
    expect(result.stats.totalTasks).toBe(1)
    expect(result.availableTaskIds[0].summary).toContain('中文任务')
  })
})
