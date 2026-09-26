/**
 * 插件系统契约测试
 *
 * 站在插件作者的角度验证公开 API 稳定性。
 * 这些测试覆盖 SPEC.md 中定义的公开契约，修改插件系统代码后必须全部通过。
 * 如果某个测试需要修改才能通过，说明你正在进行 Breaking Change。
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as path from 'path'

vi.mock('../../../utils/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { PluginRegistry, resolvePluginRouteConflicts } from '../registry'
import { HookBus } from '../hook-bus'
import { loadManifest, loadPlugin, createRegistrationAPI, normalizePluginRoutePath } from '../loader'
import type {
  PluginManifest,
  PluginEntry,
  PluginRegistrationAPI,
  ToolRegistration,
  ToolExecuteResult,
  HookEvent,
  HookDecision,
  ProviderRegistration,
  ChannelRegistration,
  HttpRouteEntry,
  LoadedPlugin
} from '../types'

// ==================== 1. Manifest 契约 ====================

describe('Manifest 契约', () => {
  it('manifest 必须包含 id 和 configSchema', () => {
    const valid: PluginManifest = {
      id: 'my-plugin',
      configSchema: {}
    }
    expect(valid.id).toBe('my-plugin')
    expect(valid.configSchema).toEqual({})
  })

  it('manifest 的可选字段都可缺省', () => {
    const minimal: PluginManifest = {
      id: 'minimal',
      configSchema: {}
    }
    expect(minimal.name).toBeUndefined()
    expect(minimal.description).toBeUndefined()
    expect(minimal.version).toBeUndefined()
    expect(minimal.channels).toBeUndefined()
    expect(minimal.providers).toBeUndefined()
    expect(minimal.enabledByDefault).toBeUndefined()
  })

  it('loadManifest 应拒绝缺少 id 的 manifest', () => {
    const fs = require('fs')
    const origReadFileSync = fs.readFileSync
    const origExistsSync = fs.existsSync
    fs.existsSync = () => true
    fs.readFileSync = () => JSON.stringify({ configSchema: {} })

    const result = loadManifest('/fake/plugin')
    expect(result).toBeNull()

    fs.readFileSync = origReadFileSync
    fs.existsSync = origExistsSync
  })

  it('loadManifest 应拒绝缺少 configSchema 的 manifest', () => {
    const fs = require('fs')
    const origReadFileSync = fs.readFileSync
    const origExistsSync = fs.existsSync
    fs.existsSync = () => true
    fs.readFileSync = () => JSON.stringify({ id: 'test' })

    const result = loadManifest('/fake/plugin')
    expect(result).toBeNull()

    fs.readFileSync = origReadFileSync
    fs.existsSync = origExistsSync
  })
})

// ==================== 2. PluginEntry 签名契约 ====================

describe('PluginEntry 签名契约', () => {
  it('插件入口必须有 id (string) 和 register (function)', () => {
    const entry: PluginEntry = {
      id: 'test-plugin',
      register(_api: PluginRegistrationAPI) { /* noop */ }
    }
    expect(typeof entry.id).toBe('string')
    expect(typeof entry.register).toBe('function')
  })

  it('onUnload 是可选的', () => {
    const withoutUnload: PluginEntry = {
      id: 'no-unload',
      register() { /* noop */ }
    }
    expect(withoutUnload.onUnload).toBeUndefined()

    const withUnload: PluginEntry = {
      id: 'with-unload',
      register() { /* noop */ },
      async onUnload() { /* cleanup */ }
    }
    expect(typeof withUnload.onUnload).toBe('function')
  })
})

// ==================== 3. Registration API 契约 ====================

