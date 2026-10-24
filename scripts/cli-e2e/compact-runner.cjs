/* eslint-env node */
/**
 * 在真进程里按脚本依次「说话 / 人点名压缩」，并且能指定模型的窗口大小。
 *
 * 命令行没有指定窗口大小和「人点名压缩」的入口，这里和命令行一样先套上 Electron 垫片、
 * 加载 TypeScript、进数据目录，再直接用后端服务（与桌面走同一条路）。
 *
 * 环境变量：
 *   SFT_DATA_DIR、SFT_API_URL/KEY/MODEL    指向假模型
 *   REAL_PROFILE_ID                        REAL_MODEL=1 时指定用桌面哪个配置（不给就用沙箱里的当前配置）
 *   REAL_MODEL=1                           不换成假模型，用沙箱借来的桌面真实配置（不要同时设 SFT_CLI_NO_BORROW）
 *   CONTEXT_LENGTH、MAX_OUTPUT_TOKENS      模型配置里的窗口与单次输出上限（可不给）
 *   STEPS                                  JSON 数组：{ say: "话" } 或 { compact: true, hint?: "补充" }
 * 每一步结束输出 `STEP_DONE <序号>`；压缩另输出 `COMPACT_RESULT <json>`；全部完成输出 `RUNNER_DONE`。
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
  const steps = JSON.parse(process.env.STEPS || '[]')
  if (!Array.isArray(steps) || steps.length === 0) throw new Error('需要 STEPS')

  const config = new ConfigService()
  setConfigServiceInstance(config)
  const profiles = config.getAiProfiles()
  if (process.env.REAL_MODEL !== '1') {
  const envProfile = {
    id: 'env-override',
    name: 'CLI Environment',
    apiUrl: process.env.SFT_API_URL,
    apiKey: process.env.SFT_API_KEY || 'sk-test',
    model: process.env.SFT_MODEL || 'mock',
  }
  if (process.env.CONTEXT_LENGTH) envProfile.contextLength = Number(process.env.CONTEXT_LENGTH)
  if (process.env.MAX_OUTPUT_TOKENS) envProfile.maxOutputTokens = Number(process.env.MAX_OUTPUT_TOKENS)
  const at = profiles.findIndex((p) => p.id === 'env-override')
  if (at >= 0) profiles[at] = envProfile
  else profiles.unshift(envProfile)
  config.setAiProfiles(profiles)
  config.setActiveAiProfile('env-override')
  }

  if (process.env.REAL_PROFILE_ID) config.setActiveAiProfile(process.env.REAL_PROFILE_ID)
  if (process.env.REAL_MODEL === '1' && (process.env.CONTEXT_LENGTH || process.env.MAX_OUTPUT_TOKENS)) {
    // 真实模型也能收紧窗口 / 单次输出（沙箱里的配置副本，不动桌面的）
    const activeId = config.getActiveAiProfile()
    config.setAiProfiles(config.getAiProfiles().map((p) => (p.id !== activeId ? p : {
      ...p,
      ...(process.env.CONTEXT_LENGTH ? { contextLength: Number(process.env.CONTEXT_LENGTH) } : {}),
      ...(process.env.MAX_OUTPUT_TOKENS ? { maxOutputTokens: Number(process.env.MAX_OUTPUT_TOKENS) } : {}),
    })))
  }

  const ai = new AiService(config)
  const history = new HistoryService()
  const pty = new PtyService()
  const agent = new AgentService(ai, pty, new HostProfileService(), new McpService(), config, new SshService())
  agent.setHistoryService(history)

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
    sessionStartTime: Date.now(),
  }

  for (const [index, step] of steps.entries()) {
    if (step.compact) {
      const result = await agent.compactContext({
        agentKey: ptyId,
        terminalType: 'local',
        hint: step.hint,
      })
      console.log(`COMPACT_RESULT ${JSON.stringify(result)}`)
    } else {
      await agent.say(ptyId, step.say, context, {
        surface: 'terminal',
        config: { executionMode: 'free' },
        callbacks: {
          // 真实模型时要看它最后答了什么
          onStep: (_runId, st) => {
            if (st && st.type === 'final_result') console.log(`FINAL ${JSON.stringify(st.content)}`)
          },
        },
      })
    }
    console.log(`STEP_DONE ${index}`)
  }
  console.log('RUNNER_DONE')
}

main().then(() => process.exit(0)).catch((error) => {
  console.error('RUNNER_FAILED', error && error.stack ? error.stack : error)
  process.exit(1)
})
