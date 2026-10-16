import { describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  FolderPathError,
  bestKeywordPerDoc,
  formatCatalog,
  fuseByDocument,
  folderDeleteNeedsConfirm,
  inFolder,
  normalizeFolder,
  planFolderRename,
  pickCatalogNameHits,
  planNameVectorUpdates,
  renderLibraryRecall,
  resolveRecallFolder,
  visibleFolders,
} from '../catalog'
import {
  buildCardPrompt,
  clampCardSummary,
  initialCard,
  isQuietHour,
  onContentReplaced,
  onGenerateSuccess,
  onHumanConfirm,
  onHumanEdit,
  pickNextCard,
  resumeInterrupted,
} from '../card-policy'
import { CardVectorStore } from '../card-vectors'
import { CardQuota } from '../card-quota'
import { normalizeKnowledgeDocument } from '../../../utils/normalize'
import type { KnowledgeDocument } from '../types'

function doc(partial: Partial<KnowledgeDocument> & Pick<KnowledgeDocument, 'id' | 'fileType'>): KnowledgeDocument {
  return {
    filename: partial.filename || partial.id,
    content: partial.content || '',
    fileSize: 1,
    tags: [],
    createdAt: 1,
    updatedAt: 1,
    chunkCount: 1,
    ...partial,
  }
}

describe('整理目录', () => {
  it('空目录留下来，文件所在的位置也会展开成上级', () => {
    expect(visibleFolders(['公司制度/差旅'], [])).toEqual(['公司制度', '公司制度/差旅'])
    expect(visibleFolders([], ['规章'])).toEqual(['规章'])
  })

  it('改名时下级跟着走，不能挪进自己里面，目标有东西就不盖', () => {
    const docs = [
      { id: 'a', filename: '办法.pdf', folder: '公司制度/差旅' },
      { id: 'b', filename: '其他.pdf', folder: '规章' },
    ]
    const plan = planFolderRename(['公司制度/差旅'], docs, '公司制度', '内控')
    expect(plan.updates).toEqual([{ id: 'a', folder: '内控/差旅' }])
    expect(plan.explicit).toContain('内控/差旅')
    expect(() => planFolderRename(['公司制度/差旅'], docs, '公司制度', '公司制度/差旅')).toThrow(FolderPathError)
    expect(() => planFolderRename(['公司制度/差旅'], docs, '公司制度', '规章')).toThrow(/已经有东西/)
  })

  it('改完会有两份同名文件时不改', () => {
    const docs = [
      { id: 'a', filename: '办法.pdf', folder: '公司制度' },
      { id: 'b', filename: '办法.pdf', folder: '公司制度' },
    ]
    expect(() => planFolderRename(['公司制度'], docs, '公司制度', '内控')).toThrow(/同名/)
  })

  it('目录里只要还有文件就先问，空目录不问', () => {
    const docs = [
      { folder: '公司制度/差旅' },
      { folder: '公司制度' },
    ]
    expect(folderDeleteNeedsConfirm(docs, '公司制度')).toBe(true)
    expect(folderDeleteNeedsConfirm(docs, '公司制度/差旅')).toBe(true)
    expect(folderDeleteNeedsConfirm(docs, '规章')).toBe(false)
  })
})

describe('档案目录', () => {
  it('目录去掉多余斜杠，拒绝往上跳', () => {
    expect(normalizeFolder(' 公司制度 / 差旅 ')).toBe('公司制度/差旅')
    expect(normalizeFolder('')).toBe('')
    expect(() => normalizeFolder('公司制度/../薪酬')).toThrow(FolderPathError)
  })

  it('范围含自己和下级，不含旁支', () => {
    expect(inFolder('公司制度/差旅', '公司制度')).toBe(true)
    expect(inFolder('公司制度', '公司制度')).toBe(true)
    expect(inFolder('公司制度补充', '公司制度')).toBe(false)
    expect(inFolder('个人/健康', '')).toBe(true)
  })

  it('这场明确给了空范围就看全库，没给过才用设置', () => {
    expect(resolveRecallFolder(undefined, '公司制度')).toBe('公司制度')
    expect(resolveRecallFolder('', '公司制度')).toBe('')
    expect(resolveRecallFolder('个人', '公司制度')).toBe('个人')
  })

  it('列目录只有路径、标题和一行说明', () => {
    const text = formatCatalog([
      { id: 'a', filename: '差旅管理办法', folder: '公司制度/差旅', cardSummary: '讲报销额度', cardStatus: 'ready' },
    ], '公司制度')
    expect(text).toContain('公司制度/差旅/差旅管理办法')
    expect(text).toContain('doc_id: a')
    expect(text).toContain('讲报销额度')
    expect(text).not.toContain('全文')
  })
})

