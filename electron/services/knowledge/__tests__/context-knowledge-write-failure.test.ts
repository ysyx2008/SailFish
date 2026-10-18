import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

let tmpDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => tmpDir || os.tmpdir(), getName: () => 'SailFish' },
}))

import { ContextKnowledgeService } from '../context-knowledge'

/** 让「个人」这份写不进去：目标位置被一个非空目录占着，改名会失败 */
function blockWrites(id: string) {
  const dir = path.join(tmpDir, 'knowledge', 'context-docs')
  const target = path.join(dir, `${id}.md`)
  fs.rmSync(target, { force: true })
  fs.mkdirSync(target)
  fs.writeFileSync(path.join(target, 'x'), '')
}

describe('记忆写不进磁盘', () => {
  let ck: ContextKnowledgeService

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ck-write-'))
    ck = new ContextKnowledgeService()
    ck.setDocument('personal', '旧内容')
  })
  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('手动保存失败：抛错，内存里仍是旧的，没有残留临时文件', () => {
    blockWrites('personal')
    expect(() => ck.setDocument('personal', '新内容')).toThrow()
    expect(ck.getDocument('personal')).toBe('旧内容')
    const dir = path.join(tmpDir, 'knowledge', 'context-docs')
    expect(fs.readdirSync(dir).some(f => f.endsWith('.tmp'))).toBe(false)
  })

  it('保存成功：磁盘和内存一致', () => {
    ck.setDocument('personal', '新内容')
    expect(ck.getDocument('personal')).toBe('新内容')
    const file = path.join(tmpDir, 'knowledge', 'context-docs', 'personal.md')
    expect(fs.readFileSync(file, 'utf-8')).toBe('新内容')
  })

  it('目录被删了也能重新建出来写', () => {
    fs.rmSync(path.join(tmpDir, 'knowledge'), { recursive: true, force: true })
    ck.setDocument('personal', '新内容')
    expect(ck.getDocument('personal')).toBe('新内容')
  })

  it('删除失败：抛错，内存里的还在', () => {
    blockWrites('personal')
    expect(() => ck.deleteDocument('personal')).toThrow()
    expect(ck.getDocument('personal')).toBe('旧内容')
  })

  it('自动更新写不进去：抛错让调用方当作没记成，写得进去的那份照常写', () => {
    ck.setDocument('root@prod', '## 磁盘\n旧')
    blockWrites('personal')
    const response = [
      '<memory id="personal">\n## 新段\n内容\n</memory>',
      '<memory id="root@prod">\n## 磁盘\n新\n</memory>',
    ].join('\n')
    expect(() => ck.applyRefreshResponse(response, ['personal', 'root@prod'])).toThrow(/personal/)
    expect(ck.getDocument('personal')).toBe('旧内容')
    expect(ck.getDocument('root@prod')).toContain('新')
  })

  it('带基准保存：基准一致就写；之后被改过就不写，把最新的交回去', () => {
    expect(ck.setDocumentIfUnchanged('personal', '我改的', '旧内容')).toEqual({ conflict: false })
    expect(ck.getDocument('personal')).toBe('我改的')

    ck.setDocument('personal', 'AI 刚写的')
    expect(ck.setDocumentIfUnchanged('personal', '又改了', '我改的')).toEqual({ conflict: true, latest: 'AI 刚写的' })
    expect(ck.getDocument('personal')).toBe('AI 刚写的')
  })

  it('不带基准保存：照旧直接写', () => {
    expect(ck.setDocumentIfUnchanged('personal', '直接写')).toEqual({ conflict: false })
    expect(ck.getDocument('personal')).toBe('直接写')
  })

  it('能取到更新时间；没有这份记忆返回 null', () => {
    expect(ck.getUpdatedAt('personal')).toBeGreaterThan(0)
    expect(ck.getUpdatedAt('不存在')).toBeNull()
  })
})
