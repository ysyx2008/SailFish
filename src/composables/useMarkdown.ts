/**
 * Markdown 渲染 composable
 * 处理 Markdown 解析、代码块交互和文件路径点击
 */
import { marked, type Token } from 'marked'
import { applyCjkFriendlyMarkdown } from '../utils/cjk-friendly-marked'
import { useTerminalStore } from '../stores/terminal'
import { toast } from './useToast'
import {
  advanceBarePathScan,
  createBareFilePathPattern,
  finalizeBarePathMatch,
  isLocalFilePath,
  normalizeUncForOpen,
} from '../utils/local-file-path'

applyCjkFriendlyMarkdown()

// ==================== Mermaid 图表渲染 ====================
// 设计：marked 把 ```mermaid 代码块渲染成占位 <div class="mermaid-block">（存 encodeURIComponent
// 后的源码），真正画图由 renderMermaidBlocks 在 DOM 落地后懒加载 mermaid 完成。
// - 懒加载：mermaid 包体积大（~3MB），首次见到 mermaid 块时才动态 import，后续命中模块缓存
// - 固定白底浅色主题：不跟随明暗 UI 主题，图表始终是干净的浅色背景（与 chart skill 默认 light 一致）
// - 流式安全：AI 输出未完成时源码语法不完整，先用 mermaid.parse 校验，失败就跳过、等下次完整再渲染
// - SVG 缓存：相同源码只 render 一次，缓存 SVG 字符串，避免虚拟滚动重建 DOM 时反复渲染（render 较重）

type MermaidApi = typeof import('mermaid')['default']

let mermaidPromise: Promise<MermaidApi> | null = null
let mermaidInited = false

const MERMAID_SVG_CACHE_MAX = 200
// 完整图缓存：key = 完整源码（trim 后），value = SVG。命中即视为终态（done）
const mermaidSvgCache = new Map<string, string>()

// 部分图缓存：流式渐进渲染过程中每个「可成功渲染的前缀」的 SVG。
// 作用：流式时 v-html 每来一个 token 就整段重建 DOM、清空已注入的 SVG，导致两次异步渲染
// 之间出现空白闪烁。renderer.code 在重建时同步查这里、注入「当前源码的最长已渲染前缀」的
// SVG 作为占位，让图不闪、只是滞后一帧；随后异步渲染再把它升级到更新的进度。
const MERMAID_PARTIAL_CACHE_MAX = 80
const mermaidPartialCache = new Map<string, string>()

const getMermaid = async (): Promise<MermaidApi> => {
  if (!mermaidPromise) {
    mermaidPromise = import('mermaid').then((m) => m.default)
  }
  const mermaid = await mermaidPromise
  if (!mermaidInited) {
    mermaid.initialize({
      startOnLoad: false,
      // strict：移除内嵌 HTML / click 交互，AI 输出的图表内容不可信，必须 sanitize
      securityLevel: 'strict',
      theme: 'base',
      fontFamily:
        '-apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", "Helvetica Neue", Helvetica, Arial, sans-serif',
      themeVariables: {
        background: '#ffffff',
        primaryColor: '#eef2ff',
        primaryBorderColor: '#a5b4fc',
        primaryTextColor: '#1e293b',
        secondaryColor: '#f1f5f9',
        secondaryBorderColor: '#cbd5e1',
        tertiaryColor: '#f8fafc',
        tertiaryBorderColor: '#e2e8f0',
        lineColor: '#94a3b8',
        textColor: '#334155',
        fontSize: '14px',
      },
      flowchart: {
        curve: 'basis',
        // 用 SVG 原生 <text> 而非 foreignObject(HTML) 渲染节点文字：界面上两者都正常，
        // 但导出/复制时要把 SVG 光栅化成 PNG（<img> → canvas），foreignObject 里的 HTML
        // 在光栅化时常渲染错位/被裁（"界面完美、导出遮挡"）。<text> 几何固定在 SVG 内，
        // 光栅化前后完全一致，导出不再遮挡。
        htmlLabels: false,
        padding: 12,
      },
    })
    mermaidInited = true
  }
  return mermaid
}

