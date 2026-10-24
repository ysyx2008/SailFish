import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { localDestinationInside } from '@shared/utils/local-destination'
import { downloadDirTree, type DownloadDirClient, type RemoteDownloadEntry } from '../sftp-download-tree'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true })
  }
})

describe('localDestinationInside', () => {
  const dir = '/tmp/chosen'

  it('普通文件名落在所选目录里', () => {
    expect(localDestinationInside(dir, 'readme.txt', path.posix)).toBe('/tmp/chosen/readme.txt')
    expect(localDestinationInside(dir, 'foo..bar', path.posix)).toBe('/tmp/chosen/foo..bar')
    expect(localDestinationInside(dir, '..hidden', path.posix)).toBe('/tmp/chosen/..hidden')
  })

  it('名字解析到目录外面时拒绝', () => {
    expect(localDestinationInside(dir, '../outside.txt', path.posix)).toBeNull()
    expect(localDestinationInside(dir, '../../.ssh/id_rsa', path.posix)).toBeNull()
    expect(localDestinationInside(dir, '/etc/passwd', path.posix)).toBeNull()
    expect(localDestinationInside(dir, '..', path.posix)).toBeNull()
    expect(localDestinationInside(dir, '.', path.posix)).toBeNull()
    expect(localDestinationInside(dir, '', path.posix)).toBeNull()
  })

  it('Windows 上反斜杠同样不能写出目录', () => {
    const win = path.win32
    const folder = 'C:\\Users\\me\\Downloads\\chosen'
    expect(localDestinationInside(folder, 'readme.txt', win)).toBe('C:\\Users\\me\\Downloads\\chosen\\readme.txt')
    expect(localDestinationInside(folder, '..\\outside.txt', win)).toBeNull()
    expect(localDestinationInside(folder, '..\\..\\Windows\\evil', win)).toBeNull()
    expect(localDestinationInside(folder, 'D:\\evil', win)).toBeNull()
  })
})

describe('downloadDirTree', () => {
  it('普通文件和子目录会下载，带 .. 的名字不写到所选目录外面', async () => {
    const root = mkdtempSync(path.join(tmpdir(), 'sft-sftp-dl-'))
    roots.push(root)
    const chosen = path.join(root, 'inbox', 'chosen')
    const marker = path.join(root, 'keep.txt')
    writeFileSync(marker, 'stay')

    const tree: Record<string, RemoteDownloadEntry[]> = {
      '/remote/proj': [
        { name: '.', type: 'd' },
        { name: '..', type: 'd' },
        { name: 'readme.txt', type: '-' },
        { name: '..hidden', type: '-' },
        { name: '../outside.txt', type: '-' },
        { name: 'notes', type: 'd' },
      ],
      '/remote/proj/notes': [
        { name: 'keep.txt', type: '-' },
        { name: '../../.ssh/id_rsa', type: '-' },
      ],
    }
    const got: string[] = []
    const client: DownloadDirClient = {
      async list(remotePath) {
        return tree[remotePath] ?? []
      },
      async get(remotePath, localPath) {
        got.push(`${remotePath} -> ${localPath}`)
        mkdirSync(path.dirname(localPath), { recursive: true })
        writeFileSync(localPath, remotePath)
      },
    }

    const skipped = await downloadDirTree(client, '/remote/proj', chosen)

    expect(skipped).toEqual(['../outside.txt', '../../.ssh/id_rsa'])
    expect(readFileSync(path.join(chosen, 'readme.txt'), 'utf8')).toBe('/remote/proj/readme.txt')
    expect(readFileSync(path.join(chosen, '..hidden'), 'utf8')).toBe('/remote/proj/..hidden')
    expect(readFileSync(path.join(chosen, 'notes', 'keep.txt'), 'utf8')).toBe('/remote/proj/notes/keep.txt')
    expect(existsSync(path.join(root, 'inbox', 'outside.txt'))).toBe(false)
    expect(existsSync(path.join(root, '.ssh', 'id_rsa'))).toBe(false)
    expect(readFileSync(marker, 'utf8')).toBe('stay')
    expect(got.every(line => line.includes(chosen))).toBe(true)
  })
})
