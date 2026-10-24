import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  retireLegacyKeywordFile,
  LEGACY_KEYWORD_FILE,
  LEGACY_KEYWORD_FILE_GRACE_MS,
} from '../legacy-keyword-file'

const DAY = 24 * 60 * 60 * 1000

describe('旧的整本关键词索引文件', () => {
  let dir: string
  const file = () => path.join(dir, LEGACY_KEYWORD_FILE)

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-legacy-kw-'))
  })
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true })
  })

  function writeAgedFile(name: string, ageMs: number) {
    const target = path.join(dir, name)
    fs.writeFileSync(target, '{}')
    const when = new Date(Date.now() - ageMs)
    fs.utimesSync(target, when, when)
  }

  it('没有这个文件：什么都不做', async () => {
    expect(await retireLegacyKeywordFile(dir)).toBe('absent')
  })

  it('旧版最近才写过：留着，换回旧版不用重建', async () => {
    writeAgedFile(LEGACY_KEYWORD_FILE, 2 * DAY)
    expect(await retireLegacyKeywordFile(dir)).toBe('kept')
    expect(fs.existsSync(file())).toBe(true)
  })

  it('闲置超过 7 天：连临时文件一起清掉', async () => {
    writeAgedFile(LEGACY_KEYWORD_FILE, LEGACY_KEYWORD_FILE_GRACE_MS + DAY)
    writeAgedFile(`${LEGACY_KEYWORD_FILE}.tmp`, LEGACY_KEYWORD_FILE_GRACE_MS + DAY)
    expect(await retireLegacyKeywordFile(dir)).toBe('removed')
    expect(fs.existsSync(file())).toBe(false)
    expect(fs.existsSync(`${file()}.tmp`)).toBe(false)
  })

  it('临时文件更新过（旧版刚写到一半）：整套都留着', async () => {
    writeAgedFile(LEGACY_KEYWORD_FILE, 30 * DAY)
    writeAgedFile(`${LEGACY_KEYWORD_FILE}.tmp`, 1 * DAY)
    expect(await retireLegacyKeywordFile(dir)).toBe('kept')
    expect(fs.existsSync(file())).toBe(true)
  })
})
