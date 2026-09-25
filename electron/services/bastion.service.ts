import { v4 as uuidv4 } from 'uuid'
import { Agent } from 'undici'
import type { BastionConfig, BastionSyncResult } from '@shared/types'
import type { ConfigService, SshSession, SessionGroup } from './config.service'
import { createLogger } from '../utils/logger'

// 复用一个不校验证书的 dispatcher（仅在用户显式开启 ignoreSsl 时使用）
let _tlsSkipDispatcher: Agent | null = null
function getTlsSkipDispatcher(): Agent {
  if (!_tlsSkipDispatcher) {
    _tlsSkipDispatcher = new Agent({ connect: { rejectUnauthorized: false } })
  }
  return _tlsSkipDispatcher
}

const log = createLogger('Bastion')

interface JumpServerAsset {
  id: string
  // v3 fields
  name?: string
  address?: string
  protocols?: Array<{ name: string; port: number } | string>
  platform?: { name: string }
  category?: string
  type?: string
  // v2 fields
  hostname?: string
  ip?: string
  protocol?: string
  port?: number
  // common
  comment?: string
  is_active: boolean
  org_name?: string
}

interface JumpServerAuthResponse {
  token: string
  keyword?: string
  date_expired?: string
  user?: { id: string; name: string; username: string }
}

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'

export class BastionService {
  constructor(private configService: ConfigService) {}

  private withTlsOverride<T>(ignoreSsl: boolean, fn: (opts: { dispatcher?: Agent }) => Promise<T>): Promise<T> {
    // 不再使用 NODE_TLS_REJECT_UNAUTHORIZED 全局变量（会影响整个进程的所有 TLS 连接）
    // 改为通过 dispatcher 仅对当前请求禁用证书校验
    const opts = ignoreSsl ? { dispatcher: getTlsSkipDispatcher() } : {}
    return fn(opts)
  }

  async testConnection(config: BastionConfig): Promise<{ success: boolean; message: string; assetCount?: number }> {
    return this.withTlsOverride(config.rejectUnauthorized === false, async (opts) => {
    try {
      const token = await this.authenticate(config.url, config.username, config.password, opts)
      const firstPage = await this.fetchAssetsPage(config.url, token, 10, 0, opts)
      if (firstPage.results?.length > 0) {
        log.info('Sample asset structure:', JSON.stringify(firstPage.results[0], null, 2))
      }
      const sshCount = this.countSshAssets(firstPage.results)
      const totalHint = firstPage.count !== undefined
        ? `（共 ${firstPage.count} 个资产，其中 ${sshCount} 个支持 SSH）`
        : `（找到 ${sshCount} 个 SSH 资产）`

      return { success: true, message: `连接成功${totalHint}`, assetCount: firstPage.count ?? sshCount }
    } catch (error: any) {
      const msg = this.formatError(error)
      log.error('Test connection failed:', msg)
      return { success: false, message: msg }
    }
    })
  }

  async syncAssets(config: BastionConfig): Promise<BastionSyncResult> {
    return this.withTlsOverride(config.rejectUnauthorized === false, async (opts) => {
    try {
      const token = await this.authenticate(config.url, config.username, config.password, opts)

      const allAssets = await this.fetchAllAssets(config.url, token, opts)
      const sshAssets = allAssets.filter(a => this.isSshAsset(a))

      if (sshAssets.length === 0) {
        return { success: true, added: 0, updated: 0, removed: 0, total: 0, groupId: '', groupName: '' }
      }

      const hostname = this.extractHostname(config.url)
      const groupName = `JumpServer (${hostname})`

      const groups: SessionGroup[] = this.configService.get('sessionGroups') || []
      const sessions: SshSession[] = this.configService.get('sshSessions') || []

      let group = groups.find(g => g.name === groupName)
      if (!group) {
        group = { id: uuidv4(), name: groupName, sortOrder: groups.length }
        groups.push(group)
      }

      if (config.autoJumpHost) {
        group.jumpHost = {
          host: hostname,
          port: config.jumpHostPort || 2222,
          username: config.username,
          authType: 'password',
          password: config.password,
          product: 'jumpserver'
        }
      }

      const groupSessions = sessions.filter(s => s.groupId === group!.id)

      let added = 0
      let updated = 0

      for (const asset of sshAssets) {
        const addr = this.getAssetAddress(asset)
        const port = this.getAssetSshPort(asset)
        const name = this.getAssetName(asset)
        if (!addr) continue

        const existing = groupSessions.find(s => s.host === addr)

        if (existing) {
          existing.name = name
          existing.port = port
          updated++
        } else {
          const newSession: SshSession = {
            id: uuidv4(),
            name,
            host: addr,
            port,
            username: '',
            authType: 'password',
            groupId: group.id,
            sortOrder: sessions.length
          }
          sessions.push(newSession)
          added++
        }
      }

      const assetAddresses = new Set(sshAssets.map(a => this.getAssetAddress(a)))
      const removed = groupSessions.filter(s => !assetAddresses.has(s.host)).length

      this.configService.set('sessionGroups', groups)
      this.configService.set('sshSessions', sessions)

      log.info(`Sync completed: added=${added}, updated=${updated}, removed=${removed}, total=${sshAssets.length}`)
      return { success: true, added, updated, removed, total: sshAssets.length, groupId: group.id, groupName }
    } catch (error: any) {
      const msg = this.formatError(error)
      log.error('Sync failed:', msg)
      return { success: false, error: msg, added: 0, updated: 0, removed: 0, total: 0, groupId: '', groupName: '' }
    }
    })
  }

