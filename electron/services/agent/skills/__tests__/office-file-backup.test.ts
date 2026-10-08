import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  forgetOfficeBackupMemoryForTest,
  officeBackupPath,
  officeFileCreatedInConversation,
  resetOfficeBackupStateForTest,
  setOfficeBackupStateDirForTest,
  snapshotOfficeFileBeforeOverwrite,
} from '../office-file-backup'

describe('snapshotOfficeFileBeforeOverwrite', () => {
  let tmpDir: string

  afterEach(() => {
    resetOfficeBackupStateForTest()
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  function file(name: string): string {
    return path.join(tmpDir, name)
  }

  it('本场新建的文件不留备份，之后再覆盖也不留', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    const fp = file('新建.xlsx')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '第一稿')
    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '第二稿')

    expect(fs.existsSync(officeBackupPath(fp))).toBe(false)
    expect(fs.readFileSync(fp, 'utf-8')).toBe('第二稿')
  })

  it('本场开始前已有的文件只在第一次覆盖前留一份，内容是动手前的', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    const fp = file('季度.docx')
    fs.writeFileSync(fp, '原来的')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '改过一次')
    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '改过两次')

    expect(fs.readFileSync(officeBackupPath(fp), 'utf-8')).toBe('原来的')
    expect(fs.readdirSync(tmpDir).filter(n => n.includes('.bak'))).toEqual(['季度.docx.bak'])
  })

  it('换一场对话再改，把那一份更新成这次动手前', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    const fp = file('季度.docx')
    fs.writeFileSync(fp, '原来的')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '上一场留下的')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-2')
    fs.writeFileSync(fp, '这一场改的')

    expect(fs.readFileSync(officeBackupPath(fp), 'utf-8')).toBe('上一场留下的')
    expect(fs.readdirSync(tmpDir).filter(n => n.endsWith('.bak'))).toHaveLength(1)
  })

  it('记下这场之后，即便内存清空，再覆盖也不会把原件盖掉', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    setOfficeBackupStateDirForTest(path.join(tmpDir, 'state'))
    const fp = file('季度.docx')
    fs.writeFileSync(fp, '原来的')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '改过')
    forgetOfficeBackupMemoryForTest()
    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')

    expect(fs.readFileSync(officeBackupPath(fp), 'utf-8')).toBe('原来的')
  })

  it('对不上这场对话时，不盖掉已经留下的备份', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    const fp = file('季度.docx')
    fs.writeFileSync(fp, '原来的')

    snapshotOfficeFileBeforeOverwrite(fp, 'conv-1')
    fs.writeFileSync(fp, '改过')
    snapshotOfficeFileBeforeOverwrite(fp, undefined)

    expect(fs.readFileSync(officeBackupPath(fp), 'utf-8')).toBe('原来的')
  })

  it('只把本场新建的文件记成自己的，开始前已有的不算', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-office-bak-'))
    const created = file('新建.docx')
    const existing = file('原来.docx')
    fs.writeFileSync(existing, '原来的')

    snapshotOfficeFileBeforeOverwrite(created, 'conv-1')
    snapshotOfficeFileBeforeOverwrite(existing, 'conv-1')

    expect(officeFileCreatedInConversation(created, 'conv-1')).toBe(true)
    expect(officeFileCreatedInConversation(existing, 'conv-1')).toBe(false)
    expect(officeFileCreatedInConversation(created, 'conv-2')).toBe(false)
    expect(officeFileCreatedInConversation(created, undefined)).toBe(false)
  })
})
