import { describe, it, expect, vi } from 'vitest'
import * as os from 'os'
import * as path from 'path'
import type { ConfigService } from '../config.service'

const mockUserData = path.join(os.tmpdir(), `sft-skillhub-${process.pid}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
  shell: { openPath: vi.fn() },
}))

import { mapSkillHubSearchItems, parseSkillHubInstallId, skillHubLocalId, SkillMarketService } from '../skill-market.service'
import { UserSkillService } from '../user-skill.service'

describe('mapSkillHubSearchItems', () => {
  it('maps SkillHub list items and prefers the Chinese description', () => {
    const skills = mapSkillHubSearchItems([
      {
        slug: 'excel',
        namespace: { canonicalName: '@kunlungrowth/excel' },
        name: 'Excel',
        description: 'English description',
        description_zh: '处理表格',
        version: '1.0.2',
        ownerName: 'u_441b0ae9',
        category: 'office-efficiency',
        tags: null,
      },
    ])

    expect(skills).toEqual([
      {
        id: '@kunlungrowth/excel',
        name: 'Excel',
        description: '处理表格',
        version: '1.0.2',
        author: 'u_441b0ae9',
        source: 'skillhub',
        tags: [],
        category: 'office-efficiency',
        url: 'https://api.skillhub.cn/api/v1/download?slug=%40kunlungrowth%2Fexcel',
      },
    ])
  })

  it('keeps same short names from different authors apart', () => {
    const skills = mapSkillHubSearchItems([
      { slug: 'excel', namespace: { canonicalName: '@kunlungrowth/excel' }, name: 'A' },
      { slug: 'excel', namespace: { canonicalName: '@zcwl/excel' }, name: 'B' },
    ])
    expect(skills.map(skill => skill.id)).toEqual(['@kunlungrowth/excel', '@zcwl/excel'])
    expect(skillHubLocalId(skills[0].id)).not.toBe(skillHubLocalId(skills[1].id))
  })

  it('drops items without an author-qualified name', () => {
    const skills = mapSkillHubSearchItems([
      { slug: 'excel', name: 'bare' },
      { slug: '../etc', namespace: { canonicalName: '../etc' }, name: 'bad' },
      { name: 'missing' },
    ])
    expect(skills).toEqual([])
  })

  it('round-trips an author-qualified name and the local folder name', () => {
    const canonical = '@kunlungrowth/excel'
    const localId = skillHubLocalId(canonical)
    expect(localId.startsWith('skillhub-')).toBe(true)
    expect(localId.includes('/') || localId.includes('@')).toBe(false)
    expect(parseSkillHubInstallId(canonical)).toEqual({ canonical, localId })
    expect(parseSkillHubInstallId(localId)).toEqual({ canonical, localId })
    expect(parseSkillHubInstallId('excel')).toBeNull()
  })

  it('truncates a long description', () => {
    const skills = mapSkillHubSearchItems([
      {
        slug: 'long-desc',
        namespace: { canonicalName: '@owner/long-desc' },
        name: 'long',
        description_zh: '文'.repeat(400),
      },
    ])
    expect(skills[0].description.endsWith('…')).toBe(true)
    expect(skills[0].description.length).toBe(301)
  })
})

describe('SkillHub live', () => {
  it.skipIf(!process.env.SKILLHUB_LIVE)('searches and previews a real skill', async () => {
    const config = { get: () => '', set: () => {} } as unknown as ConfigService
    const market = new SkillMarketService(config, new UserSkillService())
    const found = await market.searchSkillHub('pdf')
    expect(found.length).toBeGreaterThan(0)
    expect(found.every(skill => skill.source === 'skillhub')).toBe(true)
    const preview = await market.previewSkill(found[0].id, 'skillhub')
    expect(preview.success).toBe(true)
    expect(preview.content && preview.content.length).toBeGreaterThan(20)
    expect(preview.skill?.source).toBe('skillhub')
  }, 30000)
})