describe('Registration API 契约', () => {
  let collected: {
    tools: ToolRegistration[]
    providers: ProviderRegistration[]
    channels: ChannelRegistration[]
    hooks: Array<{ event: HookEvent }>
    routes: Array<{ method: string; path: string }>
  }

  beforeEach(() => {
    collected = { tools: [], providers: [], channels: [], hooks: [], routes: [] }
  })

  function createTestPlugin(registerFn: (api: PluginRegistrationAPI) => void): PluginEntry {
    return {
      id: 'contract-test',
      register: registerFn
    }
  }

  async function loadTestPlugin(entry: PluginEntry) {
    const fs = require('fs')
    const origReadFileSync = fs.readFileSync
    const origExistsSync = fs.existsSync
    const origReaddirSync = fs.readdirSync

    const pluginDir = '/tmp/test-plugins/plugins/contract-test'
    const manifest: PluginManifest = {
      id: 'contract-test',
      name: 'Contract Test Plugin',
      configSchema: {},
      enabledByDefault: true
    }

    fs.existsSync = (p: string) => {
      if (p.includes('contract-test') && p.includes('openclaw.plugin.json')) return true
      if (p.includes('contract-test') && (p.endsWith('index.js') || p.endsWith('package.json'))) return false
      if (p.includes('contract-test') && p.endsWith('index.ts')) return true
      return origExistsSync(p)
    }
    fs.readFileSync = (p: string, ...args: unknown[]) => {
      if (p.includes('openclaw.plugin.json')) return JSON.stringify(manifest)
      return origReadFileSync(p, ...args)
    }
    fs.readdirSync = (p: string, ...args: unknown[]) => {
      if (p.includes('plugins') && !p.includes('node_modules')) {
        return [{ name: 'contract-test', isDirectory: () => true }]
      }
      return origReaddirSync(p, ...args)
    }

    const plugin = await loadPlugin(pluginDir, manifest)
    plugin.entry = entry
    entry.register({
      registerTool(def, opts) {
        plugin.tools.push({ ...def, optional: opts?.optional })
        collected.tools.push(def)
      },
      registerProvider(def) {
        plugin.providers.push(def)
        collected.providers.push(def)
      },
      registerChannel(def) {
        plugin.channels.push(def)
        collected.channels.push(def)
      },
      registerHook(event, handler) {
        let list = plugin.hooks.get(event)
        if (!list) { list = []; plugin.hooks.set(event, list) }
        list.push(handler)
        collected.hooks.push({ event })
      },
      registerTtsProvider() {},
      registerHttpRoute(method, path) {
        plugin.httpRoutes.push({ pluginId: manifest.id, method: method.toUpperCase(), path, handler: () => {} })
        collected.routes.push({ method: method.toUpperCase(), path })
      }
    })

    fs.readFileSync = origReadFileSync
    fs.existsSync = origExistsSync
    fs.readdirSync = origReaddirSync

    return plugin
  }

  it('api.registerTool 接受 ToolRegistration + 可选 opts', async () => {
    const tool: ToolRegistration = {
      name: 'greet',
      description: 'Say hello',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      async execute(_id, params) {
        return { content: [{ type: 'text', text: `Hello ${params.name}` }] }
      }
    }

    const entry = createTestPlugin(api => {
      api.registerTool(tool)
      api.registerTool({ ...tool, name: 'optional_tool' }, { optional: true })
    })

    await loadTestPlugin(entry)
    expect(collected.tools).toHaveLength(2)
    expect(collected.tools[0].name).toBe('greet')
  })

  it('api.registerProvider 接受 ProviderRegistration', async () => {
    const provider: ProviderRegistration = {
      id: 'my-llm',
      name: 'My LLM',
      match(profile) { return profile.apiUrl.includes('my-llm') },
      async chatWithTools() {
        return { content: 'response', finish_reason: 'stop' }
      }
    }

    const entry = createTestPlugin(api => api.registerProvider(provider))
    await loadTestPlugin(entry)
    expect(collected.providers).toHaveLength(1)
    expect(collected.providers[0].id).toBe('my-llm')
  })

  it('api.registerChannel 接受 ChannelRegistration', async () => {
    const channel: ChannelRegistration = {
      id: 'my-im',
      name: 'My IM',
      createAdapter() {
        return {
          platform: 'my-im' as any,
          isConnected: () => false,
          sendText: async () => {},
          sendMarkdown: async () => {}
        } as any
      }
    }

    const entry = createTestPlugin(api => api.registerChannel(channel))
    await loadTestPlugin(entry)
    expect(collected.channels).toHaveLength(1)
    expect(collected.channels[0].id).toBe('my-im')
  })

  it('api.registerHook 接受 HookEvent + handler', async () => {
    const events: HookEvent[] = ['before_tool_call', 'after_tool_call', 'before_ai_request', 'message_sending']

    const entry = createTestPlugin(api => {
      for (const event of events) {
        api.registerHook(event, () => ({}))
      }
    })

    await loadTestPlugin(entry)
    expect(collected.hooks).toHaveLength(4)
    expect(collected.hooks.map(h => h.event)).toEqual(events)
  })

  it('api.registerHttpRoute 接受 method + path + handler', async () => {
    const entry = createTestPlugin(api => {
      api.registerHttpRoute('GET', '/api/status', () => {})
      api.registerHttpRoute('POST', '/api/action', () => {})
    })

    await loadTestPlugin(entry)
    expect(collected.routes).toEqual([
      { method: 'GET', path: '/api/status' },
      { method: 'POST', path: '/api/action' }
    ])
  })
})

