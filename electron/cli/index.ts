/**
 * SailFish CLI
 * 
 * Provides command-line access to all backend services for testing and automation.
 * The electron shim is already registered by main.js before this file is loaded.
 */
import { ConfigService, setConfigServiceInstance } from '../services/config.service'
import { AiService } from '../services/ai.service'
import { HistoryService } from '../services/history.service'
import { HostProfileService } from '../services/host-profile.service'
import type { ExecutionMode } from '../services/agent/types'
import { createLogger, initLogging } from '../utils/logger'
import { getDefaultShell, getLocalOS } from '../utils/platform'
import { clampAskUserTimeout, type AgentContext } from '@shared/types/agent'
import { oemResolved } from '@shared/oem-resolve'
import { t, type TranslationKey } from '../services/agent/i18n'
import electronLog from 'electron-log/main'
import { isSameSkillId } from '@sailfish/shared-types'
import { CliTranscript, confirmationLines } from './transcript'
import { agentTaskFromWords } from './invoke'
import { cliLaunch } from './launch'
import { composeLine, parseSlash, pathExists, taskFromCompose } from './compose'
import { createTuiSession, type TuiSession } from './tui-session'

/** 对话进行时，内部日志留在文件里，不再插进回复。 */
function quietConsole(): () => void {
  const transport = electronLog.transports.console
  const previous = transport.level
  transport.level = false
  return () => { transport.level = previous }
}

const log = createLogger('CLI')

/** 对外命令名；薄壳导出 SFT_CLI_NAME=sailfish，默认亦为 sailfish */
function cliName(): string {
  return process.env.SFT_CLI_NAME?.trim() || oemResolved.identity.cliName
}

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

const BOOLEAN_FLAGS = new Set(['once', 'verbose', 'free'])

