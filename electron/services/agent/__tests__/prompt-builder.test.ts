/**
 * prompt-builder.ts 单元测试
 * 测试系统提示构建器的各种功能：MBTI 风格、主机环境、SSH/本地终端差异、知识库等
 */
import { describe, it, expect, vi } from 'vitest'

// Mock Electron 模块（必须在导入 PromptBuilder 之前）
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SFTerminal'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  },
  BrowserWindow: vi.fn(),
  ipcMain: { on: vi.fn(), handle: vi.fn() }
}))

// Mock fs 模块
vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(true),
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

import { 
  PromptBuilder, 
  getMbtiStylePrompt, 
  getAllMbtiTypes,
  buildSystemPrompt
} from '../prompt-builder'
import type { AgentContext, HostProfileServiceInterface } from '../types'

// ==================== 辅助函数 ====================

function createMockContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    ptyId: 'test-pty',
    terminalOutput: [],
    systemInfo: {
      os: 'darwin',
      shell: '/bin/zsh'
    },
    terminalType: 'local',
    ...overrides
  }
}

function createMockHostProfileService(): HostProfileServiceInterface {
  return {
    generateHostContext: vi.fn().mockReturnValue(''),
    addNote: vi.fn(),
    getProfile: vi.fn().mockReturnValue(null)
  }
}

// ==================== MBTI 风格测试 ====================

describe('MBTI Style', () => {
  describe('getMbtiStylePrompt', () => {
    it('should return empty string for null', () => {
      expect(getMbtiStylePrompt(null)).toBe('')
    })

    it('should return style for valid MBTI type', () => {
      const style = getMbtiStylePrompt('INTJ')
      expect(style).toContain('策略')
      expect(style.length).toBeGreaterThan(0)
    })

    it.each([
      ['INTJ', '策略'],
      ['INTP', '逻辑'],
      ['ENTJ', '指挥'],
      ['ENTP', '创新'],
      ['INFJ', '洞察'],
      ['INFP', '理想'],
      ['ENFJ', '鼓励'],
      ['ENFP', '创意'],
      ['ISTJ', '可靠'],
      ['ISFJ', '守护'],
      ['ESTJ', '管理'],
      ['ESFJ', '协作'],
      ['ISTP', '实干'],
      ['ISFP', '灵活'],
      ['ESTP', '敏捷'],
      ['ESFP', '活力']
    ])('should return appropriate style for %s', (type, keyword) => {
      const style = getMbtiStylePrompt(type as any)
      expect(style).toContain(keyword)
    })
  })

  describe('getAllMbtiTypes', () => {
    it('should return all 16 MBTI types', () => {
      const types = getAllMbtiTypes()
      expect(types).toHaveLength(16)
    })

    it('should include type, name, and style for each', () => {
      const types = getAllMbtiTypes()
      for (const item of types) {
        expect(item.type).toBeDefined()
        expect(item.name).toBeDefined()
        expect(item.style).toBeDefined()
        expect(item.type.length).toBe(4) // MBTI 类型都是 4 个字母
      }
    })

    it('should include common MBTI types', () => {
      const types = getAllMbtiTypes()
      const typeNames = types.map(t => t.type)
      expect(typeNames).toContain('INTJ')
      expect(typeNames).toContain('ENFP')
      expect(typeNames).toContain('ISTP')
    })
  })

  describe('PromptBuilder.getMbtiStylePrompt', () => {
    it('should be same as standalone function', () => {
      expect(PromptBuilder.getMbtiStylePrompt('INTJ')).toBe(getMbtiStylePrompt('INTJ'))
      expect(PromptBuilder.getMbtiStylePrompt(null)).toBe(getMbtiStylePrompt(null))
    })
  })
})

// ==================== PromptBuilder 构建测试 ====================

