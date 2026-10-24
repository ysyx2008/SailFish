import { SSH_CONNECT_CANCELLED } from '@shared/types'
import { parseHostKeyChanged, type SshHostKeyChanged } from '@shared/utils/ssh-host-key-message'

/** 旧版取消文案：已发出的进程仍可能抛出，按整句识别，不当连接失败 */
const LEGACY_SSH_CONNECT_CANCELLED = 'SSH connect cancelled by user'

/**
 * 剥掉 Electron invoke 失败时包的那一层外壳。
 * 只认这一种已知格式，不靠内容猜。
 */
export function unwrapIpcInvokeError(raw: string): string {
  const msg = raw.trim()
  const wrapped = msg.match(
    /^(?:Error:\s*)?Error invoking remote method '[^']+':\s*(?:Error:\s*)?([\s\S]*)$/
  )
  return wrapped ? wrapped[1].trim() : msg
}

export function isSshConnectCancelledMessage(msg: string): boolean {
  const inner = unwrapIpcInvokeError(msg)
  return inner === SSH_CONNECT_CANCELLED || inner === LEGACY_SSH_CONNECT_CANCELLED
}

export function formatSshConnectFailure(
  error: unknown,
  fallback: string
): { cancelled: boolean; message: string; hostKeyChanged?: { host: string; port: number } } {
  const raw = error instanceof Error ? error.message : String(error || '')
  if (!raw.trim()) {
    return { cancelled: false, message: fallback }
  }
  if (isSshConnectCancelledMessage(raw)) {
    return { cancelled: true, message: '' }
  }
  const inner = unwrapIpcInvokeError(raw)
  if (!inner || inner.startsWith('Error invoking remote method')) {
    return { cancelled: false, message: fallback }
  }
  const changed = parseHostKeyChanged(inner)
  if (changed) {
    return {
      cancelled: false,
      message: changed.detail,
      hostKeyChanged: { host: changed.host, port: changed.port },
    }
  }
  return { cancelled: false, message: inner }
}

export type { SshHostKeyChanged }