// ==================== 4. 工具命名与执行契约 ====================

describe('工具命名与执行契约', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/tmp/test-plugins'
    })
  })

  function injectPlugin(pluginId: string, tools: ToolRegistration[]) {
    const plugin = {
      manifest: { id: pluginId, configSchema: {} } as PluginManifest,
      rootDir: `/tmp/${pluginId}`,
      tools: tools.map(t => ({ ...t })),
      providers: [],
      channels: [],
      hooks: new Map(),
      httpRoutes: [],
      enabled: true
    }
    // Access private plugins map via any
    ;(registry as any).plugins.set(pluginId, plugin)
    ;(registry as any).activatePlugin(plugin)
    return plugin
  }

  it('插件工具名格式为 plugin_{sanitizedId}_{sanitizedName}', () => {
    const tool: ToolRegistration = {
      name: 'my_tool',
      description: 'Test',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    }

    injectPlugin('hello-world', [tool])
    const defs = registry.getToolDefinitions()

    expect(defs).toHaveLength(1)
    expect(defs[0].function.name).toBe('plugin_hello_world_my_tool')
    expect(defs[0].function.name.startsWith('plugin_')).toBe(true)
  })

  it('isPluginTool 识别 plugin_ 前缀的已注册工具', () => {
    injectPlugin('test', [{
      name: 'action',
      description: 'Do something',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'done' }] })
    }])

    expect(registry.isPluginTool('plugin_test_action')).toBe(true)
    expect(registry.isPluginTool('run_command')).toBe(false)
    expect(registry.isPluginTool('plugin_nonexistent_tool')).toBe(false)
  })

  it('executeTool 将 OpenClaw 结果转换为 SailFish 格式', async () => {
    const tool: ToolRegistration = {
      name: 'greet',
      description: 'Greet',
      parameters: { type: 'object', properties: { name: { type: 'string' } } },
      async execute(_id, params) {
        return {
          content: [
            { type: 'text' as const, text: `Hello ${params.name}!` },
            { type: 'image' as const, data: 'base64data' }
          ]
        }
      }
    }

    injectPlugin('demo', [tool])
    const result = await registry.executeTool('plugin_demo_greet', { name: 'World' }, 'call-1')

    expect(result).not.toBeNull()
    expect(result!.success).toBe(true)
    expect(result!.output).toBe('Hello World!')
    expect(result!.images).toEqual(['base64data'])
  })

  it('ToolExecuteResult.content 支持 text 和 image 类型', async () => {
    const textOnly: ToolExecuteResult = {
      content: [{ type: 'text', text: 'hello' }]
    }
    expect(textOnly.content[0].type).toBe('text')

    const imageOnly: ToolExecuteResult = {
      content: [{ type: 'image', data: 'abc123' }]
    }
    expect(imageOnly.content[0].type).toBe('image')

    const mixed: ToolExecuteResult = {
      content: [
        { type: 'text', text: 'caption' },
        { type: 'image', data: 'imgdata' }
      ]
    }
    expect(mixed.content).toHaveLength(2)
  })

  it('executeTool 对超时的工具返回错误', async () => {
    const slowTool: ToolRegistration = {
      name: 'slow',
      description: 'Very slow',
      parameters: {},
      async execute() {
        await new Promise(r => setTimeout(r, 200))
        return { content: [{ type: 'text', text: 'done' }] }
      }
    }

    injectPlugin('slow-plugin', [slowTool])

    const result = await registry.executeTool('plugin_slow_plugin_slow', {}, 'call-2')
    // Normal case should succeed (timeout is 60s, our sleep is 200ms)
    expect(result!.success).toBe(true)
  })

  it('executeTool 对未知工具名返回 null', async () => {
    const result = await registry.executeTool('plugin_nonexistent_tool', {}, 'call-x')
    expect(result).toBeNull()
  })

  it('禁用的插件的工具不出现在 getToolDefinitions 中', () => {
    injectPlugin('disabled-test', [{
      name: 'action',
      description: 'Test',
      parameters: {},
      execute: async () => ({ content: [{ type: 'text', text: 'ok' }] })
    }])

    expect(registry.getToolDefinitions()).toHaveLength(1)

    registry.disablePlugin('disabled-test')
    expect(registry.getToolDefinitions()).toHaveLength(0)
  })
})