const cacheMermaidSvg = (src: string, svg: string): void => {
  if (mermaidSvgCache.size >= MERMAID_SVG_CACHE_MAX) {
    const oldest = mermaidSvgCache.keys().next().value
    if (oldest !== undefined) mermaidSvgCache.delete(oldest)
  }
  mermaidSvgCache.set(src, svg)
}

const cacheMermaidPartial = (src: string, svg: string): void => {
  // 重新插入到末尾，维持「越新越靠后」便于 LRU 式淘汰最旧（最短）的前缀
  if (mermaidPartialCache.has(src)) mermaidPartialCache.delete(src)
  if (mermaidPartialCache.size >= MERMAID_PARTIAL_CACHE_MAX) {
    const oldest = mermaidPartialCache.keys().next().value
    if (oldest !== undefined) mermaidPartialCache.delete(oldest)
  }
  mermaidPartialCache.set(src, svg)
}

/**
 * 找出当前源码「最长的、已渲染过的前缀」对应的 SVG，用于流式重建时的同步占位。
 * 流式中图源码单调增长，故此前渲染过的较短前缀必然是当前源码的前缀。
 */
const findLatestMermaidPartial = (current: string): string | undefined => {
  let bestKey = ''
  let bestSvg: string | undefined
  for (const [key, svg] of mermaidPartialCache) {
    if (key.length > bestKey.length && current.startsWith(key)) {
      bestKey = key
      bestSvg = svg
    }
  }
  return bestSvg
}

let mermaidIdSeq = 0

/**
 * 把已渲染的 mermaid <svg> 元素序列化成 data URL（image/svg+xml）。
 * - 从 viewBox/属性补齐显式宽高，让 useImageActions 栅格化时拿得到 naturalWidth（否则按比例失真）
 * - 插入白色背景矩形：mermaid SVG 本身透明，导出 PNG / 复制到剪贴板时透明会被某些应用画成黑底
 */
