/**
 * CONTACTS.md → CONTACTS.json 迁移标记
 * 路径：{userData}/agent-workspace/migrations/contacts-md.json
 */
import * as fs from 'fs'
import * as path from 'path'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('ContactMigrationMarker')

export const LEGACY_CONTACTS_MD = 'CONTACTS.md'
export const CONTACTS_FILENAME = 'CONTACTS.json'
export const MIGRATIONS_DIR = 'migrations'
export const MIGRATION_MARKER_FILENAME = 'contacts-md.json'

export type ContactMigrationStatus = 'pending' | 'deferred' | 'done' | 'failed' | 'skipped'

export interface ContactMigrationMarker {
  version: 1
  status: ContactMigrationStatus
  createdAt: number
  completedAt?: number
  bakPath?: string
  lastError?: string
  note?: string
}

const STATUSES: ContactMigrationStatus[] = ['pending', 'deferred', 'done', 'failed', 'skipped']

export function getWorkspaceDir(userDataPath: string): string {
  return path.join(userDataPath, 'agent-workspace')
}

export function getContactMigrationMarkerPath(userDataPath: string): string {
  return path.join(getWorkspaceDir(userDataPath), MIGRATIONS_DIR, MIGRATION_MARKER_FILENAME)
}

export function readContactMigrationMarker(markerPath: string): ContactMigrationMarker | null {
  try {
    if (!fs.existsSync(markerPath)) return null
    const raw = JSON.parse(fs.readFileSync(markerPath, 'utf-8'))
    if (!raw || typeof raw !== 'object') return null
    const status = raw.status as ContactMigrationStatus
    if (!STATUSES.includes(status)) return null
    return {
      version: 1,
      status,
      createdAt: typeof raw.createdAt === 'number' ? raw.createdAt : Date.now(),
      completedAt: typeof raw.completedAt === 'number' ? raw.completedAt : undefined,
      bakPath: typeof raw.bakPath === 'string' ? raw.bakPath : undefined,
      lastError: typeof raw.lastError === 'string' ? raw.lastError : undefined,
      note: typeof raw.note === 'string' ? raw.note : undefined,
    }
  } catch (e) {
    log.warn('Failed to read contacts migration marker:', e)
    return null
  }
}

export function writeContactMigrationMarker(markerPath: string, marker: ContactMigrationMarker): void {
  fs.mkdirSync(path.dirname(markerPath), { recursive: true })
  const tmp = `${markerPath}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(marker, null, 2), 'utf-8')
  fs.renameSync(tmp, markerPath)
}

export function hasValidContactsJson(jsonPath: string): boolean {
  try {
    if (!fs.existsSync(jsonPath)) return false
    const raw = JSON.parse(fs.readFileSync(jsonPath, 'utf-8'))
    return Array.isArray(raw?.contacts) && raw.contacts.length > 0
  } catch {
    return false
  }
}

export function isContactsMdMigrationPending(userDataPath: string): boolean {
  const marker = readContactMigrationMarker(getContactMigrationMarkerPath(userDataPath))
  return marker?.status === 'pending' || marker?.status === 'failed' || marker?.status === 'deferred'
}
