/**
 * task-memory.ts 单元测试
 * 测试任务记忆存储的关键词提取、相似度计算、摘要生成等功能
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  TaskMemoryStore,
  extractKeywords,
  calculateKeywordOverlap,
  detectPendingConfirmation,
  generateSummary,
  extractDigest,
  getTaskMemoryStore,
  clearTaskMemoryStore
} from '../task-memory'
import type { AgentStep } from '../types'

// ==================== extractKeywords ====================

describe('extractKeywords', () => {
  describe('service names extraction', () => {
    it.each([
      ['检查 nginx 状态', 'nginx'],
      ['重启 mysql 服务', 'mysql'],
      ['postgresql 连接问题', 'postgresql'],
      ['redis 缓存', 'redis'],
      ['mongodb 数据库', 'mongodb'],
      ['docker 容器', 'docker'],
      ['kubernetes 集群', 'kubernetes'],
      ['systemctl status', 'systemctl'],
      ['使用 git pull', 'git'],
      ['运行 npm install', 'npm'],
      ['执行 python 脚本', 'python'],
    ])('should extract service name from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('file path extraction', () => {
    it('should extract absolute paths', () => {
      const keywords = extractKeywords('编辑 /etc/nginx/nginx.conf 文件')
      expect(keywords).toContain('/etc/nginx/nginx.conf')
    })

    it('should extract multiple paths', () => {
      const keywords = extractKeywords('从 /var/log/syslog 复制到 /tmp/backup')
      expect(keywords).toContain('/var/log/syslog')
      expect(keywords).toContain('/tmp/backup')
    })
  })

  describe('port extraction', () => {
    it.each([
      ['端口 80', 'port:80'],
      ['port 443', 'port:443'],
      ['ssh 22', 'port:22'],
      ['MySQL 3306', 'port:3306'],
      ['PostgreSQL 5432', 'port:5432'],
      ['Redis 6379', 'port:6379'],
      ['开发服务器 8080', 'port:8080'],
    ])('should extract port from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('IP address extraction', () => {
    it('should extract IP addresses', () => {
      const keywords = extractKeywords('连接到 192.168.1.100')
      expect(keywords).toContain('192.168.1.100')
    })

    it('should extract multiple IPs', () => {
      const keywords = extractKeywords('从 10.0.0.1 到 10.0.0.2')
      expect(keywords).toContain('10.0.0.1')
      expect(keywords).toContain('10.0.0.2')
    })
  })

  describe('error keywords extraction', () => {
    it.each([
      ['error occurred', 'error'],
      ['connection failed', 'failed'],
      ['permission denied', 'denied'],
      ['connection refused', 'refused'],
      ['request timeout', 'timeout'],
      ['file not found', 'not found'],
      ['unauthorized access', 'unauthorized'],
      ['forbidden', 'forbidden'],
    ])('should extract error keyword from: %s', (text, expected) => {
      const keywords = extractKeywords(text)
      expect(keywords).toContain(expected)
    })
  })

  describe('deduplication', () => {
    it('should deduplicate keywords', () => {
      const keywords = extractKeywords('nginx nginx nginx')
      const nginxCount = keywords.filter(k => k === 'nginx').length
      expect(nginxCount).toBe(1)
    })
  })
})

// ==================== calculateKeywordOverlap ====================

describe('calculateKeywordOverlap', () => {
  it('should return 0 for empty arrays', () => {
    expect(calculateKeywordOverlap([], ['nginx'])).toBe(0)
    expect(calculateKeywordOverlap(['nginx'], [])).toBe(0)
    expect(calculateKeywordOverlap([], [])).toBe(0)
  })

  it('should return 0 for no overlap', () => {
    const score = calculateKeywordOverlap(['nginx', 'config'], ['mysql', 'backup'])
    expect(score).toBe(0)
  })

  it('should return positive score for exact match', () => {
    const score = calculateKeywordOverlap(['nginx'], ['nginx'])
    expect(score).toBeGreaterThan(0)
  })

  it('should return higher score for more matches', () => {
    const score1 = calculateKeywordOverlap(['nginx'], ['nginx', 'mysql'])
    const score2 = calculateKeywordOverlap(['nginx', 'config'], ['nginx', 'config'])
    expect(score2).toBeGreaterThan(score1)
  })

  it('should handle partial matches (path containment)', () => {
    const score = calculateKeywordOverlap(['/etc/nginx'], ['/etc/nginx/nginx.conf'])
    expect(score).toBeGreaterThan(0)
  })

  it('should be case insensitive', () => {
    const score = calculateKeywordOverlap(['NGINX'], ['nginx'])
    expect(score).toBeGreaterThan(0)
  })
})

// ==================== detectPendingConfirmation ====================

describe('detectPendingConfirmation', () => {
  it('should detect pending ask_user without response', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: '是否继续?' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps)
    expect(result.isPending).toBe(true)
    expect(result.pendingAction).toBe('是否继续?')
  })

  it('should not detect when ask_user has response', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: '是否继续?' },
        content: '',
        timestamp: Date.now()
      },
      {
        id: '2',
        type: 'tool_result',
        toolName: 'ask_user',
        toolResult: '是',
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps)
    expect(result.isPending).toBe(false)
  })

  it('should truncate long questions', () => {
    const longQuestion = 'a'.repeat(100)
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'ask_user',
        toolArgs: { question: longQuestion },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps)
    expect(result.pendingAction!.length).toBeLessThanOrEqual(53) // 50 + '...'
  })

  it('should return not pending for empty steps', () => {
    const result = detectPendingConfirmation([])
    expect(result.isPending).toBe(false)
  })

  it('should handle steps without ask_user', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'ls' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const result = detectPendingConfirmation(steps)
    expect(result.isPending).toBe(false)
  })
})

// ==================== generateSummary ====================

describe('generateSummary', () => {
  it('should generate success summary with icon', () => {
    const summary = generateSummary('检查 nginx', 'success', '服务正常')
    expect(summary).toContain('✓')
    expect(summary).toContain('检查 nginx')
  })

  it('should generate failed summary with icon', () => {
    const summary = generateSummary('安装软件', 'failed', '安装失败')
    expect(summary).toContain('✗')
  })

  it('should generate aborted summary', () => {
    const summary = generateSummary('长任务', 'aborted')
    expect(summary).toContain('⊘')
    expect(summary).toContain('已中止')
  })

  it('should generate pending confirmation summary', () => {
    const summary = generateSummary('危险操作', 'pending_confirmation', '', '是否删除?')
    expect(summary).toContain('⏳')
    expect(summary).toContain('等待确认')
    expect(summary).toContain('是否删除?')
  })

  it('should truncate long requests', () => {
    const longRequest = 'a'.repeat(50)
    const summary = generateSummary(longRequest, 'success')
    expect(summary.length).toBeLessThan(longRequest.length + 20)
  })

  it('should include result summary', () => {
    const summary = generateSummary('查询', 'success', '找到 10 条记录')
    expect(summary).toContain('找到 10 条记录')
  })
})

// ==================== extractDigest ====================

describe('extractDigest', () => {
  it('should extract commands from steps', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'systemctl status nginx' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '检查 nginx')
    expect(digest.commands).toContain('systemctl status nginx')
  })

  it('should extract services from commands', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'systemctl restart mysql' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '')
    expect(digest.services).toContain('mysql')
  })

  it('should extract paths from commands', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_call',
        toolName: 'execute_command',
        toolArgs: { command: 'cat /etc/nginx/nginx.conf' },
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '')
    expect(digest.paths).toContain('/etc/nginx/nginx.conf')
  })

  it('should extract errors from results', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'tool_result',
        toolName: 'execute_command',
        toolResult: 'Error: connection refused',
        content: '',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '')
    expect(digest.errors.length).toBeGreaterThan(0)
  })

  it('should extract key findings from messages', () => {
    const steps: AgentStep[] = [
      {
        id: '1',
        type: 'message',
        content: '发现: 服务未启动\n原因: 配置文件错误',
        timestamp: Date.now()
      }
    ]
    
    const digest = extractDigest(steps, '')
    expect(digest.keyFindings.length).toBeGreaterThan(0)
  })

  it('should extract services from user request', () => {
    const digest = extractDigest([], '检查 redis 和 nginx 状态')
    expect(digest.services).toContain('redis')
    expect(digest.services).toContain('nginx')
  })

  it('should limit arrays to prevent overflow', () => {
    const steps: AgentStep[] = Array(20).fill(null).map((_, i) => ({
      id: String(i),
      type: 'tool_call' as const,
      toolName: 'execute_command',
      toolArgs: { command: `command_${i}` },
      content: '',
      timestamp: Date.now()
    }))
    
    const digest = extractDigest(steps, '')
    expect(digest.commands.length).toBeLessThanOrEqual(10)
  })
})

// ==================== TaskMemoryStore ====================

describe('TaskMemoryStore', () => {
  let store: TaskMemoryStore

  beforeEach(() => {
    store = new TaskMemoryStore()
  })

  describe('saveTask', () => {
    it('should save task and return memory', () => {
      const memory = store.saveTask('task1', '检查 nginx', [], 'success', '正常')
      
      expect(memory.id).toBe('task1')
      expect(memory.userRequest).toBe('检查 nginx')
      expect(memory.status).toBe('success')
      expect(memory.summary).toContain('✓')
    })

    it('should update existing task', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      store.saveTask('task1', '检查 nginx 更新', [], 'failed')
      
      expect(store.getTaskCount()).toBe(1)
      const task = store.getTask('task1')
      expect(task?.userRequest).toBe('检查 nginx 更新')
    })

    it('should limit max memories', () => {
      // Create store with small limit for testing
      const smallStore = new TaskMemoryStore()
      // @ts-expect-error - accessing private property for testing
      smallStore.maxMemories = 3
      
      smallStore.saveTask('task1', 'Task 1', [], 'success')
      smallStore.saveTask('task2', 'Task 2', [], 'success')
      smallStore.saveTask('task3', 'Task 3', [], 'success')
      smallStore.saveTask('task4', 'Task 4', [], 'success')
      
      expect(smallStore.getTaskCount()).toBe(3)
      expect(smallStore.hasTask('task1')).toBe(false)
      expect(smallStore.hasTask('task4')).toBe(true)
    })
  })

  describe('getSummaries', () => {
    it('should return summaries in reverse chronological order', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const summaries = store.getSummaries()
      expect(summaries[0].id).toBe('task3')
      expect(summaries[2].id).toBe('task1')
    })

    it('should respect limit', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const summaries = store.getSummaries(2)
      expect(summaries).toHaveLength(2)
    })

    it('should return empty array for empty store', () => {
      const summaries = store.getSummaries()
      expect(summaries).toEqual([])
    })
  })

  describe('getRelatedDigests', () => {
    beforeEach(() => {
      store.saveTask('task1', '检查 nginx 状态', [
        { id: '1', type: 'tool_call', toolName: 'execute_command', 
          toolArgs: { command: 'systemctl status nginx' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      store.saveTask('task2', '重启 mysql 服务', [
        { id: '2', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'systemctl restart mysql' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      store.saveTask('task3', '查看磁盘空间', [
        { id: '3', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'df -h' }, content: '', timestamp: Date.now() }
      ], 'success')
    })

    it('should return related tasks by keyword', () => {
      const related = store.getRelatedDigests('nginx 配置')
      expect(related.length).toBeGreaterThan(0)
      expect(related[0].taskId).toBe('task1')
    })

    it('should return empty for no matches', () => {
      const related = store.getRelatedDigests('completely unrelated query')
      expect(related).toEqual([])
    })

    it('should respect topK limit', () => {
      const related = store.getRelatedDigests('systemctl', 1)
      expect(related.length).toBeLessThanOrEqual(1)
    })

    it('should return empty for empty query', () => {
      const related = store.getRelatedDigests('')
      expect(related).toEqual([])
    })
  })

  describe('getDigest', () => {
    it('should return digest for existing task', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      const result = store.getDigest('task1')
      
      expect(result).not.toBeNull()
      expect(result!.userRequest).toBe('检查 nginx')
    })

    it('should return null for non-existent task', () => {
      expect(store.getDigest('non-existent')).toBeNull()
    })
  })

  describe('getFullSteps', () => {
    const steps: AgentStep[] = [
      { id: '1', type: 'tool_call', toolName: 'execute_command', content: '', timestamp: Date.now() },
      { id: '2', type: 'tool_result', toolName: 'execute_command', content: '', timestamp: Date.now() }
    ]

    beforeEach(() => {
      store.saveTask('task1', 'Task', steps, 'success')
    })

    it('should return all steps', () => {
      const result = store.getFullSteps('task1')
      expect(Array.isArray(result)).toBe(true)
      expect((result as AgentStep[]).length).toBe(2)
    })

    it('should return specific step by index', () => {
      const result = store.getFullSteps('task1', 0)
      expect((result as AgentStep).id).toBe('1')
    })

    it('should return null for invalid index', () => {
      expect(store.getFullSteps('task1', 99)).toBeNull()
      expect(store.getFullSteps('task1', -1)).toBeNull()
    })

    it('should return null for non-existent task', () => {
      expect(store.getFullSteps('non-existent')).toBeNull()
    })
  })

  describe('utility methods', () => {
    it('getTaskCount should return correct count', () => {
      expect(store.getTaskCount()).toBe(0)
      store.saveTask('task1', 'Task 1', [], 'success')
      expect(store.getTaskCount()).toBe(1)
    })

    it('hasTask should check existence', () => {
      expect(store.hasTask('task1')).toBe(false)
      store.saveTask('task1', 'Task 1', [], 'success')
      expect(store.hasTask('task1')).toBe(true)
    })

    it('getTask should return full task', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      const task = store.getTask('task1')
      expect(task).not.toBeNull()
      expect(task!.id).toBe('task1')
    })

    it('clear should remove all tasks', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.clear()
      expect(store.getTaskCount()).toBe(0)
    })
  })

  describe('getTasksInOrder', () => {
    it('should return tasks in reverse chronological order', () => {
      store.saveTask('task1', 'Task 1', [], 'success')
      store.saveTask('task2', 'Task 2', [], 'success')
      store.saveTask('task3', 'Task 3', [], 'success')
      
      const tasks = store.getTasksInOrder()
      expect(tasks[0].id).toBe('task3')
      expect(tasks[2].id).toBe('task1')
    })
  })

  describe('formatSummariesForContext', () => {
    it('should format summaries as list', () => {
      store.saveTask('task1', '检查 nginx', [], 'success')
      store.saveTask('task2', '重启 mysql', [], 'failed')
      
      const formatted = store.formatSummariesForContext()
      expect(formatted).toContain('[task1]')
      expect(formatted).toContain('[task2]')
    })

    it('should return empty string for empty store', () => {
      expect(store.formatSummariesForContext()).toBe('')
    })
  })

  describe('formatRelatedDigestsForContext', () => {
    it('should format digests with details', () => {
      store.saveTask('task1', '检查 nginx 状态', [
        { id: '1', type: 'tool_call', toolName: 'execute_command',
          toolArgs: { command: 'systemctl status nginx' }, content: '', timestamp: Date.now() }
      ], 'success')
      
      const digests = store.getRelatedDigests('nginx')
      const formatted = store.formatRelatedDigestsForContext(digests)
      
      expect(formatted).toContain('task1')
      expect(formatted).toContain('命令')
    })

    it('should return empty string for empty digests', () => {
      expect(store.formatRelatedDigestsForContext([])).toBe('')
    })
  })
})

// ==================== Global store functions ====================

describe('Global TaskMemoryStore functions', () => {
  it('getTaskMemoryStore should return store for ptyId', () => {
    const store1 = getTaskMemoryStore('pty1')
    const store2 = getTaskMemoryStore('pty1')
    expect(store1).toBe(store2) // Same instance
  })

  it('getTaskMemoryStore should return different stores for different ptyIds', () => {
    const store1 = getTaskMemoryStore('pty1')
    const store2 = getTaskMemoryStore('pty2')
    expect(store1).not.toBe(store2)
  })

  it('clearTaskMemoryStore should remove store', () => {
    const store1 = getTaskMemoryStore('pty-clear-test')
    store1.saveTask('task1', 'Task', [], 'success')
    
    clearTaskMemoryStore('pty-clear-test')
    
    const store2 = getTaskMemoryStore('pty-clear-test')
    expect(store2.getTaskCount()).toBe(0)
  })
})
