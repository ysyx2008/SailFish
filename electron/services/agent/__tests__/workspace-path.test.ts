/**
 * agent-workspace 路径分层单元测试
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.homedir(), `.sft-workspace-test-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import {
  getWorkspacePath,
  getScratchPath,
  ensureAgentWorkspaceDirs,
  isInWorkspace,
  isScratchPath,
  isAutoApproveWorkspacePath,
  assessFileWriteRisk,
  resolveWriteModeIfTargetExists,
} from '../tools/file'

describe('agent workspace paths', () => {
  beforeEach(() => {
    fs.mkdirSync(mockUserData, { recursive: true })
    ensureAgentWorkspaceDirs()
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('getScratchPath creates scratch under workspace', () => {
    const scratch = getScratchPath()
    expect(scratch).toBe(path.join(getWorkspacePath(), 'scratch'))
    expect(fs.existsSync(scratch)).toBe(true)
  })

  it('isAutoApproveWorkspacePath allows scratch, root md files, charts, migrations', () => {
    const ws = getWorkspacePath()
    const scratch = getScratchPath()
    expect(isAutoApproveWorkspacePath(path.join(scratch, 'draft.py'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'TODO.md'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'TODO.json'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'USER.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'HEARTBEAT.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'IDENTITY.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'SOUL.md'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'CONTACTS.md'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'CONTACTS.json'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'charts', 'pie-1.svg'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'migrations', 'todo-md.json'))).toBe(true)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'templates', 'report.docx'))).toBe(false)
    expect(isAutoApproveWorkspacePath(path.join(ws, 'random.py'))).toBe(false)
  })

  it('ensureAgentWorkspaceDirs creates migrations', () => {
    expect(fs.existsSync(path.join(getWorkspacePath(), 'migrations'))).toBe(true)
  })

  it('isScratchPath is narrower than isInWorkspace', () => {
    const ws = getWorkspacePath()
    expect(isInWorkspace(path.join(ws, 'TODO.md'))).toBe(true)
    expect(isScratchPath(path.join(ws, 'TODO.md'))).toBe(false)
    expect(isScratchPath(path.join(getScratchPath(), 'a.txt'))).toBe(true)
  })

  describe('assessFileWriteRisk', () => {
    it('/tmp 写入（含 overwrite）降为 safe', () => {
      expect(assessFileWriteRisk('/tmp/ddb_demo.py', 'create')).toBe('safe')
      expect(assessFileWriteRisk('/tmp/ddb_demo.py', 'overwrite', { fileExists: true })).toBe('safe')
      expect(assessFileWriteRisk('/tmp/ddb_demo.py', 'append')).toBe('safe')
    })

    it('工作区外覆盖已有文件为 dangerous', () => {
      const outside = path.join(os.homedir(), 'outside-write-risk-test.txt')
      expect(assessFileWriteRisk(outside, 'overwrite', { fileExists: true })).toBe('dangerous')
      expect(assessFileWriteRisk(outside, 'create')).toBe('safe')
    })

    it('scratch 内 overwrite 仍为 safe', () => {
      const scratchFile = path.join(getScratchPath(), 'draft.py')
      expect(assessFileWriteRisk(scratchFile, 'overwrite', { fileExists: true })).toBe('safe')
    })

    it('templates 内 overwrite 为 moderate', () => {
      const tpl = path.join(getWorkspacePath(), 'templates', 'report.docx')
      expect(assessFileWriteRisk(tpl, 'overwrite', { fileExists: true })).toBe('moderate')
    })
  })

  describe('resolveWriteModeIfTargetExists', () => {
    it('新建且目标已存在时改成覆盖', () => {
      expect(resolveWriteModeIfTargetExists('create', true)).toBe('overwrite')
    })

    it('新建且目标不存在时仍是新建', () => {
      expect(resolveWriteModeIfTargetExists('create', false)).toBe('create')
    })

    it('覆盖/追加不改', () => {
      expect(resolveWriteModeIfTargetExists('overwrite', true)).toBe('overwrite')
      expect(resolveWriteModeIfTargetExists('append', true)).toBe('append')
    })
  })
})