  private async authenticate(baseUrl: string, username: string, password: string, opts: { dispatcher?: Agent } = {}): Promise<string> {
    const url = `${this.normalizeUrl(baseUrl)}/api/v1/authentication/auth/`
    log.info('Authenticating:', url)
    const resp = await this.httpPost<JumpServerAuthResponse>(url, { username, password }, opts)
    if (!resp.token) {
      throw new Error('认证失败：未返回 token（可能需要 MFA 验证）')
    }
    return resp.token
  }

  private assetsApiPath = ''

  private async fetchAssetsPage(baseUrl: string, token: string, limit: number, offset: number, opts: { dispatcher?: Agent } = {}): Promise<{ count?: number; results: JumpServerAsset[] }> {
    const base = this.normalizeUrl(baseUrl)
    const qs = `?limit=${limit}&offset=${offset}`

    if (this.assetsApiPath) {
      return this.httpGet(`${base}${this.assetsApiPath}${qs}`, token, opts)
    }

    const candidates = [
      '/api/v1/perms/users/assets/',
      '/api/v1/perms/users/self/assets/',
    ]
    let lastError: Error | undefined
    for (const path of candidates) {
      try {
        const result = await this.httpGet<{ count?: number; results: JumpServerAsset[] }>(`${base}${path}${qs}`, token, opts)
        this.assetsApiPath = path
        log.info('Using assets API path:', path)
        return result
      } catch (e: any) {
        lastError = e
        if (!e.message?.includes('HTTP 404')) throw e
      }
    }
    throw lastError!
  }

  private async fetchAllAssets(baseUrl: string, token: string, opts: { dispatcher?: Agent } = {}): Promise<JumpServerAsset[]> {
    const pageSize = 100
    const maxPages = 100
    const all: JumpServerAsset[] = []
    let offset = 0

    for (let page = 0; page < maxPages; page++) {
      const resp = await this.fetchAssetsPage(baseUrl, token, pageSize, offset, opts)
      if (!resp.results?.length) break
      all.push(...resp.results)

      if (resp.count !== undefined && all.length >= resp.count) break
      if (resp.results.length < pageSize) break
      offset += pageSize
    }

    return all
  }

  private parseSshProtocol(a: JumpServerAsset): { found: boolean; port: number } {
    if (a.protocols) {
      for (const p of a.protocols) {
        if (typeof p === 'string') {
          const [name, port] = p.split('/')
          if (name === 'ssh') return { found: true, port: parseInt(port) || 22 }
        } else if (p.name === 'ssh') {
          return { found: true, port: p.port || 22 }
        }
      }
    }
    if (a.protocol === 'ssh') return { found: true, port: a.port || 22 }
    return { found: false, port: 22 }
  }

  private isSshAsset(a: JumpServerAsset): boolean {
    return a.is_active && this.parseSshProtocol(a).found
  }

  private getAssetName(a: JumpServerAsset): string {
    return a.name || a.hostname || a.address || a.ip || a.id
  }

  private getAssetAddress(a: JumpServerAsset): string {
    return a.address || a.ip || ''
  }

  private getAssetSshPort(a: JumpServerAsset): number {
    return this.parseSshProtocol(a).port
  }

  private countSshAssets(assets: JumpServerAsset[]): number {
    return assets.filter(a => this.isSshAsset(a)).length
  }

  private async httpGet<T>(url: string, token: string, opts: { dispatcher?: Agent } = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(url, {
        signal: controller.signal,
        dispatcher: opts.dispatcher,
        headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/json', 'User-Agent': UA }
      } as RequestInit)
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} [${url}]`)
      return await resp.json() as T
    } finally {
      clearTimeout(timer)
    }
  }

  private async httpPost<T>(url: string, body: Record<string, unknown>, opts: { dispatcher?: Agent } = {}): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 15000)
    try {
      const resp = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        dispatcher: opts.dispatcher,
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json', 'User-Agent': UA },
        body: JSON.stringify(body)
      } as RequestInit)
      if (!resp.ok) throw new Error(`HTTP ${resp.status} ${resp.statusText} [${url}]`)
      return await resp.json() as T
    } finally {
      clearTimeout(timer)
    }
  }

  private normalizeUrl(url: string): string {
    return url.replace(/\/+$/, '')
  }

  private extractHostname(url: string): string {
    try {
      return new URL(url).hostname
    } catch {
      return url.replace(/^https?:\/\//, '').split(/[:/]/)[0]
    }
  }

  private formatError(error: any): string {
    if (error?.name === 'AbortError') return '连接超时'
    const causeCode = error?.cause?.code
    const causeMsg = error?.cause?.message || ''
    if (causeCode === 'ECONNREFUSED') return '连接被拒绝，请检查地址'
    if (causeCode === 'ENOTFOUND') return 'DNS 解析失败，请检查地址'
    if (causeCode === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE' || causeCode === 'SELF_SIGNED_CERT_IN_CHAIN' ||
        causeCode === 'DEPTH_ZERO_SELF_SIGNED_CERT' || causeCode === 'ERR_TLS_CERT_ALTNAME_INVALID' ||
        causeMsg.includes('self-signed') || /certificate.*verif/i.test(causeMsg)) {
      return 'SSL 证书验证失败（可能是自签名证书），请在下方开启「忽略 SSL 证书错误」'
    }
    const msg = error?.message || String(error)
    if (msg.includes('fetch failed')) return `连接失败：${causeMsg || causeCode || '请检查地址是否正确'}`
    if (msg.includes('HTTP 404')) {
      const urlMatch = msg.match(/\[(.+?)\]/)
      const hint = urlMatch ? `\n请求地址：${urlMatch[1]}` : ''
      return `API 路径不存在（404），请检查 JumpServer 地址是否正确${hint}`
    }
    if (msg.includes('401')) return '认证失败，请检查用户名和密码'
    if (msg.includes('403')) return '权限不足'
    return msg
  }
}