describe('PromptBuilder', () => {
  describe('build', () => {
    it('should build prompt with basic context', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('旗鱼（SailFish）AI Agent')
      expect(prompt).toContain('darwin')
      expect(prompt).toContain('zsh')
    })

    it('should include current working directory', () => {
      const context = createMockContext({ cwd: '/home/user/project' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('/home/user/project')
    })

    it('should include MBTI style when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        mbtiType: 'INTJ'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('策略')
      expect(prompt).toContain('你的风格')
    })

    it('should not include MBTI section when null', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        mbtiType: null
      })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('你的风格（重要！）')
    })

    it('should include user rules when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        aiRules: '请使用简洁的语言回复'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('用户自定义规则')
      expect(prompt).toContain('请使用简洁的语言回复')
    })

    it('should not include user rules section when empty', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        aiRules: ''
      })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('用户自定义规则')
    })

    it('should include personality section when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        personalityText: '回答要先结论后细节，少客套'
      })
      const prompt = builder.build()

      expect(prompt).toContain('你的个性补充')
      expect(prompt).toContain('先结论后细节')
    })

    it('should place personality section after MBTI section', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        mbtiType: 'INTJ',
        personalityText: '保持直接风格'
      })
      const prompt = builder.build()

      const mbtiPos = prompt.indexOf('## 你的风格（重要！）')
      const personalityPos = prompt.indexOf('## 你的个性补充（在 MBTI 基础上追加）')
      expect(mbtiPos).toBeGreaterThan(-1)
      expect(personalityPos).toBeGreaterThan(mbtiPos)
    })
  })

  describe('SSH terminal', () => {
    it('should include SSH constraints for SSH terminal', () => {
      const context = createMockContext({ terminalType: 'ssh' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('SSH 终端约束')
      expect(prompt).toContain('write_remote_file')
      expect(prompt).toContain('🌐 SSH 远程终端')
    })

    it('should include SSH status judgment tips', () => {
      const context = createMockContext({ terminalType: 'ssh' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('SSH 终端状态判断')
      expect(prompt).toContain('Password:')
      expect(prompt).toContain('--More--')
    })

    it('should not include SSH constraints for local terminal', () => {
      const context = createMockContext({ terminalType: 'local' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('SSH 终端约束')
      expect(prompt).toContain('💻 本地终端')
    })
  })

  describe('knowledge context', () => {
    it('should include knowledge section when enabled with context', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        knowledgeEnabled: true,
        knowledgeContext: '相关文档内容：这是测试内容'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('相关文档内容：这是测试内容')
      expect(prompt).toContain('你有知识库')
      expect(prompt).toContain('search_knowledge')
    })

    it('should show tool hint when enabled without context', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        knowledgeEnabled: true,
        knowledgeContext: ''
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('知识库工具')
      expect(prompt).toContain('search_knowledge')
    })

    it('should not include knowledge section when disabled', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        knowledgeEnabled: false
      })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('你有知识库')
      expect(prompt).not.toContain('知识库工具')
    })
  })

  describe('document context', () => {
    it('should include document when provided', () => {
      const context = createMockContext({
        documentContext: '## 用户上传的参考文档\n这是文档内容'
      })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('用户上传的参考文档')
      expect(prompt).toContain('这是文档内容')
      expect(prompt).toContain('直接使用上下文中的文档内容')
    })

    it('should not include document section when not provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('用户上传的参考文档')
    })
  })

  describe('execution mode', () => {
    it('should show strict mode note', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        executionMode: 'strict'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('严格')
      expect(prompt).toContain('所有命令需用户确认')
    })

    it('should show relaxed mode note', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        executionMode: 'relaxed'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('宽松')
      expect(prompt).toContain('仅危险命令需确认')
    })

    it('should show free mode note', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        executionMode: 'free'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('自由')
      expect(prompt).toContain('自动执行')
    })
  })

  describe('host profile', () => {
    it('should include host info when profile exists', () => {
      const context = createMockContext({ hostId: 'host-1' })
      const hostProfileService = createMockHostProfileService()
      ;(hostProfileService.getProfile as any).mockReturnValue({
        hostname: 'production-server',
        os: 'linux',
        shell: '/bin/bash',
        installedTools: ['docker', 'git', 'nginx']
      })
      
      const builder = new PromptBuilder({ 
        context,
        hostProfileService
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('production-server')
      expect(prompt).toContain('docker')
      expect(prompt).toContain('已安装工具')
    })

    it('should include conversation history when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        conversationHistory: [{
          userRequest: '检查 MySQL 状态',
          finalResult: 'MySQL 运行正常，端口 3306',
          status: 'success',
          timestamp: Date.now() - 60 * 60 * 1000,
          relevance: 0.9
        }]
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('相关历史')
      expect(prompt).toContain('检查 MySQL 状态')
    })
  })

  describe('task memory', () => {
    it('should include task memory section when available', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        availableTaskIds: [
          { id: 'task1', summary: '检查 nginx 状态' },
          { id: 'task2', summary: '重启 MySQL 服务' }
        ]
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('历史任务')
      expect(prompt).toContain('task1')
      expect(prompt).toContain('检查 nginx 状态')
      expect(prompt).toContain('task2')
      expect(prompt).toContain('recall_task')
    })

    it('should include task summaries when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        availableTaskIds: [{ id: 'task1', summary: '测试' }],
        taskSummaries: '过去 5 个任务的摘要信息'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('任务摘要')
      expect(prompt).toContain('过去 5 个任务的摘要信息')
    })

    it('should include related task digests when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        availableTaskIds: [{ id: 'task1', summary: '测试' }],
        relatedTaskDigests: '相关任务详情'
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('相关详情')
      expect(prompt).toContain('相关任务详情')
    })

    it('should not include task memory section when no tasks', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        availableTaskIds: []
      })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('历史任务')
    })
  })

  describe('core rules', () => {
    it('should include safety rules', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('安全红线')
      expect(prompt).toContain('备份')
      expect(prompt).toContain('密码')
    })

    it('should include forbidden commands', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('禁止的命令')
      expect(prompt).toContain('vim')
      expect(prompt).toContain('nano')
      expect(prompt).toContain('tmux')
    })

    it('should include work style guidelines', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('工作方式')
      expect(prompt).toContain('调用工具前')
      expect(prompt).toContain('工具执行后')
    })

    it('should require responding in user language', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('SAME language')
      expect(prompt).toContain('English')
      expect(prompt).toContain('Chinese')
    })
  })
})