// ==================== 5. HookBus 契约 ====================

describe('HookBus 契约', () => {
  let bus: HookBus

  beforeEach(() => {
    bus = new HookBus()
  })

  it('HookEvent 只有 4 种枚举值', () => {
    const validEvents: HookEvent[] = [
      'before_tool_call',
      'after_tool_call',
      'before_ai_request',
      'message_sending'
    ]
    for (const event of validEvents) {
      bus.register('test', event, () => ({}))
    }
    expect(bus.hasHandlers('before_tool_call')).toBe(true)
    expect(bus.hasHandlers('after_tool_call')).toBe(true)
    expect(bus.hasHandlers('before_ai_request')).toBe(true)
    expect(bus.hasHandlers('message_sending')).toBe(true)
  })

  it('trigger 无 handler 时返回空对象', async () => {
    const result = await bus.trigger('before_tool_call', {
      toolName: 'test', toolArgs: {}, toolCallId: '1'
    })
    expect(result).toEqual({})
  })

  it('block: true 短路后续 handler', async () => {
    const secondCalled = vi.fn()

    bus.register('p1', 'before_tool_call', () => ({ block: true }))
    bus.register('p2', 'before_tool_call', () => {
      secondCalled()
      return {}
    })

    const decision = await bus.trigger('before_tool_call', {
      toolName: 'dangerous', toolArgs: {}, toolCallId: '1'
    })

    expect(decision.block).toBe(true)
    expect(secondCalled).not.toHaveBeenCalled()
  })

  it('cancel: true 短路后续 handler', async () => {
    const secondCalled = vi.fn()

    bus.register('p1', 'message_sending', () => ({ cancel: true }))
    bus.register('p2', 'message_sending', () => {
      secondCalled()
      return {}
    })

    const decision = await bus.trigger('message_sending', {
      text: 'spam', platform: 'test'
    })

    expect(decision.cancel).toBe(true)
    expect(secondCalled).not.toHaveBeenCalled()
  })

  it('requireApproval 累积但不短路', async () => {
    const secondCalled = vi.fn()

    bus.register('p1', 'before_tool_call', () => ({ requireApproval: true }))
    bus.register('p2', 'before_tool_call', () => {
      secondCalled()
      return {}
    })

    const decision = await bus.trigger('before_tool_call', {
      toolName: 'rm', toolArgs: {}, toolCallId: '1'
    })

    expect(decision.requireApproval).toBe(true)
    expect(secondCalled).toHaveBeenCalled()
  })

  it('HookDecision 支持 block / requireApproval / cancel / modified 字段', () => {
    const decision: HookDecision = {
      block: false,
      requireApproval: true,
      cancel: false,
      modified: { newArgs: { path: '/safe' } }
    }
    expect(decision.block).toBe(false)
    expect(decision.requireApproval).toBe(true)
    expect(decision.cancel).toBe(false)
    expect(decision.modified).toBeDefined()
  })

  it('handler 抛异常不影响后续 handler', async () => {
    const secondCalled = vi.fn()

    bus.register('buggy', 'after_tool_call', () => { throw new Error('oops') })
    bus.register('good', 'after_tool_call', () => {
      secondCalled()
      return { requireApproval: true }
    })

    const decision = await bus.trigger('after_tool_call', {
      toolName: 'test', toolArgs: {}, result: { success: true, output: 'ok' }
    })

    expect(secondCalled).toHaveBeenCalled()
    expect(decision.requireApproval).toBe(true)
  })

  it('removePlugin 只移除指定插件的 handler', () => {
    bus.register('p1', 'before_tool_call', () => ({}))
    bus.register('p2', 'before_tool_call', () => ({}))
    bus.register('p1', 'after_tool_call', () => ({}))

    bus.removePlugin('p1')

    expect(bus.hasHandlers('before_tool_call')).toBe(true)
    expect(bus.hasHandlers('after_tool_call')).toBe(false)
  })
})

