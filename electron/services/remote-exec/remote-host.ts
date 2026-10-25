/**
 * 后台通道要连的一台主机：登录信息和跳板，从用户已存的会话 + 分组算出来。
 * 跳板用哪台，和开终端窗用同一条规则（effectiveJumpHost）。
 */
import { createHash } from 'node:crypto'
import { effectiveJumpHost, type JumpHostConfig, type JumpHostGroupRef, type SshEncoding } from '@shared/types'

/** 已存会话里和登录有关的字段（只取结构，不依赖配置服务的类型） */
export interface SavedSessionLogin {
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  encoding?: SshEncoding
  groupId?: string
  jumpHostOverride?: JumpHostConfig | null
}

export interface RemoteHost {
  /** 已存会话的 id */
  id: string
  name: string
  host: string
  port: number
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
  encoding: SshEncoding
  jumpHost?: JumpHostConfig
}

export function resolveRemoteHost(session: SavedSessionLogin, groups: readonly JumpHostGroupRef[]): RemoteHost {
  return {
    id: session.id,
    name: session.name,
    host: session.host,
    port: session.port,
    username: session.username,
    password: session.password,
    privateKeyPath: session.privateKeyPath,
    passphrase: session.passphrase,
    encoding: session.encoding ?? 'utf-8',
    jumpHost: effectiveJumpHost(session, groups),
  }
}

interface LoginCredential {
  username: string
  password?: string
  privateKeyPath?: string
  passphrase?: string
}

/** 「用户名 + 凭据」是同一组时得到同一个键（凭据只留哈希，不进日志和内存里的键名） */
export function credentialGroupKey(c: LoginCredential): string {
  const secret = createHash('sha256')
    .update(`${c.password ?? ''}\0${c.privateKeyPath ?? ''}\0${c.passphrase ?? ''}`)
    .digest('hex')
    .slice(0, 16)
  return `${c.username}\0${secret}`
}

/** 一台目标主机在连接表里的键：同一台（含走同一个跳板）复用一条连接 */
export function hostConnectionKey(h: RemoteHost): string {
  const via = h.jumpHost ? `${h.jumpHost.username}@${h.jumpHost.host}:${h.jumpHost.port}` : ''
  return `${h.username}@${h.host}:${h.port}|${via}`
}

export function jumpLinkKey(j: JumpHostConfig): string {
  return `${j.username}@${j.host}:${j.port}`
}
