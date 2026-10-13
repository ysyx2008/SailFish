/**
 * Deferred：v11 挂起后，在联络（__companion__）上征询并完成 CONTACTS.md → CONTACTS.json。
 *
 * 不在代码里解析 Markdown。模型读原文，用 contact_add / contact_update 写入。
 * 待办迁移还没收尾时本轮先让路，下次启动再问。
 */
import * as fs from 'fs'
import * as path from 'path'
import { app, BrowserWindow, Notification } from 'electron'
import { createLogger } from '../../../../utils/logger'
import { serializeAgentStepForIpc } from '../../../../utils/agent-step-ipc'
import type { AgentService } from '../../index'
import type { AgentCallbacks, AgentContext, AgentStep } from '../../types'
import { getLocalOS, getDefaultShell } from '../../../../utils/platform'
import { addProactiveContext } from '../../proactive-store'
import { getIMService } from '../../../im/im.service'
import { isTodoMdMigrationPending } from '../todo/migration-marker'
import {
  CONTACTS_FILENAME,
  getContactMigrationMarkerPath,
  getWorkspaceDir,
  hasValidContactsJson,
  isContactsMdMigrationPending,
  LEGACY_CONTACTS_MD,
  readContactMigrationMarker,
  writeContactMigrationMarker,
  type ContactMigrationMarker,
} from './migration-marker'

const log = createLogger('ContactsMdAgentMigrate')

const COMPANION_ID = '__companion__'
const CONSENT_USER_TASK = '[系统] 联系人数据迁移征询'
const CONSENT_FALLBACK_NOTICE =
  '发现工作区还有旧版联系人笔记（CONTACTS.md）。要不要现在整理成可以按名字查找的联系人？回复「迁」或「以后再说」即可。'

function buildMigrationSop(workspace: string, markerPath: string): string {
  return `【联系人迁移 SOP — 内部指令，勿整段念给用户听】

背景：升级后要把工作区旧版 Markdown 联系人迁到结构化本地联系人（contact 技能 / CONTACTS.json）。程序不会替你解析 Markdown。
工作区：${workspace}
迁移标记文件：${markerPath}
（位于工作区 migrations/ 免确认目录；状态字段 status：pending | deferred | skipped | done | failed）

## 本轮（启动征询）— 严格
1. **唯一动作**：必须调用 **talk_to_user** 工具（不是普通文字收工）。message 用秘书口吻说明发现旧版 CONTACTS.md、想整理成可按名字查找的联系人，并询问要不要现在迁。
2. 禁止用不带 tool_calls 的纯文本回复结束本轮——那样桌面 toast / IM 都不会发出。
3. 本轮 **禁止** 任何其它工具：不要 write_text_file / write_file / contact_add / read_file / exec / skill。talk_to_user 发出后立刻结束。

## 用户之后在联络里回复时（同一会话上下文续跑）
- **同意迁**：若 contact_* 不可用先 skill 加载 contact；read_file 读 CONTACTS.md（没有则 CONTACTS.md.bak）；用 contact_add 逐条写入。姓名或别名重合时工具会拒绝新建，改用 contact_update 把备注和渠道合并进已有的那条。只填原文里明确写出的邮箱、电话、单位、角色，不要编造。人写成 kind=person，公司/机构写成 kind=org。简称放 aliases。关系与近况放 note，不要拆成往来记录。全部成功后用 write_text_file 把迁移标记写成 status=done（保留 createdAt，补 completedAt；路径见上，免确认）；用日常回复告诉用户迁了几人即可，**不要再 talk_to_user**。
- **以后再说**：write_text_file 将标记写成 status=deferred（下次启动会再提醒）；简短确认即可。
- **明确不用迁了**：write_text_file 写成 status=skipped；简短确认即可。
- **禁止**：exec / shell / 重命名或删除 CONTACTS.md（备份由程序处理）；禁止直接改 CONTACTS.json。`
}