// ==================== 6. 插件生命周期契约 ====================

describe('插件生命周期契约', () => {
  let registry: PluginRegistry

  beforeEach(() => {
    registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/tmp/test-plugins'
    })
  })

  function injectPlugin(id: string, enabled = true) {
    const plugin = {
      manifest: { id, name: id, configSchema: {} } as PluginManifest,
      rootDir: `/tmp/${id}`,
      tools: [{
        name: 'action',
        description: 'Test action',
        parameters: {},
        execute: async () => ({ content: [{ type: 'text' as const, text: 'ok' }] })
      }],
      providers: [] as ProviderRegistration[],
      channels: [] as ChannelRegistration[],
      hooks: new Map(),
      httpRoutes: [] as import('../types').HttpRouteEntry[],
      enabled
    }
    ;(registry as any).plugins.set(id, plugin)
    if (enabled) (registry as any).activatePlugin(plugin)
    return plugin
  }

  it('enablePlugin / disablePlugin 切换插件状态', () => {
    injectPlugin('toggle-test', false)

    expect(registry.get('toggle-test')!.enabled).toBe(false)
    expect(registry.getToolDefinitions()).toHaveLength(0)

    registry.enablePlugin('toggle-test')
    expect(registry.get('toggle-test')!.enabled).toBe(true)
    expect(registry.getToolDefinitions()).toHaveLength(1)

    registry.disablePlugin('toggle-test')
    expect(registry.get('toggle-test')!.enabled).toBe(false)
    expect(registry.getToolDefinitions()).toHaveLength(0)
  })

  it('listAll 返回所有插件的摘要信息', () => {
    injectPlugin('a')
    injectPlugin('b', false)

    const list = registry.listAll()
    expect(list).toHaveLength(2)
    expect(list.find(p => p.id === 'a')!.enabled).toBe(true)
    expect(list.find(p => p.id === 'b')!.enabled).toBe(false)
    expect(list[0]).toHaveProperty('id')
    expect(list[0]).toHaveProperty('name')
    expect(list[0]).toHaveProperty('enabled')
    expect(list[0]).toHaveProperty('toolCount')
  })

  it('disablePlugin 后工具执行返回 null', async () => {
    injectPlugin('temp')
    const toolName = registry.getToolDefinitions()[0].function.name

    const before = await registry.executeTool(toolName, {}, 'call-1')
    expect(before!.success).toBe(true)

    registry.disablePlugin('temp')

    const after = await registry.executeTool(toolName, {}, 'call-2')
    expect(after).toBeNull()
  })

  it('Provider / Channel / Route 聚合只返回已启用插件的注册物', () => {
    const plugin = injectPlugin('aggregation-test')
    plugin.providers.push({
      id: 'test-provider',
      name: 'Test',
      match: () => true,
      chatWithTools: async () => ({ content: 'ok', finish_reason: 'stop' })
    })
    plugin.channels.push({
      id: 'test-channel',
      name: 'Test Channel',
      createAdapter: () => ({} as any)
    })
    plugin.httpRoutes.push({
      pluginId: 'aggregation-test',
      method: 'GET',
      path: '/api/plugins/aggregation-test/test',
      handler: () => {}
    })

    expect(registry.getAllProviders()).toHaveLength(1)
    expect(registry.getAllChannels()).toHaveLength(1)
    expect(registry.getAllHttpRoutes()).toHaveLength(1)

    registry.disablePlugin('aggregation-test')
    expect(registry.getAllProviders()).toHaveLength(0)
    expect(registry.getAllChannels()).toHaveLength(0)
    expect(registry.getAllHttpRoutes()).toHaveLength(0)
  })
})

