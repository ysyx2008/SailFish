import { describe, it, expect, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/sft-contact-mentions-unused' },
}))

import type { Contact } from '@sailfish/shared-types'
import { buildMentionNote, findMentionedContacts, formatMentionCard, MAX_MENTION_CARDS } from '../mentions'

const now = '2026-10-14T00:00:00.000Z'
function person(id: string, name: string, extra: Partial<Contact> = {}): Contact {
  return { id, name, kind: 'person', createdAt: now, updatedAt: now, ...extra }
}

const liang = person('c-liang', '梁晓东', {
  aliases: ['梁总', '晓东'],
  organization: '火山引擎',
  role: '采购负责人',
  channels: [
    { kind: 'email', value: 'Liang@Example.com' },
    { kind: 'phone', value: '138 0000 0000' },
  ],
})
const shen = person('c-shen', '沈义君', { aliases: ['沈总'] })
const yijun = person('c-yj', '义君')
const wangA = person('c-wy-a', '王瑜', { organization: '火山引擎' })
const wangB = person('c-wy-b', '王瑜', { organization: '国元证券' })
const al = person('c-al', 'Al', { aliases: ['Al Chen'] })
const one = person('c-one', '王', { aliases: ['老王'] })
const contacts = [liang, shen, yijun, wangA, wangB, al, one]

const ids = (text: string) => findMentionedContacts(contacts, text).map(c => c.id)
const none = { alreadyInConversation: () => false }

describe('findMentionedContacts', () => {
  it('认全名和两个字的简称', () => {
    expect(ids('帮我约一下梁总下周见面')).toEqual(['c-liang'])
    expect(ids('沈义君那边回了吗')).toEqual(['c-shen'])
    expect(ids('老王说明天到')).toEqual(['c-one'])
  })

  it('一个字的不认', () => {
    expect(ids('王老师你好')).toEqual([])
  })

  it('重叠时长的算数，落在里面的别人的名字不单算', () => {
    expect(ids('沈义君来了')).toEqual(['c-shen'])
    expect(ids('义君来了')).toEqual(['c-yj'])
  })

  it('只是交叠、分不清是谁，就都认', () => {
    const zhangWei = person('c-zw', '张伟')
    const weiMing = person('c-wm', '伟明')
    expect(findMentionedContacts([zhangWei, weiMing], '张伟明来了').map(c => c.id)).toEqual(['c-zw', 'c-wm'])
  })

  it('同名的几位一起认出来', () => {
    expect(ids('王瑜的报价发来了')).toEqual(['c-wy-a', 'c-wy-b'])
  })

  it('英文名要成词，大小写不论', () => {
    expect(ids('I also think so')).toEqual([])
    expect(ids('ask al about it')).toEqual(['c-al'])
  })

  it('邮箱、电话也认，句末的点不碍事', () => {
    expect(ids('发到 liang@example.com.')).toEqual(['c-liang'])
    expect(ids('发到 liang@example.com.cn')).toEqual([])
    expect(ids('打 13800000000 问问')).toEqual(['c-liang'])
    expect(ids('打 +86 138-0000-0000 问问')).toEqual(['c-liang'])
    expect(ids('订单号 138000000001')).toEqual([])
  })

  it('长串数字尾巴恰好一样不算，换行两边的数字不连成号码', () => {
    expect(ids('流水号 2026101413800000000')).toEqual([])
    expect(ids('数量 138\n00000000 件')).toEqual([])
  })

  it('按第一次出现的先后排', () => {
    expect(ids('先找沈总，再找梁总')).toEqual(['c-shen', 'c-liang'])
  })
})

describe('buildMentionNote', () => {
  it('没提到人就不附', () => {
    expect(buildMentionNote(contacts, '今天天气不错', none)).toBeUndefined()
  })

  it('名片带编号、单位、简称、联系方式', () => {
    const note = buildMentionNote(contacts, '约梁总', none)!
    expect(note.split('\n')[0]).toBe('这句话里出现的名字或联系方式，联系人里记着：')
    expect(note).toContain('- 梁晓东〔联系人 c-liang〕人 · 火山引擎 · 采购负责人；简称：梁总、晓东；邮箱 Liang@Example.com；电话 138 0000 0000')
  })

  it('长备注截断', () => {
    const chatty = person('c-c', '话痨', { note: '很长'.repeat(100) })
    const card = formatMentionCard(chatty)
    expect(card.endsWith('……')).toBe(true)
    expect(card.length).toBeLessThan(200)
  })

  it('这场里带过、信息没变的不再带；改过了再带', () => {
    const card = formatMentionCard(liang)
    const seen = { alreadyInConversation: (text: string) => text === card }
    expect(buildMentionNote(contacts, '约梁总', seen)).toBeUndefined()
    const changed = { ...liang, role: '副总裁' }
    expect(buildMentionNote([changed], '约梁总', seen)).toContain('副总裁')
  })

  it(`超过 ${MAX_MENTION_CARDS} 位只报名字`, () => {
    const many = Array.from({ length: 7 }, (_, i) => person(`c-${i}`, `张三${'甲乙丙丁戊己庚'[i]}`))
    const text = many.map(c => c.name).join('，')
    const note = buildMentionNote(many, text, none)!
    expect(note.split('\n').filter(line => line.startsWith('- '))).toHaveLength(MAX_MENTION_CARDS)
    expect(note).toContain('另外还提到：张三己、张三庚（未展开，contact 技能里可查）')
  })
})
