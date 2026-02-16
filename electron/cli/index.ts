/**
 * SFTerminal CLI
 * 
 * Provides command-line access to all backend services for testing and automation.
 * The electron shim is already registered by main.js before this file is loaded.
 */
import { ConfigService } from '../services/config.service'
import { AiService } from '../services/ai.service'
import { HistoryService } from '../services/history.service'
import { HostProfileService } from '../services/host-profile.service'

// ==================== Helpers ====================

function getVersion(): string {
  try { return require('../../package.json').version } catch { return 'unknown' }
}

function printJSON(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function printTable(rows: Record<string, unknown>[], columns?: string[]): void {
  if (rows.length === 0) {
    console.log('(empty)')
    return
  }
  const cols = columns || Object.keys(rows[0])
  // Calculate column widths
  const widths = cols.map(col => {
    const values = rows.map(r => String(r[col] ?? ''))
    return Math.max(col.length, ...values.map(v => v.length))
  })
  // Header
  console.log(cols.map((col, i) => col.padEnd(widths[i])).join('  '))
  console.log(cols.map((_, i) => '─'.repeat(widths[i])).join('  '))
  // Rows
  for (const row of rows) {
    console.log(cols.map((col, i) => String(row[col] ?? '').padEnd(widths[i])).join('  '))
  }
}

function parseArgs(args: string[]): { positional: string[], flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (next && !next.startsWith('--') && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else if (arg.startsWith('-') && arg.length === 2) {
      const key = arg.slice(1)
      const next = args[i + 1]
      if (next && !next.startsWith('-')) {
        flags[key] = next
        i++
      } else {
        flags[key] = true
      }
    } else {
      positional.push(arg)
    }
  }
  
  return { positional, flags }
}

// ==================== Service Singletons (lazy) ====================

let _configService: ConfigService | null = null
function getConfig(): ConfigService {
  if (!_configService) _configService = new ConfigService()
  return _configService
}

let _aiService: AiService | null = null
function getAi(): AiService {
  if (!_aiService) _aiService = new AiService()
  return _aiService
}

let _historyService: HistoryService | null = null
function getHistory(): HistoryService {
  if (!_historyService) _historyService = new HistoryService()
  return _historyService
}

let _hostProfileService: HostProfileService | null = null
function getHostProfile(): HostProfileService {
  if (!_hostProfileService) _hostProfileService = new HostProfileService()
  return _hostProfileService
}

// ==================== Config Commands ====================

async function configGet(args: string[]): Promise<void> {
  const key = args[0]
  if (!key) {
    console.error('Usage: sft config:get <key>')
    console.error('Example: sft config:get aiProfiles')
    process.exit(1)
  }
  const config = getConfig()
  const value = config.get(key as any)
  printJSON(value)
}

async function configSet(args: string[]): Promise<void> {
  const key = args[0]
  const rawValue = args.slice(1).join(' ')
  if (!key || !rawValue) {
    console.error('Usage: sft config:set <key> <value>')
    console.error('Example: sft config:set theme one-dark')
    console.error('For complex values, use JSON: sft config:set aiProfiles \'[{"id":"1","name":"GPT-4","apiUrl":"...","apiKey":"...","model":"gpt-4o"}]\'')
    process.exit(1)
  }
  const config = getConfig()
  let value: unknown
  try {
    value = JSON.parse(rawValue)
  } catch {
    value = rawValue
  }
  config.set(key as any, value as any)
  console.log(`✓ Set ${key}`)
}

async function configList(): Promise<void> {
  const config = getConfig()
  const all = config.getAll()
  // Print keys and value types/summaries
  for (const [key, value] of Object.entries(all)) {
    const type = Array.isArray(value) ? `Array(${value.length})` :
                 typeof value === 'object' && value !== null ? 'Object' :
                 String(value)
    const preview = type.length > 80 ? type.substring(0, 77) + '...' : type
    console.log(`  ${key}: ${preview}`)
  }
}

async function configInit(): Promise<void> {
  const config = getConfig()
  console.log('SFTerminal CLI Config Initialization')
  console.log('=====================================\n')

  // Check existing profiles
  const profiles = config.getAiProfiles()
  if (profiles.length > 0) {
    console.log(`Already have ${profiles.length} AI profile(s) configured.`)
    console.log('Use "sft config:set" to modify, or set environment variables:\n')
  } else {
    console.log('No AI profiles configured yet.')
    console.log('Set up via environment variables or config:set:\n')
  }

  console.log('Environment variables (override config):')
  console.log('  SFT_API_URL    - AI API endpoint URL')
  console.log('  SFT_API_KEY    - AI API key')
  console.log('  SFT_MODEL      - AI model name')
  console.log('  SFT_DATA_DIR   - Custom data directory')
  console.log('')
  console.log('Or configure via commands:')
  console.log('  sft config:set aiProfiles \'[{"id":"default","name":"My AI","apiUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-4o"}]\'')
  console.log('  sft config:set activeAiProfile "default"')
  console.log('')
  console.log(`Config file location: ${config.get('language') !== undefined ? 'loaded' : 'will be created'}`)
}

// ==================== AI Commands ====================

async function aiChat(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const message = positional.join(' ')
  if (!message) {
    console.error('Usage: sft ai:chat <message> [--profile <profileId>]')
    process.exit(1)
  }

  // Check env var overrides
  applyEnvOverrides()

  const ai = getAi()
  const profileId = flags.profile as string | undefined
  
  try {
    const result = await ai.chat(
      [{ role: 'user', content: message }],
      profileId
    )
    console.log(result)
  } catch (error: any) {
    console.error('AI chat error:', error.message || error)
    process.exit(1)
  }
}

async function aiStream(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const message = positional.join(' ')
  if (!message) {
    console.error('Usage: sft ai:stream <message> [--profile <profileId>]')
    process.exit(1)
  }

  applyEnvOverrides()

  const ai = getAi()
  const profileId = flags.profile as string | undefined
  
  try {
    ai.chatStream(
      [{ role: 'user', content: message }],
      (chunk: string) => process.stdout.write(chunk),
      () => { console.log() /* newline */ },
      (error: string) => {
        console.error('\nStream error:', error)
        process.exit(1)
      },
      profileId
    )
  } catch (error: any) {
    console.error('AI stream error:', error.message || error)
    process.exit(1)
  }
}

async function aiModels(): Promise<void> {
  const config = getConfig()
  const profiles = config.getAiProfiles()
  const activeId = config.getActiveAiProfile()
  
  if (profiles.length === 0) {
    console.log('No AI profiles configured.')
    console.log('Run "sft config:init" for setup instructions.')
    return
  }

  const rows = profiles.map(p => ({
    id: p.id,
    name: p.name,
    model: p.model,
    apiUrl: p.apiUrl.replace(/\/v1\/?$/, ''),
    active: p.id === activeId ? '✓' : ''
  }))
  printTable(rows)
}

// ==================== Knowledge Commands ====================

async function knowledgeSearch(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const query = positional.join(' ')
  if (!query) {
    console.error('Usage: sft knowledge:search <query> [--limit <n>] [--host <hostId>]')
    process.exit(1)
  }

  const { getKnowledgeService } = require('../services/knowledge')
  const config = getConfig()
  const ai = getAi()
  const { McpService } = require('../services/mcp.service')
  const mcp = new McpService()
  
  const service = getKnowledgeService(config, ai, mcp)
  if (!service) {
    console.error('Knowledge service not available')
    process.exit(1)
  }
  
  await service.initialize()
  
  const results = await service.search(query, {
    limit: flags.limit ? parseInt(flags.limit as string) : 5,
    hostId: flags.host as string
  })
  
  if (results.length === 0) {
    console.log('No results found.')
    return
  }

  for (const r of results) {
    console.log(`\n${'─'.repeat(60)}`)
    console.log(`Score: ${r.score.toFixed(4)}  |  Doc: ${r.filename}  |  Host: ${r.hostId || 'global'}`)
    console.log(`${'─'.repeat(60)}`)
    console.log(r.content.substring(0, 500))
    if (r.content.length > 500) console.log('...(truncated)')
  }
}

async function knowledgeList(): Promise<void> {
  const { getKnowledgeService } = require('../services/knowledge')
  const config = getConfig()
  const ai = getAi()
  const { McpService } = require('../services/mcp.service')
  const mcp = new McpService()
  
  const service = getKnowledgeService(config, ai, mcp)
  if (!service) {
    console.error('Knowledge service not available')
    process.exit(1)
  }
  
  const docs = service.getDocuments()
  
  if (docs.length === 0) {
    console.log('Knowledge base is empty.')
    return
  }

  const rows = docs.map((d: any) => ({
    id: d.id.substring(0, 8),
    filename: d.filename,
    type: d.fileType,
    host: d.hostId || 'global',
    chunks: d.chunkCount,
    date: new Date(d.createdAt).toLocaleDateString()
  }))
  printTable(rows)
}

async function knowledgeStats(): Promise<void> {
  const { getKnowledgeService } = require('../services/knowledge')
  const config = getConfig()
  const ai = getAi()
  const { McpService } = require('../services/mcp.service')
  const mcp = new McpService()
  
  const service = getKnowledgeService(config, ai, mcp)
  if (!service) {
    console.error('Knowledge service not available')
    process.exit(1)
  }
  
  await service.initialize()
  const stats = await service.getStats()
  printJSON(stats)
}

async function knowledgeAdd(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const filePath = positional[0]
  if (!filePath) {
    console.error('Usage: sft knowledge:add <file-path> [--host <hostId>]')
    process.exit(1)
  }
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')
  
  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const { getKnowledgeService } = require('../services/knowledge')
  const config = getConfig()
  const ai = getAi()
  const { McpService } = require('../services/mcp.service')
  const mcp = new McpService()
  
  const service = getKnowledgeService(config, ai, mcp)
  if (!service) {
    console.error('Knowledge service not available')
    process.exit(1)
  }
  
  await service.initialize()
  
  const content = fs.readFileSync(filePath, 'utf-8')
  const filename = path.basename(filePath)
  
  const docId = await service.addDocument(
    { filename, content, fileType: path.extname(filePath).slice(1) || 'txt' },
    { hostId: flags.host as string }
  )
  
  console.log(`✓ Added document: ${filename} (id: ${docId})`)
}

// ==================== History Commands ====================

async function historyList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const service = getHistory()
  const type = flags.type as string || 'agent'
  const limit = flags.limit ? parseInt(flags.limit as string) : 10
  
  if (type === 'chat') {
    const records = service.getChatRecords()
    const recent = records.slice(-limit)
    for (const r of recent) {
      const time = new Date(r.timestamp).toLocaleString()
      console.log(`[${time}] ${r.role}: ${r.content.substring(0, 100)}`)
    }
  } else {
    const records = service.getAgentRecords()
    const recent = records.slice(-limit)
    for (const r of recent) {
      const time = new Date(r.timestamp).toLocaleString()
      const status = r.status === 'completed' ? '✓' : '✗'
      const task = (r.userTask || r.finalResult || '(unknown)').substring(0, 80)
      console.log(`[${time}] ${status} ${task} (${r.steps?.length || 0} steps, ${r.duration || 0}ms)`)
    }
  }
}

