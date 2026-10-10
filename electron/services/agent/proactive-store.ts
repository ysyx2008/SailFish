/**
 * 主动消息上下文存储
 *
 * 当 Agent 通过 talk_to_user 向用户发送主动消息时，将内容暂存于此。
 * 用户回复时，无论来自 IM 还是桌面 UI，Agent 都能获知之前发了什么。
 *
 * 独立模块，无 agent/ 内部依赖，避免循环引用。
 */

import { t } from './i18n'

interface PendingContext {
  message: string
  title?: string
  timestamp: number
}

const store = new Map<string, PendingContext>()

const MAX_AGE_MS = 30 * 60 * 1000 // 30 分钟过期

/**
 * 存储 talk_to_user 发送的主动消息上下文
 */
export function addProactiveContext(agentId: string, message: string, title?: string): void {
  store.set(agentId, { message, title, timestamp: Date.now() })
}

/**
 * 追加主动消息上下文（不覆盖未过期的既有内容）。
 *
 * 任务事件回流（TaskSupervisor）使用：多个任务事件在短窗口内连续到达时，
 * 覆盖语义会让后到的完成通知冲掉先到的待确认上下文，导致用户回复"批准"时
 * 联络丢失 toolCallId。追加语义保证暂存的是"全部待办事项"的聚合。
 */
export function appendProactiveContext(agentId: string, message: string, title?: string): void {
  const existing = store.get(agentId)
  if (existing && Date.now() - existing.timestamp <= MAX_AGE_MS) {
    store.set(agentId, {
      message: `${existing.message}\n${message}`,
      title: title ?? existing.title,
      timestamp: Date.now()
    })
  } else {
    store.set(agentId, { message, title, timestamp: Date.now() })
  }
}

/**
 * 消费并清除主动消息上下文（一次性读取）
 * 返回格式化后的上下文字符串，过期则返回 undefined
 */
export function consumeProactiveContext(agentId: string): string | undefined {
  const ctx = store.get(agentId)
  if (!ctx) return undefined
  store.delete(agentId)

  if (Date.now() - ctx.timestamp > MAX_AGE_MS) return undefined

  return ctx.title
    ? `[${t('im.proactive_context_prefix')}: ${ctx.title}]\n${ctx.message}`
    : `[${t('im.proactive_context_prefix')}]\n${ctx.message}`
}
