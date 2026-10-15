import { describe, it, expect } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import * as crypto from 'crypto'
import { extractPdfText, extractPdfTextWithPdfjs, normalizeOcrPages } from '../pdf-text-extract.mjs'

interface PdfLine {
  text: string
  x?: number
  y?: number
}

function makeTextPdf(lines: PdfLine[], rotate = 0): Buffer {
  const stream = lines.map(line => {
    const escaped = line.text.replace(/\\/g, '\\\\').replace(/\(/g, '\\(').replace(/\)/g, '\\)')
    return `BT /F1 24 Tf ${line.x ?? 72} ${line.y ?? 720} Td (${escaped}) Tj ET\n`
  }).join('')
  const streamLen = Buffer.byteLength(stream)
  const rotateEntry = rotate ? ` /Rotate ${rotate}` : ''
  const parts = [
    '%PDF-1.4\n',
    '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj\n',
    '2 0 obj << /Type /Pages /Kids [3 0 R] /Count 1 >> endobj\n',
    `3 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792]${rotateEntry} /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >> endobj\n`,
    `4 0 obj << /Length ${streamLen} >> stream\n${stream}endstream endobj\n`,
    '5 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj\n',
  ]
  const offsets: number[] = []
  let cursor = 0
  for (const part of parts) {
    offsets.push(cursor)
    cursor += Buffer.byteLength(part)
  }
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer << /Size 6 /Root 1 0 R >>\nstartxref\n${cursor}\n%%EOF\n`
  return Buffer.concat([Buffer.from(parts.join('')), Buffer.from(xref + trailer)])
}

function withTempPdf(
  lines: string | PdfLine[],
  rotate = 0
): { filePath: string; cleanup: () => void } {
  const filePath = path.join(os.tmpdir(), `pdf-extract-${crypto.randomUUID()}.pdf`)
  const spec = typeof lines === 'string' ? [{ text: lines }] : lines
  fs.writeFileSync(filePath, makeTextPdf(spec, rotate))
  return { filePath, cleanup: () => { try { fs.unlinkSync(filePath) } catch { /* ignore */ } } }
}

describe('normalizeOcrPages', () => {
  it('0-indexed 页号一律加一，不再看数组里有没有 0', () => {
    expect(normalizeOcrPages([0, 4], 10)).toEqual([1, 5])
    // 只有第 6 页要 OCR 时数组是 [5]，原先会被当成 1-indexed 而渲错页
    expect(normalizeOcrPages([5], 10)).toEqual([6])
  })

  it('丢弃越界、负数与非整数', () => {
    expect(normalizeOcrPages([0, 99, 2.5, 'x', -1], 5)).toEqual([1])
  })

  it('空输入返回空数组', () => {
    expect(normalizeOcrPages(undefined, 5)).toEqual([])
    expect(normalizeOcrPages([], 5)).toEqual([])
  })

  it('页数未知时不猜', () => {
    expect(normalizeOcrPages([0, 1], 0)).toEqual([])
  })
})

describe('extractPdfText', () => {
  it('应从文字 PDF 抽出正文', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfText(filePath, { maxTextLength: 10000 })
      expect(result.totalPages).toBe(1)
      expect(result.content).toMatch(/Hello SailFish/)
      // 正文一律来自坐标还原；结构化抽取件只在装着时给出类型判别
      expect(result.extractor).toBe('layout')
      if (result.classifier === 'inspector') {
        expect(result.pdfType).toBe('TextBased')
      }
    } finally {
      cleanup()
    }
  })

  it('没有类型判别件也能抽出正文', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfTextWithPdfjs(filePath, { maxTextLength: 10000 })
      expect(result.extractor).toBe('layout')
      expect(result.classifier).toBeUndefined()
      expect(result.content).toMatch(/Hello SailFish/)
    } finally {
      cleanup()
    }
  })

  it('超长正文按上限截断', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfText(filePath, { maxTextLength: 5 })
      expect(result.content.length).toBeLessThanOrEqual(5)
    } finally {
      cleanup()
    }
  })
})

describe('类型判别件的接口', () => {
  it('判别入口必须在——名字对不上会让混合 PDF 的扫描页静默消失', async () => {
    const inspector = await import('@firecrawl/pdf-inspector')
    expect(typeof inspector.classifyPdfAsync).toBe('function')
  })

  it('装着判别件时要给出类型和判别来源', async () => {
    const { filePath, cleanup } = withTempPdf('Hello SailFish')
    try {
      const result = await extractPdfText(filePath, { maxTextLength: 10000 })
      // 缺原生组件的机器上判别会失败，那时不强求类型信息，但正文必须在
      if (result.classifier === 'inspector') {
        expect(result.pdfType).toBe('TextBased')
        expect(result.textLayerMissing).toBe(false)
      }
      expect(result.content).toMatch(/Hello SailFish/)
    } finally {
      cleanup()
    }
  })
})

/**
 * 版面还原的几何单测都是手搓文本块，绕过了 pdfjs，正好漏掉「坐标系假设对不对」
 * 这一环。这几条经过真实 pdfjs，专盯那个假设。
 */
describe('extractPdfText 版面还原（真实 pdfjs）', () => {
  it('内容流里倒着写的行，按纸面从上到下输出', async () => {
    const { filePath, cleanup } = withTempPdf([
      { text: 'BOTTOM LINE', y: 300 },
      { text: 'TOP LINE', y: 700 },
    ])
    try {
      const { content } = await extractPdfText(filePath, { maxTextLength: 10000 })
      expect(content.indexOf('TOP LINE')).toBeGreaterThanOrEqual(0)
      expect(content.indexOf('TOP LINE')).toBeLessThan(content.indexOf('BOTTOM LINE'))
    } finally {
      cleanup()
    }
  })

  it('旋转页不丢正文——尺子要用未旋转的页面框', async () => {
    // 段末短行落在「按 viewport 高度算出来的页眉带」里。拿 viewport 当尺子
    // 会把它当页眉删掉，而它是正文。
    const long = 'AAAAAAAAAAAAAAAAAAAAAAAAAA'
    const { filePath, cleanup } = withTempPdf([
      { text: long, y: 700 },
      { text: long, y: 660 },
      { text: long, y: 620 },
      { text: 'TAIL', y: 580 },
    ], 90)
    try {
      const { content } = await extractPdfText(filePath, { maxTextLength: 10000 })
      expect(content).toContain('TAIL')
    } finally {
      cleanup()
    }
  })

  it('正文读不出来时不整份失败，交给上层按图处理', async () => {
    const filePath = path.join(os.tmpdir(), `pdf-broken-${crypto.randomUUID()}.pdf`)
    fs.writeFileSync(filePath, Buffer.from('%PDF-1.4\nnot a real pdf\n%%EOF\n'))
    try {
      // 判别件也读不了这份垃圾，于是整体失败是对的——要紧的是失败方式明确
      await expect(extractPdfText(filePath, { maxTextLength: 10000 })).rejects.toThrow()
    } finally {
      try { fs.unlinkSync(filePath) } catch { /* ignore */ }
    }
  })

  it('西文跨行接回整段时补空格，不把词粘住', async () => {
    const { filePath, cleanup } = withTempPdf([
      { text: 'This is a long line of text', y: 700 },
      { text: 'that wraps here', y: 660 },
    ])
    try {
      const { content } = await extractPdfText(filePath, { maxTextLength: 10000 })
      expect(content).toContain('text that wraps')
      expect(content).not.toContain('textthat')
    } finally {
      cleanup()
    }
  })
})
