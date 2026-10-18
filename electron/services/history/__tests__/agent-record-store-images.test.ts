/**
 * 历史记录里的图片落盘：用户自己贴的图（images）和扫描版 PDF 的页面图（docPreviewImages）
 * 各存各的，都不能把 base64 内联进会话文件；读回来两处各自还是各自的图。
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { AgentRecordStore } from '../agent-record-store'
import type { AgentRecord } from '@shared/types'

// 1x1 PNG / JPEG 的 base64（内容不重要，只要能原样写出去再对上）
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='
const JPEG_B64 = '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA='

const USER_IMG = `data:image/png;base64,${PNG_B64}`
const PAGE_1 = `data:image/jpeg;base64,${JPEG_B64}`
const PAGE_2 = `data:image/jpeg;base64,${JPEG_B64}A`

function makeRecord(id: string): AgentRecord {
  return {
    id,
    timestamp: Date.now(),
    terminalId: 'tab-1',
    terminalType: 'assistant',
    userTask: '看看这份扫描件',
    steps: [
      {
        id: 'step-task',
        type: 'user_task',
        content: '看看这份扫描件',
        images: [USER_IMG],
        docPreviewImages: [PAGE_1, PAGE_2],
        timestamp: Date.now(),
      },
      {
        id: 'step-final',
        type: 'final_result',
        content: '读完了',
        timestamp: Date.now(),
      },
    ],
    duration: 1,
    status: 'completed',
  }
}

describe('AgentRecordStore 图片外化', () => {
  let dir: string
  let store: AgentRecordStore

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-record-images-'))
    store = new AgentRecordStore(dir)
  })

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('用户的图和页面图都落成磁盘文件，文件名互不覆盖', () => {
    const record = makeRecord('session-images-1')
    store.saveAgentRecord(record)

    const loaded = store.getAgentRecordById('session-images-1')!
    const task = loaded.steps.find(s => s.id === 'step-task')!

    expect(task.images).toHaveLength(1)
    expect(task.images![0]).toMatch(/^sft-local:\/\/history-image\/.+\/step-task-0\.png$/)
    expect(task.docPreviewImages).toHaveLength(2)
    expect(task.docPreviewImages![0]).toMatch(/^sft-local:\/\/history-image\/.+\/step-task-doc-0\.jpeg$/)
    expect(task.docPreviewImages![1]).toMatch(/^sft-local:\/\/history-image\/.+\/step-task-doc-1\.jpeg$/)

    // 磁盘上确实各有一份
    const imagesRoot = path.join(dir, 'images')
    const files: string[] = []
    const walk = (p: string) => {
      for (const name of fs.readdirSync(p)) {
        const full = path.join(p, name)
        if (fs.statSync(full).isDirectory()) walk(full)
        else files.push(path.basename(full))
      }
    }
    walk(imagesRoot)
    expect(files.sort()).toEqual(['step-task-0.png', 'step-task-doc-0.jpeg', 'step-task-doc-1.jpeg'])
  })

  it('会话文件里不再内联 base64', () => {
    store.saveAgentRecord(makeRecord('session-images-2'))

    const agentDir = path.join(dir, 'agent')
    const raw: string[] = []
    const walk = (p: string) => {
      for (const name of fs.readdirSync(p)) {
        const full = path.join(p, name)
        if (fs.statSync(full).isDirectory()) walk(full)
        else raw.push(fs.readFileSync(full, 'utf-8'))
      }
    }
    walk(agentDir)
    const all = raw.join('\n')
    expect(all).toContain('step-task-doc-0')
    expect(all).not.toContain(';base64,')
  })

  it('没有页面图的步骤不受影响，字段仍然是没有', () => {
    const record = makeRecord('session-images-3')
    delete record.steps[0].docPreviewImages
    store.saveAgentRecord(record)

    const task = store.getAgentRecordById('session-images-3')!.steps.find(s => s.id === 'step-task')!
    expect(task.docPreviewImages).toBeUndefined()
    expect(task.images).toHaveLength(1)
  })

  it('已经是磁盘地址的图再存一次，原样保留，不重复写', () => {
    store.saveAgentRecord(makeRecord('session-images-4'))
    const first = store.getAgentRecordById('session-images-4')!
    store.saveAgentRecord(first)

    const task = store.getAgentRecordById('session-images-4')!.steps.find(s => s.id === 'step-task')!
    expect(task.images![0]).toMatch(/step-task-0\.png$/)
    expect(task.docPreviewImages).toHaveLength(2)
    expect(task.docPreviewImages![0]).toMatch(/step-task-doc-0\.jpeg$/)
  })
})