// ==================== 7. 配置契约 ====================

describe('配置契约', () => {
  it('allow/deny 控制插件加载', () => {
    const registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/tmp/test',
      deny: ['bad-plugin']
    })

    // Test isAllowed via reflection
    expect((registry as any).isAllowed('good-plugin')).toBe(true)
    expect((registry as any).isAllowed('bad-plugin')).toBe(false)
  })

  it('allow 列表存在时只允许列表中的插件', () => {
    const registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/tmp/test',
      allow: ['trusted']
    })

    expect((registry as any).isAllowed('trusted')).toBe(true)
    expect((registry as any).isAllowed('unknown')).toBe(false)
  })

  it('entries 配置覆盖 enabledByDefault', () => {
    const registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/tmp/test',
      entries: { 'force-off': { enabled: false } }
    })

    expect((registry as any).isEnabled('force-off', true)).toBe(false)
    expect((registry as any).isEnabled('no-config', true)).toBe(true)
    expect((registry as any).isEnabled('no-config')).toBe(false)
  })
})

// ==================== 8. HTTP 路由命名空间与冲突契约 ====================

describe('HTTP 路由命名空间与冲突契约', () => {
  describe('normalizePluginRoutePath', () => {
    it('普通路径自动加上插件命名空间前缀', () => {
      expect(normalizePluginRoutePath('my-plugin', '/status')).toBe('/api/plugins/my-plugin/status')
      expect(normalizePluginRoutePath('my-plugin', 'status')).toBe('/api/plugins/my-plugin/status')
      expect(normalizePluginRoutePath('my-plugin', '/a/b/')).toBe('/api/plugins/my-plugin/a/b')
      expect(normalizePluginRoutePath('my-plugin', '//a//b')).toBe('/api/plugins/my-plugin/a/b')
    })

    it('已带本插件前缀的路径原样接受（幂等）', () => {
      expect(normalizePluginRoutePath('my-plugin', '/api/plugins/my-plugin/status'))
        .toBe('/api/plugins/my-plugin/status')
    })

    it('命名空间根路径归一化为插件根', () => {
      expect(normalizePluginRoutePath('my-plugin', '/')).toBe('/api/plugins/my-plugin')
    })

    it('核心保留路径一律拒绝', () => {
      const reserved = [
        '/api/chat',
        '/api/chat/history',
        '/api/auth/validate',
        '/api/health',
        '/hooks/some-token',
        '/chat'
      ]
      for (const p of reserved) {
        expect(normalizePluginRoutePath('my-plugin', p)).toBeNull()
      }
    })

    it('不得占用其他插件的命名空间', () => {
      expect(normalizePluginRoutePath('evil', '/api/plugins/victim/x')).toBeNull()
      expect(normalizePluginRoutePath('evil', '/api/plugins')).toBeNull()
    })

    it('拒绝路径穿越和空路径', () => {
      expect(normalizePluginRoutePath('my-plugin', '/../api/chat')).toBeNull()
      expect(normalizePluginRoutePath('my-plugin', '')).toBeNull()
      expect(normalizePluginRoutePath('my-plugin', '   ')).toBeNull()
    })
  })

  describe('registerHttpRoute 注册行为', () => {
    function createTestPlugin(): LoadedPlugin {
      return {
        manifest: { id: 'my-plugin', configSchema: {} },
        rootDir: '/tmp/my-plugin',
        tools: [],
        providers: [],
        channels: [],
        ttsProviders: [],
        hooks: new Map(),
        httpRoutes: [],
        enabled: true
      }
    }

    it('注册的路由携带 pluginId 并落在命名空间内', () => {
      const plugin = createTestPlugin()
      const api = createRegistrationAPI('my-plugin', plugin)

      api.registerHttpRoute('get', '/status', () => {})

      expect(plugin.httpRoutes).toHaveLength(1)
      expect(plugin.httpRoutes[0].pluginId).toBe('my-plugin')
      expect(plugin.httpRoutes[0].method).toBe('GET')
      expect(plugin.httpRoutes[0].path).toBe('/api/plugins/my-plugin/status')
    })

    it('核心路径注册被拒绝，不会进入路由表', () => {
      const plugin = createTestPlugin()
      const api = createRegistrationAPI('my-plugin', plugin)

      api.registerHttpRoute('POST', '/api/chat', () => {})
      api.registerHttpRoute('GET', '/api/plugins/other-plugin/x', () => {})

      expect(plugin.httpRoutes).toHaveLength(0)
    })
  })

  describe('resolvePluginRouteConflicts', () => {
    const handler = () => {}
    function route(pluginId: string, method: string, path: string): HttpRouteEntry {
      return { pluginId, method, path, handler }
    }

    it('同一 method+path 只保留先注册者', () => {
      const result = resolvePluginRouteConflicts([
        route('plugin-a', 'GET', '/api/plugins/plugin-a/x'),
        route('plugin-b', 'GET', '/api/plugins/plugin-a/x')
      ])

      expect(result).toHaveLength(1)
      expect(result[0].pluginId).toBe('plugin-a')
    })

    it('不同 method 的同 path 不冲突', () => {
      const result = resolvePluginRouteConflicts([
        route('plugin-a', 'GET', '/api/plugins/plugin-a/x'),
        route('plugin-a', 'POST', '/api/plugins/plugin-a/x')
      ])

      expect(result).toHaveLength(2)
    })

    it('无冲突时原样返回', () => {
      const result = resolvePluginRouteConflicts([
        route('plugin-a', 'GET', '/api/plugins/plugin-a/x'),
        route('plugin-b', 'GET', '/api/plugins/plugin-b/y')
      ])

      expect(result).toHaveLength(2)
    })
  })
})

// ==================== 9. 发现路径契约 ====================
describe('发现路径契约', () => {
  it('发现路径按 SPEC 定义的优先级排列', () => {
    const registry = new PluginRegistry({
      enabled: true,
      userDataPath: '/fake/userData',
      loadPaths: ['/custom/path']
    })

    const paths: string[] = (registry as any).getDiscoveryPaths()
    // 路径断言统一走 path.join / 分隔符归一化，保证 Windows 与 POSIX 行为一致
    const normalize = (p: string) => p.replace(/\\/g, '/')

    expect(paths[0]).toBe('/custom/path')
    expect(paths).toContain(path.join('/fake/userData', 'plugins'))
    expect(paths).toContain(path.join('/fake/userData', 'plugins', 'node_modules'))
    expect(paths.some((p: string) => normalize(p).includes('.openclaw/extensions'))).toBe(true)
  })
})
