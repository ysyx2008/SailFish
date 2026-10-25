/**
 * 后台远程通道：在用户已存的 SSH 主机上后台跑命令，不开终端窗。
 */
import { RemoteExecPool, type RemoteExecLimits } from './remote-exec-pool'

export {
  RemoteExecPool,
  RemoteExecError,
  DEFAULT_REMOTE_EXEC_LIMITS,
} from './remote-exec-pool'
export type {
  RemoteExecErrorKind,
  RemoteExecLimits,
  RemoteExecOptions,
  RemoteExecResult,
  RemoteExecPoolStats,
} from './remote-exec-pool'
export { resolveRemoteHost } from './remote-host'
export type { RemoteHost, SavedSessionLogin } from './remote-host'

/**
 * 池按「主人」分：一位主人的一场用一个池。主人停下时 disposeOwner 一并断开。
 */
export class RemoteExecRegistry {
  private readonly pools = new Map<string, RemoteExecPool>()

  constructor(private readonly limits: Partial<RemoteExecLimits> = {}) {}

  poolFor(ownerKey: string): RemoteExecPool {
    const existing = this.pools.get(ownerKey)
    if (existing && !existing.isDisposed) return existing
    const pool = new RemoteExecPool(this.limits)
    this.pools.set(ownerKey, pool)
    return pool
  }

  hasPool(ownerKey: string): boolean {
    const pool = this.pools.get(ownerKey)
    return !!pool && !pool.isDisposed
  }

  disposeOwner(ownerKey: string): void {
    const pool = this.pools.get(ownerKey)
    this.pools.delete(ownerKey)
    pool?.dispose()
  }

  disposeAll(): void {
    for (const key of [...this.pools.keys()]) this.disposeOwner(key)
  }
}

let registry: RemoteExecRegistry | undefined

export function getRemoteExecRegistry(): RemoteExecRegistry {
  registry ??= new RemoteExecRegistry()
  return registry
}