async function historyStats(): Promise<void> {
  const service = getHistory()
  const stats = service.getStorageStats()
  printJSON(stats)
}

// ==================== Host Profile Commands ====================

async function hostList(): Promise<void> {
  const service = getHostProfile()
  const profiles = service.getAllProfiles()
  
  if (profiles.length === 0) {
    console.log('No host profiles found.')
    return
  }

  const rows = profiles.map(p => ({
    hostId: p.hostId,
    os: p.os,
    shell: p.shell,
    hostname: p.hostname,
    lastProbed: p.lastProbed ? new Date(p.lastProbed).toLocaleDateString() : 'never'
  }))
  printTable(rows)
}

async function hostGet(args: string[]): Promise<void> {
  const hostId = args[0]
  if (!hostId) {
    console.error('Usage: sft host:get <hostId>')
    process.exit(1)
  }
  const service = getHostProfile()
  const profile = service.getProfile(hostId)
  if (!profile) {
    console.error(`Host profile not found: ${hostId}`)
    process.exit(1)
  }
  printJSON(profile)
}

// ==================== MCP Commands ====================

async function mcpList(): Promise<void> {
  const config = getConfig()
  const servers = config.getMcpServers()
  
  if (servers.length === 0) {
    console.log('No MCP servers configured.')
    return
  }

  const rows = servers.map(s => ({
    id: s.id.substring(0, 8),
    name: s.name,
    transport: s.transport,
    enabled: s.enabled ? '✓' : '',
    endpoint: s.transport === 'stdio' ? s.command : s.url
  }))
  printTable(rows)
}

