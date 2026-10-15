/**
 * PDF 正文抽取：自己按页面坐标还原正文顺序；类型判别（文字型 / 扫描件 / 哪些页
 * 要 OCR）仍交给结构化抽取件。
 *
 * 为什么不直接用结构化抽取件的 markdown：它给出的正文顺序不可靠——实测一份
 * 法规，每条条文的末尾行被排到了前面，拼出来是「第二十八条 数据。第二十九条
 * 使用价值。」这种残句。顺序错了，表格结构也就不可信，所以宁可丢结构保顺序。
 *
 * worker（utilityProcess）与 CLI/无 worker 回退共用，避免两套逻辑分叉。
 */
import fs from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'
import { buildPdfDocumentInit } from './pdfjs-config.mjs'
import { reflowPage, pageBoxFromView } from './pdf-layout.mjs'

const require = createRequire(import.meta.url)

/** @type {Promise<typeof import('@firecrawl/pdf-inspector') | null> | null} */
let inspectorLoad = null
/** @type {typeof import('pdfjs-dist/legacy/build/pdf.mjs') | null} */
let pdfjsLib = null

function loadInspector() {
  if (!inspectorLoad) {
    inspectorLoad = import('@firecrawl/pdf-inspector').catch(() => null)
  }
  return inspectorLoad
}

async function loadPdfjs() {
  if (pdfjsLib) return pdfjsLib
  const mod = await import('pdfjs-dist/legacy/build/pdf.mjs')
  try {
    const workerPath = require.resolve('pdfjs-dist/legacy/build/pdf.worker.mjs')
    mod.GlobalWorkerOptions.workerSrc = pathToFileURL(workerPath).href
  } catch {
    // 解析不到 worker 时走 pdfjs 默认行为
  }
  pdfjsLib = mod
  return mod
}

/**
 * classifyPdf 给的是 0-indexed 页号，统一转成 1-indexed 并滤掉越界。
 *
 * 注意结构化抽取件的两个入口基准不同：类型判别给 0-indexed，整份抽取给
 * 1-indexed。换回另一个入口就得同时改这里，否则整份差一页。
 *
 * 原先根据「数组里有没有 0」反推索引基准，只有一个来源之后这个猜测既不必要
 * 也不安全——例如只有第 6 页（0-indexed 的 5）需要 OCR 时，数组里没有 0，
 * 会被当成 1-indexed，于是渲错页。
 * @param {unknown} pages
 * @param {number} totalPages
 * @returns {number[]}
 */
export function normalizeOcrPages(pages, totalPages) {
  if (!Array.isArray(pages) || pages.length === 0 || totalPages <= 0) return []
  const zeroBased = pages.filter((n) => Number.isInteger(n) && n >= 0)
  return [...new Set(zeroBased.map((p) => p + 1))]
    .filter((p) => p >= 1 && p <= totalPages)
}

/**
 * 只做类型判别：文字型还是扫描件、哪些页需要 OCR。
 * 正文不从这里来——它给出的顺序不可靠，见文件头说明。
 * @param {string} filePath
 */
async function classifyPdf(filePath) {
  const inspector = await loadInspector()
  if (!inspector?.classifyPdfAsync) return null
  try {
    const result = await inspector.classifyPdfAsync(fs.readFileSync(filePath))
    const pdfType = result.pdfType
    const known = pdfType === 'TextBased' || pdfType === 'Scanned'
      || pdfType === 'ImageBased' || pdfType === 'Mixed'
    if (!known) return null
    const totalPages = Number.isInteger(result.pageCount) ? result.pageCount : 0
    return {
      pdfType,
      totalPages,
      pagesNeedingOcr: normalizeOcrPages(result.pagesNeedingOcr, totalPages),
    }
  } catch {
    // 原生包缺失（如缺组件的 Intel Mac）或判别抛错：正文照抽，只是没有类型信息
    return null
  }
}

/**
 * @param {string} filePath
 * @param {{ maxTextLength?: number, onProgress?: (current: number, total: number) => void }} [opts]
 */
export async function extractPdfText(filePath, opts = {}) {
  // 判别类型和抽正文各自解析一遍，互不依赖，并行跑省掉一半墙钟时间
  const [classification, extraction] = await Promise.all([
    classifyPdf(filePath),
    // 正文抽取是唯一的正文来源，但它失败不该让整份解析失败：加密、损坏的
    // PDF 还能靠类型判别走渲图那条路，至少让用户看见内容
    extractPdfTextWithPdfjs(filePath, opts).then(
      (value) => ({ value, error: null }),
      (error) => ({ value: null, error })
    ),
  ])

  if (!extraction.value) {
    if (!classification) throw extraction.error
    return {
      content: '',
      pageCount: 0,
      totalPages: classification.totalPages,
      pdfType: classification.pdfType,
      pagesNeedingOcr: classification.pagesNeedingOcr,
      extractor: 'layout',
      classifier: 'inspector',
      textLayerMissing: true,
      strippedLines: 0,
    }
  }

  const extracted = extraction.value
  if (!classification) return extracted

  return {
    ...extracted,
    pdfType: classification.pdfType,
    pagesNeedingOcr: classification.pagesNeedingOcr,
    totalPages: classification.totalPages || extracted.totalPages,
    classifier: 'inspector',
    // 说有文字层却一个字也抽不出来，多半是字体缺编码表这类解析 miss。标出来让
    // 上层照扫描件处理（渲前几页交给视觉），用户至少看得见内容。
    textLayerMissing: classification.pdfType === 'TextBased' && !extracted.content,
  }
}

/**
 * @param {string} filePath
 * @param {{ maxTextLength?: number, onProgress?: (current: number, total: number) => void }} [opts]
 */
export async function extractPdfTextWithPdfjs(filePath, opts = {}) {
  const maxTextLength = opts.maxTextLength ?? Infinity
  const onProgress = opts.onProgress
  const pdfjs = await loadPdfjs()
  const data = new Uint8Array(fs.readFileSync(filePath))
  const doc = await pdfjs.getDocument(buildPdfDocumentInit(data)).promise
  const totalPages = doc.numPages
  const textParts = []
  let totalChars = 0
  let extractedPages = 0
  let strippedLines = 0
  try {
    for (let i = 1; i <= totalPages; i++) {
      const page = await doc.getPage(i)
      const tc = await page.getTextContent()
      // 按坐标还原，而不是按内容流顺序拼接。尺子必须是未旋转的 page.view——
      // 文本块坐标就在那个坐标系里，viewport 已经旋转裁剪过了
      const pageText = reflowPage(tc.items, pageBoxFromView(page.view), () => { strippedLines++ })
      if (pageText) textParts.push(pageText)
      extractedPages = i
      totalChars += pageText.length
      onProgress?.(i, totalPages)
      if (totalChars >= maxTextLength) break
    }
  } finally {
    doc.destroy()
  }
  let content = textParts.join('\n\n').trim()
  if (content.length > maxTextLength) content = content.slice(0, maxTextLength)
  return {
    content,
    pageCount: extractedPages,
    totalPages,
    pdfType: undefined,
    pagesNeedingOcr: [],
    extractor: 'layout',
    textLayerMissing: false,
    strippedLines,
  }
}