async function deliverConsentNotice(message: string, title = '联系人迁移'): Promise<void> {
  const trimmed = message.trim()
  if (!trimmed) return

  try {
    const im = getIMService()
    const result = await im.sendNotification(trimmed, { markdown: !!title, title })
    if (result.success) {
      log.info(`Consent notice delivered via IM (${result.platform})`)
    } else if (result.error) {
      log.warn('Consent notice IM delivery failed:', result.error)
    }
  } catch (e) {
    log.debug('Consent notice IM unavailable:', e)
  }

  let windowFocused = false
  try {
    const win = BrowserWindow.getAllWindows()[0]
    if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
      win.webContents.send('watch:proactive-message', {
        agentId: COMPANION_ID,
        message: trimmed,
        watchName: title,
      })
      windowFocused = win.isFocused()
    }
  } catch (e) {
    log.debug('Consent notice app delivery failed:', e)
  }

  if (!windowFocused && Notification.isSupported()) {
    try {
      const notification = new Notification({
        title,
        body: trimmed.length > 200 ? `${trimmed.substring(0, 200)}...` : trimmed,
      })
      notification.on('click', () => {
        const win = BrowserWindow.getAllWindows()[0]
        if (!win || win.isDestroyed()) return
        win.show()
        win.focus()
        win.webContents.send('watch:activate-message', { agentId: COMPANION_ID })
      })
      notification.show()
    } catch (e) {
      log.debug('Consent notice system notification failed:', e)
    }
  }

  addProactiveContext(COMPANION_ID, trimmed, title)
}

function createCompanionDesktopCallbacks(
  agentId: string,
  state: { talkedToUser: boolean },
): AgentCallbacks {
  const send = (channel: string, payload: Record<string, unknown>) => {
    const win = BrowserWindow.getAllWindows()[0]
    if (!win || win.isDestroyed() || win.webContents.isDestroyed()) return
    win.webContents.send(channel, payload)
  }

  const noteTalkToUser = (step: AgentStep) => {
    if (step.type === 'tool_call' && step.toolName === 'talk_to_user') {
      state.talkedToUser = true
    }
  }

  return {
    onStart: (_runId, userTask) => {
      send('agent:running', { agentId, userTask })
    },
    onStep: (_runId, step) => {
      noteTalkToUser(step)
      const serialized = serializeAgentStepForIpc(step)
      if (!serialized) return
      send('agent:step', { agentId, step: serialized })
    },
    onStepRemoved: (_runId, stepId) => {
      send('agent:stepRemoved', { agentId, stepId })
    },
    onNeedConfirm: (confirmation) => {
      send('agent:needConfirm', {
        agentId,
        toolCallId: confirmation.toolCallId,
        toolName: confirmation.toolName,
        toolArgs: JSON.parse(JSON.stringify(confirmation.toolArgs)),
        riskLevel: confirmation.riskLevel,
        displayName: confirmation.displayName,
        reasons: confirmation.reasons,
        trustCommandOffer: confirmation.trustCommandOffer,
      })
    },
    onNeedSecureInput: (request) => {
      send('agent:needSecureInput', {
        agentId,
        requestId: request.requestId,
        skillId: request.skillId,
        envName: request.envName,
        prompt: request.prompt,
        isUpdate: request.isUpdate,
      })
    },
    onComplete: (_runId, result, pendingUserMessages) => {
      send('agent:complete', { agentId, result, pendingUserMessages })
    },
    onError: (_runId, error) => {
      send('agent:error', { agentId, error })
    },
  }
}

