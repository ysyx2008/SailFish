/** 主机身份变了时，经 IPC 传递的稳定第一行。后面两行是主机和端口，其余是给人看的说明。 */
export const SSH_HOST_KEY_CHANGED = 'SSH_HOST_KEY_CHANGED'

export interface SshHostKeyChanged {
  host: string
  port: number
  detail: string
}

export function encodeHostKeyChanged(host: string, port: number, detail: string): string {
  return `${SSH_HOST_KEY_CHANGED}\n${host}\n${port}\n${detail}`
}

export function parseHostKeyChanged(message: string): SshHostKeyChanged | null {
  const lines = message.split('\n')
  if (lines[0] !== SSH_HOST_KEY_CHANGED) return null
  const host = lines[1] ?? ''
  const port = Number(lines[2])
  const detail = lines.slice(3).join('\n').trim()
  if (!host || host.includes('\n') || !Number.isInteger(port) || port < 1 || port > 65535 || !detail) {
    return null
  }
  return { host, port, detail }
}