function parseArgs(args: string[]): { positional: string[], flags: Record<string, string | boolean> } {
  const positional: string[] = []
  const flags: Record<string, string | boolean> = {}
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      const key = arg.slice(2)
      const next = args[i + 1]
      if (!BOOLEAN_FLAGS.has(key) && next && !next.startsWith('--') && !next.startsWith('-')) {
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
  if (!_configService) {
    _configService = new ConfigService()
    setConfigServiceInstance(_configService)
  }
  return _configService
}

let _aiService: AiService | null = null
function getAi(): AiService {
  if (!_aiService) _aiService = new AiService(getConfig())
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
    console.error(`Usage: ${cliName()} config:get <key>`)
    console.error(`Example: ${cliName()} config:get aiProfiles`)
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
    console.error(`Usage: ${cliName()} config:set <key> <value>`)
    console.error(`Example: ${cliName()} config:set theme one-dark`)
    console.error(`For complex values, use JSON: ${cliName()} config:set aiProfiles '[{"id":"1","name":"GPT-5.5","apiUrl":"...","apiKey":"...","model":"gpt-5.5"}]'`)
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
  console.log('SailFish CLI Config Initialization')
  console.log('=====================================\n')

  // Check existing profiles
  const profiles = config.getAiProfiles()
  if (profiles.length > 0) {
    console.log(`Already have ${profiles.length} AI profile(s) configured.`)
    console.log(`Use "${cliName()} config:set" to modify, or set environment variables:\n`)
  } else {
    console.log('No AI profiles configured yet.')
    console.log('Set up via environment variables or config:set:\n')
  }

  console.log('Environment variables (override config):')
  console.log('  SFT_API_URL    - AI API endpoint URL')
  console.log('  SFT_API_KEY    - AI API key')
  console.log('  SFT_MODEL      - AI model name')
  console.log('  SFT_DATA_DIR   - CLI sandbox directory (tests / --sandbox)')
  console.log('  SFT_CLI_SANDBOX=1 - Same as --sandbox')
  console.log('  SFT_CLI_SHARE_DESKTOP=1 - Dev CLI: use real desktop data')
  console.log('  SFT_CLI_NO_BORROW=1 - Do not borrow AI Profiles/credentials in sandbox')
  console.log('')
  console.log('Or configure via commands:')
  console.log(`  ${cliName()} config:set aiProfiles '[{"id":"default","name":"My AI","apiUrl":"https://api.openai.com/v1","apiKey":"sk-xxx","model":"gpt-5.5"}]'`)
  console.log(`  ${cliName()} config:set activeAiProfile "default"`)
  console.log('')
  console.log(`Config file location: ${config.get('language') !== undefined ? 'loaded' : 'will be created'}`)
}

// ==================== AI Commands ====================

async function aiChat(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const message = positional.join(' ')
  if (!message) {
    console.error(`Usage: ${cliName()} ai:chat <message> [--profile <profileId>]`)
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
    console.error(`Usage: ${cliName()} ai:stream <message> [--profile <profileId>]`)
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
    console.log(`Run "${cliName()} config:init" for setup instructions.`)
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
    console.error(`Usage: ${cliName()} knowledge:search <query> [--limit <n>] [--host <hostId>]`)
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
    console.log(
      `Score: ${r.score.toFixed(4)}  |  Doc: ${r.metadata?.filename || 'unknown'}  |  Host: ${r.metadata?.hostId || 'global'}`
    )
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
  
  const docs = service.listLibraryDocuments()
  
  if (docs.length === 0) {
    console.log('Knowledge base is empty.')
    return
  }

  const rows = docs.map((d: any) => ({
    id: d.id.substring(0, 8),
    folder: d.folder || '',
    filename: d.filename,
    by: d.addedBy || '',
    card: d.cardStatus || '',
    type: d.fileType,
    chunks: d.chunkCount,
  }))
  printTable(rows)
}

async function knowledgeService() {
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
  return service
}

async function knowledgeFolderCreate(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const folder = positional[0]
  if (!folder) {
    console.error(`Usage: ${cliName()} knowledge:folder:create <目录>`)
    process.exit(1)
  }
  const service = await knowledgeService()
  console.log(`已建目录：${service.createFolder(folder)}`)
}

async function knowledgeFolderList(): Promise<void> {
  const service = await knowledgeService()
  const folders = service.listFolders()
  if (folders.length === 0) {
    console.log('（没有目录）')
    return
  }
  for (const folder of folders) console.log(folder)
}

/** 打印秘书列目录时会看到的内容（一次一层） */
async function knowledgeCatalog(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const service = await knowledgeService()
  try {
    console.log(service.listCatalog(positional[0] || '', { allFolders: !!flags['all-folders'] }))
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}

async function knowledgeFolderRename(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const from = positional[0]
  const to = positional[1]
  if (!from || !to) {
    console.error(`Usage: ${cliName()} knowledge:folder:rename <原目录> <新目录>`)
    process.exit(1)
  }
  const service = await knowledgeService()
  const dest = service.renameFolder(from, to)
  const children = service.listFolders().filter((folder: string) => folder === dest || folder.startsWith(`${dest}/`))
  console.log(`已改名：${from} → ${dest}`)
  for (const folder of children) console.log(folder)
}

async function knowledgeFolderDelete(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const folder = positional[0]
  if (!folder) {
    console.error(`Usage: ${cliName()} knowledge:folder:delete <目录>`)
    process.exit(1)
  }
  const service = await knowledgeService()
  const removed = await service.deleteFolder(folder)
  console.log(`已删除目录：${folder}（${removed} 份文件）。没有回收站。`)
}

async function knowledgeContext(args: string[]): Promise<void> {
  const query = args.join(' ').trim()
  if (!query) {
    console.error(`Usage: ${cliName()} knowledge:context <query>`)
    process.exit(1)
  }
  const service = await knowledgeService()
  const context = await service.buildContext(query, { includeConversations: false })
  console.log(context || '（没有召回）')
}

function resolveLibraryDoc(
  docs: Array<{ id: string; filename: string }>,
  docId: string,
): { id: string; filename: string } {
  const exact = docs.filter(item => item.id === docId)
  const matches = exact.length > 0 ? exact : docs.filter(item => item.id.startsWith(docId))
  if (matches.length === 1) return matches[0]
  if (matches.length === 0) {
    console.error(`文档不存在: ${docId}`)
    process.exit(1)
  }
  console.error(`「${docId}」对上了多份档案，请写完整编号：`)
  for (const item of matches) console.error(`${item.id}  ${item.filename}`)
  process.exit(1)
}

async function knowledgeCard(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const docId = positional[0]
  const text = typeof flags.text === 'string' ? flags.text : ''
  if (!docId || !text) {
    console.error(`Usage: ${cliName()} knowledge:card <docId> --text <说明>`)
    process.exit(1)
  }
  const service = await knowledgeService()
  await service.initialize()
  const doc = resolveLibraryDoc(service.listLibraryDocuments(), docId)
  const ok = await service.updateCardText(doc.id, text)
  if (!ok) {
    console.error('说明没写上')
    process.exit(1)
  }
  console.log(`已写说明：${doc.filename}`)
}

async function knowledgeRemove(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const docId = positional[0]
  if (!docId) {
    console.error(`Usage: ${cliName()} knowledge:remove <docId> [--yes]`)
    process.exit(1)
  }
  const service = await knowledgeService()
  await service.initialize()
  const doc = resolveLibraryDoc(service.listLibraryDocuments(), docId)
  if (service.libraryDeleteNeedsConfirm(doc.id) && flags.yes !== true) {
    console.error(`需要确认：${doc.filename} 是用户放入的。没有回收站。确认无误请加 --yes。`)
    process.exit(1)
  }
  const removed = await service.removeDocument(doc.id)
  if (!removed) {
    console.error(`文档不存在: ${docId}`)
    process.exit(1)
  }
  console.log(`已删除：${doc.filename}`)
}

async function knowledgeCardQuota(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const service = await knowledgeService()
  if (flags.drain === true) {
    const taken = service.drainCardAllowance()
    const allowance = service.cardAllowance()
    console.log(`accepted=${taken} limit=${allowance.limit} used=${allowance.used}`)
    return
  }
  const allowance = service.cardAllowance()
  console.log(`used=${allowance.used} limit=${allowance.limit}`)
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

async function knowledgeRebuild(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const force = flags.force === true || flags.force === 'true'

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

  console.log(`Rebuilding indices (force=${force})...`)
  const result = await service.rebuildAllIndices(force)
  printJSON(result)
}

async function knowledgeRepair(args: string[]): Promise<void> {
  void args
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

  console.log('Repairing index (incremental, only missing docs)...')
  service.on('repairProgress', ({ current, total, filename }: { current: number; total: number; filename: string }) => {
    process.stdout.write(`\r  [${current}/${total}] ${filename}`.padEnd(80))
  })
  const result = await service.repairIndex()
  process.stdout.write('\n')
  printJSON(result)
}

async function knowledgeAdd(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const filePath = positional[0]
  if (!filePath) {
    console.error(`Usage: ${cliName()} knowledge:add <file-path> [--host <hostId>] [--folder <目录>]`)
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

  // 与界面入库同一条路：先解析再入库。直接按文本读会把 PDF / Word 的字节流当正文存进去
  const { getDocumentParserService } = require('../services/document-parser.service')
  const parsed = await getDocumentParserService().parseDocument({
    name: path.basename(filePath),
    path: filePath,
    size: fs.statSync(filePath).size
  })

  if (parsed.error) {
    console.error(`Parse failed: ${parsed.error}`)
    process.exit(1)
  }
  if (parsed.skipped) {
    console.error(`Skipped: ${parsed.filename} exceeds the parser size limit`)
    process.exit(1)
  }
  if (!parsed.content.trim()) {
    console.error(`Parse produced no text: ${parsed.filename}`)
    process.exit(1)
  }

  const duplicate = service.isDuplicate(parsed.content)
  if (duplicate.isDuplicate && duplicate.existingDoc) {
    console.log(`= Already present: ${duplicate.existingDoc.filename} (id: ${duplicate.existingDoc.id})`)
    return
  }

  const docId = await service.addDocument(parsed, {
    hostId: flags.host as string,
    folder: typeof flags.folder === 'string' ? flags.folder : undefined,
    addedBy: 'user',
  })

  const placed = service.getDocument(docId)
  const where = placed?.folder ? `${placed.folder}/${placed.filename}` : parsed.filename
  console.log(
    `✓ Added document: ${where} (id: ${docId}, type: ${parsed.fileType}, ${parsed.content.length} chars)`
  )
}

// ==================== Knowledge Bench Commands ====================

function getKnowledgeForBench(): any {
  const { getKnowledgeService } = require('../services/knowledge')
  const { McpService } = require('../services/mcp.service')
  const service = getKnowledgeService(getConfig(), getAi(), new McpService())
  if (!service) {
    console.error('Knowledge service not available')
    process.exit(1)
  }
  return service
}

/** 仓库自带的中性问题集，换台机器、没有用户数据也能跑 */
function defaultQuestionSetPath(): string {
  const path = require('path') as typeof import('path')
  return path.resolve(__dirname, '../../docs/bench/repo-docs.question-set.json')
}

function benchProgress(enabled: boolean): ((done: number, total: number, label: string) => void) | undefined {
  if (!enabled) return undefined
  // 重定向到文件时 \r 不会覆盖，会把进度摊成一长串，所以只在终端里原地刷新
  if (!process.stderr.isTTY) {
    return (done, total) => {
      if (done === total) process.stderr.write(`已完成 ${total} 项\n`)
    }
  }
  return (done, total, label) => {
    process.stderr.write(`\r${`[${done}/${total}] ${label}`.padEnd(70).slice(0, 70)}`)
    if (done === total) process.stderr.write('\n')
  }
}

async function knowledgeBench(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  const setPath = path.resolve((flags.set as string) || defaultQuestionSetPath())
  if (!fs.existsSync(setPath)) {
    console.error(`Question set not found: ${setPath}`)
    console.error(`Generate one first: ${cliName()} knowledge:bench:gen <file...> --out <path>`)
    process.exit(1)
  }

  const { QuestionSetStore, RecallBench, BenchReportFormatter } = require('../services/knowledge/bench')
  const { getDocumentParserService } = require('../services/document-parser.service')

  const store = new QuestionSetStore(setPath)
  const set = store.load()

  const service = getKnowledgeForBench()
  await service.initialize()

  const bench = new RecallBench(service, getDocumentParserService())
  const report = await bench.run(set, {
    baseDir: store.baseDir,
    includeCandidates: !!flags['include-candidates'],
    keepCorpus: !!flags.keep,
    onProgress: benchProgress(!flags.json)
  })

  if (flags.json) {
    printJSON(report)
  } else {
    console.log(BenchReportFormatter.toText(report))
  }

  // 一条都没搜到，最常见的原因是嵌入模型没就绪。这种全 0 的报告不能当基线存档，
  // 否则日后拿它作对照，什么改动都显得是巨大进步
  if (report.caseCount > 0 && report.metrics.manualTop5 === 0) {
    console.error(
      '\n期望命中的文档在主动检索里全部缺席。通常是嵌入模型没就绪，或问题集与语料不匹配——这种数字不能当基线，已跳过存档。'
    )
    process.exit(1)
  }

  if (typeof flags.save === 'string') {
    const savePath = path.resolve(flags.save)
    fs.mkdirSync(path.dirname(savePath), { recursive: true })
    fs.writeFileSync(savePath, JSON.stringify(report, null, 2) + '\n', 'utf-8')
    process.stderr.write(`报告已存档：${savePath}\n`)
  }
}

async function knowledgeBenchGen(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  if (positional.length === 0 || typeof flags.out !== 'string') {
    // 不给默认输出路径：忘了 --out 就把仓库自带的问题集覆盖掉，那是没人授权的改动
    console.error(`Usage: ${cliName()} knowledge:bench:gen <file-or-dir...> --out <path> [--per-doc 8] [--noise 5] [--name <name>] [--profile <id>]`)
    process.exit(1)
  }

  const supported = new Set(['.pdf', '.docx', '.doc', '.txt', '.md', '.mdc', '.json', '.xml', '.html', '.csv', '.xlsx', '.xls'])
  const files: string[] = []
  for (const target of positional) {
    const resolved = path.resolve(target)
    if (!fs.existsSync(resolved)) {
      console.error(`Not found: ${resolved}`)
      process.exit(1)
    }
    if (fs.statSync(resolved).isDirectory()) {
      for (const name of fs.readdirSync(resolved).sort()) {
        const child = path.join(resolved, name)
        if (fs.statSync(child).isFile() && supported.has(path.extname(name).toLowerCase())) {
          files.push(child)
        }
      }
    } else {
      files.push(resolved)
    }
  }
  if (files.length === 0) {
    console.error('No supported document found in the given paths')
    process.exit(1)
  }

  const { QuestionGenerator, QuestionSetStore } = require('../services/knowledge/bench')
  const { getDocumentParserService } = require('../services/document-parser.service')

  const generator = new QuestionGenerator(getAi(), getDocumentParserService())
  process.stderr.write(`出题中：${files.length} 份语料\n`)

  const set = await generator.generate(files, {
    perDoc: Number(flags['per-doc']) || 8,
    noiseCount: flags.noise === undefined ? 5 : Number(flags.noise),
    name: (flags.name as string) || undefined,
    profileId: (flags.profile as string) || undefined
  })

  const outPath = path.resolve(flags.out as string)
  new QuestionSetStore(outPath).save(set)

  console.log(`✓ ${set.cases.length} 条候选问题 + ${set.noiseQuestions.length} 条无关问题 → ${outPath}`)
  console.log(`  全部为候选状态。勾选时把要用的那条 status 改成 "approved"，不要的改成 "rejected"。`)
  console.log(`  想先看看效果：${cliName()} knowledge:bench --set ${outPath} --include-candidates`)
}

async function knowledgeBenchCompare(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const fs = require('fs') as typeof import('fs')
  const path = require('path') as typeof import('path')

  if (positional.length < 2) {
    console.error(`Usage: ${cliName()} knowledge:bench:compare <before.json> <after.json>`)
    process.exit(1)
  }

  const load = (p: string) => {
    const resolved = path.resolve(p)
    if (!fs.existsSync(resolved)) {
      console.error(`Report not found: ${resolved}`)
      process.exit(1)
    }
    return JSON.parse(fs.readFileSync(resolved, 'utf-8'))
  }

  const { BenchReportFormatter } = require('../services/knowledge/bench')
  console.log(BenchReportFormatter.compare(load(positional[0]), load(positional[1])))
}

// ==================== History Commands ====================

async function historyList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const service = getHistory()
  const limit = flags.limit ? parseInt(flags.limit as string) : 10

  const records = service.getAgentRecords()
  const recent = records.slice(-limit)
  if (recent.length === 0) {
    console.log('No agent records found. (0 steps)')
    return
  }
  for (const r of recent) {
    const time = new Date(r.timestamp).toLocaleString()
    const status = r.status === 'completed' ? '✓' : '✗'
    const label = (r.title || r.userTask || r.finalResult || '(unknown)').substring(0, 80)
    console.log(`[${time}] ${status} ${label} (${r.steps?.length || 0} steps, ${r.duration || 0}ms)`)
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
  let profiles = service.getAllProfiles()
  
  if (!profiles.find(p => p.hostId === 'local')) {
    try {
      await service.probeAndUpdateLocal()
      profiles = service.getAllProfiles()
    } catch { /* ignore probe errors */ }
  }

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
    console.error(`Usage: ${cliName()} host:get <hostId>`)
    process.exit(1)
  }
  const service = getHostProfile()
  let profile = service.getProfile(hostId)
  if (!profile && hostId === 'local') {
    try {
      await service.probeAndUpdateLocal()
      profile = service.getProfile(hostId)
    } catch { /* ignore probe errors */ }
  }
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
    console.log('No MCP connectors configured.')
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

// ==================== Watch & Sensor Commands ====================

async function watchList(): Promise<void> {
  const { getWatchStore } = require('../services/watch/store')
  const store = getWatchStore()
  const watches = store.getAll()

  if (watches.length === 0) {
    console.log('No watches configured.')
    return
  }

  const rows = watches.map((w: any) => ({
    id: w.id.substring(0, 12),
    name: w.name,
    enabled: w.enabled ? '✓' : '',
    triggers: w.triggers.map((t: any) => t.type).join(', '),
    output: w.output.type,
    priority: w.priority,
    lastRun: w.lastRun ? new Date(w.lastRun.at).toLocaleString() : 'never'
  }))
  printTable(rows)
}

async function watchCreate(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const { getWatchStore } = require('../services/watch/store')
  const store = getWatchStore()

  const name = flags.name as string
  const prompt = flags.prompt as string

  if (!name || !prompt) {
    console.error('Error: --name and --prompt are required.')
    console.error(`Usage: ${cliName()} watch:create --name "My Watch" --prompt "Do something" [--cron "0 9 * * *"] [--heartbeat] [--output im]`)
    process.exit(1)
  }

  const triggers: any[] = []
  if (flags.cron) {
    triggers.push({ type: 'cron', expression: flags.cron })
  }
  if (flags.heartbeat !== undefined) {
    triggers.push({ type: 'heartbeat' })
  }
  if (triggers.length === 0) {
    triggers.push({ type: 'manual' })
  }

  const outputType = (flags.output as string) || 'log'

  const watch = store.create({
    name,
    prompt,
    triggers,
    execution: { type: 'local' },
    output: { type: outputType },
    priority: 'normal'
  })

  console.log(`Watch created: ${watch.name} (${watch.id})`)
  console.log(`  Triggers: ${watch.triggers.map((t: any) => t.type).join(', ')}`)
  console.log(`  Output: ${watch.output.type}`)
}

async function watchTrigger(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(`Error: watch ID required. Usage: ${cliName()} watch:trigger <id>`)
    return
  }

  const { getWatchStore } = require('../services/watch/store')
  const store = getWatchStore()

  // 支持部分 ID 匹配
  const watches = store.getAll()
  const match = watches.find((w: any) => w.id === id || w.id.startsWith(id))
  if (!match) {
    console.error(`Watch not found: ${id}`)
    return
  }

  console.log(`Triggering watch: ${match.name} (${match.id})`)
  console.log(`Prompt: ${match.prompt.substring(0, 100)}...`)
  console.log('Note: In CLI mode, watch execution requires the Electron app running.')
  console.log('The watch has been validated and is ready for execution.')
}

async function watchDelete(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(`Error: watch ID required. Usage: ${cliName()} watch:delete <id>`)
    return
  }

  const { getWatchStore } = require('../services/watch/store')
  const store = getWatchStore()

  const watches = store.getAll()
  const match = watches.find((w: any) => w.id === id || w.id.startsWith(id))
  if (!match) {
    console.error(`Watch not found: ${id}`)
    return
  }

  store.delete(match.id)
  console.log(`Watch deleted: ${match.name} (${match.id})`)
}

async function watchHistory(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const limit = flags.limit ? parseInt(flags.limit as string) : 10
  const watchId = flags.watch as string | undefined

  // 走 WatchService：普通关切按正文树补齐流水；无参/唤醒仍读速览分桶
  const { getWatchService } = require('../services/watch/watch.service')
  const { getSensorService } = require('../services/sensor')
  const service = getWatchService()
  service.init({
    configService: getConfig(),
    agentService: {} as any,
    aiService: getAi(),
    sensorService: getSensorService(),
    historyService: getHistory(),
    mainWindow: null
  })
  const history = service.getHistory(watchId, limit)

  if (history.length === 0) {
    console.log('No watch execution history.')
    return
  }

  for (const h of history) {
    const time = new Date(h.at).toLocaleString()
    const statusIcon = h.status === 'completed' ? '✓' : h.status === 'skipped' ? '⊘' : '✗'
    const duration = `${Math.round(h.duration / 1000)}s`
    const trigger = h.triggerType || '?'
    console.log(`[${time}] ${statusIcon} ${h.watchName} (${trigger}, ${duration})`)
    if (h.skipReason) console.log(`  Skipped: ${h.skipReason}`)
    if (h.error) console.log(`  Error: ${h.error}`)
  }
}

async function todoList(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const { listTodos } = require('../services/agent/skills/todo/api')
  const includeDone = flags.all !== undefined || flags.done !== undefined
  const items = listTodos({ includeDone })
  if (items.length === 0) {
    console.log(includeDone ? 'No todos.' : 'No active todos.')
    return
  }
  const rows = items.map((t: { id: string; title: string; status: string; dueDate?: string; priority?: string }) => ({
    id: t.id.substring(0, 8),
    title: t.title.length > 40 ? t.title.slice(0, 37) + '...' : t.title,
    status: t.status,
    due: t.dueDate ? t.dueDate.slice(0, 10) : '',
    priority: t.priority || '',
  }))
  printTable(rows)
}

async function todoCreate(args: string[]): Promise<void> {
  const { flags, positional } = parseArgs(args)
  const title = (flags.title as string) || positional.join(' ').trim()
  if (!title) {
    console.error(`Error: title required. Usage: ${cliName()} todo:create --title "…" [--due YYYY-MM-DD]`)
    process.exit(1)
  }
  const { createTodo } = require('../services/agent/skills/todo/api')
  const item = await createTodo({
    title,
    dueDate: typeof flags.due === 'string' ? flags.due : undefined,
  })
  console.log(`Todo created: ${item.title} (${item.id})`)
}

async function todoDelete(args: string[]): Promise<void> {
  const id = args[0]
  if (!id) {
    console.error(`Error: todo ID required. Usage: ${cliName()} todo:delete <id>`)
    process.exit(1)
  }
  const { listTodos, deleteTodo } = require('../services/agent/skills/todo/api')
  const all = listTodos({ includeDone: true })
  const match = all.find((t: { id: string }) => t.id === id || t.id.startsWith(id))
  if (!match) {
    console.error(`Todo not found: ${id}`)
    process.exit(1)
  }
  await deleteTodo(match.id)
  console.log(`Todo deleted: ${match.title} (${match.id})`)
}

async function sensorStatus(): Promise<void> {
  const { getSensorService } = require('../services/sensor')
  const service = getSensorService()

  const sensors = service.getSensorStatus()
  console.log('Sensor Status:')
  for (const s of sensors) {
    const status = s.running ? '● running' : '○ stopped'
    console.log(`  ${s.name}: ${status}`)
  }

  const recent = service.getRecentEvents(5)
  if (recent.length > 0) {
    console.log('\nRecent Events:')
    for (const e of recent) {
      const time = new Date(e.timestamp).toLocaleTimeString()
      console.log(`  [${time}] ${e.type} (source: ${e.source})`)
    }
  }
}

async function sensorHeartbeat(): Promise<void> {
  const { getSensorService } = require('../services/sensor')
  const service = getSensorService()
  service.heartbeat.beat()
  console.log('Heartbeat triggered.')
}

async function bondStatus(): Promise<void> {
  const { getBondService } = require('../services/bond.service')
  const service = getBondService()
  const metrics = service.calculate()
  const milestones = service.getAllMilestones()

  const trustLabels: Record<string, string> = {
    stranger: '陌生人 (Stranger)',
    acquaintance: '相识 (Acquaintance)',
    companion: '伙伴 (Companion)',
    soulmate: '知己 (Soulmate)',
  }

  console.log('\n  Bond Metrics:')
  console.log(`    Level:       ${metrics.level}/100`)
  console.log(`    Trust:       ${trustLabels[metrics.trustLevel] || metrics.trustLevel}`)
  console.log(`    Days:        ${metrics.daysTogether}`)
  console.log(`    Tasks:       ${metrics.tasksCompleted}`)
  console.log(`    Exec Mode:   ${metrics.executionMode}`)

  console.log('\n  Milestones:')
  for (const m of milestones) {
    const icon = m.achieved ? '★' : '☆'
    console.log(`    ${icon} ${m.label_zh} (${m.label_en}) — threshold: ${m.threshold}`)
  }
  console.log()
}

async function watchTemplates(): Promise<void> {
  const { watchTemplates: templates } = require('../services/watch/templates')
  console.log(`\n  Watch Templates (${templates.length}):\n`)
  for (const tpl of templates) {
    console.log(`  ${tpl.icon}  ${tpl.id.padEnd(24)} ${tpl.name}`)
    console.log(`      ${tpl.description}\n`)
  }
}

async function watchFromTemplate(args: string[]): Promise<void> {
  const templateId = args[0]
  if (!templateId) {
    console.error('Error: template ID is required.')
    console.error(`Usage: ${cliName()} watch:from-template <template-id>`)
    console.error(`Run \`${cliName()} watch:templates\` to see available templates.`)
    process.exit(1)
  }

  const { getWatchService } = require('../services/watch/watch.service')
  const service = getWatchService()
  try {
    const watch = service.createFromTemplate(templateId)
    console.log(`Watch created from template "${templateId}":`)
    console.log(`  ID: ${watch.id}`)
    console.log(`  Name: ${watch.name}`)
    console.log(`  Triggers: ${watch.triggers.map((t: any) => t.type).join(', ')}`)
  } catch (err: any) {
    console.error('Error:', err.message)
    process.exit(1)
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

async function agentRun(args: string[], surface: 'plain' | 'screen' = 'plain'): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const task = positional.join(' ')
  const once = flags.once === true || !process.stdin.isTTY
  // 带上一句话直接开工。什么都不带、并且是自己开着终端，才进同一屏。
  const screen = surface === 'screen' && !task && Boolean(process.stdin.isTTY && process.stdout.isTTY) && !once
  if (!task && !screen) {
    console.error(`Usage: ${cliName()} agent:run <task> [--mode <strict|relaxed|free>] [--free] [--once] [--verbose]`)
    console.error(`   or: ${cliName()} "a quoted multi-word task" [--mode relaxed]`)
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
  
  // Initialize web search service
  try {
    const webSearch = require('../services/web-search/index')
    const webSearchSettings = config.get('webSearchSettings')
    if (webSearchSettings) {
      await webSearch.initWebSearch(webSearchSettings)
    }
  } catch (e) {
    log.warn('Web search init failed (non-fatal):', e)
  }

  const agent = new AgentService(ai, pty, hostProfile, mcp, config, ssh)
  const history = getHistory()
  agent.setHistoryService(history)

  // 站在用户敲命令的那个目录里，而不是回家目录
  const cwd = process.cwd()
  const ptyId = pty.create({ cwd }).id
  const { initTerminalStateService } = require('../services/terminal-state.service')
  initTerminalStateService(pty).initTerminal(ptyId, 'local', cwd)

  // 默认 relaxed：与桌面一致，高危需确认；--free / --mode free 才全自动
  const modeRaw = String(flags.mode || 'relaxed')
  const mode = ['strict', 'relaxed', 'free'].includes(modeRaw) ? modeRaw : 'relaxed'
  const verbose = flags.verbose === true
  const session: TuiSession | null = screen
    ? createTuiSession({ cwd, title: oemResolved.identity.productName })
    : null
  const transcript = new CliTranscript({
    verbose,
    tty: Boolean(process.stdout.isTTY),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    columns: process.stdout.columns || 80,
    ...(session ? { write: (chunk: string) => session.write(chunk) } : {}),
  })

  /**
   * stdin 单飞：同一时刻只允许一个读取者。
   *
   * 确认框、提问、密钥输入都各自建 readline 实例。若两个实例同时挂在 stdin 上，
   * 隐藏输入赖以生效的回显抑制会被另一个实例的默认回显绕开，密钥就明文打到屏幕上。
   */
  let activeReader: { cancel: () => void } | null = null
  /**
   * 读取代际：登记 activeReader 只能发生在 await 之后，若此期间又有人发起读取，
   * 先来者必须自己退场——否则它会挂在 stdin 上却不在锁里，成为失管的第二个读取者。
   */
  let readerGeneration = 0

  /** 取消未决的 stdin 读取（任务结束时调用，避免 readline 悬挂导致终端 raw 模式泄漏） */
  const cancelPendingRead = () => {
    activeReader?.cancel()
    activeReader = null
    session?.cancelRead()
  }

  /**
   * 读一行输入。hidden 时不回显（密钥等敏感输入用）。
   * timeoutMs 到期或被 cancel 时返回 null，调用方据此收尾——绝不无限期挂着。
   */
  const readLine = async (promptText: string, opts: { hidden?: boolean; timeoutMs?: number } = {}): Promise<string | null> => {
    const { hidden = false, timeoutMs } = opts
    const generation = ++readerGeneration
    cancelPendingRead()

    const readline = await import('readline')
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true })

    let settled = false
    let timer: NodeJS.Timeout | undefined
    let self: { cancel: () => void } | null = null
    const finish = (resolve: (v: string | null) => void, value: string | null) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (activeReader === self) activeReader = null
      rl.close()
      resolve(value)
    }

    return new Promise<string | null>((resolve) => {
      // await 期间已被后来者取代：不碰 stdin，直接退场
      if (generation !== readerGeneration) {
        rl.close()
        resolve(null)
        return
      }

      // 提示词本身要显示，所以先让 question 写完再静音；之后每次按键回显都会经过
      // _writeToOutput，被这里吞掉。依赖 Node readline 在 raw 模式下由自己负责回显。
      let muted = false
      if (hidden) {
        const anyRl = rl as any
        anyRl._writeToOutput = (str: string) => {
          if (!muted) anyRl.output.write(str)
        }
      }

      self = { cancel: () => finish(resolve, null) }
      activeReader = self
      if (timeoutMs) timer = setTimeout(() => finish(resolve, null), timeoutMs)

      rl.question(promptText, (answer) => {
        // raw 模式不做 CRLF 翻译，光标只下移不回到行首，所以要显式回车
        if (hidden) process.stdout.write('\r\n')
        finish(resolve, answer)
      })
      muted = true
    })
  }

  // 同一屏时改走屏幕上的那一行；平时仍是原来的逐行读取。
  const io = {
    read: readLine as (prompt: string, opts?: { hidden?: boolean; timeoutMs?: number; composer?: boolean }) => Promise<string | null>,
    show: (line: string) => { console.log(line) },
  }
  if (session) {
    io.read = (prompt, opts) => session.readLine(prompt, opts)
    io.show = (line) => session.note(line)
  }

  /**
   * ask_user 应答：交互式终端下把提问接到 stdin。
   * 非 TTY 时该工具本就不在工具列表里（context.unattended），不会走到这里。
   */
  const answerAsking = async (step: any) => {
    const args = step.toolArgs || {}
    const options: string[] = Array.isArray(args.options) ? args.options.filter((opt: unknown) => typeof opt === 'string') : []
    const defaultValue = typeof args.default_value === 'string' ? args.default_value : ''

    // 与工具自身的等待窗口对齐（misc.ts 同款上下限），过期后不再占着 stdin
    const deadline = clampAskUserTimeout(args.timeout) * 1000
    const startedAt = Date.now()
    const prompt = defaultValue
      ? `你的回答（直接回车选「${defaultValue}」）： `
      : '你的回答： '

    // 误按回车不该让用户失去作答机会——有默认值时回车就是选它，否则重新问
    while (Date.now() - startedAt < deadline) {
      transcript.clearActivity()
      const answer = await io.read(prompt, { timeoutMs: deadline - (Date.now() - startedAt) })
      if (answer === null) return
      const raw = answer.trim()
      if (!raw) {
        if (!defaultValue) continue
        io.show(`  ${defaultValue}`)
        agent.addUserMessage(ptyId, defaultValue)
        return
      }
      // 有选项时，纯数字按编号解释（这是列表本身的约定，不是猜测语义）
      const index = options.length > 0 && /^\d+$/.test(raw) ? Number(raw) - 1 : -1
      const picked = index >= 0 && index < options.length ? options[index] : undefined
      agent.addUserMessage(ptyId, picked ?? raw)
      return
    }
  }

  const reviewerNote = (confirmation: any): string => {
    if (!confirmation.autoReview) return ''
    const { rationale, reason } = confirmation.autoReview
    return rationale
      || (reason ? t(`autoReview.reason.${reason}` as TranslationKey) : '')
      || ''
  }

  const asked = new Set<string>()
  const callbacks = {
    onStep: (_agentId: string, step: any) => {
      transcript.push(step)
      if (step.type === 'asking' && !step.isStreaming && !asked.has(step.id)) {
        asked.add(step.id)
        void answerAsking(step)
      }
    },
    onNeedSecureInput: (request: any) => {
      // 没有这个回调时 Agent 会永久挂起（连超时都没有），所以两种情况都必须给出结论
      void (async () => {
        transcript.clearActivity()
        if (!process.stdin.isTTY) {
          transcript.hint(`${request.prompt || request.envName}：没有交互终端，已取消`)
          agent.resolveSecureInput(ptyId, request.requestId, false)
          return
        }
        io.show(request.prompt || `需要填写 ${request.envName}`)
        const entered = await io.read(`${request.envName}（输入不显示）： `, { hidden: true, timeoutMs: 300_000 })
        const value = entered?.trim()
        if (!value) {
          transcript.hint('已取消')
          agent.resolveSecureInput(ptyId, request.requestId, false)
          return
        }
        try {
          const { getDefaultCredentialService } = await import('../services/credential.service')
          await getDefaultCredentialService().setSkillEnv(request.skillId, request.envName, value)
          agent.resolveSecureInput(ptyId, request.requestId, true)
          transcript.hint('已记下')
        } catch (err) {
          // 存不进去也必须给出结论，否则 Agent 一直等在那里
          transcript.fail(err instanceof Error ? err.message : String(err))
          agent.resolveSecureInput(ptyId, request.requestId, false)
        }
      })()
    },
    onNeedConfirm: (confirmation: any) => {
      transcript.clearActivity()
      const riskKey = `taskmgr.risk.${confirmation.riskLevel}` as TranslationKey
      const riskLabel = t(riskKey) === riskKey ? String(confirmation.riskLevel || '') : t(riskKey)
      for (const line of confirmationLines({
        toolName: confirmation.toolName,
        toolArgs: confirmation.toolArgs,
        displayName: confirmation.displayName,
        riskLabel,
        reasons: confirmation.reasons,
        reviewerNote: reviewerNote(confirmation),
      })) io.show(line)
      void (async () => {
        if (mode === 'free') {
          transcript.hint('已按全自动放行')
          agent.confirmToolCall(ptyId, confirmation.toolCallId, true)
          return
        }
        if (!process.stdin.isTTY) {
          transcript.hint('没有交互终端，这一步被拒绝了。要自动放行请加 --free')
          agent.confirmToolCall(ptyId, confirmation.toolCallId, false)
          return
        }
        const answer = await io.read('允许吗？[y/N] ')
        if (answer === null) {
          agent.confirmToolCall(ptyId, confirmation.toolCallId, false)
          return
        }
        const ok = /^y(es)?$/i.test(answer.trim())
        agent.confirmToolCall(ptyId, confirmation.toolCallId, ok)
        transcript.hint(ok ? '已允许' : '已拒绝')
      })()
    },
    onComplete: (_agentId: string, _result: string, _pending?: unknown, extra?: { aborted?: boolean }) => {
      if (extra?.aborted) transcript.interrupted()
      cancelPendingRead()
    },
    onError: (_agentId: string, error: string, extra?: { aborted?: boolean }) => {
      cancelPendingRead()
      if (extra?.aborted) transcript.interrupted()
      else transcript.fail(error)
    }
  }

  const context = {
    ptyId,
    cwd,
    terminalOutput: [],
    systemInfo: {
      os: getLocalOS(),
      shell: getDefaultShell()
    },
    terminalType: 'local' as const,
    // 交互式终端里有人坐在屏幕前（下面注册了 stdin 应答通道）；
    // 管道/CI/被程序调起时无人可答，如实申报。
    unattended: !process.stdin.isTTY
  }

  let busy = false
  const onSigint = () => {
    if (session) {
      session.handleInterrupt()
      return
    }
    if (busy) {
      transcript.interrupted()
      cancelPendingRead()
      agent.abort(ptyId)
      return
    }
    process.exit(130)
  }
  process.on('SIGINT', onSigint)

  const screenHint = '拖进终端或粘贴的路径会作为附件。/skills 查看技能，/skill 名字 加上，/unskill 名字 拿掉，/exit 离开。PgUp 往上翻。'

  const skillCatalog = (): { id: string; name: string }[] => {
    const skills = require('../services/agent/skills') as typeof import('../services/agent/skills')
    const list = skills.getSkillsSummary().map(item => ({ id: item.id, name: item.name }))
    try {
      const { getUserSkillService } = require('../services/user-skill.service')
      for (const item of getUserSkillService().getEnabledSkills() as { id: string; name: string }[]) {
        if (!list.some(known => isSameSkillId(known.id, item.id))) list.push({ id: item.id, name: item.name })
      }
    } catch { /* 用户技能读不到时，名单里只剩内置的 */ }
    return list
  }

  const visibleSkills = (): { id: string; name: string; systemManaged?: boolean }[] => {
    return agent.getVisibleSkills(ptyId)
  }

  const refreshAside = () => {
    if (!session) return
    const names = visibleSkills().filter(item => !item.systemManaged).map(item => item.name)
    session.setAside(names.length ? `技能 ${names.join('、')}` : '')
  }

  const showSkills = () => {
    if (!session) return
    const list = skillCatalog()
    const pinned = visibleSkills()
    const on = list.filter(item => pinned.some(visible => isSameSkillId(visible.id, item.id)))
    session.note(on.length ? `已加上：${on.map(item => item.name).join('、')}` : '还没有加上的技能')
    session.note('可以加：')
    for (const item of list) {
      const mark = pinned.some(visible => isSameSkillId(visible.id, item.id)) ? '  · 已加上' : ''
      session.note(`  ${item.id}  ${item.name}${mark}`)
    }
    session.note('加上用 /skill 后面的名字，拿掉用 /unskill。')
    refreshAside()
  }

  const changeSkill = async (action: 'skill' | 'unskill', arg: string) => {
    if (!session) return
    if (!arg) {
      session.note(action === 'skill' ? '用法：/skill 技能名' : '用法：/unskill 技能名')
      return
    }
    const hits = skillCatalog().filter(item => item.id === arg || item.name === arg)
    if (hits.length !== 1) {
      session.note(hits.length > 1 ? '有好几个同名的，用名单里左边那一列。' : '没有叫这个的技能。/skills 看名单。')
      return
    }
    const chosen = hits[0]
    if (action === 'unskill') {
      await agent.unpinSkill(ptyId, chosen.id)
      session.note(`已拿掉「${chosen.name}」`)
    } else {
      const result = await agent.pinSkill(ptyId, chosen.id)
      if (!result.ok) {
        session.note(result.error === 'system_managed'
          ? '这个由系统自己管，不用加。'
          : result.error === 'mcp_not_supported'
            ? '外部工具包不在这里加。'
            : (result.error ? `没加上：${result.error}` : '没加上。'))
        return
      }
      session.note(`已加上「${chosen.name}」`)
    }
    refreshAside()
  }

  const runScreen = async () => {
    if (!session) return
    const screenSession = session
    let depth = 0
    screenSession.setOnInterrupt(() => {
      transcript.interrupted()
      cancelPendingRead()
      agent.abort(ptyId)
    })
    const deliver = async (raw: string) => {
      const text = raw.trim()
      if (!text) return
      const slash = parseSlash(text)
      if (slash && slash.name !== 'unknown') {
        screenSession.note(`› ${text}`)
        if (slash.name === 'exit') {
          screenSession.requestLeave(0)
          if (depth > 0) agent.abort(ptyId)
          return
        }
        if (slash.name === 'help') {
          screenSession.note(screenHint)
          return
        }
        if (slash.name === 'skills') {
          showSkills()
          return
        }
        await changeSkill(slash.name, slash.arg)
        return
      }
      const composed = composeLine(text, cwd, pathExists)
      if (slash?.name === 'unknown' && composed.paths.length === 0) {
        screenSession.note('没有这条命令。/help 看能用的。')
        return
      }
      const message = taskFromCompose(composed)
      if (!message) return
      depth++
      screenSession.setBusy(true)
      busy = true
      try {
        const payload: AgentContext = { ...context }
        if (composed.paths.length > 0) {
          const { materializeAttachments } = await import('./attach')
          const files = await materializeAttachments(composed.paths)
          for (const err of files.errors) screenSession.note(err)
          if (files.attachments.length > 0) payload.attachments = files.attachments
          if (files.documentContext) payload.documentContext = files.documentContext
          if (files.images) payload.images = files.images
          if (files.previewImages) payload.previewImages = files.previewImages
        }
        screenSession.note(`› ${message}`)
        const said = await agent.say(ptyId, message, payload, {
          surface: 'terminal',
          config: { executionMode: mode as ExecutionMode },
          callbacks,
        })
        if (said.outcome === 'ran') transcript.finish(said.result || '')
      } catch (error: any) {
        transcript.fail(error?.message || String(error))
      } finally {
        depth--
        busy = depth > 0
        screenSession.setBusy(depth > 0)
      }
    }

    screenSession.setOnBareSubmit((text) => { void deliver(text) })
    screenSession.note(screenHint)
    while (!screenSession.leaving) {
      const next = await screenSession.readLine('› ', { composer: true })
      if (next === null) break
      const text = next.trim()
      if (!text) continue
      if (/^(exit|quit)$/i.test(text)) {
        screenSession.requestLeave(0)
        break
      }
      await deliver(text)
    }
  }

  const restoreConsole = verbose ? () => {} : quietConsole()
  let hinted = false
  let turn: string | null = task
  try {
    if (session) {
      await session.run(runScreen)
    } else while (turn) {
      busy = true
      try {
        const said = await agent.say(ptyId, turn, context, {
          surface: 'terminal',
          config: { executionMode: mode as ExecutionMode },
          callbacks,
        })
        transcript.finish(said.outcome === 'ran' ? said.result : '')
      } catch (error: any) {
        transcript.fail(error?.message || String(error))
      } finally {
        busy = false
      }
      if (once) break
      if (!hinted) {
        transcript.hint('接着说就行，exit 结束。Ctrl+C 停下正在做的这一轮')
        hinted = true
      }
      const next = await readLine('› ')
      if (next === null) break
      const text = next.trim()
      if (!text) continue
      if (/^(exit|quit)$/i.test(text)) break
      turn = text
    }

    // 标题在第一句时另起请求，退出前等它写完，但不打到屏幕上
    const title = await Promise.race([
      agent.getAgent(ptyId)?.waitForInitialTitle() ?? Promise.resolve(null),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), 30_000)),
    ])
    if (verbose) {
      const sessionId = agent.getAgent(ptyId)?.getSessionId()
      if (sessionId) console.log(`\nsession: ${sessionId}${title ? `  ${title}` : ''}`)
    }

    // 这场没记的记忆收尾时补上，同样等它写完再退出
    await Promise.race([
      agent.getAgent(ptyId)?.flushMemory() ?? Promise.resolve(),
      new Promise<void>((resolve) => { setTimeout(resolve, 60_000).unref() }),
    ])
  } finally {
    process.removeListener('SIGINT', onSigint)
    restoreConsole()
    pty.dispose(ptyId)
    agent.cleanupAgent(ptyId)
    // 关掉 keep-alive 连接池，否则 Node 事件循环还会挂十几秒
    ai.dispose()
  }
  if (session?.exitCode === 130) process.exitCode = 130
}