export const mermaidSvgToDataUrl = (svgEl: SVGSVGElement): string => {
  const clone = svgEl.cloneNode(true) as SVGSVGElement
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg')

  let w = svgEl.width?.baseVal?.value || 0
  let h = svgEl.height?.baseVal?.value || 0
  const vb = svgEl.viewBox?.baseVal
  if ((!w || !h) && vb && vb.width && vb.height) {
    w = vb.width
    h = vb.height
  }
  if (w && h) {
    clone.setAttribute('width', String(Math.round(w)))
    clone.setAttribute('height', String(Math.round(h)))
  }

  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect')
  bg.setAttribute('x', '0')
  bg.setAttribute('y', '0')
  bg.setAttribute('width', '100%')
  bg.setAttribute('height', '100%')
  bg.setAttribute('fill', '#ffffff')
  clone.insertBefore(bg, clone.firstChild)

  const xml = new XMLSerializer().serializeToString(clone)
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(xml)}`
}

/**
 * 渐进渲染：从完整源码开始，逐行回退找到「最长可成功渲染的前缀」。
 * 流式输出时最后一行往往是半截语法（如 `B --> API Gat`），整段 parse 会失败；
 * 去掉不完整的尾行后前面已输出的节点就能先画出来——实现「AI 输出到哪、图就画到哪」。
 * 返回 complete 标记当前是否为完整图（用于决定是否标记 done + 缓存 + 显示工具栏）。
 */
const renderMermaidProgressive = async (
  mermaid: MermaidApi,
  src: string
): Promise<{ svg: string; complete: boolean } | null> => {
  const lines = src.split('\n')
  for (let n = lines.length; n >= 1; n--) {
    const sub = lines.slice(0, n).join('\n').trim()
    if (!sub) continue
    try {
      await mermaid.parse(sub)
    } catch {
      continue
    }
    try {
      const { svg } = await mermaid.render(`sf-mermaid-${++mermaidIdSeq}`, sub)
      return { svg, complete: n === lines.length }
    } catch {
      continue
    }
  }
  return null
}

/**
 * 扫描容器内所有 mermaid 占位块，懒加载 mermaid 后画成 SVG（支持流式渐进渲染）。
 * - `data-mermaid-state="done"` 的块为终态，跳过
 * - `data-mermaid-rendered` 记录上次渲染所用源码：与当前一致则跳过——既避免重复渲染，
 *   也防止本函数写入 innerHTML 反过来触发 MutationObserver 造成死循环
 * - 完整图：缓存 SVG + 标记 done + 挂复制/下载工具栏；部分图：标记 partial，不缓存、不挂工具栏
 * - 调用方应自行 debounce
 */
const renderMermaidBlocks = async (root: HTMLElement | null): Promise<void> => {
  if (!root) return
  const blocks = Array.from(
    root.querySelectorAll<HTMLElement>('.mermaid-block:not([data-mermaid-state="done"])')
  )
  if (blocks.length === 0) return

  // 比较/记录统一用编码值（data-mermaid-src 原始属性值）：既安全（含引号/换行的源码不破坏
  // HTML），也让 renderer.code 能在拼字符串时同步预注入完整图（见 renderer.code）而被这里识别跳过

  // 先用缓存兜一遍（完整图），能命中的不必加载 mermaid
  const pending: HTMLElement[] = []
  for (const el of blocks) {
    const srcEnc = el.getAttribute('data-mermaid-src') || ''
    const src = decodeURIComponent(srcEnc).trim()
    if (!src) continue
    if (el.getAttribute('data-mermaid-rendered') === srcEnc) continue
    const cached = mermaidSvgCache.get(src)
    if (cached) {
      el.innerHTML = cached
      el.setAttribute('data-mermaid-state', 'done')
      el.setAttribute('data-mermaid-rendered', srcEnc)
      continue
    }
    pending.push(el)
  }
  if (pending.length === 0) return

  let mermaid: MermaidApi
  try {
    mermaid = await getMermaid()
  } catch {
    return
  }

  for (const el of pending) {
    const srcEnc = el.getAttribute('data-mermaid-src') || ''
    const current = decodeURIComponent(srcEnc).trim()
    if (!current) continue
    if (el.getAttribute('data-mermaid-state') === 'done') continue
    if (el.getAttribute('data-mermaid-rendered') === srcEnc) continue

    const cached = mermaidSvgCache.get(current)
    if (cached) {
      el.innerHTML = cached
      el.setAttribute('data-mermaid-state', 'done')
      el.setAttribute('data-mermaid-rendered', srcEnc)
      continue
    }

    const result = await renderMermaidProgressive(mermaid, current)

    // 渲染期间源码可能又变了（流式），只在仍匹配时写入；不匹配则留待下次扫描
    if ((el.getAttribute('data-mermaid-src') || '') !== srcEnc) continue

    if (!result) {
      // 一行都渲染不出（如刚冒头的 "flow"）：记下当前源码避免重复尝试，等新内容到来再试
      el.setAttribute('data-mermaid-rendered', srcEnc)
      continue
    }

    if (result.complete) {
      cacheMermaidSvg(current, result.svg)
      el.innerHTML = result.svg
      el.setAttribute('data-mermaid-state', 'done')
    } else {
      // 缓存这一帧的部分图，供 renderer.code 在下次 v-html 重建时同步占位、避免闪空
      cacheMermaidPartial(current, result.svg)
      el.innerHTML = result.svg
      el.setAttribute('data-mermaid-state', 'partial')
    }
    el.setAttribute('data-mermaid-rendered', srcEnc)
  }
}

const writeClipboard = async (text: string): Promise<boolean> => {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // fallback: 动态创建的 DOM 元素中 navigator.clipboard 可能因用户手势丢失而失败
    try {
      const textarea = document.createElement('textarea')
      textarea.value = text
      textarea.style.cssText = 'position:fixed;opacity:0;left:-9999px'
      document.body.appendChild(textarea)
      textarea.select()
      const ok = document.execCommand('copy')
      document.body.removeChild(textarea)
      return ok
    } catch {
      return false
    }
  }
}

/**
 * 检测文本是否为 HTTP(S) URL
 * 仅识别 http/https 协议，避免 javascript:/data: 等危险协议
 */
const isHttpUrl = (text: string): boolean => {
  const trimmed = text.trim()
  if (!/^https?:\/\//i.test(trimmed)) return false
  try {
    const url = new URL(trimmed)
    return url.protocol === 'http:' || url.protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * 放进标签正文的文字。marked 交给自定义 renderer 的是原文，默认实现会转义；
 * 换掉默认实现之后得自己转，否则行内代码、语言名里的尖括号会变成真标签。
 */
const escapeHtml = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * HTML 属性值转义
 */
const escapeAttr = (text: string): string => {
  return text
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

/**
 * 解码 HTML 实体（用于从 marked 输出中还原原始文本）
 */
const decodeHtmlEntities = (text: string): string => {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}

/**
 * 后处理 HTML：将文本节点中的裸 HTTP(S) URL 转为可点击链接
 * 仅处理不在 <a>、<code>、<pre> 标签内的文本
 * 必须在 wrapBareFilePaths 之前执行，避免 URL 中的 "p://" 片段被误识别为 Windows 盘符路径
 */
const wrapBareUrls = (html: string): string => {
  // 匹配 http/https URL：贪婪匹配非空白、非 <>、非引号、非反引号字符
  // 注意：反引号之内的内容由 codespan 处理，不会到这里
  const urlPattern = /https?:\/\/[^\s<>"'`]+/gi
  // 结尾常见的中英文标点不纳入链接
  const trailingPunct = /[.,;:!?。，；：！？、)\]】』」》>]+$/

  const parts = html.split(/(<[^>]+>)/g)
  const depth = { a: 0, code: 0, pre: 0 }

  return parts.map(part => {
    if (part.startsWith('<')) {
      if (/<a[\s>]/i.test(part)) depth.a++
      else if (/<\/a>/i.test(part)) depth.a = Math.max(0, depth.a - 1)
      if (/<code[\s>]/i.test(part)) depth.code++
      else if (/<\/code>/i.test(part)) depth.code = Math.max(0, depth.code - 1)
      if (/<pre[\s>]/i.test(part)) depth.pre++
      else if (/<\/pre>/i.test(part)) depth.pre = Math.max(0, depth.pre - 1)
      return part
    }

    if (depth.a > 0 || depth.code > 0 || depth.pre > 0) return part

    return part.replace(urlPattern, (match) => {
      // 剥离尾部标点（如 "访问 https://example.com/。" 中的 "。"）
      const tail = trailingPunct.exec(match)
      let url = match
      let suffix = ''
      if (tail) {
        url = match.slice(0, -tail[0].length)
        suffix = tail[0]
      }
      if (!isHttpUrl(url)) return match
      return `<a href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer" class="external-url-link" title="点击在浏览器中打开">${url}</a>${suffix}`
    })
  }).join('')
}