async function mcpTools(): Promise<void> {
  const { McpService } = require('../services/mcp.service')
  const config = getConfig()
  const mcp = new McpService()
  
  // Connect to enabled servers
  const servers = config.getEnabledMcpServers()
  for (const server of servers) {
    try {
      console.log(`Connecting to ${server.name}...`)
      await mcp.connect(server)
    } catch (error: any) {
      console.error(`  Failed: ${error.message}`)
    }
  }
  
  const tools = mcp.getAllTools()
  if (tools.length === 0) {
    console.log('No tools available.')
    return
  }

  for (const tool of tools) {
    console.log(`\n  ${tool.name} (${tool.serverId})`)
    if (tool.description) console.log(`    ${tool.description}`)
  }
}

// ==================== Scheduler Commands ====================

async function schedulerList(): Promise<void> {
  // Use require() for CJS compatibility (dynamic import uses ESM resolution which doesn't handle .ts)
  const { getSchedulerService } = require('../services/scheduler.service')
  const service = getSchedulerService()
  const tasks = service.getTasks()
  
  if (tasks.length === 0) {
    console.log('No scheduled tasks.')
    return
  }

  const rows = tasks.map((t: any) => ({
    id: t.id.substring(0, 8),
    name: t.name,
    enabled: t.enabled ? '✓' : '',
    type: t.schedule.type,
    target: t.target.type,
    lastRun: t.lastRunAt ? new Date(t.lastRunAt).toLocaleString() : 'never'
  }))
  printTable(rows)
}

