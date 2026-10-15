/**
 * 把 OEM 配置收成运行时用的值。
 * 字符串字段：不写（undefined）用旗鱼默认；写成空字符串则关掉，不退回旗鱼。
 * 安装身份写空仍用默认，避免装出没有名字的程序。
 */
import type { OemConfig } from './oem-types'
import { oemConfig } from './oem-runtime'

export const SAILFISH_GITHUB_REPOSITORY = 'ysyx2008/SailFish'
export const SAILFISH_UPDATE_ROOT = 'https://sfterm-download.oss-cn-wuhan-lr.aliyuncs.com/releases/'
export const SAILFISH_WEBSITE = 'https://www.sfterm.com'
export const SAILFISH_DOCS = 'https://www.sfterm.com/docs'
export const SAILFISH_ISSUES = 'https://github.com/ysyx2008/SailFish/issues'
export const SAILFISH_QQ_GROUP = '1078041072'
export const SAILFISH_CONTACT_EMAIL = 'nuoyan_cfan@163.com'
export const SAILFISH_LICENSE = 'http://www.gnu.org/licenses/agpl-3.0.html'
export const SAILFISH_SKILL_REGISTRY = 'https://www.sfterm.com/skill-registry.json'

export const SAILFISH_APP_ID = 'com.sfterm.terminal'
export const SAILFISH_PRODUCT_NAME = 'SailFish'
export const SAILFISH_DATA_DIR_NAME = 'SailFish'
export const SAILFISH_PROTOCOL = 'sailfish'
export const SAILFISH_CLI_NAME = 'sailfish'

export interface ResolvedRepository {
  owner: string
  repo: string
}

export interface ResolvedDistribution {
  github: ResolvedRepository | null
  /** 以 / 结尾；null 表示这一路关掉 */
  updateRoot: string | null
}

export interface ResolvedLinks {
  website: string | null
  docs: string | null
  issues: string | null
  qqGroup: string | null
  contactEmail: string | null
  license: string | null
  skillRegistry: string | null
}

export interface ResolvedIdentity {
  appId: string
  productName: string
  dataDirName: string
  protocol: string
  cliName: string
}

export interface ResolvedOem {
  distribution: ResolvedDistribution
  links: ResolvedLinks
  identity: ResolvedIdentity
  /** 相对或绝对路径；null 表示用旗鱼自带图标 */
  icons: { app: string | null; tray: string | null }
  communitySkillMarket: boolean
  inAppUpdateEnabled: boolean
}

function absentOrEmpty(value: string | undefined, fallback: string): string | null {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  return trimmed ? trimmed : null
}

function identityString(value: string | undefined, fallback: string): string {
  if (value === undefined) return fallback
  const trimmed = value.trim()
  return trimmed || fallback
}

function parseRepository(value: string | null): ResolvedRepository | null {
  if (!value) return null
  const parts = value.split('/').map(part => part.trim()).filter(Boolean)
  if (parts.length !== 2) return null
  return { owner: parts[0], repo: parts[1] }
}

/** 图标不写或写成空都用旗鱼自带的图，没有「关掉图标」这一档。 */
function optionalPath(value: string | undefined): string | null {
  if (value === undefined) return null
  const trimmed = value.trim()
  return trimmed || null
}

function withTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`
}

function normalizeProtocol(value: string): string {
  return value.replace(/:\/?\/?$/, '').replace(/[^a-z0-9+-]/gi, '').toLowerCase() || SAILFISH_PROTOCOL
}

export function resolveOem(config: OemConfig): ResolvedOem {
  const repository = absentOrEmpty(config.distribution?.repository, SAILFISH_GITHUB_REPOSITORY)
  const updateRootRaw = absentOrEmpty(config.distribution?.updateRoot, SAILFISH_UPDATE_ROOT)
  const github = parseRepository(repository)
  const updateRoot = updateRootRaw ? withTrailingSlash(updateRootRaw) : null

  const identity: ResolvedIdentity = {
    appId: identityString(config.identity?.appId, SAILFISH_APP_ID),
    productName: identityString(config.identity?.productName, SAILFISH_PRODUCT_NAME),
    dataDirName: identityString(config.identity?.dataDirName, SAILFISH_DATA_DIR_NAME),
    protocol: normalizeProtocol(identityString(config.identity?.protocol, SAILFISH_PROTOCOL)),
    cliName: identityString(config.identity?.cliName, SAILFISH_CLI_NAME),
  }

  return {
    distribution: { github, updateRoot },
    links: {
      website: absentOrEmpty(config.links?.website, SAILFISH_WEBSITE),
      docs: absentOrEmpty(config.links?.docs, SAILFISH_DOCS),
      issues: absentOrEmpty(config.links?.issues, SAILFISH_ISSUES),
      qqGroup: absentOrEmpty(config.links?.qqGroup, SAILFISH_QQ_GROUP),
      contactEmail: absentOrEmpty(config.links?.contactEmail, SAILFISH_CONTACT_EMAIL),
      license: absentOrEmpty(config.links?.license, SAILFISH_LICENSE),
      skillRegistry: absentOrEmpty(config.links?.skillRegistry, SAILFISH_SKILL_REGISTRY),
    },
    identity,
    icons: {
      app: optionalPath(config.icons?.app),
      tray: optionalPath(config.icons?.tray),
    },
    communitySkillMarket: config.communitySkillMarket !== false,
    inAppUpdateEnabled: Boolean(github || updateRoot),
  }
}

export const oemResolved: ResolvedOem = resolveOem(oemConfig)

export function releaseMetaUrls(resolved: ResolvedOem = oemResolved): string[] {
  const urls: string[] = []
  if (resolved.distribution.updateRoot) {
    urls.push(`${resolved.distribution.updateRoot}release-meta.json`)
  }
  const github = resolved.distribution.github
  if (github) {
    urls.push(`https://github.com/${github.owner}/${github.repo}/releases/latest/download/release-meta.json`)
  }
  return urls
}

export function speechPackUrls(version: string, resolved: ResolvedOem = oemResolved): { github: string | null; oss: string | null } {
  const github = resolved.distribution.github
  let oss: string | null = null
  if (resolved.distribution.updateRoot) {
    try {
      const root = new URL(resolved.distribution.updateRoot)
      const parent = root.pathname.replace(/\/+$/, '').split('/').slice(0, -1).join('/')
      root.pathname = `${parent}/optional/speech/speech-pack-${version}.zip`
      oss = root.toString()
    } catch {
      oss = null
    }
  }
  return {
    github: github
      ? `https://github.com/${github.owner}/${github.repo}/releases/download/speech-pack-v${version}/speech-pack-${version}.zip`
      : null,
    oss,
  }
}

const MESSAGING_DOC_FILES = {
  readme: { zh: 'README_CN.md', en: 'README.md' },
  dingtalk: { zh: 'dingtalk_CN.md', en: 'dingtalk.md' },
  feishu: { zh: 'feishu_CN.md', en: 'feishu.md' },
  slack: { zh: 'slack_CN.md', en: 'slack.md' },
  telegram: { zh: 'telegram_CN.md', en: 'telegram.md' },
  wecom: { zh: 'wecom_CN.md', en: 'wecom.md' },
} as const

export type MessagingDocChannel = keyof typeof MESSAGING_DOC_FILES

/** 聊天渠道说明在代码仓库的文档里。仓库这一路关掉时没有链接，不退回旗鱼的仓库。 */
export function messagingGuideUrl(channel: MessagingDocChannel, locale?: string, resolved: ResolvedOem = oemResolved): string | null {
  const github = resolved.distribution.github
  if (!github) return null
  const file = locale?.startsWith('zh') ? MESSAGING_DOC_FILES[channel].zh : MESSAGING_DOC_FILES[channel].en
  return `https://github.com/${github.owner}/${github.repo}/blob/main/docs/messaging/${file}`
}
