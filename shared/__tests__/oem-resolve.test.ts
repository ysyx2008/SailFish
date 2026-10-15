import { describe, expect, it } from 'vitest'
import type { OemConfig } from '../oem-types'
import { OEM_FEATURE_DEFAULTS } from '../oem-types'
import {
  messagingGuideUrl,
  releaseMetaUrls,
  resolveOem,
  speechPackUrls,
  SAILFISH_CONTACT_EMAIL,
  SAILFISH_GITHUB_REPOSITORY,
  SAILFISH_LICENSE,
  SAILFISH_SKILL_REGISTRY,
  SAILFISH_UPDATE_ROOT,
} from '../oem-resolve'

function config(partial: Partial<OemConfig> = {}): OemConfig {
  return {
    brand: {
      name: { zh: '旗鱼', en: 'SailFish' },
      logo: '/assets/logo.png',
      copyright: { zh: '© 2026 旗鱼', en: '© 2026 SailFish' },
    },
    features: { ...OEM_FEATURE_DEFAULTS },
    ...partial,
  }
}

describe('resolveOem', () => {
  it('不写更新地址和链接时用旗鱼默认', () => {
    const resolved = resolveOem(config())
    expect(resolved.distribution.github).toEqual({ owner: 'ysyx2008', repo: 'SailFish' })
    expect(resolved.distribution.updateRoot).toBe(SAILFISH_UPDATE_ROOT)
    expect(resolved.inAppUpdateEnabled).toBe(true)
    expect(resolved.links.contactEmail).toBe(SAILFISH_CONTACT_EMAIL)
    expect(resolved.links.license).toBe(SAILFISH_LICENSE)
    expect(resolved.links.skillRegistry).toBe(SAILFISH_SKILL_REGISTRY)
    expect(resolved.communitySkillMarket).toBe(true)
    expect(resolved.identity.protocol).toBe('sailfish')
    expect(resolved.identity.dataDirName).toBe('SailFish')
    expect(resolved.icons.app).toBeNull()
    expect(resolved.models.catalogUrl).toBeNull()
    expect(resolved.models.auth).toBe('none')
  })

  it('两处更新地址都写成空时不做应用内更新，也不退回旗鱼仓库', () => {
    const resolved = resolveOem(config({
      distribution: { repository: '', updateRoot: '  ' },
    }))
    expect(resolved.distribution.github).toBeNull()
    expect(resolved.distribution.updateRoot).toBeNull()
    expect(resolved.inAppUpdateEnabled).toBe(false)
    expect(releaseMetaUrls(resolved)).toEqual([])
    expect(speechPackUrls('1.0.0', resolved)).toEqual({ github: null, oss: null })
    expect(messagingGuideUrl('feishu', 'zh-CN', resolved)).toBeNull()
  })

  it('只关掉一路更新时另一路仍在', () => {
    const resolved = resolveOem(config({
      distribution: { repository: '', updateRoot: 'https://updates.example.com/releases' },
    }))
    expect(resolved.distribution.github).toBeNull()
    expect(resolved.distribution.updateRoot).toBe('https://updates.example.com/releases/')
    expect(resolved.inAppUpdateEnabled).toBe(true)
    expect(speechPackUrls('1.0.0', resolved).oss).toBe(
      'https://updates.example.com/optional/speech/speech-pack-1.0.0.zip',
    )
    const nested = resolveOem(config({
      distribution: { repository: '', updateRoot: 'https://updates.example.com/acme/releases/' },
    }))
    expect(speechPackUrls('1.0.0', nested).oss).toBe(
      'https://updates.example.com/acme/optional/speech/speech-pack-1.0.0.zip',
    )
    expect(speechPackUrls('1.0.0', resolved).github).toBeNull()
  })

  it('链接写成空就不显示，不写的项仍是旗鱼默认', () => {
    const resolved = resolveOem(config({
      links: { contactEmail: '', license: '' },
    }))
    expect(resolved.links.contactEmail).toBeNull()
    expect(resolved.links.license).toBeNull()
    expect(resolved.links.website).toBe('https://www.sfterm.com')
    expect(resolved.links.issues).toBe(`https://github.com/${SAILFISH_GITHUB_REPOSITORY}/issues`)
  })

  it('社区技能市场默认开，显式关掉才关', () => {
    expect(resolveOem(config()).communitySkillMarket).toBe(true)
    expect(resolveOem(config({ communitySkillMarket: false })).communitySkillMarket).toBe(false)
  })

  it('安装身份不写用默认，写了就用厂商的', () => {
    const resolved = resolveOem(config({
      identity: {
        appId: 'com.example.app',
        productName: 'Example',
        dataDirName: 'Example',
        protocol: 'Example://',
        cliName: 'example',
      },
      icons: { app: 'oem/logo.png' },
    }))
    expect(resolved.identity.appId).toBe('com.example.app')
    expect(resolved.identity.productName).toBe('Example')
    expect(resolved.identity.dataDirName).toBe('Example')
    expect(resolved.identity.protocol).toBe('example')
    expect(resolved.identity.cliName).toBe('example')
    expect(resolved.icons.app).toBe('oem/logo.png')
  })

  it('模型清单不写或写成空就是不自带；写成地址才打开，登录与否另算', () => {
    expect(resolveOem(config({ models: { catalogUrl: '' } })).models.catalogUrl).toBeNull()
    expect(resolveOem(config({ models: { catalogUrl: 'not a url' } })).models.catalogUrl).toBeNull()
    const resolved = resolveOem(config({
      models: { catalogUrl: 'https://llm.example/models.json', auth: 'login' },
    }))
    expect(resolved.models.catalogUrl).toBe('https://llm.example/models.json')
    expect(resolved.models.auth).toBe('login')
    expect(resolveOem(config({
      models: { catalogUrl: 'https://llm.example/models.json' },
    })).models.auth).toBe('none')
  })
})