async function schedulerHistory(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const { getSchedulerService } = require('../services/scheduler.service')
  const service = getSchedulerService()
  const limit = flags.limit ? parseInt(flags.limit as string) : 10
  const taskId = flags.task as string | undefined
  
  const history = service.getHistory(taskId, limit)
  
  if (history.length === 0) {
    console.log('No execution history.')
    return
  }

  for (const h of history) {
    const time = new Date(h.startedAt).toLocaleString()
    const status = h.success ? '✓' : '✗'
    const duration = h.duration ? `${Math.round(h.duration / 1000)}s` : '?'
    console.log(`[${time}] ${status} ${h.taskName || h.taskId.substring(0, 8)} (${duration})`)
    if (h.error) console.log(`  Error: ${h.error}`)
  }
}

// ==================== SSH Session Commands ====================

async function sshList(): Promise<void> {
  const config = getConfig()
  const sessions = config.getSshSessions()
  
  if (sessions.length === 0) {
    console.log('No SSH sessions configured.')
    return
  }

  const rows = sessions.map(s => ({
    id: s.id.substring(0, 8),
    name: s.name,
    host: s.host,
    port: s.port,
    user: s.username,
    auth: s.authType,
    group: s.groupId || s.group || ''
  }))
  printTable(rows)
}

// ==================== Agent Commands ====================

