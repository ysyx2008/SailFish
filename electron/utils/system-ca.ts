/**
 * 后台的 https 同时信任软件自带的根证书和这台电脑系统里的根证书。
 * 只做这一次；失败就保持原样，不关掉校验。
 * 不在这里写日志：调用方往往比日志系统更早执行，由调用方在日志就绪后记下返回的那句。
 */
import tls from 'node:tls'

/** 当前的 @types/node 还没给这两个接口写类型，运行时（Electron 自带的 Node 22）是有的。 */
interface SystemTrustStore {
  getCACertificates?(type?: 'default' | 'system'): string[]
  setDefaultCACertificates?(certs: readonly string[]): void
}

const trustStore = tls as SystemTrustStore

export interface SystemCaNote {
  level: 'info' | 'warn'
  message: string
}

let note: SystemCaNote | null = null

/** 两份名单合成一份，重复的只留先出现的那张。 */
export function mergeCertificatePems(bundled: readonly string[], system: readonly string[]): string[] {
  const seen = new Set<string>()
  const merged: string[] = []
  for (const pem of [...bundled, ...system]) {
    const key = pem.replace(/\s+/g, '')
    if (!key || seen.has(key)) continue
    seen.add(key)
    merged.push(pem)
  }
  return merged
}

export function trustSystemCertificates(): SystemCaNote {
  if (note) return note
  if (typeof trustStore.getCACertificates !== 'function' || typeof trustStore.setDefaultCACertificates !== 'function') {
    note = { level: 'warn', message: '当前运行时没有系统证书库接口，仍只用内置根证书' }
    return note
  }
  try {
    const bundled = trustStore.getCACertificates('default')
    const system = trustStore.getCACertificates('system')
    const merged = mergeCertificatePems(bundled, system)
    const added = merged.length - bundled.length
    if (added <= 0) {
      note = { level: 'info', message: '系统证书库没有额外的根证书' }
      return note
    }
    trustStore.setDefaultCACertificates(merged)
    note = { level: 'info', message: `已同时信任系统根证书 ${added} 张（共 ${merged.length} 张）` }
  } catch (err) {
    note = { level: 'warn', message: `读取系统证书库失败，仍只用内置根证书: ${err instanceof Error ? err.message : String(err)}` }
  }
  return note
}
