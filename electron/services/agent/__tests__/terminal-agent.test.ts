/**
 * sailfish.ts 单元测试
 * 测试 SailFish 类的功能：模式检测、工具列表获取、系统提示构建
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock Electron 模块（必须在导入 SailFish 之前）
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
    existsSync: vi.fn().mockReturnValue(true), // 返回 true 避免创建目录
    readFileSync: vi.fn().mockReturnValue(''),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
    readdirSync: vi.fn().mockReturnValue([])
  }
})

import { SailFish } from '../sailfish'
import type { AgentServices, AgentContext } from '../types'

// ==================== Mock 实现 ====================

// Mock AI 服务
function createMockAiService() {
  return {
    chatWithToolsStream: vi.fn(),
    abort: vi.fn()
  }
}

// Mock PTY 服务
function createMockPtyService() {
  return {
    onData: vi.fn().mockReturnValue(() => {}),
    write: vi.fn()
  }
}

// Mock 统一终端服务
function createMockUnifiedTerminalService() {
  return {
    getTerminalType: vi.fn().mockReturnValue('local'),
    onData: vi.fn().mockReturnValue(() => {})
  }
}

// Mock 主机档案服务
function createMockHostProfileService() {
  return {
    generateHostContext: vi.fn().mockReturnValue(''),
    addNote: vi.fn(),
    getProfile: vi.fn().mockReturnValue(null)
  }
}

// Mock 配置服务
function createMockConfigService() {
  return {
    get: vi.fn().mockReturnValue(undefined),
    getAgentMbti: vi.fn().mockReturnValue(null),
    getAiRules: vi.fn().mockReturnValue(''),
    getAgentPersonalityText: vi.fn().mockReturnValue(''),
    getAgentName: vi.fn().mockReturnValue(''),
    getLanguage: vi.fn().mockReturnValue('zh-CN'),
    getAiProfiles: vi.fn().mockReturnValue([{ id: 'test', contextLength: 128000 }]),
    getActiveAiProfile: vi.fn().mockReturnValue('test'),
    getAgentOnboardingCompleted: vi.fn().mockReturnValue(true),
    hasVisionCapability: vi.fn().mockReturnValue(true)
  }
}

// Mock MCP 服务
function createMockMcpService() {
  return {
    isServerReady: vi.fn().mockReturnValue(false),
    getTools: vi.fn().mockReturnValue([]),
    getToolDefinitions: vi.fn().mockReturnValue([]),
    shouldDeferTools: vi.fn().mockReturnValue(false),
    getToolDefinitionsByServerIds: vi.fn().mockReturnValue([]),
    getServerCatalogText: vi.fn().mockReturnValue(''),
    getServerStatuses: vi.fn().mockReturnValue([])
  }
}

// 创建基础的 AgentServices mock
function createMockServices(overrides?: Partial<AgentServices>): AgentServices {
  return {
    aiService: createMockAiService() as any,
    ptyService: createMockPtyService() as any,
    unifiedTerminalService: createMockUnifiedTerminalService() as any,
    hostProfileService: createMockHostProfileService() as any,
    configService: createMockConfigService() as any,
    mcpService: createMockMcpService() as any,
    ...overrides
  }
}

// 创建基础的 AgentContext
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

function setRunTerminalType(agent: SailFish, terminalType: 'local' | 'ssh') {
  ;(agent as any).currentRun = {
    context: { terminalType }
  }
}

function toolNames(tools: ReturnType<SailFish['getAvailableTools']>): string[] {
  return tools.map(t => t.function.name)
}

// ==================== SailFish 测试 ====================

describe('SailFish', () => {
  let agent: SailFish
  let mockServices: AgentServices

  beforeEach(() => {
    vi.clearAllMocks()
    mockServices = createMockServices()
    agent = new SailFish(mockServices, 'test-pty')
  })

  describe('constructor', () => {
    it('should initialize with ptyId', () => {
      expect(agent.ptyId).toBe('test-pty')
    })

    it('should inherit from Agent', () => {
      expect(agent).toHaveProperty('executionMode')
      expect(agent).toHaveProperty('commandTimeout')
    })

    it('should have default config from Agent', () => {
      expect(agent.executionMode).toBe('strict')
      expect(agent.commandTimeout).toBe(30000)
    })
  })

  describe('getAvailableTools', () => {
    it('should return tools for local mode', () => {
      agent = new SailFish(createMockServices(), 'test-pty')
      setRunTerminalType(agent, 'local')
      const tools = agent.getAvailableTools()
      
      expect(Array.isArray(tools)).toBe(true)
      expect(toolNames(tools)).toContain('execute_command')
      expect(toolNames(tools)).not.toContain('exec')
    })

    it('should return tools for ssh mode', () => {
      agent = new SailFish(createMockServices(), 'ssh-pty')
      setRunTerminalType(agent, 'ssh')
      const tools = agent.getAvailableTools()
      
      expect(Array.isArray(tools)).toBe(true)
      expect(toolNames(tools)).toContain('execute_command')
      expect(toolNames(tools)).toContain('exec')
    })

    it('should return base tools when no unified service', () => {
      const services = createMockServices()
      // 移除 unifiedTerminalService
      delete (services as any).unifiedTerminalService
      
      agent = new SailFish(services, 'test-pty')
      const tools = agent.getAvailableTools()
      
      expect(Array.isArray(tools)).toBe(true)
    })

    it('should include MCP tools when server loaded via progressive disclosure', () => {
      const mockMcpService = createMockMcpService()
      mockMcpService.shouldDeferTools.mockReturnValue(true)
      mockMcpService.getServerStatuses.mockReturnValue([
        { id: 'srv1', name: 'Test MCP', connected: true, toolCount: 1 }
      ])
      mockMcpService.getToolDefinitionsByServerIds.mockImplementation((ids: string[]) => {
        if (!ids.includes('srv1')) return []
        return [
          {
            type: 'function' as const,
            function: {
              name: 'mcp_tool',
              description: 'A MCP tool',
              parameters: { type: 'object', properties: {} }
            }
          }
        ]
      })

      const services = createMockServices({
        mcpService: mockMcpService as any
      })

      agent = new SailFish(services, 'test-pty')
      ;(agent as any).getMcpToolSession().loadServer('srv1')

      const tools = agent.getAvailableTools()

      expect(Array.isArray(tools)).toBe(true)
      expect(tools.some(t => t.function.name === 'mcp_tool')).toBe(true)
    })

    it('should return function type tools', () => {
      const tools = agent.getAvailableTools()
      
      // 所有工具都应该是 function 类型
      for (const tool of tools) {
        expect(tool.type).toBe('function')
        expect(tool.function).toBeDefined()
        expect(tool.function.name).toBeDefined()
      }
    })

    it('web_fetch should not expose max_bytes to LLM', () => {
      const tool = agent.getAvailableTools().find((t) => t.function.name === 'web_fetch')
      expect(tool).toBeDefined()
      const props = tool!.function.parameters?.properties as Record<string, unknown> | undefined
      expect(props?.max_bytes).toBeUndefined()
    })
  })

  describe('terminal mode detection', () => {
    it('should use local tools when context.terminalType is local', () => {
      agent = new SailFish(createMockServices(), 'test-pty')
      setRunTerminalType(agent, 'local')
      const tools = agent.getAvailableTools()
      
      expect(toolNames(tools)).toContain('execute_command')
    })

    it('should use ssh tools when context.terminalType is ssh', () => {
      agent = new SailFish(createMockServices(), 'ssh-pty')
      setRunTerminalType(agent, 'ssh')
      const tools = agent.getAvailableTools()
      
      expect(toolNames(tools)).toContain('execute_command')
    })

    it('should default to assistant tools when no run context', () => {
      const services = createMockServices()
      delete (services as any).unifiedTerminalService
      
      agent = new SailFish(services, 'test-pty')
      const tools = agent.getAvailableTools()
      
      expect(toolNames(tools)).toContain('exec')
      // 助手没开终端不带终端工具，开窗入口一直在
      expect(toolNames(tools)).not.toContain('execute_command')
      expect(toolNames(tools)).toContain('manage_pane')
    })
  })

  describe('agent methods', () => {
    it('should support updateConfig', () => {
      agent.updateConfig({ executionMode: 'relaxed' })
      expect(agent.executionMode).toBe('relaxed')
    })

    it('should support isRunning check', () => {
      expect(agent.isRunning()).toBe(false)
    })

    it('should support getExecutionPhase', () => {
      expect(agent.getExecutionPhase()).toBe('idle')
    })

    it('should support abort when not running', () => {
      expect(agent.abort()).toBe(false)
    })

    it('should support setCallbacks', () => {
      const callbacks = {
        onStep: vi.fn(),
        onComplete: vi.fn()
      }
      
      // 应该不抛出错误
      expect(() => agent.setCallbacks(callbacks)).not.toThrow()
    })

    it('should support cleanup', () => {
      expect(() => agent.cleanup()).not.toThrow()
    })
  })
})

// ==================== SailFish run 测试 ====================

describe('SailFish run', () => {
  let agent: SailFish
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new SailFish(mockServices, 'test-pty')
  })

  it('should run task and return response', async () => {
    const expectedResponse = 'Terminal task completed'
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk(expectedResponse)
        onDone({ content: expectedResponse, tool_calls: undefined })
        return Promise.resolve()
      }
    )

    const context = createMockContext()
    const result = await agent.run('List files', context)
    
    expect(result).toBe(expectedResponse)
  })

  it('should pass context to AI service', async () => {
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Done')
        onDone({ content: 'Done', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    const context = createMockContext({
      cwd: '/home/user',
      hostId: 'host-1'
    })
    
    await agent.run('Check status', context)
    
    // 验证 AI 服务被调用
    expect(mockAiService.chatWithToolsStream).toHaveBeenCalled()
    
    // 验证消息列表（第一个参数）
    const messages = mockAiService.chatWithToolsStream.mock.calls[0][0]
    expect(messages.length).toBeGreaterThan(0)
    
    // 系统消息应该包含系统提示
    const systemMessage = messages.find((m: any) => m.role === 'system')
    expect(systemMessage).toBeDefined()
  })

  it('should include terminal output in context', async () => {
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Done')
        onDone({ content: 'Done', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    const context = createMockContext({
      terminalOutput: ['$ ls', 'file1.txt', 'file2.txt']
    })
    
    await agent.run('What files are here?', context)
    
    expect(mockAiService.chatWithToolsStream).toHaveBeenCalled()
  })

  it('should use host profile when available', async () => {
    const mockHostProfileService = createMockHostProfileService()
    mockHostProfileService.generateHostContext.mockReturnValue('Host: production-server')
    mockHostProfileService.getProfile.mockReturnValue({
      os: 'linux',
      shell: '/bin/bash'
    })
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Done')
        onDone({ content: 'Done', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    const services = createMockServices({
      aiService: mockAiService as any,
      hostProfileService: mockHostProfileService as any
    })
    
    agent = new SailFish(services, 'test-pty')
    
    const context = createMockContext({
      hostId: 'host-1'
    })
    
    await agent.run('Check server status', context)
    
    // 验证使用了主机档案服务
    expect(mockAiService.chatWithToolsStream).toHaveBeenCalled()
  })

  it('should handle different terminal types', async () => {
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Done')
        onDone({ content: 'Done', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    // 测试 SSH 终端
    const sshContext = createMockContext({
      terminalType: 'ssh'
    })
    
    await agent.run('Remote task', sshContext)
    
    expect(mockAiService.chatWithToolsStream).toHaveBeenCalled()
  })
})

// ==================== SailFish 工具执行测试 ====================

describe('SailFish tool execution', () => {
  let agent: SailFish
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new SailFish(mockServices, 'test-pty')
  })

  it('should execute command tools', async () => {
    // 使用 wait 工具来测试，因为它不需要真实的终端服务
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'wait',
        arguments: JSON.stringify({ seconds: 0.01 }) // 很短的等待
      }
    }

    let callCount = 0
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        callCount++
        if (callCount === 1) {
          // 第一次调用返回工具调用
          setTimeout(() => {
            onDone({ content: '', tool_calls: [toolCall] })
          }, 10)
        } else {
          // 第二次调用返回最终响应
          setTimeout(() => {
            onChunk('Tool executed')
            onDone({ content: 'Tool executed', tool_calls: undefined })
          }, 10)
        }
        return Promise.resolve()
      }
    )

    const context = createMockContext()
    const result = await agent.run('Wait briefly', context)
    
    expect(result).toBe('Tool executed')
    expect(mockAiService.chatWithToolsStream).toHaveBeenCalledTimes(2)
  }, 10000)

  it('should handle tool execution errors gracefully', async () => {
    const toolCall = {
      id: 'call-1',
      type: 'function' as const,
      function: {
        name: 'invalid_tool',
        arguments: '{}'
      }
    }

    let callCount = 0
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        callCount++
        if (callCount === 1) {
          onDone({ content: '', tool_calls: [toolCall] })
        } else {
          onChunk('Error handled')
          onDone({ content: 'Error handled', tool_calls: undefined })
        }
        return Promise.resolve()
      }
    )

    const context = createMockContext()
    
    // 应该不抛出错误，而是正常处理
    const result = await agent.run('Test invalid tool', context)
    expect(result).toBeDefined()
  })
})

// ==================== SailFish 回调测试 ====================

describe('SailFish callbacks', () => {
  let agent: SailFish
  let mockServices: AgentServices
  let mockAiService: ReturnType<typeof createMockAiService>

  beforeEach(() => {
    vi.clearAllMocks()
    mockAiService = createMockAiService()
    mockServices = createMockServices({
      aiService: mockAiService as any
    })
    agent = new SailFish(mockServices, 'test-pty')
  })

  it('should trigger onStep callback', async () => {
    const onStep = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Response')
        onDone({ content: 'Response', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onStep })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    expect(onStep).toHaveBeenCalled()
  })

  it('should trigger onComplete callback', async () => {
    const onComplete = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, onChunk, _onToolCall, onDone) => {
        onChunk('Done')
        onDone({ content: 'Done', tool_calls: undefined })
        return Promise.resolve()
      }
    )

    agent.setCallbacks({ onComplete })
    
    const context = createMockContext()
    await agent.run('Test', context)
    
    expect(onComplete).toHaveBeenCalled()
    expect(onComplete).toHaveBeenCalledWith(
      expect.any(String), // agentId
      'Done',             // result
      expect.any(Array),  // pendingUserMessages
      { aborted: false },
    )
  })

  it('should trigger onError callback on failure', async () => {
    const onError = vi.fn()
    
    mockAiService.chatWithToolsStream.mockImplementation(
      (_messages, _tools, _onChunk, _onToolCall, _onDone, onErrorCb) => {
        onErrorCb('Test error')
        return Promise.reject(new Error('Test error'))
      }
    )

    agent.setCallbacks({ onError })
    
    const context = createMockContext()
    
    try {
      await agent.run('Test', context)
    } catch {
      // 预期抛出错误
    }
    
    expect(onError).toHaveBeenCalled()
  })
})

// ==================== SailFish 多实例测试 ====================

describe('SailFish multiple instances', () => {
  let mockServices: AgentServices

  beforeEach(() => {
    vi.clearAllMocks()
    mockServices = createMockServices()
  })

  it('should support multiple agents with different ptyIds', () => {
    const agent1 = new SailFish(mockServices, 'pty-1')
    const agent2 = new SailFish(mockServices, 'pty-2')
    
    expect(agent1.ptyId).toBe('pty-1')
    expect(agent2.ptyId).toBe('pty-2')
    expect(agent1).not.toBe(agent2)
  })

  it('should have independent configurations', () => {
    const agent1 = new SailFish(mockServices, 'pty-1')
    const agent2 = new SailFish(mockServices, 'pty-2')
    
    agent1.updateConfig({ executionMode: 'relaxed' })
    
    expect(agent1.executionMode).toBe('relaxed')
    expect(agent2.executionMode).toBe('strict')
  })

  it('should have independent running states', () => {
    const agent1 = new SailFish(mockServices, 'pty-1')
    const agent2 = new SailFish(mockServices, 'pty-2')
    
    // 两个 agent 都不应该在运行
    expect(agent1.isRunning()).toBe(false)
    expect(agent2.isRunning()).toBe(false)
  })
})
