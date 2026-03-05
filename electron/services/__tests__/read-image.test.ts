/**
 * read_file 图片读取功能单元测试
 * 测试 Agent 工具 read_file 对图片文件的处理
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/mock/user/data'),
    getName: vi.fn().mockReturnValue('SailFish'),
    getVersion: vi.fn().mockReturnValue('1.0.0')
  }
}))

vi.mock('../terminal-state.service', () => ({
  getTerminalStateService: () => ({
    getCwd: () => '/tmp'
  })
}))

vi.mock('../file-search.service', () => ({
  getFileSearchService: () => ({})
}))

vi.mock('../document-parser.service', () => ({
  getDocumentParserService: () => ({})
}))

import { VISION_IMAGE_EXTENSIONS, IMAGE_MIME_TYPES, CONVERTIBLE_IMAGE_EXTENSIONS } from '../agent/tools/types'
import { readFile } from '../agent/tools/file'

function createMockExecutor() {
  const steps: Array<Record<string, unknown>> = []
  return {
    steps,
    executor: {
      terminalService: {
        getTerminalType: () => 'local'
      },
      addStep: (step: Record<string, unknown>) => {
        const full = { id: `step-${steps.length}`, timestamp: Date.now(), ...step }
        steps.push(full)
        return full
      },
      updateStep: vi.fn(),
      waitForConfirmation: vi.fn().mockResolvedValue(true),
      isAborted: () => false,
      getHostId: () => undefined,
      hasPendingUserMessage: () => false,
      peekPendingUserMessage: () => undefined,
      consumePendingUserMessage: () => undefined,
      getRealtimeTerminalOutput: () => [],
      getCurrentPlan: () => undefined,
      setCurrentPlan: vi.fn(),
      getTaskMemory: () => ({})
    } as any
  }
}

const mockConfig = { debugMode: false } as any

describe('read_file 图片功能', () => {
  let tempDir: string
  let pngFile: string
  let jpgFile: string
  let bmpFile: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-img-test-'))

    // 1x1 红色 PNG（最小合法 PNG）
    const pngBuffer = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
      'base64'
    )
    pngFile = path.join(tempDir, 'test.png')
    fs.writeFileSync(pngFile, pngBuffer)

    jpgFile = path.join(tempDir, 'photo.jpg')
    fs.writeFileSync(jpgFile, Buffer.from([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10]))

    bmpFile = path.join(tempDir, 'image.bmp')
    fs.writeFileSync(bmpFile, Buffer.from([0x42, 0x4D, 0x00, 0x00]))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  describe('VISION_IMAGE_EXTENSIONS / IMAGE_MIME_TYPES', () => {
    it('应覆盖常见图片格式', () => {
      for (const ext of ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp']) {
        expect(VISION_IMAGE_EXTENSIONS.has(ext)).toBe(true)
      }
    })

    it('MIME 类型与扩展名一一对应', () => {
      expect(IMAGE_MIME_TYPES['.jpg']).toBe('image/jpeg')
      expect(IMAGE_MIME_TYPES['.jpeg']).toBe('image/jpeg')
      expect(IMAGE_MIME_TYPES['.png']).toBe('image/png')
      expect(IMAGE_MIME_TYPES['.gif']).toBe('image/gif')
      expect(IMAGE_MIME_TYPES['.bmp']).toBe('image/bmp')
      expect(IMAGE_MIME_TYPES['.webp']).toBe('image/webp')
    })

    it('不应包含非图片格式', () => {
      for (const ext of ['.txt', '.pdf', '.docx', '.mp4', '.zip']) {
        expect(VISION_IMAGE_EXTENSIONS.has(ext)).toBe(false)
      }
    })
  })

  describe('readFile 读取图片', () => {
    it('读取 PNG 图片返回 base64 data URL', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: pngFile }, mockConfig, executor)

      expect(result.success).toBe(true)
      expect(result.images).toBeDefined()
      expect(result.images!.length).toBe(1)
      expect(result.images![0]).toMatch(/^data:image\/png;base64,/)
    })

    it('读取 JPG 图片使用正确 MIME', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: jpgFile }, mockConfig, executor)

      expect(result.success).toBe(true)
      expect(result.images![0]).toMatch(/^data:image\/jpeg;base64,/)
    })

    it('读取 BMP 图片使用正确 MIME', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: bmpFile }, mockConfig, executor)

      expect(result.success).toBe(true)
      expect(result.images![0]).toMatch(/^data:image\/bmp;base64,/)
    })

    it('output 中包含文件名和大小', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: pngFile }, mockConfig, executor)

      expect(result.output).toContain('test.png')
    })
  })

  describe('readFile info_only 模式', () => {
    it('info_only 不返回 images 字段', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: pngFile, info_only: true }, mockConfig, executor)

      expect(result.success).toBe(true)
      expect(result.images).toBeUndefined()
    })

    it('info_only 返回图片类型信息', async () => {
      const { executor } = createMockExecutor()
      const result = await readFile('pty-1', { path: pngFile, info_only: true }, mockConfig, executor)

      expect(result.output).toContain('PNG')
      expect(result.output).toContain(pngFile)
    })
  })

  describe('readFile 超大图片', () => {
    it('超过 10MB 的图片应返回错误', async () => {
      const bigFile = path.join(tempDir, 'big.png')
      // 创建 >10MB 的文件（稀疏写入节省磁盘）
      const fd = fs.openSync(bigFile, 'w')
      fs.ftruncateSync(fd, 11 * 1024 * 1024)
      fs.closeSync(fd)

      try {
        const { executor } = createMockExecutor()
        const result = await readFile('pty-1', { path: bigFile }, mockConfig, executor)

        expect(result.success).toBe(false)
        expect(result.error).toBeDefined()
      } finally {
        fs.unlinkSync(bigFile)
      }
    })
  })

  describe('非图片文件不走图片逻辑', () => {
    it('.txt 文件不应返回 images', async () => {
      const txtFile = path.join(tempDir, 'readme.txt')
      fs.writeFileSync(txtFile, 'Hello world')

      try {
        const { executor } = createMockExecutor()
        const result = await readFile('pty-1', { path: txtFile }, mockConfig, executor)

        expect(result.success).toBe(true)
        expect(result.images).toBeUndefined()
        expect(result.output).toContain('Hello world')
      } finally {
        fs.unlinkSync(txtFile)
      }
    })
  })
})

// ─── ICO 支持 & 二进制检测 ───────────────────────────────────────────

/** 构造最小合法 ICO 文件（单图标） */
function buildIco(imageData: Buffer, width: number, height: number): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)   // reserved
  header.writeUInt16LE(1, 2)   // type = ICO
  header.writeUInt16LE(1, 4)   // count = 1

  const entry = Buffer.alloc(16)
  entry[0] = width >= 256 ? 0 : width
  entry[1] = height >= 256 ? 0 : height
  entry[2] = 0              // color count
  entry[3] = 0              // reserved
  entry.writeUInt16LE(1, 4)  // color planes
  entry.writeUInt16LE(32, 6) // bits per pixel
  entry.writeUInt32LE(imageData.length, 8)
  entry.writeUInt32LE(22, 12) // offset = 6 + 16

  return Buffer.concat([header, entry, imageData])
}