describe('目录印象', () => {
  it('卡片和关键词打到同一份时排在只中一边的前面', () => {
    const fused = fuseByDocument(
      ['card-only', 'both'],
      [{ docId: 'both', score: 3, excerpt: '三十个工作日' }]
    )
    expect(fused[0].docId).toBe('both')
    expect(fused[0].fromCard).toBe(true)
    expect(fused[0].fromKeyword).toBe(true)
    expect(fused[0].excerpt).toBe('三十个工作日')
  })

  it('关键词按文档取最高分，低于门槛的不要', () => {
    const picked = bestKeywordPerDoc([
      { docId: 'a', score: 0.2, excerpt: '弱' },
      { docId: 'b', score: 2, excerpt: '甲' },
      { docId: 'b', score: 4, excerpt: '乙' },
    ], 1.2, 5)
    expect(picked).toEqual([{ docId: 'b', score: 4, excerpt: '乙' }])
  })

  it('印象里标明脱节，并守住字数', () => {
    const docs = new Map([
      ['a', { id: 'a', filename: '差旅管理办法', folder: '公司制度', cardStatus: 'stale' as const, cardSummary: '旧说明' }],
    ])
    const text = renderLibraryRecall({
      fused: [{ docId: 'a', score: 1, fromCard: true, fromKeyword: false }],
      docs,
      excerpts: [{ docId: 'a', text: '不得超过三十个工作日' }],
    })
    expect(text).toContain('doc_id: a')
    expect(text).toContain('说明还停在旧版')
    expect(text).toContain('不得超过三十个工作日')
    expect(text).toContain('不是用户刚说的话')

    const huge = renderLibraryRecall({
      fused: [{ docId: 'a', score: 1, fromCard: true, fromKeyword: false }],
      docs,
      excerpts: [{ docId: 'a', text: '字'.repeat(5000) }],
      charBudget: 400,
    })
    expect(huge.length).toBeLessThanOrEqual(500)
  })

  it('对上的目录只带目录本身，范围外的不进来', () => {
    const picked = pickCatalogNameHits([
      { kind: 'folder', score: 0.95, folder: '公司制度' },
      { kind: 'folder', score: 0.9, folder: '公司制度/差旅' },
      { kind: 'file', score: 0.8, folder: '公司制度/差旅', docId: 'leave' },
      { kind: 'folder', score: 0.7, folder: '个人' },
      { kind: 'file', score: 0.6, folder: '个人', docId: 'menu' },
    ], '公司制度')
    expect(picked.folders).toEqual(['公司制度/差旅'])
    expect(picked.fileIds).toEqual(['leave'])

    const docs = new Map([
      ['leave', { id: 'leave', filename: '差旅报销.md', folder: '公司制度/差旅' }],
      ['menu', { id: 'menu', filename: '菜单.md', folder: '公司制度/差旅' }],
    ])
    const text = renderLibraryRecall({
      fused: [{ docId: 'leave', score: 1, fromCard: false, fromKeyword: false }],
      docs,
      excerpts: [],
      folders: picked.folders,
    })
    expect(text).toContain('目录：公司制度/差旅')
    expect(text).toContain('差旅报销.md')
    expect(text).not.toContain('菜单.md')
  })

  it('文件挪了目录，标题没变也要改记它所在的位置', () => {
    const have = new Map([
      ['file:leave', { text: '差旅报销.md', folder: '公司制度/差旅' }],
    ])
    const plan = planNameVectorUpdates([
      { id: 'file:leave', text: '差旅报销.md', folder: '规章' },
    ], have)
    expect(plan.embed).toEqual([])
    expect(plan.reuse).toEqual(['file:leave'])
    expect(plan.stale).toEqual([])
  })
})