// ==================== Companion（联络） ====================

async function promptYesNo(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log('   无 TTY：已拒绝（加 --mode free 或 --free 可自动批准）')
    return false
  }
  const readline = await import('readline')
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  try {
    const answer = await new Promise<string>((resolve) => {
      rl.question(`${question} [y/N] `, resolve)
    })
    return /^y(es)?$/i.test(answer.trim())
  } finally {
    rl.close()
  }
}

/**
 * 联络这一轮挂着等任务回执的时候，用户在命令行里敲的每一行都是对联络说的话（等于在对话里插话）。
 * 没有 TTY 就不监听。联络自己要用户确认时先 pause：真把监听关掉，让 y/n 那个提问独占键盘，
 * 免得同一行被两个读取方同时收到（双份回显、那一句被当成对联络说的话）；答完 resume 再接上。
 */
function listenForUserLines(onLine: (line: string) => void): { pause(): void; resume(): void; close(): void } {
  if (!process.stdin.isTTY) return { pause() {}, resume() {}, close() {} }
  const readline = require('readline') as typeof import('readline')
  let rl: import('readline').Interface | undefined
  let closed = false
  const open = () => {
    if (rl || closed) return
    const opened = readline.createInterface({ input: process.stdin, output: process.stdout })
    opened.on('line', (line: string) => {
      const text = line.trim()
      if (text) onLine(text)
    })
    rl = opened
  }
  const shut = () => {
    rl?.close()
    rl = undefined
  }
  open()
  return {
    pause: shut,
    resume: open,
    close() {
      closed = true
      shut()
    },
  }
}

