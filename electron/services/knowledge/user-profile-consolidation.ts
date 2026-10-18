/**
 * 把旧用户画像并入记忆「用户」这件事接到真实的文件与模型上。
 * 整合本身的规则在 user-profile-consolidator.ts。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { createLogger } from '../../utils/logger'
import { getWorkspacePath } from '../agent/workspace-paths'
import { getContextKnowledgeService } from './context-knowledge'
import { UserProfileConsolidator } from './user-profile-consolidator'

const log = createLogger('UserProfileConsolidation')

const LEGACY_FILE = 'USER.md'
const ARCHIVED_FILE = 'USER.md.merged'
/** 启动后等一阵再动手：这是后台整理，不和首屏、后端服务抢资源 */
const START_DELAY_MS = 45_000

interface ChatClient {
  chat(
    messages: Array<{ role: 'user'; content: string }>,
    maxOutputTokens: number,
  ): Promise<{ text: string; complete: boolean }>
  getOutputLimit(): number
}

export function createUserProfileConsolidator(ai: ChatClient): UserProfileConsolidator {
  const legacyPath = () => path.join(getWorkspacePath(), LEGACY_FILE)
  const backupDir = () => path.join(app.getPath('userData'), 'knowledge', 'context-docs-backup')
  return new UserProfileConsolidator({
    readLegacyProfile: () => {
      try {
        return fs.readFileSync(legacyPath(), 'utf-8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') log.warn('读取旧用户画像失败:', err)
        return ''
      }
    },
    archiveLegacyProfile: () => {
      fs.renameSync(legacyPath(), path.join(getWorkspacePath(), ARCHIVED_FILE))
    },
    saveBackup: (name, content) => {
      fs.mkdirSync(backupDir(), { recursive: true })
      // 上次整合在写入之后、收起旧文件之前被打断时，会带着已整合的结果再来一遍；
      // 此时同名留底里是更早的原文，不能覆盖，内容不同就另起一个名字
      for (let n = 1; ; n++) {
        const file = path.join(backupDir(), `${name}.before-user-merge${n === 1 ? '' : `.${n}`}`)
        if (!fs.existsSync(file)) {
          fs.writeFileSync(file, content, 'utf-8')
          return
        }
        if (fs.readFileSync(file, 'utf-8') === content) return
      }
    },
    memory: getContextKnowledgeService(),
    chat: (messages, maxOutputTokens) => ai.chat(messages, maxOutputTokens),
    getOutputLimit: () => ai.getOutputLimit(),
  })
}

/** 旧画像还在才会动手；失败不重试，留到下次启动 */
export function scheduleUserProfileConsolidation(ai: ChatClient): void {
  const timer = setTimeout(() => {
    createUserProfileConsolidator(ai).run().catch(err => {
      log.warn('旧用户画像整合出错:', err)
    })
  }, START_DELAY_MS)
  timer.unref?.()
}
