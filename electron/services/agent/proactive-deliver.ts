/**
 * 主动消息投递管道
 *
 * 从 talk_to_user 提取的投递核心：IM 触达（如有最近联系人）→ 桌面联络线 IPC →
 * 窗口无焦点时系统通知 → 持久化到联络历史（proactive_notice，重启后可恢复）。
 * talk_to_user（Agent 主动找人）与任务事件回流（TaskSupervisor）共用此管道，
 * 「联络线」是唯一的人机汇合点。
 *
 * 本模块只管"送达"，不管"联络是否知情"——暂存上下文（proactive-store）由调用方
 * 按语义自行决定写入内容与时机。
 */
import { COMPANION_AGENT_KEY } from '@shared/types'
import { createLogger } from '../../utils/logger'
import { getIMService } from '../im/im.service'
import type { HistoryService } from '../history.service'

const log = createLogger('ProactiveDeliver')

const COMPANION_AGENT_ID = COMPANION_AGENT_KEY

export interface ProactiveDeliveryResult {
  deliveredVia: string[]
  failedChannels: { platform: string; error: string }[]
  /** IM 整体投递失败且无法按平台细分时的原始错误（供调用方反馈） */
  imError?: string
}

/**
 * 投递一条主动消息到联络线（桌面 + IM + 系统通知），送达后持久化到联络历史。
 * 所有渠道均为 best-effort，不抛异常；全失败仅体现在返回值 deliveredVia 为空。
 *
 * `fromCompanion`：调用方是联络自己（companion 主动调 talk_to_user）时置 true——
 * 消息已以工具卡片形式落在联络会话里（IM 来源的运行也会实时镜像进联络 tab），
 * 应用内再注入一条 proactive 步骤、历史里再存一份 proactive 记录都是回声重复。
 * 因此应用内投递降级为 mirrorOnly（前端只 toast 提醒、不注入步骤），
 * 并跳过历史另存；IM 触达与系统通知不受影响。
 */
export async function deliverProactiveMessage(
  message: string,
  opts?: { title?: string; historyService?: HistoryService; fromCompanion?: boolean; alwaysPersist?: boolean }
): Promise<ProactiveDeliveryResult> {
  const title = opts?.title
  const fromCompanion = opts?.fromCompanion === true
  const alwaysPersist = opts?.alwaysPersist === true
  const deliveredVia: string[] = []
  const failedChannels: { platform: string; error: string }[] = []
  let imError: string | undefined

  // IM 渠道：有最近联系人才尝试
  try {
    const imService = getIMService()
    const lastContact = imService.getLastContact()

    if (lastContact) {
      const result = await imService.sendNotification(message, {
        markdown: !!title,
        title,
      })
      if (result.failedPlatforms?.length) {
        failedChannels.push(...result.failedPlatforms)
      }
      if (result.success) {
        deliveredVia.push(result.platform || 'IM')
      } else if (result.error) {
        imError = result.failedPlatforms?.length
          ? result.failedPlatforms.map(f => `${f.platform}: ${f.error}`).join('; ')
          : result.error
      }
    }
  } catch (e) {
    log.debug('deliverProactiveMessage: IM delivery unavailable:', e)
  }

  // 应用内：联络线待展示消息（不创建标签页，用户点击通知后才展开）。
  // 联络自己发的消息带 mirrorOnly 标记：内容已在其会话工具卡片里，前端只 toast
  // 提醒、不再注入步骤——否则 Agent 忙时排队的消息会在运行结束后再冒一次（回声）。
  let windowFocused = false
  try {
    const electron = require('electron')
    const windows = electron.BrowserWindow?.getAllWindows?.()
    if (windows?.length > 0) {
      const mainWindow = windows[0]
      if (!mainWindow.isDestroyed()) {
        mainWindow.webContents.send('watch:proactive-message', {
          agentId: COMPANION_AGENT_ID,
          message,
          watchName: title || '',
          ...(fromCompanion ? { mirrorOnly: true } : {})
        })
        deliveredVia.push('app')
        windowFocused = mainWindow.isFocused()
      }
    }
  } catch (e) {
    log.debug('deliverProactiveMessage: app delivery failed:', e)
  }

  // 窗口不存在或没有焦点时，发系统通知；点击通知时激活应用并展开对话
  if (!windowFocused) {
    try {
      const electron = require('electron')
      const { Notification } = electron
      if (Notification?.isSupported?.()) {
        const notification = new Notification({
          title: title || 'SailFish',
          body: message.length > 200 ? message.substring(0, 200) + '...' : message
        })
        notification.on('click', () => {
          const windows = electron.BrowserWindow?.getAllWindows?.()
          if (windows?.length > 0) {
            const win = windows[0]
            if (!win.isDestroyed()) {
              win.show()
              win.focus()
              if (process.platform === 'win32') {
                win.webContents.focus()
              }
              win.webContents.send('watch:activate-message', { agentId: COMPANION_AGENT_ID })
            }
          }
        })
        notification.show()
      }
    } catch (e) {
      log.debug('deliverProactiveMessage: system notification failed:', e)
    }
  }

  // 持久化到联络历史：重启后 restoreCompanionHistoryIfNeeded 恢复时可见。
  // 不依赖 companion Agent 是否正在运行，直接写一条最小 AgentRecord。
  // 联络自身的消息不另存——其 talk_to_user 工具步骤已随联络会话落盘，再存一份
  // 会在重启后的合并视图里重复出现。
  // alwaysPersist（任务复命等数据事件）：即使所有实时渠道都没送达（CLI 无窗口/IM）
  // 也落盘——历史记录是事件唯一留下的痕迹。
  if ((deliveredVia.length > 0 || alwaysPersist) && opts?.historyService && !fromCompanion) {
    try {
      const ts = Date.now()
      const uid = `proactive-${ts}-${Math.random().toString(36).slice(2, 8)}`
      opts.historyService.saveAgentRecord({
        id: `${uid}-session`,
        timestamp: ts,
        terminalId: '',
        agentKey: COMPANION_AGENT_ID,
        terminalType: 'assistant',
        userTask: '__proactive__',
        steps: [
          { id: `${uid}-notice`, type: 'proactive_notice', content: message, timestamp: ts },
        ],
        finalResult: message,
        duration: 0,
        status: 'completed',
      })
      // 失效 Watch 联络上下文缓存，否则连触发会重复投递
      try {
        const { getWatchService } = require('../../watch/watch.service')
        getWatchService().invalidateCompanionContextCache()
      } catch { /* watch 未初始化时跳过 */ }
    } catch (e) {
      log.debug('deliverProactiveMessage: 保存主动消息历史失败:', e)
    }
  }

  return { deliveredVia, failedChannels, imError }
}
