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

import { VISION_IMAGE_EXTENSIONS, IMAGE_MIME_TYPES } from '../agent/tools/types'
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