/**
 * 后处理 HTML：将文本节点中的裸文件路径转为可点击链接
 * 仅处理不在 <a>、<code>、<pre> 标签内的文本
 *
 * Unix 部分字符类含 `\\`：tool_call 卡片中显示的 shell 命令常含 `\<空格>` 转义形式
 * （如 `/Users/yushen/Library/Application\ Support/...`），不识别会让前半段截断、
 * 后半段被单独包链接、`::before` 的 📄 emoji 出现在路径中间。整段识别后由主进程 IPC
 * 反转义 `\<char>` 还原为真实路径。
 */
const wrapBareFilePaths = (html: string): string => {
  // 匹配常见文件路径模式（支持中文、日文、韩文、欧洲字符等 Unicode 路径）
  // Unix：多级可不带扩展名（/opt/homebrew/bin/python3、目录尾 /）；单级须带扩展名
  // Windows 盘符 / UNC / Home：见 createBareFilePathPattern
  const filePathPattern = createBareFilePathPattern()

  // 拆分 HTML 为标签和文本节点
  const parts = html.split(/(<[^>]+>)/g)
  const depth = { a: 0, code: 0, pre: 0 }

  return parts.map(part => {
    if (part.startsWith('<')) {
      // 跟踪标签嵌套深度
      if (/<a[\s>]/i.test(part)) depth.a++
      else if (/<\/a>/i.test(part)) depth.a = Math.max(0, depth.a - 1)
      if (/<code[\s>]/i.test(part)) depth.code++
      else if (/<\/code>/i.test(part)) depth.code = Math.max(0, depth.code - 1)
      if (/<pre[\s>]/i.test(part)) depth.pre++
      else if (/<\/pre>/i.test(part)) depth.pre = Math.max(0, depth.pre - 1)
      return part
    }

    // 在 <a>、<code>、<pre> 内不做处理
    if (depth.a > 0 || depth.code > 0 || depth.pre > 0) return part

    // 不用 String.replace：边界失败时须 lastIndex+1，否则贪婪匹配会吞掉后续真路径
    const out: string[] = []
    let last = 0
    let m: RegExpExecArray | null
    filePathPattern.lastIndex = 0
    while ((m = filePathPattern.exec(part)) !== null) {
      const path = finalizeBarePathMatch(m[0], part, m.index)
      filePathPattern.lastIndex = advanceBarePathScan(part, m.index, m[0], path)
      if (!path) continue
      if (m.index > last) out.push(part.slice(last, m.index))
      const openPath = normalizeUncForOpen(path)
      out.push(
        `<a class="file-path-link" data-file-path="${escapeAttr(openPath)}" title="点击打开文件">${path}</a>`
      )
      last = m.index + path.length
    }
    if (last < part.length) out.push(part.slice(last))
    return out.length > 0 ? out.join('') : part
  }).join('')
}