/**
 * 以联络（__companion__）身份对话：`sailfish companion "消息"`。
 *
 * 用途：无头回归联络专属能力（manage_tasks 任务管理只对 __companion__ 注册）。
 * 联络经 manage_tasks 建的 / 交代的任务与桌面同一条路在后端跑（没有窗口只是没人认领到侧栏）；
 * 联络派完任务后这一轮不收工，等任务的回执在同一轮里送到、由联络回复并打印（和桌面一样）。
 * 等的时候用户敲的每一行都是对联络说的话；`--task-wait` 是等的上限，到点不再等、打印没做完的任务后退出。
 */
async function companionChat(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const message = positional.join(' ')
  if (!message) {
    console.error(`Usage: ${cliName()} companion <消息> [--mode <strict|relaxed|free>] [--free] [--task-wait <秒>] [--once] [--verbose]`)
    process.exit(1)
  }

  applyEnvOverrides()

  const { PtyService } = require('../services/pty.service')
  const { AgentService } = require('../services/agent')
  const { McpService } = require('../services/mcp.service')
  const { COMPANION_AGENT_KEY } = require('@shared/types')

  const config = getConfig()
  const ai = getAi()
  const pty = new PtyService()
  const hostProfile = getHostProfile()
  const mcp = new McpService()
  const { SshService } = require('../services/ssh.service')
  const ssh = new SshService()

  const agent = new AgentService(ai, pty, hostProfile, mcp, config, ssh)
  agent.setHistoryService(getHistory())

  const modeRaw = String(flags.mode || (flags.free ? 'free' : 'relaxed'))
  const mode = ['strict', 'relaxed', 'free'].includes(modeRaw) ? modeRaw : 'relaxed'
  // 联络这一轮为任务等回执的上限：防止任务长挂导致 CLI 永不退出（0 = 不等，回复后即退出）
  const taskWaitSec = Math.max(0, Number(flags['task-wait'] ?? 600) || 0)

  const verbose = flags.verbose === true
  const once = flags.once === true || !process.stdin.isTTY
  const transcript = new CliTranscript({
    verbose,
    tty: Boolean(process.stdout.isTTY),
    color: Boolean(process.stdout.isTTY) && !process.env.NO_COLOR,
    columns: process.stdout.columns || 80,
  })
  let userLines: ReturnType<typeof listenForUserLines> | undefined
  /** 联络开始为任务等回执时记下，到上限不再等 */
  let onStartedWaiting: (() => void) | undefined

  const callbacks = {
    onStep: (_agentId: string, step: any) => {
      if (step.type === 'tool_call' && step.toolName === 'manage_tasks' && step.toolArgs?.action === 'await') {
        onStartedWaiting?.()
      }
      transcript.push(step)
    },
    onNeedConfirm: (confirmation: any) => {
      transcript.clearActivity()
      const riskKey = `taskmgr.risk.${confirmation.riskLevel}` as TranslationKey
      const riskLabel = t(riskKey) === riskKey ? String(confirmation.riskLevel || '') : t(riskKey)
      const note = confirmation.autoReview
        ? (confirmation.autoReview.rationale
          || (confirmation.autoReview.reason ? t(`autoReview.reason.${confirmation.autoReview.reason}` as TranslationKey) : ''))
        : ''
      for (const line of confirmationLines({
        toolName: confirmation.toolName,
        toolArgs: confirmation.toolArgs,
        displayName: confirmation.displayName,
        riskLabel,
        reasons: confirmation.reasons,
        reviewerNote: note,
      })) console.log(line)
      void (async () => {
        if (mode === 'free') {
          transcript.hint('已按全自动放行')
          agent.confirmToolCall(COMPANION_AGENT_KEY, confirmation.toolCallId, true)
          return
        }
        userLines?.pause()
        let ok = false
        try {
          ok = await promptYesNo('允许吗？')
        } finally {
          userLines?.resume()
        }
        agent.confirmToolCall(COMPANION_AGENT_KEY, confirmation.toolCallId, ok)
        transcript.hint(ok ? '已允许' : '已拒绝')
      })().catch(err => transcript.fail(err instanceof Error ? err.message : String(err)))
    },
    onComplete: (_agentId: string, _result: string, _pending?: unknown, extra?: { aborted?: boolean }) => {
      if (extra?.aborted) transcript.interrupted()
    },
    onError: (_agentId: string, error: string, extra?: { aborted?: boolean }) => {
      if (extra?.aborted) transcript.interrupted()
      else transcript.fail(error)
    }
  }

  // 回执叫醒联络另起的一轮也用这套回调（与桌面推联络页同一个口子）
  agent.setUiCallbacksFactory((key: string) => key === COMPANION_AGENT_KEY ? callbacks : undefined)
  const supervisor = agent.getTaskSupervisor()
  supervisor.setFullAutoForAssignedTasks(mode === 'free')
  const companionContext = () => ({
    terminalOutput: [],
    systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
    terminalType: 'assistant' as const,
    cwd: process.cwd(),
  })

  // 联络派完任务后这一轮等着回执，最多等 --task-wait 秒（0 = 派完就收工，回复后即退出）
  supervisor.setReceiptWaitLimit(taskWaitSec * 1000)
  const companion = agent.createAssistantAgent(COMPANION_AGENT_KEY)
  let deadlineTimer: NodeJS.Timeout | undefined
  onStartedWaiting = () => {
    if (deadlineTimer || taskWaitSec <= 0) return
    transcript.hint(`联络在等派出的任务（最多 ${taskWaitSec} 秒，--task-wait 可调）。这时敲的话直接说给联络`)
    // 不 unref：等回执期间这个定时器同时是进程的保活句柄（没有 TTY 时没有别的东西占着事件循环）
    deadlineTimer = setTimeout(() => agent.abort(COMPANION_AGENT_KEY), taskWaitSec * 1000)
  }

  const restoreConsole = verbose ? () => {} : quietConsole()
  let turn: string | null = message
  let hinted = false
  let busy = false
  const onSigint = () => {
    if (busy) {
      transcript.interrupted()
      agent.abort(COMPANION_AGENT_KEY)
      return
    }
    process.exit(130)
  }
  process.on('SIGINT', onSigint)
  try {
    while (turn) {
      const saying = turn
      busy = true
      userLines = listenForUserLines(line => {
        agent.say(COMPANION_AGENT_KEY, line, companionContext(), { surface: 'assistant' })
          .catch((err: any) => transcript.fail(err?.message || String(err)))
      })
      try {
        const result = await agent.runAssistant(
          COMPANION_AGENT_KEY,
          saying,
          companionContext(),
          { executionMode: mode as 'strict' | 'relaxed' | 'free' },
          undefined,
          callbacks
        )
        transcript.finish(result)
      } catch (error: any) {
        transcript.fail(error?.message || String(error))
      } finally {
        busy = false
        if (deadlineTimer) clearTimeout(deadlineTimer)
        deadlineTimer = undefined
        userLines.close()
        userLines = undefined
      }
      if (once) break
      if (!hinted) {
        transcript.hint('接着对联络说就行，exit 结束')
        hinted = true
      }
      const readline = await import('readline')
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
      const next = await new Promise<string | null>((resolve) => {
        rl.question('› ', resolve)
        rl.once('close', () => resolve(null))
      })
      rl.close()
      if (next === null) break
      const text = next.trim()
      if (!text) continue
      if (/^(exit|quit)$/i.test(text)) break
      turn = text
    }
  } finally {
    process.removeListener('SIGINT', onSigint)
    restoreConsole()
    if (deadlineTimer) clearTimeout(deadlineTimer)
    userLines?.close()
  }

  const remaining = supervisor.listLiveTasks().filter((t: any) => t.isRunning)
  if (remaining.length > 0) {
    console.log(`\n⚠️ 联络不再等了，仍有 ${remaining.length} 个任务在跑（进程退出后任务中断）：`)
    for (const t of remaining) {
      console.log(`   - 「${t.title}」(${t.agentKey}) phase=${t.phase ?? '-'} steps=${t.stepCount}`)
    }
  }
  // 进程将退出：防抖窗口里的回执立刻交给联络，等它处理完落进记录（最多再等一分钟）
  await supervisor.flushPendingEvents()
  const settleDeadline = Date.now() + 60_000
  while (companion.isRunning() && Date.now() < settleDeadline) {
    await new Promise(r => setTimeout(r, 500))
  }

  // 关掉 keep-alive 连接池，否则 Node 事件循环还会挂十几秒
  ai.dispose()
}

