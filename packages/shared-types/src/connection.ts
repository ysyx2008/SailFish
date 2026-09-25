/**
 * 连接相关共享类型（IPC 边界）
 *
 * 这些类型在前后端之间通过 IPC 序列化传递，是单一真相来源。
 * 后端 service 文件、preload、前端 store 一律从 `@shared/types` 导入，
 * 禁止重复定义；如需扩展（如 service 内部支持 Buffer 等不可序列化字段），
 * 请基于这里的边界类型派生。
 */

/** 主机列表排序方式 */
export type SessionSortBy = 'custom' | 'name' | 'name-desc' | 'lastUsed'

/**
 * 跳板机配置（对外 IPC + 前端表单共用）
 *
 * `product: 'jumpserver'` 只由堡垒机同步写入。普通 Linux 跳板没有这个标记。
 */
export interface JumpHostConfig {
  host: string
  port: number
  username: string
  authType: 'password' | 'privateKey'
  password?: string
  privateKeyPath?: string
  passphrase?: string
  product?: 'jumpserver'
}

/** 堡垒机同步创建的分组标题前缀，用来认出尚未带 product 标记的旧数据 */
export const JUMPSERVER_SYNC_GROUP_PREFIX = 'JumpServer ('

/** 继承分组跳板机时，把堡垒机同步分组标成 JumpServer，避免和手填的 Linux 跳板混在一起 */
export function jumpHostFromGroup(groupName: string, jumpHost: JumpHostConfig): JumpHostConfig {
  if (jumpHost.product === 'jumpserver' || groupName.startsWith(JUMPSERVER_SYNC_GROUP_PREFIX)) {
    return jumpHost.product === 'jumpserver' ? jumpHost : { ...jumpHost, product: 'jumpserver' }
  }
  return jumpHost
}

/** 跳板机拒绝端口转发时给用户看的说明 */
export const JUMP_FORWARDING_REFUSED_MESSAGE =
  '这台跳板机不允许端口转发，旗鱼无法经它连到目标机器。若是普通 Linux 跳板，请允许端口转发；若是 JumpServer，请在跳板机配置里勾选「这是 JumpServer」。'

/** SSH 通道打开失败原因：管理员禁止（RFC 4254，ssh2 放在 err.reason） */
const SSH_OPEN_ADMINISTRATIVELY_PROHIBITED = 1

/**
 * 跳板机拒绝端口转发。优先看 ssh2 的 reason，原文匹配只作兜底。
 */
export function isTcpForwardingRefused(error: string | { message?: string; reason?: unknown }): boolean {
  if (typeof error !== 'string' && error.reason === SSH_OPEN_ADMINISTRATIVELY_PROHIBITED) return true
  const message = typeof error === 'string' ? error : (error.message || '')
  const text = message.toLowerCase()
  return text.includes('port forwarding') || text.includes('administratively prohibited')
}

/** 创建本地 PTY 时的可选参数 */
export interface PtyOptions {
  cols?: number
  rows?: number
  cwd?: string
  shell?: string
  env?: Record<string, string>
  /** 字符编码：'auto' | 'utf-8' | 'gbk' | 'big5' | 'shift_jis' 等 */
  encoding?: string
}

/** pty.create 返回值：实例 ID + 实际 spawn 的 shell（与 resolveDefaultShell 同语义） */
export interface PtyCreateResult {
  id: string
  shellPath: string
  shellKind: 'powershell' | 'cmd' | 'bash'
}

/**
 * SFTP 连接配置（IPC 边界）
 *
 * 注意：`privateKey` 仅为字符串。Service 内部如需 Buffer（例如 `fs.readFileSync`
 * 读出私钥文件），请使用局部变量，不要扩展此接口。IPC 序列化无法传递 Buffer。
 */
export interface SftpConfig {
  host: string
  port: number
  username: string
  password?: string
  privateKey?: string
  privateKeyPath?: string
  passphrase?: string
}

/** SSH 终端支持的字符编码 */
export type SshEncoding =
  | 'utf-8'         // UTF-8 (默认，支持所有语言)
  | 'gbk'           // 简体中文 (Windows)
  | 'gb2312'        // 简体中文
  | 'gb18030'       // 简体中文 (完整)
  | 'big5'          // 繁体中文
  | 'shift_jis'     // 日语
  | 'euc-jp'        // 日语 (Unix)
  | 'euc-kr'        // 韩语
  | 'iso-8859-1'    // Latin-1 (西欧语言)
  | 'iso-8859-15'   // Latin-9 (西欧语言，含欧元符号)
  | 'windows-1252'  // Windows 西欧
  | 'koi8-r'        // 俄语
  | 'windows-1251'  // 俄语 (Windows)

/**
 * 用户主动放弃 SSH 握手时的稳定错误码。
 * 经 IPC 后只剩 message，前后端用同一条识别「取消」，不要当连接失败弹窗。
 */
export const SSH_CONNECT_CANCELLED = 'SSH_CONNECT_CANCELLED'

/** SSH 连接配置（IPC 边界） */
export interface SshConfig {
  host: string
  port: number
  username: string
  password?: string
  /** 私钥内容（直接传递） */
  privateKey?: string
  /** 私钥文件路径（从文件读取） */
  privateKeyPath?: string
  /** 私钥密码（可选） */
  passphrase?: string
  cols?: number
  rows?: number
  /** 跳板机配置 */
  jumpHost?: JumpHostConfig
  /** 字符编码，默认 utf-8 */
  encoding?: SshEncoding
}