// ==================== 向后兼容函数测试 ====================

describe('buildSystemPrompt (backward compatible)', () => {
  it('should work with minimal arguments', () => {
    const context = createMockContext()
    const prompt = buildSystemPrompt(context)
    
    expect(prompt).toContain('旗鱼（SailFish）AI Agent')
    expect(prompt.length).toBeGreaterThan(100)
  })

  it('should work with all arguments', () => {
    const context = createMockContext()
    const hostProfileService = createMockHostProfileService()
    
    const prompt = buildSystemPrompt(
      context,
      hostProfileService,
      'INTJ',
      '知识库内容',
      true,
      [{
        userRequest: '记忆1',
        finalResult: '记忆2',
        status: 'success',
        timestamp: Date.now(),
        relevance: 0.9
      }],
      'strict',
      '用户规则',
      '个性补充',
      '任务摘要',
      '相关任务',
      [{ id: 'task1', summary: '测试任务' }]
    )
    
    expect(prompt).toContain('策略') // MBTI
    expect(prompt).toContain('知识库内容')
    expect(prompt).toContain('记忆1')
    expect(prompt).toContain('用户规则')
    expect(prompt).toContain('个性补充')
    expect(prompt).toContain('任务摘要')
    expect(prompt).toContain('task1')
  })

  it('should produce same result as PromptBuilder', () => {
    const context = createMockContext()
    
    const fromFunction = buildSystemPrompt(context, undefined, 'ENFP')
    
    const builder = new PromptBuilder({ context, mbtiType: 'ENFP' })
    const fromBuilder = builder.build()
    
    expect(fromFunction).toBe(fromBuilder)
  })
})

// ==================== 对话历史检索测试 ====================