/** 升级后旧笔记可能又被改过；和升级时的备份不一样就另存一份，不删内容。 */
function retireLegacyContactsMd(mdPath: string, bakPath: string): void {
  if (!fs.existsSync(mdPath)) return
  try {
    if (!fs.existsSync(bakPath)) {
      fs.renameSync(mdPath, bakPath)
      log.info('Retired CONTACTS.md → CONTACTS.md.bak')
      return
    }
    if (fs.readFileSync(mdPath).equals(fs.readFileSync(bakPath))) {
      fs.unlinkSync(mdPath)
      log.info('Removed leftover CONTACTS.md (identical to bak)')
      return
    }
    const stamped = `${bakPath}.${Date.now()}`
    fs.renameSync(mdPath, stamped)
    log.info('Retired edited CONTACTS.md → %s', path.basename(stamped))
  } catch (e) {
    log.warn('Failed to retire CONTACTS.md:', e)
  }
}

/**
 * 只认迁移标记：征询期间秘书可能先记下零星新人，通讯录非空不代表旧笔记已迁完。
 */
function finalizeIfMigrated(workspace: string, marker: ContactMigrationMarker | null): boolean {
  if (marker?.status !== 'done') return false
  const jsonPath = path.join(workspace, CONTACTS_FILENAME)
  if (!hasValidContactsJson(jsonPath)) return false
  retireLegacyContactsMd(
    path.join(workspace, LEGACY_CONTACTS_MD),
    path.join(workspace, `${LEGACY_CONTACTS_MD}.bak`),
  )
  return true
}

export async function runContactsMdAgentMigrationIfNeeded(agentService: AgentService): Promise<void> {
  const userDataPath = app.getPath('userData')
  const workspace = getWorkspaceDir(userDataPath)
  const markerPath = getContactMigrationMarkerPath(userDataPath)
  const marker = readContactMigrationMarker(markerPath)
  const mdPath = path.join(workspace, LEGACY_CONTACTS_MD)
  const bakPath = path.join(workspace, `${LEGACY_CONTACTS_MD}.bak`)

  if (finalizeIfMigrated(workspace, marker)) return
  if (!isContactsMdMigrationPending(userDataPath)) return

  if (isTodoMdMigrationPending(userDataPath)) {
    log.info('Deferring contacts migration until TODO.md migration settles')
    return
  }

  if (!fs.existsSync(mdPath) && !fs.existsSync(bakPath)) {
    writeContactMigrationMarker(markerPath, {
      version: 1,
      status: 'skipped',
      createdAt: marker?.createdAt ?? Date.now(),
      completedAt: Date.now(),
      note: 'CONTACTS.md and bak missing',
    })
    return
  }

  try {
    if (agentService.isRunning(COMPANION_ID)) {
      log.warn('Aborting busy companion before contacts migration consent')
      agentService.abort(COMPANION_ID)
    }
  } catch (e) {
    log.warn('Failed to abort companion before contacts consent:', e)
  }

  try {
    await agentService.preloadSkills(COMPANION_ID, ['contact'])
  } catch (e) {
    log.warn('preload contact skill failed:', e)
  }

  const context: AgentContext = {
    terminalOutput: [],
    systemInfo: { os: getLocalOS(), shell: getDefaultShell() },
    terminalType: 'assistant',
    cwd: workspace,
    contextHint: buildMigrationSop(workspace, markerPath),
  }

  const talkState = { talkedToUser: false }
  try {
    log.info('Offering CONTACTS.md migration consent via companion')
    const finalText = await agentService.runAssistant(
      COMPANION_ID,
      CONSENT_USER_TASK,
      context,
      {
        enabled: true,
        commandTimeout: 30000,
        autoExecuteSafe: true,
        autoExecuteModerate: true,
        executionMode: 'relaxed',
        debugMode: false,
      },
      undefined,
      createCompanionDesktopCallbacks(COMPANION_ID, talkState),
    )
    if (!talkState.talkedToUser) {
      const notice =
        typeof finalText === 'string' && finalText.trim()
          ? finalText.trim()
          : CONSENT_FALLBACK_NOTICE
      log.warn('Contacts consent run finished without talk_to_user; delivering toast/IM fallback')
      await deliverConsentNotice(notice)
    }
  } catch (e) {
    log.warn('CONTACTS.md migration consent run skipped/failed (will retry next launch):', e)
  }
}