describe('检索说明的状态', () => {
  it('人改过的说明，原文换版后留着并标明脱节', () => {
    const kept = onContentReplaced({
      cardStatus: 'ready',
      cardSummary: '我改过的',
      cardSourceHash: 'old',
      cardHumanEdited: true,
    })
    expect(kept.cardStatus).toBe('stale')
    expect(kept.cardSummary).toBe('我改过的')

    const rewritten = onContentReplaced({ cardStatus: 'ready', cardSummary: '机器写的', cardHumanEdited: false })
    expect(rewritten.cardStatus).toBe('pending')
    expect(rewritten.cardSummary).toBeUndefined()
  })

  it('生成过程中原文变了，不把新说明写成已对齐', () => {
    const pending = onGenerateSuccess(initialCard(), '新说明', 'h1', 'h2')
    expect(pending.cardStatus).toBe('pending')
    expect(pending.cardSummary).toBeUndefined()
  })

  it('人确认之后，说明重新对上当前原文', () => {
    const confirmed = onHumanConfirm({
      cardStatus: 'stale',
      cardSummary: '我改过的',
      cardSourceHash: 'old',
      cardHumanEdited: true,
    }, 'new')
    expect(confirmed.cardStatus).toBe('ready')
    expect(confirmed.cardSourceHash).toBe('new')
    expect(confirmed.cardSummary).toBe('我改过的')
  })

  it('人改说明时如果还对得上当前原文，就保持可用', () => {
    const edited = onHumanEdit({
      cardStatus: 'ready',
      cardSummary: '旧',
      cardSourceHash: 'same',
      cardHumanEdited: false,
    }, '我改成这样', 'same')
    expect(edited.cardStatus).toBe('ready')
    expect(edited.cardHumanEdited).toBe(true)
    expect(edited.cardSummary).toBe('我改成这样')
  })

  it('写到一半中断，下次接着排队', () => {
    expect(resumeInterrupted({ cardStatus: 'generating' }).cardStatus).toBe('pending')
  })

  it('优先写最近被翻到、还没有说明的', () => {
    const next = pickNextCard([
      { id: 'old', cardStatus: 'pending', createdAt: 1 },
      { id: 'touched', cardStatus: 'pending', createdAt: 5, cardTouchedAt: 9 },
      { id: 'done', cardStatus: 'ready', createdAt: 1, cardTouchedAt: 99 },
    ], { remainingToday: 20, remainingThisTick: 1 })
    expect(next?.id).toBe('touched')
    expect(pickNextCard(
      [{ id: 'a', cardStatus: 'pending', createdAt: 1 }],
      { remainingToday: 0, remainingThisTick: 1 }
    )).toBeUndefined()
  })

  it('提示词写明说明不能代替原文，超长只给开头', () => {
    const prompt = buildCardPrompt('办法.pdf', '监管', '甲'.repeat(20_000))
    expect(prompt).toContain('不能代替原文')
    expect(prompt).toContain('办法.pdf')
    expect(prompt).toContain('只给出开头')
    expect(prompt.length).toBeLessThan(20_000)
  })

  it('说明压成一段，并有字数上限', () => {
    expect(clampCardSummary('第一句。\n\n第二句。')).toBe('第一句。 第二句。')
    expect(clampCardSummary('字'.repeat(500)).length).toBe(300)
  })

  it('静默时段跨过夜', () => {
    const night = new Date(2026, 9, 15, 23, 30)
    const morning = new Date(2026, 9, 15, 8, 0)
    expect(isQuietHour(night, { start: '22:00', end: '07:00' })).toBe(true)
    expect(isQuietHour(morning, { start: '22:00', end: '07:00' })).toBe(false)
    expect(isQuietHour(night, null)).toBe(false)
  })
})

describe('说明向量和每日额度', () => {
  it('向量文件坏了就当作没有，不把检索带崩', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cards-')), 'card-vectors.json')
    fs.writeFileSync(file, '{', 'utf-8')
    const store = new CardVectorStore(file)
    expect(store.isBroken()).toBe(true)
    expect(store.search([1, 0], 5)).toEqual([])
  })

  it('按余弦把更近的说明排前面', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-cards-')), 'card-vectors.json')
    const store = new CardVectorStore(file)
    store.upsert('far', [0, 1])
    store.upsert('near', [1, 0])
    expect(store.search([1, 0], 1)[0].docId).toBe('near')
  })

  it('同一天的额度重启后还在，第二天重新算', () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sf-quota-')), 'card-quota.json')
    const today = new Date(2026, 9, 15, 12, 0)
    const tomorrow = new Date(2026, 9, 16, 12, 0)
    const quota = new CardQuota(file)
    expect(quota.take(today, 1)).toBe(true)
    expect(quota.take(today, 1)).toBe(false)
    const again = new CardQuota(file)
    expect(again.usedToday(today)).toBe(1)
    expect(again.take(tomorrow, 1)).toBe(true)
  })
})

describe('老档案补字段', () => {
  it('缺字段的文档补成用户放入、说明待写；主机记忆不动', () => {
    const library = normalizeKnowledgeDocument(doc({ id: '1', fileType: 'pdf', filename: '办法.pdf' }))
    expect(library.addedBy).toBe('user')
    expect(library.cardStatus).toBe('pending')
    expect(library.folder).toBe('')

    const memory = normalizeKnowledgeDocument(doc({
      id: '2',
      fileType: 'host-memory',
      source: '用户告知',
    }))
    expect(memory.cardStatus).toBeUndefined()
    expect(memory.source).toBe('用户告知')
  })
})
