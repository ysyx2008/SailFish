/* eslint-env node */
/**
 * 在真进程里接着一场老会话说一句话。
 *
 * 命令行没有「接着某场会话」的入口，这里和命令行一样先套上 Electron 垫片、加载 TypeScript、
 * 进数据目录，再直接用后端服务：和桌面里重开历史会话继续说话走同一条路（带上原会话号）。
 *
 * 环境变量：SFT_DATA_DIR、SFT_API_URL/KEY/MODEL（指向假模型）、RESUME_SESSION、RESUME_LINE
 * 说完这一轮、伙计都停下后输出 `RESUME_DONE` 并退出。
 */
'use strict'

const Module = require('module')
const path = require('path')

const ROOT = path.resolve(__dirname, '../..')
const shim = path.join(ROOT, 'electron/cli/electron-shim.js')
const origResolve = Module._resolveFilename
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-updater') return shim
  return origResolve.call(this, request, ...rest)
}
process.env.SFT_CLI_MODE = '1'
require('tsx/cjs')
require(path.join(ROOT, 'electron/cli/cli-data.js')).setupCliDataDir({ defaultSandbox: true })

const { ConfigService, setConfigServiceInstance } = require(path.join(ROOT, 'electron/services/config.service'))
const { AiService } = require(path.join(ROOT, 'electron/services/ai.service'))
const { HistoryService } = require(path.join(ROOT, 'electron/services/history.service'))
const { HostProfileService } = require(path.join(ROOT, 'electron/services/host-profile.service'))
const { PtyService } = require(path.join(ROOT, 'electron/services/pty.service'))
const { McpService } = require(path.join(ROOT, 'electron/services/mcp.service'))
const { SshService } = require(path.join(ROOT, 'electron/services/ssh.service'))
const { AgentService } = require(path.join(ROOT, 'electron/services/agent'))

async function main() {
  const sessionId = process.env.RESUME_SESSION
  const line = process.env.RESUME_LINE
  if (!sessionId || !line) throw new Error('需要 RESUME_SESSION 和 RESUME_LINE')

  const config = new ConfigService()
  setConfigServiceInstance(config)
  const profiles = config.getAiProfiles()
  const envProfile = {
    id: 'env-override',
    name: 'CLI Environment',
    apiUrl: process.env.SFT_API_URL,
    apiKey: process.env.SFT_API_KEY || 'sk-test',
    model: process.env.SFT_MODEL || 'mock',
  }
  const at = profiles.findIndex((p) => p.id === 'env-override')
  if (at >= 0) profiles[at] = envProfile
  else profiles.unshift(envProfile)
  config.setAiProfiles(profiles)
  config.setActiveAiProfile('env-override')

  const ai = new AiService(config)
  const history = new HistoryService()
  const pty = new PtyService()
  const agent = new AgentService(ai, pty, new HostProfileService(), new McpService(), config, new SshService())
  agent.setHistoryService(history)

  const record = history.getAgentRecordStore().getAgentRecordById(sessionId)
  if (!record) throw new Error(`找不到会话 ${sessionId}`)

  const cwd = process.cwd()
  const ptyId = pty.create({ cwd }).id
  const { initTerminalStateService } = require(path.join(ROOT, 'electron/services/terminal-state.service'))
  initTerminalStateService(pty).initTerminal(ptyId, 'local', cwd)

  const context = {
    ptyId,
    cwd,
    terminalOutput: [],
    systemInfo: { os: process.platform === 'darwin' ? 'macos' : process.platform, shell: process.env.SHELL || '/bin/zsh' },
    terminalType: 'local',
    unattended: true,
    sessionId,
    sessionStartTime: record.timestamp,
  }
  await agent.say(ptyId, line, context, {
    surface: 'terminal',
    config: { executionMode: 'free' },
    callbacks: {},
  })
  console.log('RESUME_DONE')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('RESUME_FAILED', error && error.stack ? error.stack : error)
  process.exit(1)
})
