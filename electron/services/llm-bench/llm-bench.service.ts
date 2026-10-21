import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import * as fs from 'fs'
import { createLogger } from '../../utils/logger'
import { getLocale } from '../../i18n/main-i18n'
import type { AiService } from '../ai.service'
import type { ConfigService } from '../config.service'
import { LlmBenchRunner } from './runner'
import { BENCH_OUTPUT_PASSAGE } from './suite'
import {
  BENCH_DEFAULT_SHOTS,
  BENCH_SHOT_CHOICES,
  BENCH_SUITE_VERSION,
  BENCH_TEMPERATURE,
  DEFAULT_BENCH_RUNGS,
  type BenchProgress,
  type BenchReport,
  type StartBenchInput,
} from './types'

const log = createLogger('LlmBench')

function sanitizeFilePart(name: string): string {
  return name.replace(/[/\\:*?"<>|]/g, '-').slice(0, 80) || 'model'
}

const IPC_CHANNELS = [
  'llmBench:listProfiles',
  'llmBench:getActiveProfileId',
  'llmBench:getLocale',
  'llmBench:getSuiteInfo',
  'llmBench:start',
  'llmBench:stop',
  'llmBench:isRunning',
  'llmBench:getReport',
  'llmBench:saveReport',
  'llmBench:writeClipboard',
] as const

export class LlmBenchService {
  private window: BrowserWindow | null = null
  private runner: LlmBenchRunner | null = null
  private latest: BenchReport | null = null

  constructor() {
    this.setupIpc()
  }

  setDependencies(deps: { ai: AiService; config: ConfigService }): void {
    this.runner = new LlmBenchRunner({
      ai: deps.ai,
      listProfiles: () => deps.config.getAiProfiles(),
      getActiveProfileId: () => deps.config.getActiveAiProfile(),
    })
    this.runner.onProgress((progress) => {
      this.latest = progress.report
      this.broadcast(progress)
    })
  }

  setWindow(window: BrowserWindow | null): void {
    this.window = window
    if (window) {
      window.on('closed', () => {
        if (this.window === window) {
          this.stopIfRunning()
          this.window = null
        }
      })
    }
  }

  private stopIfRunning(): void {
    this.runner?.stop()
  }

  private broadcast(progress: BenchProgress): void {
    if (this.window && !this.window.isDestroyed()) {
      this.window.webContents.send('llmBench:progress', progress)
    }
  }

  private setupIpc(): void {
    for (const channel of IPC_CHANNELS) {
      try { ipcMain.removeHandler(channel) } catch { /* ignore */ }
    }

    ipcMain.handle('llmBench:listProfiles', () => this.runner?.listProfiles() ?? [])
    ipcMain.handle('llmBench:getActiveProfileId', () => this.runner?.getActiveProfileId() ?? '')
    ipcMain.handle('llmBench:getLocale', () => getLocale())
    // 题里冻住的那几样（版本、长度档、可选发数）由这里给，压测窗不另抄一份
    ipcMain.handle('llmBench:getSuiteInfo', () => ({
      suiteVersion: BENCH_SUITE_VERSION,
      rungs: [...DEFAULT_BENCH_RUNGS],
      shotChoices: [...BENCH_SHOT_CHOICES],
      defaultShots: BENCH_DEFAULT_SHOTS,
    }))
    ipcMain.handle('llmBench:isRunning', () => this.runner?.isRunning() ?? false)
    ipcMain.handle('llmBench:getReport', () => this.latest)

    ipcMain.handle('llmBench:start', async (_event, input: StartBenchInput) => {
      if (!this.runner) return { ok: false, error: 'not_ready' }
      const startError = this.runner.peekStartError(input)
      if (startError) return { ok: false, error: startError }
      void this.runner.start(input).catch((err) => {
        log.error('bench run failed:', err)
        const report: BenchReport = {
          suiteVersion: BENCH_SUITE_VERSION,
          startedAt: Date.now(),
          finishedAt: Date.now(),
          profile: { id: input.profileId, name: input.profileId, model: '', apiUrl: '' },
          contextLength: 0,
          inputLimit: 0,
          temperature: BENCH_TEMPERATURE,
          passageChars: BENCH_OUTPUT_PASSAGE.length,
          shotsPerRung: 0,
          standardLadder: false,
          rungs: [{
            targetChars: 0,
            actualChars: 0,
            estimatedTokens: 0,
            status: 'error',
            success: false,
            rateLimited: false,
            truncated: false,
            error: err instanceof Error ? err.message : String(err),
          }],
        }
        this.latest = report
        this.broadcast({ report })
      })
      return { ok: true }
    })

    ipcMain.handle('llmBench:stop', () => {
      this.stopIfRunning()
      return true
    })

    ipcMain.handle('llmBench:writeClipboard', async (_event, text: string) => {
      await clipboard.writeText(text)
      return true
    })

    ipcMain.handle('llmBench:saveReport', async () => {
      if (!this.latest) return { saved: false }
      const opts = {
        defaultPath: `sailfish-bench-${sanitizeFilePart(this.latest.profile.model)}-${this.latest.startedAt}.json`,
        filters: [{ name: 'JSON', extensions: ['json'] }],
      }
      const win = this.window && !this.window.isDestroyed() ? this.window : null
      const result = win
        ? await dialog.showSaveDialog(win, opts)
        : await dialog.showSaveDialog(opts)
      if (result.canceled || !result.filePath) return { saved: false }
      fs.writeFileSync(result.filePath, JSON.stringify(this.latest, null, 2), 'utf-8')
      return { saved: true, filePath: result.filePath }
    })
  }
}

let instance: LlmBenchService | null = null

export function getLlmBenchService(): LlmBenchService {
  if (!instance) instance = new LlmBenchService()
  return instance
}