async function agentRun(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const task = positional.join(' ')
  if (!task) {
    console.error('Usage: sft agent:run <task> [--mode <strict|relaxed|free>]')
    process.exit(1)
  }

  applyEnvOverrides()

  const { PtyService } = require('../services/pty.service')
  const { AgentService } = require('../services/agent')
  const { McpService } = require('../services/mcp.service')

  const config = getConfig()
  const ai = getAi()
  const pty = new PtyService()
  const hostProfile = getHostProfile()
  const mcp = new McpService()
  const { SshService } = require('../services/ssh.service')
  const ssh = new SshService()
  
  const agent = new AgentService(ai, pty, hostProfile, mcp, config, ssh)
  
  // Create a local terminal for the agent
  const ptyId = pty.create({})
  
  const mode = (flags.mode as string) || 'free'
  
  // Set up output callbacks
  const callbacks = {
    onStep: (_agentId: string, step: any) => {
      const prefix = step.type === 'thinking' ? '💭' :
                     step.type === 'tool_call' ? '🔧' :
                     step.type === 'tool_result' ? '📋' :
                     step.type === 'message' ? '💬' : '  '
      const content = step.content?.substring(0, 200) || ''
      console.log(`${prefix} [${step.type}] ${content}`)
      if (step.toolName) {
        console.log(`   Tool: ${step.toolName}`)
        if (step.toolArgs) {
          const argsStr = JSON.stringify(step.toolArgs).substring(0, 200)
          console.log(`   Args: ${argsStr}`)
        }
      }
    },
    onNeedConfirm: (confirmation: any) => {
      console.log(`\n⚠️  Confirmation needed: ${confirmation.toolName} (risk: ${confirmation.riskLevel})`)
      console.log(`   Args: ${JSON.stringify(confirmation.toolArgs).substring(0, 200)}`)
      // In CLI mode, auto-approve for 'free' mode
      if (mode === 'free') {
        console.log('   Auto-approved (free mode)')
        agent.confirmToolCall(ptyId, confirmation.toolCallId, true)
      } else {
        console.log('   Auto-rejected (not in free mode)')
        agent.confirmToolCall(ptyId, confirmation.toolCallId, false)
      }
    },
    onComplete: (_agentId: string, result: string) => {
      console.log(`\n✓ Agent completed: ${result.substring(0, 500)}`)
    },
    onError: (_agentId: string, error: string) => {
      console.error(`\n✗ Agent error: ${error}`)
    }
  }

  const context = {
    ptyId,
    terminalOutput: [],
    systemInfo: {
      os: process.platform,
      shell: process.env.SHELL || 'bash'
    },
    terminalType: 'local' as const
  }

  console.log(`Running agent task: "${task}"`)
  console.log(`Execution mode: ${mode}\n`)

  try {
    const result = await agent.run(
      ptyId,
      task,
      context,
      { executionMode: mode },
      undefined,
      undefined,
      callbacks
    )
    console.log('\n=== Result ===')
    console.log(result)
  } catch (error: any) {
    console.error('\nAgent execution failed:', error.message || error)
  } finally {
    pty.dispose(ptyId)
    agent.cleanupAgent(ptyId)
  }
}

// ==================== User Skills Commands ====================

async function skillList(): Promise<void> {
  const { getUserSkillService } = require('../services/user-skill.service')
  const service = getUserSkillService()
  const skills = service.getAllSkills()
  
  if (skills.length === 0) {
    console.log('No user skills found.')
    return
  }

  const rows = skills.map((s: any) => ({
    id: s.id,
    name: s.name,
    enabled: s.enabled ? '✓' : '',
    description: (s.description || '').substring(0, 50)
  }))
  printTable(rows)
}

// ==================== PTY Commands ====================

async function ptyExec(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const command = positional.join(' ')
  if (!command) {
    console.error('Usage: sft pty:exec <command> [--timeout <ms>]')
    process.exit(1)
  }

  const { PtyService } = require('../services/pty.service')
  const pty = new PtyService()
  const ptyId = pty.create({})

  const timeout = flags.timeout ? parseInt(flags.timeout as string) : 10000

  try {
    const result = await pty.executeInTerminal(ptyId, command, timeout)
    if (result.output) {
      process.stdout.write(result.output)
      if (!result.output.endsWith('\n')) console.log()
    }
  } catch (error: any) {
    console.error('Execution error:', error.message || error)
    process.exit(1)
  } finally {
    pty.dispose(ptyId)
  }
}

async function ptyShells(): Promise<void> {
  const { PtyService } = require('../services/pty.service')
  const pty = new PtyService()
  const shells = await pty.getAvailableShells()
  const rows = shells.map((s: any) => ({
    shell: s.value,
    label: s.label
  }))
  printTable(rows)
}

// ==================== Local FS Commands ====================

async function localFsList(args: string[]): Promise<void> {
  const dirPath = args[0] || process.cwd()
  const { LocalFsService } = require('../services/local-fs.service')
  const fs = new LocalFsService()

  try {
    const files = await fs.list(dirPath)
    const rows = files.map((f: any) => ({
      name: f.name,
      type: f.isDirectory ? 'dir' : 'file',
      size: f.isDirectory ? '' : formatSize(f.size),
      modified: f.modifyTime ? new Date(f.modifyTime).toLocaleString() : ''
    }))
    printTable(rows)
  } catch (error: any) {
    console.error('Error:', error.message || error)
    process.exit(1)
  }
}