// ==================== IM Commands ====================

const SUPPORTED_IM_PLATFORMS = ['dingtalk', 'feishu', 'slack', 'telegram', 'wecom'] as const
type IMPlatformName = typeof SUPPORTED_IM_PLATFORMS[number]

type StoreKey = Parameters<ReturnType<typeof getConfig>['get']>[0]

interface IMPlatformMeta {
  label: string
  /** field name → StoreSchema key，用于从 config 读取凭证 */
  configKeys: Record<string, StoreKey>
  autoKey: StoreKey
  /** 可选字段不参与"凭证是否齐全"判断 */
  optionalFields?: string[]
}

const IM_PLATFORMS: Record<IMPlatformName, IMPlatformMeta> = {
  dingtalk: {
    label: 'DingTalk (钉钉)',
    configKeys: { clientId: 'imDingTalkClientId', clientSecret: 'imDingTalkClientSecret' },
    autoKey: 'imDingTalkAutoConnect',
  },
  feishu: {
    label: 'Feishu (飞书)',
    configKeys: { appId: 'imFeishuAppId', appSecret: 'imFeishuAppSecret' },
    autoKey: 'imFeishuAutoConnect',
  },
  slack: {
    label: 'Slack',
    configKeys: { botToken: 'imSlackBotToken', appToken: 'imSlackAppToken' },
    autoKey: 'imSlackAutoConnect',
  },
  telegram: {
    label: 'Telegram',
    configKeys: { botToken: 'imTelegramBotToken' },
    autoKey: 'imTelegramAutoConnect',
  },
  wecom: {
    label: 'WeCom (企业微信)',
    configKeys: { botId: 'imWeComBotId', secret: 'imWeComSecret' },
    autoKey: 'imWeComAutoConnect',
  },
}

