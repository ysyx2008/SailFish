import { EventEmitter } from 'events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { AgentRecord } from '@shared/types'

let tmpDir = ''

interface VectorRow {
  docId: string
  content: string
  tags: string
}

const vectorRows: VectorRow[] = []

vi.mock('electron', () => ({
  app: {
    getPath: () => tmpDir,
    getAppPath: () => process.cwd(),
    getName: () => 'SailFish',
    getVersion: () => '1.0.0',
    isPackaged: false,
  },
}))

vi.mock('../knowledge/embedding', () => ({
  getEmbeddingService: () => ({
    setDevice() {},
    async initialize() {},
    getCurrentModel: () => null,
    getDimensions: () => 8,
    isReady: () => true,
    async embedSingle() { return [1, 0, 0, 0, 0, 0, 0, 0] },
    async embed(texts: string[]) { return texts.map(() => [1, 0, 0, 0, 0, 0, 0, 0]) },
    dispose() {},
    async disposeAsync() {},
  }),
}))

vi.mock('../knowledge/storage', () => {
  const vector = Object.assign(new EventEmitter(), {
    async initialize() {},
    isNameIndexBroken: () => false,
    async listNameMeta() { return null },
    async getStats() { return { chunkCount: vectorRows.length, lastUpdated: Date.now() } },
    async getAllDocIds() { return new Set(vectorRows.map(row => row.docId)) },
    async addRecords(incoming: VectorRow[]) { vectorRows.push(...incoming) },
    async removeDocumentChunks(docId: string) {
      return vector.removeDocumentChunksMany([docId])
    },
    async removeDocumentChunksMany(docIds: string[]) {
      const drop = new Set(docIds)
      const before = vectorRows.length
      for (let i = vectorRows.length - 1; i >= 0; i--) {
        if (drop.has(vectorRows[i].docId)) vectorRows.splice(i, 1)
      }
      return before - vectorRows.length
    },
    async hybridSearch(query: string, _embedding: number[], opts?: { tags?: string[] }) {
      const tags = opts?.tags ?? []
      return vectorRows
        .filter(row => {
          const have = row.tags.split(',')
          if (!tags.every(tag => have.includes(tag))) return false
          return row.content.includes(query)
        })
        .map(row => ({ docId: row.docId, content: row.content, score: 0.9 }))
    },
    async removeNames() {},
    async searchNames() { return [] },
    async compact() {},
    async disposeAsync() {},
  })
  return { getVectorStorage: () => vector }
})

import { HistoryService } from '../history.service'
import { getKnowledgeService } from '../knowledge'
import { DEFAULT_KNOWLEDGE_SETTINGS } from '../knowledge/types'

function makeRecord(overrides: Partial<AgentRecord> & { id: string; timestamp: number; duration: number; userTask: string }): AgentRecord {
  return {
    terminalId: 'pty-1',
    terminalType: 'local',
    steps: [],
    status: 'completed',
    ...overrides,
  }
}

describe('按天数清理对话时，知识库里对应的内容一起删', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-history-knowledge-'))
    vectorRows.length = 0
  })

  afterEach(async () => {
    await getKnowledgeService()?.disposeAsync()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('清掉的对话检索不到，留下来的对话和机器笔记还在', async () => {
    const knowledge = getKnowledgeService(
      {
        getKnowledgeSettings: () => ({
          ...DEFAULT_KNOWLEDGE_SETTINGS,
          embeddingMode: 'api',
          enableRerank: false,
        }),
        updateKnowledgeSettings() {},
        get: () => undefined,
      } as never,
      {} as never,
    )
    expect(knowledge).not.toBeNull()

    const history = new HistoryService()
    const oldTime = new Date('2025-01-01T10:00:00').getTime()
    const recentTime = Date.now() - 24 * 60 * 60 * 1000
    const oldPhrase = '旧对话里那句只有这里有的话：紫藤密码柜'
    const recentPhrase = '最近这场还要留着：青瓷茶杯'
    const movedPhrase = '正文还在、索引日期是旧的：青花瓷盘'
    const note = '这台机器自己的笔记：楠木抽屉'

    history.saveAgentRecord(makeRecord({
      id: 'old-session', timestamp: oldTime, duration: 100, userTask: oldPhrase,
    }))
    history.saveAgentRecord(makeRecord({
      id: 'recent-session', timestamp: recentTime, duration: 100, userTask: recentPhrase,
    }))
    history.saveAgentRecord(makeRecord({
      id: 'moved-session', timestamp: oldTime, duration: 100, userTask: movedPhrase,
    }))

    const movedFrom = path.join(tmpDir, 'history', 'agent', '2025-01-01', 'moved-session')
    const movedDate = new Date(recentTime).toISOString().slice(0, 10)
    const movedTo = path.join(tmpDir, 'history', 'agent', movedDate, 'moved-session')
    fs.mkdirSync(path.dirname(movedTo), { recursive: true })
    fs.renameSync(movedFrom, movedTo)

    await knowledge!.indexConversation({
      taskId: 'old-session',
      sessionId: 'old-session',
      hostId: 'personal',
      userRequest: oldPhrase,
      finalResult: '当时记下了',
      status: 'success',
      timestamp: oldTime,
    })
    await knowledge!.indexConversation({
      taskId: 'recent-session',
      sessionId: 'recent-session',
      hostId: 'personal',
      userRequest: recentPhrase,
      finalResult: '还在用',
      status: 'success',
      timestamp: recentTime,
    })
    await knowledge!.indexConversation({
      taskId: 'moved-session',
      sessionId: 'moved-session',
      hostId: 'personal',
      userRequest: movedPhrase,
      finalResult: '目录还在',
      status: 'success',
      timestamp: oldTime,
    })
    const noteId = await knowledge!.addHostMemory('desk', note)
    expect(noteId).toBeTruthy()

    expect((await knowledge!.searchConversations(oldPhrase)).map(hit => hit.userRequest)).toContain(oldPhrase)
    expect((await knowledge!.searchHostMemories('desk')).map(hit => hit.content)).toContain(note)

    await history.cleanupOldRecords(30)

    const left = history.getRecentAgentRecords(10).map(record => record.id)
    expect(left).toContain('recent-session')
    expect(left).toContain('moved-session')
    expect(left).not.toContain('old-session')
    expect((await knowledge!.searchConversations(oldPhrase)).map(hit => hit.userRequest)).not.toContain(oldPhrase)
    expect((await knowledge!.searchConversations(recentPhrase)).map(hit => hit.userRequest)).toContain(recentPhrase)
    expect((await knowledge!.searchConversations(movedPhrase)).map(hit => hit.userRequest)).toContain(movedPhrase)
    expect((await knowledge!.searchHostMemories('desk')).map(hit => hit.content)).toContain(note)
  })
})