async function localFsInfo(): Promise<void> {
  const { LocalFsService } = require('../services/local-fs.service')
  const localFs = new LocalFsService()
  const home = localFs.getHomeDir()
  const sep = localFs.getSeparator()
  const folders = localFs.getSpecialFolders()

  console.log(`Home: ${home}`)
  console.log(`Separator: ${sep}`)
  console.log('Special Folders:')
  const rows = folders.map((f: any) => ({
    name: f.name,
    path: f.path
  }))
  printTable(rows)
}

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB']
  const i = Math.floor(Math.log(bytes) / Math.log(1024))
  return `${(bytes / Math.pow(1024, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`
}

// ==================== Document Parser Commands ====================

async function docParse(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const filePath = positional[0]
  if (!filePath) {
    console.error('Usage: sft doc:parse <file-path>')
    process.exit(1)
  }

  const fs = require('fs')
  const path = require('path')

  if (!fs.existsSync(filePath)) {
    console.error(`File not found: ${filePath}`)
    process.exit(1)
  }

  const { getDocumentParserService } = require('../services/document-parser.service')
  const parser = getDocumentParserService()
  const stats = fs.statSync(filePath)

  const result = await parser.parseDocument({
    name: path.basename(filePath),
    path: filePath,
    size: stats.size
  })

  if (result.error) {
    console.error(`Parse failed: ${result.error}`)
    process.exit(1)
  }
  console.log(`Filename: ${result.filename}`)
  console.log(`Type: ${result.fileType}`)
  console.log(`Size: ${formatSize(result.fileSize || 0)}`)
  console.log(`Parse time: ${result.parseTime}ms`)
  console.log(`Content length: ${result.content.length} chars`)
  console.log(`\n--- Content Preview ---`)
  console.log(result.content.substring(0, 1000))
  if (result.content.length > 1000) console.log('\n...(truncated)')
}

async function docTypes(): Promise<void> {
  const { getDocumentParserService } = require('../services/document-parser.service')
  const parser = getDocumentParserService()
  const types = parser.getSupportedTypes()
  const rows = types.map((t: any) => ({
    extension: t.extension.startsWith('.') ? t.extension : `.${t.extension}`,
    description: t.description,
    available: t.available ? '✓' : ''
  }))
  printTable(rows)
}

// ==================== Env Override Utility ====================

let _envOverridesApplied = false
function applyEnvOverrides(): void {
  if (_envOverridesApplied) return
  _envOverridesApplied = true

  const apiUrl = process.env.SFT_API_URL
  const apiKey = process.env.SFT_API_KEY
  const model = process.env.SFT_MODEL

  if (apiUrl || apiKey || model) {
    const config = getConfig()
    const profiles = config.getAiProfiles()
    
    const envProfile = {
      id: 'env-override',
      name: 'CLI Environment',
      apiUrl: apiUrl || profiles[0]?.apiUrl || 'https://api.openai.com/v1',
      apiKey: apiKey || profiles[0]?.apiKey || '',
      model: model || profiles[0]?.model || 'gpt-4o'
    }

    const existingIdx = profiles.findIndex(p => p.id === 'env-override')
    if (existingIdx >= 0) {
      profiles[existingIdx] = envProfile
    } else {
      profiles.unshift(envProfile)
    }
    
    config.setAiProfiles(profiles)
    config.setActiveAiProfile('env-override')
  }
}

// ==================== Help ====================

