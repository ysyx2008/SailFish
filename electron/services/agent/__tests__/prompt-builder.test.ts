/**
 * prompt-builder.ts 单元测试
 * 测试系统提示构建器的各种功能：MBTI 风格、主机环境、SSH/本地终端差异、知识库等
 */
import { describe, it, expect, vi } from 'vitest'

// Mock Electron 模块（必须在导入 PromptBuilder 之前）
vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
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

vi.mock('../../browser-bridge/browser-bridge.service', () => ({
  getBrowserBridgeService: vi.fn().mockReturnValue({
    getStatus: vi.fn().mockReturnValue({
      gatewayRunning: true,
      port: 12345,
      connections: [],
      install: null,
      extensionIds: {
        chromium: 'dgmhdapfpihhkboikpgfanpgnijbpdhd',
        chromiumDev: 'ocdljfppijcjpgaaamgeailkgajgjdml',
        firefox: 'sailfish-browser-bridge@yushen.dev',
      },
    }),
  }),
}))

import * as fs from 'fs'
import { 
  PromptBuilder, 
  getMbtiStylePrompt, 
  getAllMbtiTypes,
  buildSystemPrompt,
  buildLoadedSkillsRosterSection,
  buildLoadedSkillsThisTurnHint,
  buildSkillsContentSectionText,
  patchLoadedSkillsSectionsInSystemPrompt,
  LOADED_SKILLS_ROSTER_HEADING,
  SKILLS_CONTENT_HEADING,
} from '../prompt-builder'
import type { AgentContext, HostProfileServiceInterface } from '../types'
import { normalizeProactiveCompact } from '@shared/types'

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
      expect(prompt).toContain('软件启动时间：')
      expect(prompt).toMatch(/软件启动时间：\d{4}-\d{2}-\d{2} \d{2}:\d{2} 周[日一二三四五六]/)
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

    it('should include personality as primary section when provided', () => {
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('SOUL.md')) return '回答要先结论后细节，少客套'
        return ''
      })
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()

      expect(prompt).toContain('# 你的灵魂（重要！）')
      expect(prompt).toContain('先结论后细节')
      vi.mocked(fs.readFileSync).mockReturnValue('' as any)
    })

    it('should nest MBTI under personality when both provided', () => {
      vi.mocked(fs.readFileSync).mockImplementation((p: any) => {
        if (typeof p === 'string' && p.includes('SOUL.md')) return '保持直接风格'
        return ''
      })
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        mbtiType: 'INTJ',
      })
      const prompt = builder.build()

      expect(prompt).toContain('# 你的灵魂（重要！）')
      expect(prompt).toContain('保持直接风格')
      expect(prompt).toContain('## 风格参考（MBTI）')
      expect(prompt).not.toContain('# 你的风格（重要！）\n')
      vi.mocked(fs.readFileSync).mockReturnValue('' as any)
    })

    it('should use MBTI as primary when no personality text', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        mbtiType: 'INTJ',
      })
      const prompt = builder.build()

      expect(prompt).toContain('# 你的风格（重要！）')
      expect(prompt).not.toContain('# 你的灵魂（重要！）')
    })
  })

  describe('SSH terminal', () => {
    it('should show SSH terminal type in host environment', () => {
      const context = createMockContext({ terminalType: 'ssh' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('🌐 SSH 远程终端')
    })

    it('should show local terminal type in host environment', () => {
      const context = createMockContext({ terminalType: 'local' })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('- **终端类型**: 💻 本地终端')
      expect(prompt).not.toContain('🌐 SSH 远程终端')
    })
  })

  describe('workbench prompt', () => {
    it('should include workbenchPrompt verbatim when set on context', () => {
      const snippet = '# 界面能力（产出物面板）\n\n测试工作台描述'
      const prompt = new PromptBuilder({
        context: createMockContext({ workbenchPrompt: snippet })
      }).build()

      expect(prompt).toContain(snippet)
    })

    it('should omit workbench section when workbenchPrompt absent', () => {
      const prompt = new PromptBuilder({ context: createMockContext() }).build()
      expect(prompt).not.toContain('# 界面能力（产出物面板）')
    })
  })

  describe('skills content', () => {
    it('should include skills content when provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({
        context,
        skillsContent: '**禁止的命令**：vim/vi/nano/emacs'
      })
      const prompt = builder.build()

      expect(prompt).toContain('技能文档')
      expect(prompt).toContain('禁止的命令')
      expect(prompt).toContain('vim')
    })

    it('should not include skills content section when empty', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()

      expect(prompt).not.toContain('技能文档')
    })
  })

  describe('loaded skills roster', () => {
    it('says none are open when roster is empty', () => {
      const prompt = new PromptBuilder({ context: createMockContext() }).build()
      expect(prompt).toContain('这场对话开着的技能')
      expect(prompt).toContain('当前没有开着的技能')
    })

    it('lists currently open skills including user-mounted ones', () => {
      const prompt = new PromptBuilder({
        context: createMockContext(),
        loadedSkillsRoster: [
          { id: 'user:polymarket', name: 'polymarket' },
          { id: 'excel', name: 'Excel' },
        ],
      }).build()
      expect(prompt).toContain('polymarket（user:polymarket）')
      expect(prompt).toContain('Excel（excel）')
      expect(prompt).toContain('不要只凭自己有没有 load 过判断')
    })
  })

  describe('buildLoadedSkillsThisTurnHint', () => {
    it('says none when roster is empty', () => {
      expect(buildLoadedSkillsThisTurnHint([])).toBe(
        '这场对话当前开着的技能：无。以这一行为准，不要用上一轮的回答。'
      )
    })

    it('lists currently open skills', () => {
      const hint = buildLoadedSkillsThisTurnHint([
        { id: 'user:polymarket', name: 'polymarket' },
        { id: 'excel', name: 'Excel' },
      ])
      expect(hint).toContain('polymarket（user:polymarket）')
      expect(hint).toContain('Excel（excel）')
      expect(hint).toContain('以这一行为准')
    })
  })

  describe('patchLoadedSkillsSectionsInSystemPrompt', () => {
    it('inserts roster and skill docs into an old cached prompt', () => {
      const patched = patchLoadedSkillsSectionsInSystemPrompt(
        '# 已有关切\n\n无',
        buildLoadedSkillsRosterSection([{ id: 'user:polymarket', name: 'polymarket' }]),
        buildSkillsContentSectionText('## polymarket\n\n查市场'),
      )
      expect(patched).toContain(LOADED_SKILLS_ROSTER_HEADING)
      expect(patched).toContain('polymarket（user:polymarket）')
      expect(patched).toContain(SKILLS_CONTENT_HEADING)
      expect(patched).toContain('查市场')
    })

    it('replaces a stale roster when skills change', () => {
      const first = patchLoadedSkillsSectionsInSystemPrompt(
        '# 身份\n\n秘书',
        buildLoadedSkillsRosterSection([{ id: 'excel', name: 'Excel' }]),
        '',
      )
      const next = patchLoadedSkillsSectionsInSystemPrompt(
        first,
        buildLoadedSkillsRosterSection([]),
        '',
      )
      expect(next).toContain('当前没有开着的技能')
      expect(next).not.toContain('Excel')
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
      expect(prompt).toContain('知识库')
      expect(prompt).toContain('search_knowledge')
      expect(prompt).toContain('sf_user_message')
    })

    it('should show tool hint when enabled without context', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        knowledgeEnabled: true,
        knowledgeContext: ''
      })
      const prompt = builder.build()
      
      expect(prompt).toContain('知识库')
      expect(prompt).toContain('search_knowledge')
    })

    it('should not include knowledge section when disabled', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ 
        context,
        knowledgeEnabled: false
      })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('search_knowledge')
    })
  })

  describe('document context', () => {
    it('should include document when provided', () => {
      const context = createMockContext({
        documentContext: '## 用户上传的参考文档\n这是文档内容'
      })
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('用户附加了文档')
      expect(prompt).toContain('sf_uploaded_docs')
    })

    it('should not include document section when not provided', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('用户附加了文档')
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
      expect(prompt).toContain('另有硬墙')
      expect(prompt).toContain('不排除存在误报可能')
      expect(prompt).not.toContain('不要换写法')
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
      expect(prompt).toContain('另有硬墙')
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
      expect(prompt).toContain('另有硬墙')
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

    it('should fall back to profile.shell when context.systemInfo.shell is unknown', () => {
      const context = createMockContext({
        hostId: 'local',
        systemInfo: { os: 'windows', shell: 'unknown' }
      })
      const hostProfileService = createMockHostProfileService()
      ;(hostProfileService.getProfile as any).mockReturnValue({
        hostname: 'DESKTOP',
        shell: 'powershell'
      })

      const prompt = PromptBuilder.buildHostEnvironment(context, hostProfileService)

      expect(prompt).toContain('Shell: powershell')
      expect(prompt).not.toContain('Shell: unknown')
    })

    it('should prefer context.systemInfo.shell over profile.shell', () => {
      const context = createMockContext({
        hostId: 'local',
        systemInfo: { os: 'windows', shell: 'cmd' }
      })
      const hostProfileService = createMockHostProfileService()
      ;(hostProfileService.getProfile as any).mockReturnValue({
        shell: 'powershell'
      })

      const prompt = PromptBuilder.buildHostEnvironment(context, hostProfileService)

      expect(prompt).toContain('Shell: cmd')
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
      
      expect(prompt).toContain('过往对话')
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
      expect(prompt).toContain('recall')
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

    it('should not include terminal-specific rules (moved to workbench prompt)', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).not.toContain('禁止的命令')
      expect(prompt).not.toContain('tmux')
      expect(prompt).not.toContain('长耗时命令')
    })

    it('should include work style guidelines', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('行为准则')
      expect(prompt).toContain('调用工具前')
      expect(prompt).toContain('执行后')
    })

    it('should require responding in user language', () => {
      const context = createMockContext()
      const builder = new PromptBuilder({ context })
      const prompt = builder.build()
      
      expect(prompt).toContain('SAME language')
      expect(prompt).toContain('MUST respond')
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
      '任务摘要',
      '相关任务',
      [{ id: 'task1', summary: '测试任务' }]
    )
    
    expect(prompt).toContain('策略') // MBTI
    expect(prompt).toContain('知识库内容')
    expect(prompt).toContain('记忆1')
    expect(prompt).toContain('用户规则')
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

      expect(prompt).toContain('过往对话')
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

      expect(prompt).not.toContain('过往对话')
    })
  })
})