function readIMCredentials(platform: IMPlatformName): Record<string, any> | null {
  const config = getConfig()
  const meta = IM_PLATFORMS[platform]
  const optionals = new Set(meta.optionalFields || [])
  const creds: Record<string, any> = {}
  let hasAll = true

  for (const [field, configKey] of Object.entries(meta.configKeys)) {
    const val = config.get(configKey)
    creds[field] = val
    if (!optionals.has(field) && !val) hasAll = false
  }

  return hasAll ? creds : null
}

async function imStatus(): Promise<void> {
  const config = getConfig()

  const rows = Object.entries(IM_PLATFORMS).map(([key, meta]) => {
    const creds = readIMCredentials(key as IMPlatformName)
    const autoConnect = !!config.get(meta.autoKey)
    return {
      platform: meta.label,
      configured: creds ? '✓' : '✗',
      autoConnect: autoConnect ? '✓' : '',
    }
  })

  printTable(rows)
}

async function imConnect(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase() as IMPlatformName | undefined
  if (!platform || !SUPPORTED_IM_PLATFORMS.includes(platform)) {
    console.error(`Usage: ${cliName()} im:connect <dingtalk|feishu|slack|telegram|wecom>`)
    process.exit(1)
  }

  const creds = readIMCredentials(platform)
  if (!creds) {
    const meta = IM_PLATFORMS[platform]
    const keys = Object.values(meta.configKeys).join(', ')
    console.error(`${meta.label} credentials not configured.`)
    console.error(`Set the following config keys first: ${keys}`)
    console.error(`Example: ${cliName()} config:set ${Object.values(meta.configKeys)[0]} '"your-value"'`)
    process.exit(1)
  }

  console.log(`Connecting to ${IM_PLATFORMS[platform].label}...`)

  try {
    const adapter = createIMAdapter(platform, creds)

    // adapter 接口要求设置回调，这里仅做连接测试，不处理消息
    adapter.onMessage = () => {}
    adapter.onConnectionChange = (connected: boolean) => {
      if (connected) console.log(`  Connection established`)
    }

    await adapter.start()

    if (adapter.isConnected()) {
      console.log(`✓ ${IM_PLATFORMS[platform].label} connected successfully`)
    } else {
      console.log(`✓ ${IM_PLATFORMS[platform].label} started (connection pending)`)
    }

    await adapter.stop()
  } catch (err: any) {
    const msg = (err.message || String(err))
      .replace(/xoxb-\S+/g, 'xoxb-***')
      .replace(/xapp-\S+/g, 'xapp-***')
      .replace(/\d{5,}:[A-Za-z0-9_-]+/g, '***:***')
    console.error(`✗ Connection failed: ${msg}`)
    process.exit(1)
  }
}

function createIMAdapter(platform: IMPlatformName, creds: Record<string, any>) {
  switch (platform) {
    case 'dingtalk': {
      const { DingTalkAdapter } = require('../services/im/dingtalk-adapter')
      return new DingTalkAdapter({ clientId: creds.clientId, clientSecret: creds.clientSecret })
    }
    case 'feishu': {
      const { FeishuAdapter } = require('../services/im/feishu-adapter')
      return new FeishuAdapter({ appId: creds.appId, appSecret: creds.appSecret })
    }
    case 'slack': {
      const { SlackAdapter } = require('../services/im/slack-adapter')
      return new SlackAdapter({ botToken: creds.botToken, appToken: creds.appToken })
    }
    case 'telegram': {
      const { TelegramAdapter } = require('../services/im/telegram-adapter')
      return new TelegramAdapter({ botToken: creds.botToken })
    }
    case 'wecom': {
      const { WeComAdapter } = require('../services/im/wecom-adapter')
      return new WeComAdapter({ botId: creds.botId, secret: creds.secret })
    }
  }
}

