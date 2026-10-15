import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import type { ToolExecutorConfig } from '../../../tools/types'

const mockUserData = path.join(os.tmpdir(), `sft-contact-exec-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { executeContactTool } from '../executor'
import { loadStore, resetWriteQueueForTest } from '../store'
import { ensureAgentWorkspaceDirs } from '../../../tools/file'

function mockExecutor(steps?: string[], visible?: string[]): ToolExecutorConfig {
  return {
    agentId: 'agent-1',
    addStep: (step: { content?: string; toolResult?: string }) => {
      if (step.content) steps?.push(step.content)
      if (step.toolResult) visible?.push(step.toolResult)
      return { id: 's', timestamp: Date.now() }
    },
    updateStep: () => undefined,
  } as unknown as ToolExecutorConfig
}

describe('contact executor', () => {
  beforeEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
    resetWriteQueueForTest()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('contact_add refuses a duplicate alias and contact_update merges the note', async () => {
    const created = await executeContactTool(
      'contact_add',
      '',
      { name: '沈义君', aliases: ['沈总'], role: '证券金融部负责人' },
      'c1',
      {} as never,
      mockExecutor()
    )
    expect(created.success).toBe(true)
    expect(created.output).toContain('已添加')

    const duplicate = await executeContactTool(
      'contact_add',
      '',
      { name: '沈总', note: '10月16日拜访' },
      'c2',
      {} as never,
      mockExecutor()
    )
    expect(duplicate.output).toContain('未新建')
    expect(duplicate.output).toContain('different_person')
    expect(loadStore().contacts).toHaveLength(1)

    const namesake = await executeContactTool(
      'contact_add',
      '',
      { name: '沈总', organization: '另一家', different_person: true },
      'c2b',
      {} as never,
      mockExecutor()
    )
    expect(namesake.output).toContain('已添加')
    expect(loadStore().contacts).toHaveLength(2)
    await executeContactTool('contact_delete', '', { id: loadStore().contacts[1].id }, 'c2c', {} as never, mockExecutor())

    const id = loadStore().contacts[0].id
    const updated = await executeContactTool(
      'contact_update',
      '',
      { id, note: '证券金融部负责人。10月16日拜访' },
      'c3',
      {} as never,
      mockExecutor()
    )
    expect(updated.output).toContain('已更新')
    expect(loadStore().contacts[0].note).toContain('10月16日')
    expect(loadStore().contacts[0].createdAt).toBeTruthy()
  })

  it('points to the legacy notes only on lookups while CONTACTS.md is still there', async () => {
    fs.writeFileSync(path.join(mockUserData, 'agent-workspace', 'CONTACTS.md'), '- 王瑜\n', 'utf-8')
    const added = await executeContactTool(
      'contact_add',
      '',
      { name: '俞枫' },
      'c6',
      {} as never,
      mockExecutor()
    )
    expect(added.output).not.toContain('CONTACTS.md')
    const found = await executeContactTool(
      'contact_search',
      '',
      { query: '王瑜' },
      'c7',
      {} as never,
      mockExecutor()
    )
    expect(found.output).toContain('CONTACTS.md')

    const hit = await executeContactTool(
      'contact_search',
      '',
      { query: '俞枫' },
      'c8',
      {} as never,
      mockExecutor()
    )
    expect(hit.output).not.toContain('CONTACTS.md')

    fs.writeFileSync(
      path.join(mockUserData, 'agent-workspace', 'migrations', 'contacts-md.json'),
      JSON.stringify({ version: 1, status: 'skipped', createdAt: Date.now() }),
      'utf-8'
    )
    const afterSkip = await executeContactTool(
      'contact_search',
      '',
      { query: '王瑜' },
      'c9',
      {} as never,
      mockExecutor()
    )
    expect(afterSkip.output).not.toContain('CONTACTS.md')
  })

  it('entries without id in the file can still be updated', async () => {
    fs.writeFileSync(
      path.join(mockUserData, 'agent-workspace', 'CONTACTS.json'),
      JSON.stringify({ version: 1, contacts: [{ name: '丁宏志' }], updatedAt: 0 }),
      'utf-8'
    )
    const id = loadStore().contacts[0].id
    expect(loadStore().contacts[0].id).toBe(id)
    const updated = await executeContactTool(
      'contact_update',
      '',
      { id, organization: '国元期货' },
      'c10',
      {} as never,
      mockExecutor()
    )
    expect(updated.output).toContain('已更新')
    expect(loadStore().contacts[0]).toMatchObject({ id, organization: '国元期货' })
  })

  it('update and delete steps name the person instead of the id', async () => {
    await executeContactTool(
      'contact_add',
      '',
      { name: '周总', organization: '国元证券' },
      'c11',
      {} as never,
      mockExecutor()
    )
    const id = loadStore().contacts[0].id
    const steps: string[] = []
    const visible: string[] = []
    const exec = mockExecutor(steps, visible)
    const updated = await executeContactTool(
      'contact_update',
      '',
      { id, name: '周立军', add_aliases: ['周总'] },
      'c12',
      {} as never,
      exec
    )
    expect(steps[0]).toBe('更新联系人: 周总 · 国元证券 → 周立军')
    expect(steps.join('\n') + visible.join('\n')).not.toContain(id)
    expect(updated.output).toContain(id)

    steps.length = 0
    visible.length = 0
    const removed = await executeContactTool('contact_delete', '', { id }, 'c13', {} as never, exec)
    expect(steps[0]).toBe('删除联系人: 周立军 · 国元证券')
    expect(steps.join('\n') + visible.join('\n')).not.toContain(id)
    expect(removed.output).toContain(id)
  })

  it('a person with no unit is shown by a phone, and lookups hide the id from the chat', async () => {
    await executeContactTool(
      'contact_add',
      '',
      { name: '（未命名）', channels: [{ kind: 'phone', value: '15255459369' }] },
      'c14',
      {} as never,
      mockExecutor()
    )
    const id = loadStore().contacts[0].id
    const steps: string[] = []
    const visible: string[] = []
    const exec = mockExecutor(steps, visible)
    const listed = await executeContactTool('contact_list', '', {}, 'c15', {} as never, exec)
    expect(listed.output).toContain(id)
    expect(visible.join('\n')).toContain('（未命名）')
    expect(visible.join('\n')).toContain('15255459369')
    expect(visible.join('\n')).not.toContain(id)

    steps.length = 0
    visible.length = 0
    await executeContactTool('contact_delete', '', { id }, 'c16', {} as never, exec)
    expect(steps[0]).toBe('删除联系人: （未命名） · 15255459369')
    expect(steps.join('\n') + visible.join('\n')).not.toContain(id)

    const missing = await executeContactTool('contact_delete', '', { id: 'gone' }, 'c17', {} as never, exec)
    expect(missing.success).toBe(false)
    expect(missing.error).toBe('找不到这位联系人')
    expect(missing.error).not.toContain('gone')
    expect(steps.some(line => line.includes('gone'))).toBe(false)
  })

  it('contact_search finds by alias', async () => {
    await executeContactTool(
      'contact_add',
      '',
      { name: '刘玲玲', aliases: ['Catherine'], kind: 'person' },
      'c4',
      {} as never,
      mockExecutor()
    )
    const found = await executeContactTool(
      'contact_search',
      '',
      { query: 'catherine' },
      'c5',
      {} as never,
      mockExecutor()
    )
    expect(found.output).toContain('刘玲玲')
  })
})