const MARKDOWN_CACHE_MAX = 500
const markdownCache = new Map<string, string>()

export function useMarkdown() {
  const terminalStore = useTerminalStore()

  // 配置 marked 渲染器
  const renderer = new marked.Renderer()

  // 自定义代码块渲染（添加复制按钮）
  // 使用 data 属性标记，通过事件委托处理点击，解决流式输出时按钮不可用的问题
  // 兼容 marked 不同版本的 API
  renderer.code = (codeOrToken: string | { text: string; lang?: string }, language?: string) => {
    // 兼容新旧版本 marked API
    let code: string
    let lang: string
    
    if (typeof codeOrToken === 'object' && codeOrToken !== null) {
      // 新版本 marked，参数是 token 对象
      code = codeOrToken.text || ''
      lang = codeOrToken.lang || 'text'
    } else {
      // 旧版本 marked，参数是分散的
      code = codeOrToken as string
      lang = language || 'text'
    }
    
    // Mermaid 图表：输出占位 div，真正渲染由 renderMermaidBlocks 在 DOM 落地后懒加载完成。
    // 源码用 encodeURIComponent 存进 data 属性，避免 HTML 属性转义破坏语法（换行/引号等）。
    // 关键：若该图此前已完整渲染过（命中缓存），直接把 SVG 同步拼进字符串——这样流式
    // 时 v-html 反复重建 DOM 也不会闪空白（完整图随每次重渲染立即带出），renderMermaidBlocks
    // 看到 data-mermaid-rendered === data-mermaid-src 会跳过，不重复渲染。
    if (lang === 'mermaid') {
      const trimmed = code.trim()
      const enc = encodeURIComponent(code)
      const cached = mermaidSvgCache.get(trimmed)
      if (cached) {
        return `<div class="mermaid-block" data-mermaid-src="${enc}" data-mermaid-rendered="${enc}" data-mermaid-state="done">${cached}</div>`
      }
      // 流式中：注入最近已渲染的部分图作占位（不设 data-mermaid-rendered，让异步渲染继续升级它），
      // 避免每次 v-html 重建时闪成空白
      const partial = findLatestMermaidPartial(trimmed)
      if (partial) {
        return `<div class="mermaid-block" data-mermaid-src="${enc}" data-mermaid-state="partial">${partial}</div>`
      }
      return `<div class="mermaid-block" data-mermaid-src="${enc}"></div>`
    }

    const escapedCode = escapeHtml(code)
    
    // 始终渲染按钮，通过事件委托在点击时获取代码内容
    const copyBtn = `<button class="code-copy-btn" data-action="copy" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
    
    const sendBtn = `<button class="code-send-btn" data-action="send" title="发送到终端"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>`
    
    return `<div class="code-block"><div class="code-header"><span>${escapeHtml(lang)}</span><div class="code-actions">${sendBtn}${copyBtn}</div></div><pre><code>${escapedCode}</code></pre></div>`
  }

  // 自定义行内代码渲染 - 检测文件路径 / URL 并添加可点击标记
  renderer.codespan = (codeOrToken: string | { text: string }) => {
    const text = typeof codeOrToken === 'object' ? (codeOrToken.text || '') : codeOrToken
    // 解码 HTML 实体后检测是否为文件路径或 URL。展示时仍转义原文，检测归检测。
    const decoded = decodeHtmlEntities(text)
    const shown = escapeHtml(text)

    if (isLocalFilePath(decoded)) {
      return `<code class="inline-code file-path-link" data-file-path="${escapeAttr(normalizeUncForOpen(decoded))}" title="点击打开文件">${shown}</code>`
    }

    // HTTP(S) URL：用 <a> 代替 <code>，复用 inline-code 样式以保留代码块外观，
    // 同时天然支持点击跳转（Electron setWindowOpenHandler 会调用 shell.openExternal）
    if (isHttpUrl(decoded)) {
      return `<a href="${escapeAttr(decoded)}" target="_blank" rel="noopener noreferrer" class="inline-code external-url-link" title="点击在浏览器中打开">${shown}</a>`
    }

    return `<code class="inline-code">${shown}</code>`
  }

  // 自定义链接渲染 - 检测文件路径链接
  // marked v18+ 传入 token 对象，链接文本需通过 parser.parseInline(tokens) 解析
  renderer.link = function (
    hrefOrToken: string | { href: string; title?: string | null; text?: string; tokens?: unknown[] },
    title?: string | null,
    text?: string
  ) {
    let href: string, linkTitle: string, linkText: string

    if (typeof hrefOrToken === 'object' && hrefOrToken !== null) {
      href = hrefOrToken.href || ''
      linkTitle = hrefOrToken.title || ''
      linkText = hrefOrToken.tokens
        ? this.parser.parseInline(hrefOrToken.tokens as Token[])
        : (hrefOrToken.text || '')
    } else {
      href = hrefOrToken as string
      linkTitle = title || ''
      linkText = text || ''
    }

    const decodedHref = decodeHtmlEntities(href)

    // 文件路径链接：使用 data-file-path 标记，通过事件委托处理点击
    if (isLocalFilePath(decodedHref)) {
      const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ' title="点击打开文件"'
      return `<a class="file-path-link" data-file-path="${escapeAttr(normalizeUncForOpen(decodedHref))}"${titleAttr}>${linkText}</a>`
    }

    // 普通链接：在新标签页打开
    const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ''
    return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${linkText}</a>`
  }

  // 转义 markdown 文本中的原始 HTML 块/内联 HTML，防止 <meta refresh>、<script>
  // 等危险标签被 v-html 注入 DOM 后执行（如 web_fetch 返回的 HTTP 错误页 HTML 片段）。
  // 注意：此 override 仅影响输入文本里的 HTML token，不影响 renderer 自身输出的 HTML。
  renderer.html = (htmlOrToken: string | { text?: string; raw?: string; block?: boolean }) => {
    const raw = typeof htmlOrToken === 'object'
      ? (htmlOrToken.text ?? htmlOrToken.raw ?? '')
      : (htmlOrToken ?? '')
    return raw.replace(/</g, '&lt;').replace(/>/g, '&gt;')
  }

  // 配置 marked
  marked.setOptions({
    renderer,
    breaks: true,  // 支持换行
    gfm: true      // 支持 GitHub 风格 Markdown
  })

  const renderMarkdown = (text: string): string => {
    if (!text) return ''

    const cached = markdownCache.get(text)
    if (cached) return cached

    let html: string
    try {
      html = marked.parse(text, { async: false })
      // 先处理 URL（变成 <a>），再处理文件路径
      // 这样文件路径扫描会跳过已链接化的 URL，避免 "p://" 被误识别为 Windows 盘符
      html = wrapBareUrls(html)
      html = wrapBareFilePaths(html)
    } catch (e) {
      html = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
    }

    if (markdownCache.size >= MARKDOWN_CACHE_MAX) {
      const oldest = markdownCache.keys().next().value!
      markdownCache.delete(oldest)
    }
    markdownCache.set(text, html)
    return html
  }

  // 从代码块中提取代码内容（反转义 HTML）
  const getCodeFromBlock = (button: HTMLElement): string => {
    const codeBlock = button.closest('.code-block')
    const codeElement = codeBlock?.querySelector('pre code')
    if (!codeElement) return ''
    
    // 获取文本内容（自动反转义 HTML 实体）
    return codeElement.textContent || ''
  }

  // 事件委托处理代码块按钮点击 + 文件路径链接点击
  const handleCodeBlockClick = async (event: MouseEvent) => {
    const target = event.target as HTMLElement

    // 处理文件路径点击（通过 data-file-path 属性标记）
    const filePathEl = target.closest('[data-file-path]') as HTMLElement
    if (filePathEl) {
      event.preventDefault()
      event.stopPropagation()
      const filePath = filePathEl.dataset.filePath
      if (filePath) openFilePath(filePath)
      return
    }
    
    // 查找带有 data-action 属性的按钮（可能点击的是 SVG 或其子元素）
    const button = target.closest('.code-copy-btn, .code-send-btn') as HTMLElement
    if (!button) {
      return
    }
    
    const action = button.dataset.action
    const code = getCodeFromBlock(button)
    
    if (!code) {
      return
    }
    
    if (action === 'copy') {
      await writeClipboard(code)
    } else if (action === 'send') {
      try {
        const activeTab = terminalStore.activeTab
        console.log('Active tab:', activeTab?.id, 'ptyId:', activeTab?.ptyId)
        if (activeTab?.ptyId) {
          // 发送代码到终端（不自动添加回车，让用户确认后再执行）
          await terminalStore.writeToTerminal(activeTab.id, code)
          // 自动让终端获得焦点，方便用户按回车执行
          terminalStore.focusTerminal(activeTab.id)
          console.log('代码已发送到终端')
        } else {
          console.warn('没有活动的终端')
        }
      } catch (error) {
        console.error('发送到终端失败:', error)
      }
    }
  }

  // 文件路径右键菜单
  let activeContextMenu: HTMLElement | null = null

  const removeContextMenu = () => {
    if (activeContextMenu) {
      activeContextMenu.remove()
      activeContextMenu = null
    }
  }

  const handleFilePathContextMenu = (event: MouseEvent) => {
    const target = event.target as HTMLElement
    const filePathEl = target.closest('[data-file-path]') as HTMLElement
    if (!filePathEl) return

    const filePath = filePathEl.dataset.filePath
    if (!filePath) return

    event.preventDefault()
    event.stopPropagation()
    removeContextMenu()

    const menu = document.createElement('div')
    menu.className = 'file-path-context-menu'
    menu.style.cssText = `
      position: fixed;
      left: ${event.clientX}px;
      top: ${event.clientY}px;
      min-width: 160px;
      background: var(--bg-secondary);
      border: 1px solid var(--border-color);
      border-radius: 8px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
      padding: 6px;
      z-index: 10000;
      animation: fadeIn 0.1s ease;
    `

    const items = [
      { label: '打开文件', icon: 'file', action: () => openFilePath(filePath) },
      { label: '打开所在文件夹', icon: 'folder', action: () => showInFolder(filePath) },
      { divider: true },
      { label: '复制路径', icon: 'copy', action: () => copyPathToClipboard(filePath) }
    ]

    for (const item of items) {
      if ('divider' in item && item.divider) {
        const divider = document.createElement('div')
        divider.style.cssText = 'height: 1px; background: var(--border-color); margin: 6px 0;'
        menu.appendChild(divider)
        continue
      }
      const btn = document.createElement('button')
      btn.style.cssText = `
        display: flex; align-items: center; gap: 10px; width: 100%;
        padding: 8px 12px; font-size: 13px; color: var(--text-primary);
        background: transparent; border: none; border-radius: 4px;
        cursor: pointer; text-align: left;
      `
      btn.textContent = item.label!
      btn.addEventListener('mouseenter', () => { btn.style.background = 'var(--bg-hover)' })
      btn.addEventListener('mouseleave', () => { btn.style.background = 'transparent' })
      btn.addEventListener('click', () => {
        item.action!()
        removeContextMenu()
      })
      menu.appendChild(btn)
    }

    document.body.appendChild(menu)
    activeContextMenu = menu

    // 防止超出视口
    requestAnimationFrame(() => {
      const rect = menu.getBoundingClientRect()
      if (rect.right > window.innerWidth) menu.style.left = `${window.innerWidth - rect.width - 10}px`
      if (rect.bottom > window.innerHeight) menu.style.top = `${window.innerHeight - rect.height - 10}px`
    })

    const closeOnClick = (e: MouseEvent) => {
      if (!menu.contains(e.target as Node)) {
        removeContextMenu()
        document.removeEventListener('click', closeOnClick)
        document.removeEventListener('contextmenu', closeOnClick)
      }
    }
    const closeOnEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        removeContextMenu()
        document.removeEventListener('keydown', closeOnEsc)
      }
    }
    setTimeout(() => {
      document.addEventListener('click', closeOnClick)
      document.addEventListener('contextmenu', closeOnClick)
      document.addEventListener('keydown', closeOnEsc)
    }, 0)
  }

  const openFilePath = async (filePath: string) => {
    if (!window.electronAPI?.shell?.openPath) return
    try {
      const errorMsg = await window.electronAPI.shell.openPath(filePath)
      if (errorMsg) {
        toast.error('打开文件失败：文件可能已被删除或移动')
      }
    } catch {
      toast.error('打开文件失败：文件可能已被删除或移动')
    }
  }

  const showInFolder = async (filePath: string) => {
    if (!window.electronAPI?.shell?.showItemInFolder) return
    try {
      await window.electronAPI.shell.showItemInFolder(filePath)
    } catch {
      toast.error('打开所在文件夹失败')
    }
  }

  const copyPathToClipboard = async (filePath: string) => {
    const ok = await writeClipboard(filePath)
    if (ok) toast.success('路径已复制')
    else toast.error('复制路径失败')
  }

  // 复制消息
  const copyMessage = async (content: string) => {
    await writeClipboard(content)
  }

  return {
    renderMarkdown,
    renderMermaidBlocks,
    handleCodeBlockClick,
    handleFilePathContextMenu,
    copyMessage
  }
}