async function imDisconnect(args: string[]): Promise<void> {
  const platform = args[0]?.toLowerCase()
  if (!platform) {
    console.error(`Usage: ${cliName()} im:disconnect <dingtalk|feishu|slack|telegram|wecom>`)
    console.error('Note: In CLI mode, each invocation is a separate process.')
    console.error('This command is mainly useful for clearing auto-connect settings.')
    process.exit(1)
  }

  if (!SUPPORTED_IM_PLATFORMS.includes(platform as IMPlatformName)) {
    console.error(`Unknown platform: ${platform}`)
    console.error(`Supported: ${SUPPORTED_IM_PLATFORMS.join(', ')}`)
    process.exit(1)
  }

  const config = getConfig()
  const meta = IM_PLATFORMS[platform as IMPlatformName]
  config.set(meta.autoKey, false as any)
  console.log(`✓ ${meta.label} auto-connect disabled`)
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
    files: s.files?.length || 0,
    description: (s.description || '').substring(0, 50)
  }))
  printTable(rows)
}

// ==================== Skill Market Commands ====================

async function skillMarket(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const { getSkillMarketService } = require('../services/skill-market.service')
  const { getUserSkillService } = require('../services/user-skill.service')
  const service = getSkillMarketService(getConfig(), getUserSkillService())

  console.log('Fetching skill market...')
  const query = flags.search as string | undefined
  const skills = query
    ? await service.searchSkills(query)
    : await service.listSkills(true)

  if (skills.length === 0) {
    console.log(query ? `No skills matching "${query}".` : 'No skills in the market.')
    return
  }

  const rows = skills.map((s: any) => ({
    id: s.id,
    name: s.name,
    version: s.version || '',
    status: s.installed ? (s.hasUpdate ? '↑ update' : '✓ installed') : '',
    description: (s.description || '').substring(0, 50)
  }))
  printTable(rows)
  console.log(`\nTotal: ${skills.length} skill(s)`)
}

async function skillInstall(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const skillId = positional[0]
  if (!skillId) {
    console.error(`Usage: ${cliName()} skill:install <skill-id>`)
    process.exit(1)
  }

  const { getSkillMarketService } = require('../services/skill-market.service')
  const { getUserSkillService } = require('../services/user-skill.service')
  const service = getSkillMarketService(getConfig(), getUserSkillService())

  console.log(`Installing skill "${skillId}"...`)
  const result = await service.installSkill(skillId)

  if (result.success) {
    console.log(`✓ Skill "${skillId}" installed successfully.`)
  } else {
    console.error(`✗ Failed to install "${skillId}": ${result.error}`)
    process.exit(1)
  }
}

async function skillUninstall(args: string[]): Promise<void> {
  const { positional } = parseArgs(args)
  const skillId = positional[0]
  if (!skillId) {
    console.error(`Usage: ${cliName()} skill:uninstall <skill-id>`)
    process.exit(1)
  }

  const { getSkillMarketService } = require('../services/skill-market.service')
  const { getUserSkillService } = require('../services/user-skill.service')
  const service = getSkillMarketService(getConfig(), getUserSkillService())

  const result = service.uninstallSkill(skillId)

  if (result.success) {
    console.log(`✓ Skill "${skillId}" uninstalled.`)
  } else {
    console.error(`✗ Failed to uninstall "${skillId}": ${result.error}`)
    process.exit(1)
  }
}

async function skillRegistry(args: string[]): Promise<void> {
  const { flags } = parseArgs(args)
  const { getSkillMarketService } = require('../services/skill-market.service')
  const { getUserSkillService } = require('../services/user-skill.service')
  const service = getSkillMarketService(getConfig(), getUserSkillService())

  if (flags.reset) {
    service.setRegistryUrl('')
    console.log('Registry URL reset to default.')
    return
  }

  if (flags.set && typeof flags.set === 'string') {
    service.setRegistryUrl(flags.set)
    console.log(`Registry URL set to: ${flags.set}`)
    return
  }

  const url = service.getRegistryUrl()
  console.log(`Registry URL: ${url}`)

  try {
    const registry = await service.fetchRegistry(true)
    console.log(`Registry version: ${registry.version}`)
    console.log(`Last updated: ${registry.updated}`)
    console.log(`Skills available: ${registry.skills.length}`)
  } catch (error: any) {
    console.log(`(Could not fetch registry: ${error.message})`)
  }
}

// ==================== PTY Commands ====================