// ==================== 交互通道测试 ====================

describe('Remote channel context', () => {
  it('should include Mermaid rendering hint for desktop channel', () => {
    const builder = new PromptBuilder({ context: createMockContext({ remoteChannel: 'desktop' }) })
    const prompt = builder.build()

    expect(prompt).toContain('mermaid')
    expect(prompt).toContain('Mermaid 语法')
    expect(prompt).toContain('浅色白底')
  })

  it('should include Mermaid hint when remoteChannel is omitted (defaults to desktop)', () => {
    const builder = new PromptBuilder({ context: createMockContext() })
    const prompt = builder.build()

    expect(prompt).toContain('Mermaid 语法')
  })

  it('should not include Mermaid hint for IM channels', () => {
    const builder = new PromptBuilder({ context: createMockContext({ remoteChannel: 'feishu' }) })
    const prompt = builder.build()

    expect(prompt).toContain('飞书机器人')
    expect(prompt).not.toContain('Mermaid 语法')
  })

  it('should not include Mermaid hint for web channel', () => {
    const builder = new PromptBuilder({ context: createMockContext({ remoteChannel: 'web' }) })
    const prompt = builder.build()

    expect(prompt).toContain('Web 远程页面')
    expect(prompt).not.toContain('Mermaid 语法')
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

  it('should include browser bridge section when extension connected', async () => {
    const { getBrowserBridgeService } = await import('../../browser-bridge/browser-bridge.service')
    vi.mocked(getBrowserBridgeService).mockReturnValue({
      getStatus: vi.fn().mockReturnValue({
        gatewayRunning: true,
        port: 12345,
        connections: [{ browser: 'chrome', origin: 'chrome-extension://abc/', state: 'ready' }],
        install: null,
        extensionIds: {
          chromium: 'dgmhdapfpihhkboikpgfanpgnijbpdhd',
          chromiumDev: 'ocdljfppijcjpgaaamgeailkgajgjdml',
          firefox: 'sailfish-browser-bridge@yushen.dev',
        },
      }),
    } as unknown as ReturnType<typeof getBrowserBridgeService>)

    const prompt = new PromptBuilder({ context: createMockContext() }).build()
    expect(prompt).toContain('# 浏览器助手')
    expect(prompt).toContain('Chromium')
    expect(prompt).toContain('browser_list_tabs')
  })
})

describe('上下文开销', () => {
  it('默认适中：同一本账，取向写在最后一句', () => {
    const prompt = new PromptBuilder({ context: createMockContext() }).build()
    expect(prompt).toContain('**经济性**')
    expect(prompt).toContain('1/10到1/30')
    expect(prompt).toContain('总账可能更便宜')
    expect(prompt).toContain('用户希望你在适当时候主动压缩上下文')
    expect(prompt).not.toContain('较为积极地主动压缩')
    expect(prompt).not.toContain('只在非常必要的时候')
  })

  it('较多：同一本账，较为积极', () => {
    const prompt = new PromptBuilder({ context: createMockContext(), proactiveCompact: 'more' }).build()
    expect(prompt).toContain('用户希望你较为积极地主动压缩上下文')
    expect(prompt).toContain('总账可能更便宜')
    expect(prompt).not.toContain('在适当时候主动压缩')
    expect(prompt).not.toContain('只在非常必要的时候')
  })

  it('较少：同一本账，只在非常必要时', () => {
    const prompt = new PromptBuilder({ context: createMockContext(), proactiveCompact: 'less' }).build()
    expect(prompt).toContain('用户希望你只在非常必要的时候主动压缩上下文')
    expect(prompt).toContain('总账可能更便宜')
    expect(prompt).not.toContain('较为积极地主动压缩')
    expect(prompt).not.toContain('在适当时候主动压缩')
  })

  it('不主动压缩：不写经济性说明', () => {
    const prompt = new PromptBuilder({ context: createMockContext(), proactiveCompact: 'off' }).build()
    expect(prompt).not.toContain('**经济性**')
    expect(prompt).not.toContain('总账可能更便宜')
  })

  it('脏值回落到适中', () => {
    expect(normalizeProactiveCompact('nope')).toBe('balanced')
    expect(normalizeProactiveCompact(undefined)).toBe('balanced')
    const prompt = new PromptBuilder({
      context: createMockContext(),
      proactiveCompact: normalizeProactiveCompact('nope'),
    }).build()
    expect(prompt).toContain('总账可能更便宜')
  })
})

describe('伙计自己的工作契约', () => {
  it('写明硬墙不确认、高风险跟这场同一道门、写删只认 scratch 绝对路径', () => {
    const prompt = PromptBuilder.buildSubAgentSystemPrompt({
      context: createMockContext({ terminalType: 'assistant' }),
    })
    expect(prompt).toContain('不会向用户确认')
    expect(prompt).toContain('不排除存在误报可能')
    expect(prompt).toContain('只认绝对路径')
    expect(prompt).toContain('scratch')
    expect(prompt).toContain('桌面等正式目录')
    expect(prompt).toContain('同一道门')
    expect(prompt).not.toContain('不会弹确认')
    expect(prompt).toContain('只做交代给你的那一件')
    expect(prompt).toContain('不要接手整场')
    expect(prompt).toContain('做完清理现场')
    expect(prompt).toContain('要交付的产出物')
    expect(prompt).not.toContain('当别人在干活')
  })
})