/** 构造多尺寸 ICO（两个图标） */
function buildMultiSizeIco(small: Buffer, large: Buffer): Buffer {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2)
  header.writeUInt16LE(2, 4) // count = 2

  const entry1 = Buffer.alloc(16)
  entry1[0] = 16; entry1[1] = 16
  entry1.writeUInt16LE(1, 4); entry1.writeUInt16LE(32, 6)
  entry1.writeUInt32LE(small.length, 8)
  entry1.writeUInt32LE(6 + 32, 12) // offset = header + 2 entries

  const entry2 = Buffer.alloc(16)
  entry2[0] = 0; entry2[1] = 0 // 0 = 256
  entry2.writeUInt16LE(1, 4); entry2.writeUInt16LE(32, 6)
  entry2.writeUInt32LE(large.length, 8)
  entry2.writeUInt32LE(6 + 32 + small.length, 12)

  return Buffer.concat([header, entry1, entry2, small, large])
}

describe('read_file ICO 支持', () => {
  let tempDir: string
  let icoWithPng: string
  let icoWithBmp: string
  let icoMultiSize: string
  let icoCorrupted: string
  let icoTooSmall: string

  const PNG_1x1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==',
    'base64'
  )

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-ico-test-'))

    // 1) 正常 ICO（内嵌 PNG）
    icoWithPng = path.join(tempDir, 'icon.ico')
    fs.writeFileSync(icoWithPng, buildIco(PNG_1x1, 1, 1))

    // 2) BMP-only ICO（非 PNG magic）
    const fakeBmp = Buffer.alloc(44)
    fakeBmp.writeUInt32LE(40, 0) // BITMAPINFOHEADER size
    icoWithBmp = path.join(tempDir, 'bmp-icon.ico')
    fs.writeFileSync(icoWithBmp, buildIco(fakeBmp, 1, 1))

    // 3) 多尺寸 ICO（16x16 BMP + 256x256 PNG），应提取最大的 PNG
    icoMultiSize = path.join(tempDir, 'multi.ico')
    const smallBmp = Buffer.alloc(44)
    smallBmp.writeUInt32LE(40, 0)
    fs.writeFileSync(icoMultiSize, buildMultiSizeIco(smallBmp, PNG_1x1))

    // 4) 损坏文件（ICO header 但 offset 越界）
    icoCorrupted = path.join(tempDir, 'corrupt.ico')
    const corrupt = buildIco(PNG_1x1, 1, 1)
    corrupt.writeUInt32LE(99999, 6 + 12) // 篡改 data offset
    fs.writeFileSync(icoCorrupted, corrupt)

    // 5) 过小文件
    icoTooSmall = path.join(tempDir, 'tiny.ico')
    fs.writeFileSync(icoTooSmall, Buffer.from([0, 0, 1, 0]))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('CONVERTIBLE_IMAGE_EXTENSIONS 包含 .ico', () => {
    expect(CONVERTIBLE_IMAGE_EXTENSIONS.has('.ico')).toBe(true)
  })

  it('.ico 不在 VISION_IMAGE_EXTENSIONS 中（需要转换）', () => {
    expect(VISION_IMAGE_EXTENSIONS.has('.ico')).toBe(false)
  })

  it('读取含 PNG 的 ICO 文件返回 base64 PNG data URL', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: icoWithPng }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.images).toBeDefined()
    expect(result.images!.length).toBe(1)
    expect(result.images![0]).toMatch(/^data:image\/png;base64,/)
  })

  it('多尺寸 ICO 提取最大尺寸的 PNG', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: icoMultiSize }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.images).toBeDefined()
    expect(result.images![0]).toMatch(/^data:image\/png;base64,/)
    expect(result.output).toContain('256x256')
  })

  it('BMP-only ICO 不返回 images，返回描述信息', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: icoWithBmp }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.output).toContain('BMP')
  })

  it('损坏的 ICO 文件不崩溃', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: icoCorrupted }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.output).toContain('BMP') // 降级到描述模式
  })

  it('info_only 模式返回 ICO 文件信息', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: icoWithPng, info_only: true }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.images).toBeUndefined()
    expect(result.output).toContain('ICO')
  })
})