function printHelp(): void {
  const version = getVersion()

  console.log(`
SFTerminal CLI v${version}
============================

Usage: sft <command> [options]

Configuration:
  config:get <key>          Get a config value
  config:set <key> <value>  Set a config value (use JSON for complex values)
  config:list               List all config keys and values
  config:init               Show setup instructions

AI Chat:
  ai:chat <message>         Send a chat message (non-streaming)
  ai:stream <message>       Send a chat message (streaming)
  ai:models                 List configured AI profiles
    --profile <id>          Use specific AI profile

Agent:
  agent:run <task>           Run an AI agent task
    --mode <mode>            Execution mode: strict, relaxed, free (default: free)

Knowledge Base:
  knowledge:search <query>   Search the knowledge base
    --limit <n>              Number of results (default: 5)
    --host <hostId>          Filter by host
  knowledge:list             List all documents
  knowledge:add <file>       Add a document to knowledge base
    --host <hostId>          Associate with host
  knowledge:stats            Show knowledge base statistics

History:
  history:list               List recent records
    --type <chat|agent>      Record type (default: agent)
    --limit <n>              Number of records (default: 10)
  history:stats              Show storage statistics

Host Profiles:
  host:list                  List all host profiles
  host:get <hostId>          Get detailed host profile

SSH Sessions:
  ssh:list                   List configured SSH sessions

MCP Servers:
  mcp:list                   List configured MCP servers
  mcp:tools                  List available MCP tools (connects to servers)

Scheduler:
  scheduler:list             List scheduled tasks
  scheduler:history          Show execution history
    --task <id>              Filter by task
    --limit <n>              Number of records (default: 10)

User Skills:
  skill:list                 List user-defined skills

Terminal (PTY):
  pty:exec <command>         Execute a command in a PTY shell
    --timeout <ms>           Max wait time (default: 10000)
  pty:shells                 List available shells

File System:
  fs:list [path]             List files in a directory
  fs:info                    Show home dir and special folders

Document Parser:
  doc:parse <file>           Parse a document and show content preview
  doc:types                  List supported document types

Environment Variables:
  SFT_API_URL                Override AI API URL
  SFT_API_KEY                Override AI API key
  SFT_MODEL                  Override AI model name
  SFT_DATA_DIR               Custom data directory

Examples:
  sft ai:chat "Hello, what can you do?"
  sft ai:stream "Explain Docker in 3 sentences"
  sft knowledge:search "how to deploy nginx"
  sft agent:run "List files in current directory" --mode free
  SFT_API_KEY=sk-xxx sft ai:chat "test"
`)
}

// ==================== Main ====================

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === '--help' || command === '-h' || command === 'help') {
    printHelp()
    return
  }

  if (command === '--version' || command === '-v') {
    console.log(getVersion())
    return
  }

  const cmdArgs = args.slice(1)

  try {
    switch (command) {
      // Config
      case 'config:get':     await configGet(cmdArgs); break
      case 'config:set':     await configSet(cmdArgs); break
      case 'config:list':    await configList(); break
      case 'config:init':    await configInit(); break

      // AI
      case 'ai:chat':        await aiChat(cmdArgs); break
      case 'ai:stream':      await aiStream(cmdArgs); break
      case 'ai:models':      await aiModels(); break

      // Agent
      case 'agent:run':      await agentRun(cmdArgs); break

      // Knowledge
      case 'knowledge:search': await knowledgeSearch(cmdArgs); break
      case 'knowledge:list':   await knowledgeList(); break
      case 'knowledge:add':    await knowledgeAdd(cmdArgs); break
      case 'knowledge:stats':  await knowledgeStats(); break

      // History
      case 'history:list':   await historyList(cmdArgs); break
      case 'history:stats':  await historyStats(); break

      // Host Profile
      case 'host:list':      await hostList(); break
      case 'host:get':       await hostGet(cmdArgs); break

      // SSH
      case 'ssh:list':       await sshList(); break

      // MCP
      case 'mcp:list':       await mcpList(); break
      case 'mcp:tools':      await mcpTools(); break

      // Scheduler
      case 'scheduler:list':    await schedulerList(); break
      case 'scheduler:history': await schedulerHistory(cmdArgs); break

      // Skills
      case 'skill:list':     await skillList(); break

      // PTY
      case 'pty:exec':       await ptyExec(cmdArgs); break
      case 'pty:shells':     await ptyShells(); break

      // Local FS
      case 'fs:list':        await localFsList(cmdArgs); break
      case 'fs:info':        await localFsInfo(); break

      // Document Parser
      case 'doc:parse':      await docParse(cmdArgs); break
      case 'doc:types':      await docTypes(); break

      default:
        console.error(`Unknown command: ${command}`)
        console.error('Run "sft --help" for available commands.')
        process.exit(1)
    }
  } catch (error: any) {
    console.error(`Error: ${error.message || error}`)
    if (process.env.SFT_DEBUG) {
      console.error(error.stack)
    }
    process.exit(1)
  }
}

main().catch(error => {
  console.error('Fatal error:', error)
  process.exit(1)
})
