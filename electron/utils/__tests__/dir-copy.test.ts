import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

let tmpRoot = ''

vi.mock('electron', () => ({
  app: {
    getVersion: () => '1.2.3',
    getPath: () => tmpRoot,
  },
}))

import {
  collectFiles,
  copyDirectoryWithProgress,
  CopyCanceledError,
} from '../dir-copy'
import {
  BACKUP_MARKER_FILENAME,
  exportUserData,
  extractBackupToStaging,
  replaceUserDataFromStaging,
  validateBackupArchive,
  writeBackupMarker,
} from '../data-backup'

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sft-dircopy-'))
})

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
})

describe('collectFiles / copyDirectoryWithProgress', () => {
  it('收集文件并跳过符号链接与指定文件名', () => {
    const src = path.join(tmpRoot, 'src')
    fs.mkdirSync(path.join(src, 'sub'), { recursive: true })
    fs.writeFileSync(path.join(src, 'a.txt'), 'aaa')
    fs.writeFileSync(path.join(src, 'sub', 'b.txt'), 'bb')
    fs.writeFileSync(path.join(src, 'skip-me'), 'x')
    fs.symlinkSync(path.join(src, 'a.txt'), path.join(src, 'link.txt'))

    const { files, totalBytes } = collectFiles(src, { skipNames: ['skip-me'] })
    expect(files.map((f) => f.rel).sort()).toEqual(['a.txt', path.join('sub', 'b.txt')].sort())
    expect(totalBytes).toBe(5)
  })

  it('复制成功并报告进度', async () => {
    const src = path.join(tmpRoot, 'src')
    const dst = path.join(tmpRoot, 'dst')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'f.txt'), 'hello')

    const ticks: number[] = []
    await copyDirectoryWithProgress({
      source: src,
      target: dst,
      progressIntervalMs: 0,
      onProgress: (p) => { ticks.push(p.pct) },
    })
    expect(fs.readFileSync(path.join(dst, 'f.txt'), 'utf-8')).toBe('hello')
    expect(ticks.at(-1)).toBe(100)
  })

  it('取消时抛 CopyCanceledError', async () => {
    const src = path.join(tmpRoot, 'src')
    const dst = path.join(tmpRoot, 'dst')
    fs.mkdirSync(src, { recursive: true })
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(src, `f${i}.txt`), 'x'.repeat(1000))
    }
    let n = 0
    await expect(
      copyDirectoryWithProgress({
        source: src,
        target: dst,
        progressIntervalMs: 0,
        shouldCancel: () => (++n > 2),
      }),
    ).rejects.toBeInstanceOf(CopyCanceledError)
  })

  it('大文件流式复制时中途上报字节进度', async () => {
    const src = path.join(tmpRoot, 'src')
    const dst = path.join(tmpRoot, 'dst')
    fs.mkdirSync(src, { recursive: true })
    // 2.5MiB，超过默认 1MiB 流式阈值
    fs.writeFileSync(path.join(src, 'big.bin'), Buffer.alloc(2.5 * 1024 * 1024, 1))

    const byteTicks: number[] = []
    await copyDirectoryWithProgress({
      source: src,
      target: dst,
      progressIntervalMs: 0,
      streamThresholdBytes: 1024 * 1024,
      onProgress: (p) => { byteTicks.push(p.bytes) },
    })
    expect(fs.statSync(path.join(dst, 'big.bin')).size).toBe(2.5 * 1024 * 1024)
    // 除最终 100% 外，至少有一次中途字节进度
    expect(byteTicks.some((b) => b > 0 && b < 2.5 * 1024 * 1024)).toBe(true)
    expect(byteTicks.at(-1)).toBe(2.5 * 1024 * 1024)
  })
})

