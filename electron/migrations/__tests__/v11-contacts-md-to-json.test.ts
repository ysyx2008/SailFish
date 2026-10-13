import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('electron', () => ({
  app: { getPath: () => '', getName: () => 'SailFish', getVersion: () => '1.0.0', isPackaged: false },
  BrowserWindow: class {},
}))

import { prepareContactsMdMigration } from '../v11-contacts-md-to-json'
import {
  getContactMigrationMarkerPath,
  readContactMigrationMarker,
} from '../../services/agent/skills/contact/migration-marker'

describe('migration v11 - prepareContactsMdMigration', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-v11-contacts-'))
  })

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true })
  })

  it('skips when no CONTACTS.md', () => {
    expect(prepareContactsMdMigration(tmpDir).status).toBe('skipped')
  })

  it('backs up and marks pending when CONTACTS.md has content', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'CONTACTS.md'), '# 联系人\n- 王瑜\n', 'utf-8')

    const result = prepareContactsMdMigration(tmpDir)
    expect(result.status).toBe('pending')
    expect(fs.existsSync(path.join(ws, 'CONTACTS.md'))).toBe(true)
    expect(fs.existsSync(path.join(ws, 'CONTACTS.md.bak'))).toBe(true)
    expect(readContactMigrationMarker(getContactMigrationMarkerPath(tmpDir))?.status).toBe('pending')
  })

  it('is idempotent when already pending', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'CONTACTS.md'), '- 王瑜\n', 'utf-8')
    prepareContactsMdMigration(tmpDir)
    expect(prepareContactsMdMigration(tmpDir).status).toBe('already_pending')
  })

  it('still asks when CONTACTS.json already has a few entries', () => {
    const ws = path.join(tmpDir, 'agent-workspace')
    fs.mkdirSync(ws, { recursive: true })
    fs.writeFileSync(path.join(ws, 'CONTACTS.md'), '- 旧笔记里的人\n', 'utf-8')
    fs.writeFileSync(
      path.join(ws, 'CONTACTS.json'),
      JSON.stringify({
        version: 1,
        contacts: [{ id: '1', name: '王瑜', kind: 'person', createdAt: 't', updatedAt: 't' }],
        updatedAt: Date.now(),
      }),
      'utf-8'
    )
    expect(prepareContactsMdMigration(tmpDir).status).toBe('pending')
    expect(readContactMigrationMarker(getContactMigrationMarkerPath(tmpDir))?.status).toBe('pending')
    expect(fs.readFileSync(path.join(ws, 'CONTACTS.md'), 'utf-8')).toContain('旧笔记')
  })
})
