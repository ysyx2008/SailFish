import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'
import { encodeHostKeyChanged } from '@shared/utils/ssh-host-key-message'
import { t } from '../i18n/main-i18n'

/** ssh2 拒绝主机密钥时的原句。前面可能被传文件的库加上「名字: 」。 */
export const SSH_HOST_KEY_DENIED = 'Host denied (verification failed)'

interface HostKeyEntry {
  host: string
  port: number
  fingerprint: string
}

interface HostKeyFile {
  version: 1
  entries: HostKeyEntry[]
}

export type HostKeyDenial =
  | { kind: 'changed'; host: string; port: number; previous: string; presented: string }
  | { kind: 'unrecorded'; host: string; port: number }

interface HostIdentity {
  host: string
  port: number
  id: string
}

function identityOf(host: string, port: number): HostIdentity | null {
  let name = host.trim().toLowerCase()
  if (name.startsWith('[') && name.endsWith(']') && name.length > 2) name = name.slice(1, -1)
  if (!name || name.includes('\0') || name.includes('\n') || name.includes('\r')) return null
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return { host: name, port, id: `${name}\n${port}` }
}

export function fingerprintHostKey(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64')}`
}

function isHostKeyDeniedMessage(message: string): boolean {
  return message === SSH_HOST_KEY_DENIED || message.endsWith(`: ${SSH_HOST_KEY_DENIED}`)
}

/**
 * 旗鱼自己记住的主机身份。文件只含公钥指纹，权限仍限本人可读。
 * 第一次见到就记下；没变就通过；变了先停，等用户确认再换成新的。
 */
export class SshHostKeyStore {
  private readonly pending = new Map<string, string>()
  private readonly denials = new Map<string, HostKeyDenial>()

  constructor(private readonly filePath: string) {}

  check(host: string, port: number, key: Buffer): boolean {
    const identity = identityOf(host, port)
    if (!identity || !Buffer.isBuffer(key) || key.length === 0) {
      if (identity) this.denials.set(identity.id, { kind: 'unrecorded', host: identity.host, port: identity.port })
      return false
    }
    const presented = fingerprintHostKey(key)
    let known: Map<string, HostKeyEntry>
    try {
      known = this.load()
    } catch {
      this.denials.set(identity.id, { kind: 'unrecorded', host: identity.host, port: identity.port })
      return false
    }
    const current = known.get(identity.id)
    if (!current) {
      try {
        this.save(known, identity, presented)
      } catch {
        this.denials.set(identity.id, { kind: 'unrecorded', host: identity.host, port: identity.port })
        return false
      }
      this.pending.delete(identity.id)
      this.denials.delete(identity.id)
      return true
    }
    if (current.fingerprint === presented) {
      this.pending.delete(identity.id)
      this.denials.delete(identity.id)
      return true
    }
    this.pending.set(identity.id, presented)
    this.denials.set(identity.id, {
      kind: 'changed',
      host: identity.host,
      port: identity.port,
      previous: current.fingerprint,
      presented,
    })
    return false
  }

  denial(host: string, port: number): HostKeyDenial | null {
    const identity = identityOf(host, port)
    if (!identity) return null
    return this.denials.get(identity.id) ?? null
  }

  /** 把刚才对不上的那一次身份记成新的。没有待确认的对不上，就不写。 */
  acceptChanged(host: string, port: number): boolean {
    const identity = identityOf(host, port)
    if (!identity) return false
    const presented = this.pending.get(identity.id)
    if (!presented) return false
    let known: Map<string, HostKeyEntry>
    try {
      known = this.load()
      this.save(known, identity, presented)
    } catch {
      return false
    }
    this.pending.delete(identity.id)
    this.denials.delete(identity.id)
    return true
  }

  private load(): Map<string, HostKeyEntry> {
    let raw: string
    try {
      raw = fs.readFileSync(this.filePath, 'utf8')
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return new Map()
      throw err
    }
    const parsed = JSON.parse(raw) as HostKeyFile
    if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      throw new Error('bad host key file')
    }
    const known = new Map<string, HostKeyEntry>()
    for (const entry of parsed.entries) {
      const identity = identityOf(entry?.host, entry?.port)
      if (!identity || typeof entry.fingerprint !== 'string' || !entry.fingerprint) continue
      known.set(identity.id, {
        host: identity.host,
        port: identity.port,
        fingerprint: entry.fingerprint,
      })
    }
    return known
  }

  private save(known: Map<string, HostKeyEntry>, identity: HostIdentity, fingerprint: string): void {
    known.set(identity.id, { host: identity.host, port: identity.port, fingerprint })
    const body: HostKeyFile = { version: 1, entries: [...known.values()] }
    const dir = path.dirname(this.filePath)
    fs.mkdirSync(dir, { recursive: true })
    const tmp = `${this.filePath}.${process.pid}.tmp`
    fs.writeFileSync(tmp, JSON.stringify(body), { mode: 0o600 })
    try {
      fs.chmodSync(tmp, 0o600)
    } catch {
      /* Windows 上 chmod 可能无效，写入时的 mode 已经尽量收紧 */
    }
    fs.renameSync(tmp, this.filePath)
    try {
      fs.chmodSync(this.filePath, 0o600)
    } catch {
      /* 同上 */
    }
  }
}

let singleton: SshHostKeyStore | null = null

export function getSshHostKeyStore(): SshHostKeyStore {
  if (!singleton) {
    singleton = new SshHostKeyStore(path.join(app.getPath('userData'), 'ssh-host-keys.json'))
  }
  return singleton
}

export function makeHostVerifier(
  host: string,
  port: number,
  store: SshHostKeyStore = getSshHostKeyStore(),
): (key: Buffer, callback: (accepted: boolean) => void) => void {
  return (key, callback) => {
    let accepted = false
    try {
      accepted = store.check(host, port, key)
    } catch {
      accepted = false
    }
    callback(accepted)
  }
}

export function hostKeyFailureError(
  err: unknown,
  host: string,
  port: number,
  store: SshHostKeyStore = getSshHostKeyStore(),
): Error | null {
  const message = err instanceof Error ? err.message : String(err ?? '')
  if (!isHostKeyDeniedMessage(message)) return null
  const denial = store.denial(host, port)
  if (!denial) return null
  const where = `${denial.host}:${denial.port}`
  if (denial.kind === 'unrecorded') {
    return new Error(t('error.hostKeyUnrecorded', { where }))
  }
  const detail = t('error.hostKeyChanged', {
    where,
    previous: denial.previous,
    presented: denial.presented,
  })
  return new Error(encodeHostKeyChanged(denial.host, denial.port, detail))
}