describe('data-backup', () => {
  it('exportUserData 打成 zip 并写入标记；取消清理半成品', async () => {
    const src = path.join(tmpRoot, 'userdata')
    const dst = path.join(tmpRoot, 'backup.zip')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'qiyu-terminal-config.json'), '{}')
    fs.writeFileSync(path.join(src, 'data-location.json'), '{}')

    await exportUserData({ source: src, target: dst })
    expect(fs.existsSync(dst)).toBe(true)
    expect(fs.statSync(dst).isFile()).toBe(true)
    // 临时 marker 不应残留在 userData（zip 方案不写盘到 source）
    expect(fs.existsSync(path.join(src, BACKUP_MARKER_FILENAME))).toBe(false)

    const v = await validateBackupArchive(dst)
    expect(v.ok).toBe(true)

    const staging = path.join(tmpRoot, 'staging')
    await extractBackupToStaging({ archive: dst, staging })
    expect(fs.existsSync(path.join(staging, 'qiyu-terminal-config.json'))).toBe(true)
    expect(fs.existsSync(path.join(staging, 'data-location.json'))).toBe(false)
    expect(fs.existsSync(path.join(staging, BACKUP_MARKER_FILENAME))).toBe(true)

    const dst2 = path.join(tmpRoot, 'backup2.zip')
    let n = 0
    await expect(
      exportUserData({
        source: src,
        target: dst2,
        shouldCancel: () => (++n > 0),
      }),
    ).rejects.toBeInstanceOf(CopyCanceledError)
    expect(fs.existsSync(dst2)).toBe(false)
    expect(fs.existsSync(`${dst2}.sft-partial`)).toBe(false)
  })

  it('取消时删除 .sft-partial，不碰已有目标文件', async () => {
    const src = path.join(tmpRoot, 'userdata-keep')
    const dst = path.join(tmpRoot, 'keep.zip')
    fs.mkdirSync(src, { recursive: true })
    for (let i = 0; i < 30; i++) {
      fs.writeFileSync(path.join(src, `f${i}.bin`), Buffer.alloc(64 * 1024, i))
    }
    fs.writeFileSync(dst, 'old-good-backup')

    let n = 0
    await expect(
      exportUserData({
        source: src,
        target: dst,
        shouldCancel: () => (++n > 3),
      }),
    ).rejects.toBeInstanceOf(CopyCanceledError)

    expect(fs.readFileSync(dst, 'utf-8')).toBe('old-good-backup')
    expect(fs.existsSync(`${dst}.sft-partial`)).toBe(false)
  })

  it('replaceUserDataFromStaging 替换内容并保留 keepNames', () => {
    const userData = path.join(tmpRoot, 'ud')
    const staging = path.join(userData, '.restore-staging')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(userData, 'old.json'), 'old')
    fs.writeFileSync(path.join(userData, 'data-location.json'), '{"keep":true}')
    fs.writeFileSync(path.join(staging, 'new.json'), 'new')
    writeBackupMarker(staging)

    replaceUserDataFromStaging(userData, staging, {
      keepNames: ['data-location.json', '.restore-staging', '.restore-old'],
    })

    expect(fs.existsSync(path.join(userData, 'old.json'))).toBe(false)
    expect(fs.readFileSync(path.join(userData, 'new.json'), 'utf-8')).toBe('new')
    expect(fs.readFileSync(path.join(userData, 'data-location.json'), 'utf-8')).toBe('{"keep":true}')
    expect(fs.existsSync(staging)).toBe(false)
    expect(fs.existsSync(path.join(userData, '.restore-old'))).toBe(false)
    expect(fs.existsSync(path.join(userData, BACKUP_MARKER_FILENAME))).toBe(false)
  })

  it('replace 中途失败时尽量回滚旧文件', () => {
    const userData = path.join(tmpRoot, 'ud2')
    const staging = path.join(userData, '.restore-staging')
    fs.mkdirSync(staging, { recursive: true })
    fs.writeFileSync(path.join(userData, 'keep-me.json'), 'old')
    fs.writeFileSync(path.join(staging, 'clash.json'), 'new')
    // 目标已是目录 → rename 文件到该路径会失败
    fs.mkdirSync(path.join(userData, 'clash.json'))

    expect(() =>
      replaceUserDataFromStaging(userData, staging, {
        keepNames: ['data-location.json', '.restore-staging', '.restore-old', 'clash.json'],
      }),
    ).toThrow()
    const stillThere =
      fs.existsSync(path.join(userData, 'keep-me.json')) ||
      fs.existsSync(path.join(userData, '.restore-old', 'keep-me.json'))
    expect(stillThere).toBe(true)
  })

  it('validateBackupArchive 拒绝无效文件', async () => {
    const d = path.join(tmpRoot, 'empty.zip')
    fs.writeFileSync(d, 'not-a-zip')
    expect(await validateBackupArchive(d)).toEqual({ ok: false, error: 'invalid_marker' })

    const dir = path.join(tmpRoot, 'adir')
    fs.mkdirSync(dir)
    expect(await validateBackupArchive(dir)).toEqual({ ok: false, error: 'not_archive' })
  })

  it('zip 打包进度随实际处理增长，完成前不到 100%', async () => {
    const src = path.join(tmpRoot, 'userdata-prog')
    const dst = path.join(tmpRoot, 'prog.zip')
    fs.mkdirSync(src, { recursive: true })
    for (let i = 0; i < 8; i++) {
      fs.writeFileSync(path.join(src, `f${i}.bin`), Buffer.alloc(256 * 1024, i))
    }

    const ticks: number[] = []
    await exportUserData({
      source: src,
      target: dst,
      onProgress: (p) => { ticks.push(p.pct) },
    })
    expect(ticks.length).toBeGreaterThan(1)
    expect(ticks.at(-1)).toBe(100)
    // 若中间曾报 100% 再继续，说明仍在用入队假进度
    const lastIdx = ticks.length - 1
    expect(ticks.slice(0, lastIdx).every((p) => p < 100)).toBe(true)
  })

  it('已压缩扩展名使用 STORE，文本仍 DEFLATE', async () => {
    const src = path.join(tmpRoot, 'userdata-store')
    const dst = path.join(tmpRoot, 'store.zip')
    fs.mkdirSync(src, { recursive: true })
    fs.writeFileSync(path.join(src, 'small.txt'), 'compressible '.repeat(2000))
    fs.writeFileSync(path.join(src, 'model.bin'), Buffer.alloc(100_000, 9))
    // 大 JSON 仍应压缩，不能因体积走 STORE
    fs.writeFileSync(path.join(src, 'big.json'), JSON.stringify({ x: 'y'.repeat(3000) }).repeat(200))

    await exportUserData({ source: src, target: dst })

    const yauzl = await import('yauzl')
    const methods = await new Promise<Record<string, number>>((resolve, reject) => {
      yauzl.default.open(dst, { lazyEntries: true }, (err, zip) => {
        if (err || !zip) return reject(err ?? new Error('open failed'))
        const map: Record<string, number> = {}
        zip.on('error', reject)
        zip.on('end', () => resolve(map))
        zip.on('entry', (entry) => {
          map[entry.fileName.replace(/\\/g, '/')] = entry.compressionMethod
          zip.readEntry()
        })
        zip.readEntry()
      })
    })
    // 0 = STORE, 8 = DEFLATE
    expect(methods['model.bin']).toBe(0)
    expect(methods['small.txt']).toBe(8)
    expect(methods['big.json']).toBe(8)
  })

  it('浏览器缓存不进包，同名的用户目录仍在；读不了的文件跳过且压缩包仍生成', async () => {
    const src = path.join(tmpRoot, 'userdata-skip')
    const dst = path.join(tmpRoot, 'skip.zip')
    const cache = path.join(src, 'browser-profiles', '_default_', 'Default', 'Cache', 'Cache_Data')
    fs.mkdirSync(cache, { recursive: true })
    fs.writeFileSync(path.join(cache, 'f_000026'), 'cache-bytes')
    fs.writeFileSync(path.join(src, 'browser-profiles', '_default_', 'Default', 'Cookies'), 'cookie-jar')
    fs.writeFileSync(path.join(src, 'browser-profiles', '_default_', 'LOCK'), 'lock')
    const userCache = path.join(src, 'notes', 'Cache')
    fs.mkdirSync(userCache, { recursive: true })
    fs.writeFileSync(path.join(userCache, 'keep.txt'), 'keep-me')
    fs.writeFileSync(path.join(src, 'ok.txt'), 'ok')
    const locked = path.join(src, 'locked.bin')
    fs.writeFileSync(locked, 'secret')
    fs.chmodSync(locked, 0o000)
    try {
      let readable = true
      try {
        const fh = await fs.promises.open(locked, 'r')
        await fh.close()
      } catch {
        readable = false
      }

      const stats = await exportUserData({ source: src, target: dst })
      expect(fs.existsSync(dst)).toBe(true)

      const yauzl = await import('yauzl')
      const names = await new Promise<string[]>((resolve, reject) => {
        yauzl.default.open(dst, { lazyEntries: true }, (err, zip) => {
          if (err || !zip) return reject(err ?? new Error('open failed'))
          const list: string[] = []
          zip.on('error', reject)
          zip.on('end', () => resolve(list))
          zip.on('entry', (entry) => {
            list.push(entry.fileName.replace(/\\/g, '/'))
            zip.readEntry()
          })
          zip.readEntry()
        })
      })

      expect(names).toContain('ok.txt')
      expect(names).toContain('notes/Cache/keep.txt')
      expect(names).toContain('browser-profiles/_default_/Default/Cookies')
      expect(names.some((n) => n.includes('Cache_Data') || n.endsWith('f_000026'))).toBe(false)
      expect(names).not.toContain('browser-profiles/_default_/LOCK')

      if (!readable) {
        expect(names).not.toContain('locked.bin')
        expect(stats.skippedUnreadable).toBe(1)
      }
    } finally {
      fs.chmodSync(locked, 0o644)
    }
  })
})