async function ptyExec(args: string[]): Promise<void> {
  const { positional, flags } = parseArgs(args)
  const command = positional.join(' ')
  if (!command) {
    console.error(`Usage: ${cliName()} pty:exec <command> [--timeout <ms>]`)
    process.exit(1)
  }

  const { PtyService } = require('../services/pty.service')
  const pty = new PtyService()
  const ptyId = pty.create({}).id

  const timeout = flags.timeout ? parseInt(flags.timeout as string) : 10000

  try {
    const result = await pty.executeInTerminal(ptyId, command, timeout)
    // 显式 return 让 TS 控制流分析更清晰（process.exit 是 never，narrowing 本身够用，
    // 但加 return 后维护者不必去翻 @types/node 才能确信下面访问 result.output 是安全的）
    if (result.status === 'no_instance') {
      console.error(`Execution error: terminal instance not found (id=${result.ptyId})`)
      process.exit(1)
      return
    }
    if (result.output) {
      process.stdout.write(result.output)
      if (!result.output.endsWith('\n')) console.log()
    }
    if (result.status === 'timeout') {
      console.error(`\n[command timed out after ${timeout}ms]`)
      process.exit(124)
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
    console.error(`Usage: ${cliName()} doc:parse <file-path>`)
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
      model: model || profiles[0]?.model || 'gpt-5.5'
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
${oemResolved.identity.productName} CLI v${version}
============================

  默认使用桌面真实数据（配置 / 凭据 / 历史）。
  高危操作默认需确认（--mode relaxed）；全自动请显式 --mode free 或 --free。
  不带参数、自己开着终端，进入同一屏：底下输入，上面是这场对话。拖进终端的文件会附上，/skills 可查看并加上技能。
  带上一句话则直接开工，字在当前终端里往下走，说完可以接着说。从别的程序接进来，或 --once，答完即离开。
  不必给整句话加引号。秘书站在你敲命令的那个目录里。

用法:
  ${cliName()}                                        # 不带参数，进入同一屏
  ${cliName()} "用引号包起来的任务说明" [options]   # 带上一句话，直接开工
  ${cliName()} agent:run <task> [options]           # 同上（单词语任务请走这条或 --task）
  ${cliName()} <command> [args]

任务判定（shell 会剥掉引号，CLI 只能看到结果）:
  · 一句话不必加引号，第一个词不是已知命令就交给秘书
  · --task / -t <text> → 显式任务（英文单词语请用这条）
  · 英文单词语未知命令（如 modell）→ 报错提示，不丢给 Agent

常用:
  models                     列出 AI Profiles
  history list|stats
  watch list|history|templates
  knowledge search|list|stats
  knowledge bench            跑召回基线（该想起的想起了吗 / 不该来的有没有来 / 占多少篇幅）
  companion <消息>           以联络身份对话（含任务管理；联络建的任务由 CLI 值班到跑完）
  --help / -h / help
  --version / -v

全局选项:
  --sandbox                  写入 cli-sandbox，并从桌面借用 AI Profiles/凭据
  --share-desktop            开发态改用桌面真实数据（装机命令默认已是）
  --mode <strict|relaxed|free>  执行模式（默认 relaxed）
  --free                     等同 --mode free（危险：跳过确认）
  --once                     说完这一轮就退出（默认在终端里可以接着说）
  --verbose                  多打过程：工具结果、内部日志、会话号
  --task / -t <text>         显式任务文本
  --task-wait <秒>           companion 命令专用：联络为任务等回执的上限（默认 600；0 = 不等）

替我审批（默认关；只对交互式任务生效）:
  ${cliName()} config:set autoApprovalReview true

环境变量:
  SFT_API_URL / SFT_API_KEY / SFT_MODEL
  SFT_DATA_DIR               自定义沙箱目录（测试用）
  SFT_CLI_SANDBOX=1          同 --sandbox
  SFT_CLI_SHARE_DESKTOP=1    同 --share-desktop
  SFT_CLI_NO_BORROW=1        沙箱内不借用桌面 Key/Profiles

内部命令（完整列表，冒号风格仍可用）:
  config:*  ai:*  agent:run  knowledge:*  history:*  host:*  ssh:*
  mcp:*  scheduler:*  watch:*  todo:*  sensor:*  bond:*  im:*  skill:*
  pty:*  fs:*  doc:*  websearch:test

示例:
  ${cliName()} "列出当前目录下的 markdown 文件"
  ${cliName()} --task 备份配置 --mode relaxed
  ${cliName()} --sandbox "装机命令试跑，别动真数据" --free
  ${cliName()} models
  ${cliName()} agent:run "重启本机 nginx" --mode free
  ${cliName()} companion "帮我建个任务：统计 docs 下 markdown 数量" --task-wait 300
`)
}

function printUnknownAsTaskHint(token: string): void {
  console.error(`未知命令: ${token}`)
  console.error('要当作 Agent 任务，请用引号包住完整说明，或显式指定：')
  console.error(`  ${cliName()} "你的任务说明（可含空格）"`)
  console.error(`  ${cliName()} --task "单词语任务也可以"`)
  console.error(`  ${cliName()} agent:run "..."`)
  console.error(`查看命令: ${cliName()} --help`)
}

/**
 * 解析入口：短命令映射、引号任务、--task。
 * @returns null 表示已打印错误并应 exit(1)
 */
function resolveCliInvocation(args: string[]): { command: string; cmdArgs: string[] } | null {
  const { positional, flags } = parseArgs(args)

  const taskFlag = flags.task ?? flags.t
  if (typeof taskFlag === 'string' && taskFlag.trim()) {
    const restFlags: string[] = []
    for (const [k, v] of Object.entries(flags)) {
      if (k === 'task' || k === 't') continue
      if (v === true) restFlags.push(`--${k}`)
      else restFlags.push(`--${k}`, String(v))
    }
    return { command: 'agent:run', cmdArgs: [taskFlag, ...restFlags] }
  }

  if (positional.length === 0) {
    // 仅有全局 flag（如 --sandbox）时仍给 help
    return { command: '__help__', cmdArgs: [] }
  }

  const head = positional[0]

  if (head.includes(':')) {
    const idx = args.indexOf(head)
    return { command: head, cmdArgs: idx >= 0 ? args.slice(idx + 1) : positional.slice(1) }
  }

  if (head === 'models') {
    return { command: 'ai:models', cmdArgs: positional.slice(1) }
  }
  if (head === 'companion') {
    // 从原始 args 截取以保留 flags（--mode 等）
    const idx = args.indexOf(head)
    return { command: 'companion:chat', cmdArgs: idx >= 0 ? args.slice(idx + 1) : positional.slice(1) }
  }
  if (head === 'history') {
    const sub = positional[1]
    if (sub === 'list' || sub === 'stats') {
      return { command: `history:${sub}`, cmdArgs: positional.slice(2) }
    }
    console.error(`Usage: ${cliName()} history list|stats`)
    return null
  }
  if (head === 'watch') {
    const sub = positional[1]
    const map: Record<string, string> = {
      list: 'watch:list',
      history: 'watch:history',
      templates: 'watch:templates',
    }
    if (sub && map[sub]) {
      return { command: map[sub], cmdArgs: positional.slice(2) }
    }
    console.error(`Usage: ${cliName()} watch list|history|templates`)
    return null
  }
  if (head === 'knowledge') {
    const sub = positional[1]
    // 从原始 args 截取以保留 flags（--set / --out / --limit 等）；只按 positional 切会把它们全丢掉
    const tail = (anchor: string, fallbackFrom: number) => {
      const idx = args.indexOf(anchor)
      return idx >= 0 ? args.slice(idx + 1) : positional.slice(fallbackFrom)
    }
    if (sub === 'bench') {
      const third = positional[2]
      if (third === 'gen' || third === 'compare') {
        return { command: `knowledge:bench:${third}`, cmdArgs: tail(third, 3) }
      }
      return { command: 'knowledge:bench', cmdArgs: tail('bench', 2) }
    }
    if (sub === 'bench:gen' || sub === 'bench:compare') {
      return { command: `knowledge:${sub}`, cmdArgs: tail(sub, 2) }
    }
    const map: Record<string, string> = {
      search: 'knowledge:search',
      list: 'knowledge:list',
      stats: 'knowledge:stats',
    }
    if (sub && map[sub]) {
      return { command: map[sub], cmdArgs: tail(sub, 2) }
    }
    console.error(`Usage: ${cliName()} knowledge search|list|stats|bench`)
    return null
  }
  if (head === 'agent') {
    if (positional[1] === 'run') {
      return { command: 'agent:run', cmdArgs: positional.slice(2) }
    }
    console.error(`Usage: ${cliName()} agent run <task>  或  ${cliName()} agent:run <task>`)
    return null
  }

  // 没加引号时 shell 会把一句话拆开。第一个词不是已知命令，就整句交给秘书。
  const task = agentTaskFromWords(positional)
  if (task) {
    const restFlags: string[] = []
    for (const [k, v] of Object.entries(flags)) {
      if (v === true) restFlags.push(`--${k}`)
      else restFlags.push(`--${k}`, String(v))
    }
    return { command: 'agent:run', cmdArgs: [task, ...restFlags] }
  }

  printUnknownAsTaskHint(positional.length === 1 ? head : positional.join(' '))
  return null
}

// ==================== Web Search ====================

async function webSearchTest(args: string[]): Promise<void> {
  const query = args[0]
  if (!query) {
    console.error(`Usage: ${cliName()} websearch:test <query>`)
    process.exit(1)
  }

  const config = new ConfigService()
  const settings = config.get('webSearchSettings')
  console.log('Settings:', JSON.stringify(settings, null, 2))

  if (!settings?.enabled) {
    console.error('Web search is not enabled. Enable it in Settings > AI > Web Search.')
    process.exit(1)
  }

  const apiKey = settings.apiKey
  const providerId = settings.providerId
  console.log(`\nProvider: ${providerId}`)
  console.log(`API Key: ${apiKey ? apiKey.slice(0, 8) + '...' : '(empty)'}`)

  // Raw fetch to see the actual response
  console.log(`\n--- Raw API call for "${query}" ---\n`)

  if (providerId === 'bocha') {
    const resp = await fetch('https://api.bochaai.com/v1/web-search', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, count: 3, summary: true }),
    })
    console.log(`Status: ${resp.status} ${resp.statusText}`)
    const raw = await resp.text()
    console.log(`\nResponse body:\n${raw}`)
  } else {
    console.log('Raw test only supports bocha. Testing through service...')
  }

  // Also test through our service layer
  console.log('\n--- Test through WebSearchService ---\n')
  try {
    const webSearch = require('../services/web-search/index')
    await webSearch.initWebSearch(settings)
    const results = await webSearch.search(query, { maxResults: 3 })
    console.log(`Results: ${results.length}`)
    if (results.length > 0) {
      printJSON(results)
    } else {
      console.log('No results returned from service.')
    }
  } catch (e: any) {
    console.error('Service error:', e.message)
  }
}

// ==================== Main ====================

/** 嵌入模型走进程内推理，退出前放掉，避免 process.exit 时被硬杀掉。 */
async function disposeCliKnowledge(): Promise<void> {
  try {
    const { getKnowledgeService } = require('../services/knowledge')
    const ks = getKnowledgeService()
    if (ks) await ks.disposeAsync(1000)
  } catch { /* 没加载过就不用放 */ }
}

async function runCli(): Promise<void> {
  const config = new ConfigService()
  initLogging(config.getLogLevel())

  const args = process.argv.slice(2)
  const launch = cliLaunch(args, Boolean(process.stdin.isTTY && process.stdout.isTTY))
  if (launch === 'version') {
    console.log(getVersion())
    return
  }
  if (launch === 'help') {
    printHelp()
    return
  }
  if (launch === 'screen') {
    try {
      await agentRun(args, 'screen')
    } finally {
      await disposeCliKnowledge()
    }
    return
  }

  const resolved = resolveCliInvocation(args)
  if (!resolved) {
    process.exit(1)
  }
  if (resolved.command === '__help__') {
    printHelp()
    return
  }

  const { command, cmdArgs } = resolved

  let exitCode = 0
  try {
    switch (command) {
      case 'config:get':     await configGet(cmdArgs); break
      case 'config:set':     await configSet(cmdArgs); break
      case 'config:list':    await configList(); break
      case 'config:init':    await configInit(); break

      case 'ai:chat':        await aiChat(cmdArgs); break
      case 'ai:stream':      await aiStream(cmdArgs); break
      case 'ai:models':      await aiModels(); break

      case 'agent:run':      await agentRun(cmdArgs); break
      case 'companion:chat': await companionChat(cmdArgs); break

      case 'knowledge:search':  await knowledgeSearch(cmdArgs); break
      case 'knowledge:list':    await knowledgeList(); break
      case 'knowledge:folder:create': await knowledgeFolderCreate(cmdArgs); break
      case 'knowledge:folder:list': await knowledgeFolderList(); break
      case 'knowledge:catalog': await knowledgeCatalog(cmdArgs); break
      case 'knowledge:folder:rename': await knowledgeFolderRename(cmdArgs); break
      case 'knowledge:folder:delete': await knowledgeFolderDelete(cmdArgs); break
      case 'knowledge:context': await knowledgeContext(cmdArgs); break
      case 'knowledge:card': await knowledgeCard(cmdArgs); break
      case 'knowledge:remove': await knowledgeRemove(cmdArgs); break
      case 'knowledge:card:quota': await knowledgeCardQuota(cmdArgs); break
      case 'knowledge:add':     await knowledgeAdd(cmdArgs); break
      case 'knowledge:stats':   await knowledgeStats(); break
      case 'knowledge:rebuild': await knowledgeRebuild(cmdArgs); break
      case 'knowledge:repair':  await knowledgeRepair(cmdArgs); break
      case 'knowledge:bench':   await knowledgeBench(cmdArgs); break
      case 'knowledge:bench:gen': await knowledgeBenchGen(cmdArgs); break
      case 'knowledge:bench:compare': await knowledgeBenchCompare(cmdArgs); break

      case 'history:list':   await historyList(cmdArgs); break
      case 'history:stats':  await historyStats(); break

      case 'host:list':      await hostList(); break
      case 'host:get':       await hostGet(cmdArgs); break

      case 'ssh:list':       await sshList(); break

      case 'mcp:list':       await mcpList(); break
      case 'mcp:tools':      await mcpTools(); break

      case 'scheduler:list':    await schedulerList(); break
      case 'scheduler:history': await schedulerHistory(cmdArgs); break

      case 'watch:list':        await watchList(); break
      case 'watch:create':      await watchCreate(cmdArgs); break
      case 'watch:trigger':     await watchTrigger(cmdArgs); break
      case 'watch:delete':      await watchDelete(cmdArgs); break
      case 'watch:history':     await watchHistory(cmdArgs); break
      case 'watch:templates':   await watchTemplates(); break
      case 'watch:from-template': await watchFromTemplate(cmdArgs); break
      case 'todo:list':          await todoList(cmdArgs); break
      case 'todo:create':        await todoCreate(cmdArgs); break
      case 'todo:delete':        await todoDelete(cmdArgs); break
      case 'sensor:status':     await sensorStatus(); break
      case 'sensor:heartbeat':  await sensorHeartbeat(); break
      case 'bond:status':       await bondStatus(); break

      case 'im:status':      await imStatus(); break
      case 'im:connect':     await imConnect(cmdArgs); break
      case 'im:disconnect':  await imDisconnect(cmdArgs); break

      case 'skill:list':      await skillList(); break
      case 'skill:market':    await skillMarket(cmdArgs); break
      case 'skill:install':   await skillInstall(cmdArgs); break
      case 'skill:uninstall': await skillUninstall(cmdArgs); break
      case 'skill:registry':  await skillRegistry(cmdArgs); break

      case 'pty:exec':       await ptyExec(cmdArgs); break
      case 'pty:shells':     await ptyShells(); break

      case 'fs:list':        await localFsList(cmdArgs); break
      case 'fs:info':        await localFsInfo(); break

      case 'doc:parse':      await docParse(cmdArgs); break
      case 'doc:types':      await docTypes(); break

      case 'websearch:test': await webSearchTest(cmdArgs); break

      default:
        printUnknownAsTaskHint(command)
        process.exit(1)
    }
  } catch (error: any) {
    console.error(`Error: ${error.message || error}`)
    if (process.env.SFT_DEBUG) {
      console.error(error.stack)
    }
    exitCode = 1
  } finally {
    await disposeCliKnowledge()
  }
  if (exitCode !== 0) process.exit(exitCode)
}

export { runCli }
