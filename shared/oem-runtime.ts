/**
 * OEM 配置运行时入口。
 *
 * - 存在 `shared/oem.config.ts`（gitignore，OEM 可选）→ 使用其中的 oemConfig
 * - 否则 → 使用 oem-defaults（开源默认）
 *
 * Vite 打包时由 optional-oem-config 插件在构建期选定；
 * CLI / tsx 走下方 Node 探测，便于本机放一份 oem.config.ts 调试。
 */
import type { OemConfig } from './oem-types'
import { oemConfig as defaultOemConfig } from './oem-defaults'

export type { OemConfig, OemFeatures, OemFeatureKey, OemBrand, OemSsoConfig, OemSsoGateMode, OemSsoVerifyIdToken, OemDistribution, OemLinks, OemIdentity, OemIcons } from './oem-types'
export { OEM_FEATURE_DEFAULTS } from './oem-types'

function tryLoadOemOverride(): OemConfig | undefined {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const path = require('node:path') as typeof import('node:path')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createRequire } = require('node:module') as typeof import('node:module')
    const req = createRequire(__filename)
    for (const name of ['oem.config.ts', 'oem.config.js', 'oem.config.mjs']) {
      const full = path.join(__dirname, name)
      if (!fs.existsSync(full)) continue
      const mod = req(full) as { oemConfig?: OemConfig }
      if (mod?.oemConfig) return mod.oemConfig
    }
  } catch {
    return undefined
  }
  return undefined
}

export const oemConfig: OemConfig = tryLoadOemOverride() ?? defaultOemConfig
