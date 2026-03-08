/**
 * 飞书 API 会话管理
 * 复用 IM 配置中的 appId / appSecret，创建独立的 lark.Client 实例
 */

import { createLogger } from '../../../../utils/logger'
import { t } from '../../i18n'

const log = createLogger('FeishuSession')

let lark: any

async function loadSDK(): Promise<void> {
  if (!lark) {
    try {
      lark = await import('@larksuiteoapi/node-sdk')
    } catch (err) {
      log.error('Failed to load @larksuiteoapi/node-sdk:', err)
      throw new Error('@larksuiteoapi/node-sdk not available')
    }
  }
}

let client: any = null
let currentAppId = ''

/**
 * 获取或创建 lark.Client（单例，凭证变更时重建）
 */
export async function getClient(appId: string, appSecret: string): Promise<any> {
  if (!appId || !appSecret) {
    throw new Error(t('feishu.credentials_missing'))
  }

  if (client && currentAppId === appId) {
    return client
  }

  await loadSDK()

  client = new lark.Client({
    appId,
    appSecret,
    appType: lark.AppType.SelfBuild,
    domain: lark.Domain.Feishu,
  })
  currentAppId = appId
  log.info('Created lark.Client for skill')
  return client
}

/**
 * 获取当前 client（不创建新的）
 */
export function getCurrentClient(): any {
  return client
}

/**
 * 关闭会话
 */
export function closeSession(): void {
  client = null
  currentAppId = ''
  log.info('Session closed')
}

/**
 * 提取飞书 API 错误信息
 */
export function extractApiError(err: any): string {
  if (err?.response?.data) {
    const d = err.response.data
    return d.msg || d.message || JSON.stringify(d)
  }
  if (err?.msg) return err.msg
  if (err?.message) return err.message
  return String(err)
}
