/**
 * 后台远程通道：在用户已存的 SSH 主机上后台跑命令，不开终端窗。
 */
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