describe('read_file 二进制文件检测', () => {
  let tempDir: string
  let binaryFile: string
  let textFile: string
  let utf16LeFile: string
  let utf16BeFile: string
  let utf8BomFile: string
  let emptyFile: string

  beforeAll(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sf-bin-test-'))

    // 二进制文件（含 null bytes）
    binaryFile = path.join(tempDir, 'data.bin')
    const bin = Buffer.alloc(100)
    bin.write('RIFF', 0)
    bin[10] = 0; bin[20] = 0; bin[30] = 0
    fs.writeFileSync(binaryFile, bin)

    // 普通文本文件
    textFile = path.join(tempDir, 'hello.txt')
    fs.writeFileSync(textFile, 'Hello, world!\nLine 2\n')

    // UTF-16 LE BOM 文本（含 null bytes 但不应被判为二进制）
    utf16LeFile = path.join(tempDir, 'utf16le.txt')
    const utf16Le = Buffer.from([0xFF, 0xFE, 0x48, 0x00, 0x69, 0x00]) // BOM + "Hi"
    fs.writeFileSync(utf16LeFile, utf16Le)

    // UTF-16 BE BOM 文本
    utf16BeFile = path.join(tempDir, 'utf16be.txt')
    const utf16Be = Buffer.from([0xFE, 0xFF, 0x00, 0x48, 0x00, 0x69]) // BOM + "Hi"
    fs.writeFileSync(utf16BeFile, utf16Be)

    // UTF-8 BOM 文本
    utf8BomFile = path.join(tempDir, 'utf8bom.txt')
    const utf8Bom = Buffer.from([0xEF, 0xBB, 0xBF, ...Buffer.from('Hello')])
    fs.writeFileSync(utf8BomFile, utf8Bom)

    // 空文件（极小）
    emptyFile = path.join(tempDir, 'empty.dat')
    fs.writeFileSync(emptyFile, Buffer.alloc(0))
  })

  afterAll(() => {
    fs.rmSync(tempDir, { recursive: true, force: true })
  })

  it('二进制文件被检测并拒绝读取', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: binaryFile }, mockConfig, executor)

    expect(result.success).toBe(false)
    expect(result.error).toBeDefined()
    expect(result.error).toContain('.bin')
  })

  it('普通文本文件正常读取', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: textFile }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.output).toContain('Hello, world!')
  })

  it('UTF-16 LE BOM 文件不被误判为二进制', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: utf16LeFile }, mockConfig, executor)

    expect(result.success).toBe(true)
  })

  it('UTF-16 BE BOM 文件不被误判为二进制', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: utf16BeFile }, mockConfig, executor)

    expect(result.success).toBe(true)
  })

  it('UTF-8 BOM 文件正常读取', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: utf8BomFile }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.output).toContain('Hello')
  })

  it('info_only 模式下二进制文件返回信息而非错误', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: binaryFile, info_only: true }, mockConfig, executor)

    expect(result.success).toBe(true)
    expect(result.images).toBeUndefined()
  })

  it('空文件不被误判为二进制', async () => {
    const { executor } = createMockExecutor()
    const result = await readFile('pty-1', { path: emptyFile }, mockConfig, executor)

    expect(result.success).toBe(true)
  })
})