describe('Conversation History in Prompt', () => {
  describe('formatTimeAgo', () => {
    it('should show "刚刚" for recent timestamps (< 1 hour)', () => {
      const result = PromptBuilder.formatTimeAgo(Date.now() - 30 * 60 * 1000)
      expect(result).toBe('刚刚')
    })

    it('should show hours for timestamps < 24 hours', () => {
      const result = PromptBuilder.formatTimeAgo(Date.now() - 5 * 60 * 60 * 1000)
      expect(result).toBe('5小时前')
    })

    it('should show days for timestamps < 30 days', () => {
      const result = PromptBuilder.formatTimeAgo(Date.now() - 3 * 24 * 60 * 60 * 1000)
      expect(result).toBe('3天前')
    })

    it('should show months for timestamps >= 30 days', () => {
      const result = PromptBuilder.formatTimeAgo(Date.now() - 65 * 24 * 60 * 60 * 1000)
      expect(result).toBe('2个月前')
    })
  })

  describe('conversation history in prompt', () => {
    it('should include conversation history section', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        conversationHistory: [{
          userRequest: '部署前端到生产环境',
          finalResult: '部署成功',
          status: 'success',
          timestamp: Date.now() - 3 * 24 * 60 * 60 * 1000,
          relevance: 0.85
        }]
      })
      const prompt = builder.build()

      expect(prompt).toContain('相关历史')
      expect(prompt).toContain('部署前端到生产环境')
      expect(prompt).toContain('部署成功')
      expect(prompt).toContain('✓')
    })

    it('should show failed status icon', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        conversationHistory: [{
          userRequest: 'nginx 排错',
          finalResult: '排查失败',
          status: 'failed',
          timestamp: Date.now(),
          relevance: 0.7
        }]
      })
      const prompt = builder.build()

      expect(prompt).toContain('✗')
      expect(prompt).toContain('nginx 排错')
    })

    it('should not include section when conversation history is empty', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        conversationHistory: []
      })
      const prompt = builder.build()

      expect(prompt).not.toContain('相关历史')
    })
  })
})

// ==================== 边界情况测试 ====================

describe('Edge cases', () => {
  it('should handle Windows OS', () => {
    const context = createMockContext({
      systemInfo: { os: 'Windows 11', shell: 'powershell' }
    })
    const builder = new PromptBuilder({ context })
    const prompt = builder.build()
    
    expect(prompt).toContain('Windows 11')
    expect(prompt).toContain('powershell')
  })

  it('should handle Linux OS', () => {
    const context = createMockContext({
      systemInfo: { os: 'Ubuntu 22.04', shell: '/bin/bash' }
    })
    const builder = new PromptBuilder({ context })
    const prompt = builder.build()
    
    expect(prompt).toContain('Ubuntu 22.04')
    expect(prompt).toContain('bash')
  })

  it('should handle unknown OS/shell', () => {
    const context = createMockContext({
      systemInfo: { os: '', shell: '' }
    })
    const builder = new PromptBuilder({ context })
    const prompt = builder.build()
    
    // 应该不会崩溃，正常构建
    expect(prompt).toContain('旗鱼（SailFish）AI Agent')
  })

  it('should handle missing cwd', () => {
    const context = createMockContext()
    delete (context as any).cwd
    
    const builder = new PromptBuilder({ context })
    const prompt = builder.build()
    
    expect(prompt).toContain('未成功获取')
  })

  it('should handle conversation history in prompt', () => {
    const context = createMockContext()
    const history = Array(10).fill(null).map((_, i) => ({
      userRequest: `任务 ${i}`,
      finalResult: `结果 ${i}`,
      status: 'success',
      timestamp: Date.now() - i * 60 * 60 * 1000,
      relevance: 0.9 - i * 0.05
    }))
    
    const builder = new PromptBuilder({ 
      context,
      conversationHistory: history
    })
    const prompt = builder.build()
    
    expect(prompt).toContain('任务 0')
    expect(prompt).toContain('任务 9')
  })

  it('should handle whitespace-only user rules', () => {
    const context = createMockContext()
    const builder = new PromptBuilder({ 
      context,
      aiRules: '   \n\t  '
    })
    const prompt = builder.build()
    
    expect(prompt).not.toContain('用户自定义规则')
  })
})
