import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'

const mockUserData = path.join(os.tmpdir(), `sft-pasted-image-${Date.now()}`)

vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name === 'userData') return mockUserData
      throw new Error(`unexpected getPath: ${name}`)
    },
  },
}))

import { getScratchPath } from '../workspace-paths'
import { deletePastedImage, getPastedImageDir, parseImageDataUrl, savePastedImage } from '../pasted-image'

const PNG_1X1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

describe('pasted-image', () => {
  beforeEach(() => {
    fs.mkdirSync(mockUserData, { recursive: true })
  })

  afterEach(() => {
    fs.rmSync(mockUserData, { recursive: true, force: true })
  })

  it('parseImageDataUrl 抽出 mime 与字节', () => {
    const parsed = parseImageDataUrl(PNG_1X1)
    expect(parsed?.mime).toBe('image/png')
    expect(parsed?.buffer.length).toBeGreaterThan(0)
    expect(parsed?.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))).toBe(true)
  })

  it('空 data URL 返回 null', () => {
    expect(parseImageDataUrl('')).toBeNull()
    expect(parseImageDataUrl('data:image/png;base64,')).toBeNull()
    expect(parseImageDataUrl('not-a-data-url')).toBeNull()
  })

  it('非图片 mime、非 base64 一律拒绝', () => {
    expect(parseImageDataUrl('data:text/plain;base64,aGVsbG8=')).toBeNull()
    expect(parseImageDataUrl('data:image/png,not-base64%ZZ')).toBeNull()
  })

  it('默认超过直接看的上限就拒绝，显式放宽后才能留下更大的原图', () => {
    expect(() => savePastedImage(PNG_1X1, 'a.png', 10)).toThrow(/too large/)
    const kept = savePastedImage(PNG_1X1, 'a.png', 1024)
    expect(fs.existsSync(kept)).toBe(true)
  })

  it('savePastedImage 落到历史目录且不进 scratch', () => {
    const filePath = savePastedImage(PNG_1X1)
    const pastedDir = getPastedImageDir()
    expect(filePath.startsWith(pastedDir)).toBe(true)
    expect(filePath.includes(`${path.sep}history${path.sep}images${path.sep}pasted${path.sep}`)).toBe(true)
    expect(filePath.startsWith(getScratchPath())).toBe(false)
    expect(path.extname(filePath)).toBe('.png')
    expect(fs.existsSync(filePath)).toBe(true)
    expect(fs.readFileSync(filePath).length).toBeGreaterThan(0)
  })

  it('通用文件名用 pasted- 时间戳，有意义的名字保留词干', () => {
    const generic = savePastedImage(PNG_1X1, 'image.png')
    expect(path.basename(generic)).toMatch(/^pasted-\d{8}-\d{6}\.png$/)

    const named = savePastedImage(PNG_1X1, '会议纪要截图.png')
    expect(path.basename(named)).toMatch(/^会议纪要截图-\d{8}-\d{6}\.png$/)
  })

  it('同秒重复落盘不覆盖', () => {
    const a = savePastedImage(PNG_1X1, 'shot.png')
    const b = savePastedImage(PNG_1X1, 'shot.png')
    expect(a).not.toBe(b)
    expect(fs.existsSync(a)).toBe(true)
    expect(fs.existsSync(b)).toBe(true)
  })

  it('deletePastedImage 只删我们落下的粘贴图', () => {
    const pasted = savePastedImage(PNG_1X1)
    const outsider = path.join(mockUserData, 'keep.png')
    fs.writeFileSync(outsider, 'keep')

    expect(deletePastedImage(pasted)).toBe(true)
    expect(fs.existsSync(pasted)).toBe(false)
    expect(deletePastedImage(outsider)).toBe(false)
    expect(fs.existsSync(outsider)).toBe(true)
    expect(deletePastedImage(getPastedImageDir())).toBe(false)
  })
})
