/**
 * Markdown 渲染 composable
 * 处理 Markdown 解析、代码块交互和文件路径点击
 */
import { marked } from 'marked'
import { useTerminalStore } from '../stores/terminal'

/**
 * 检测文本是否为本地文件路径
 * 支持三种格式：
 * - Unix/macOS/Linux 绝对路径：/path/to/file
 * - 用户主目录路径：~/path/to/file
 * - Windows 路径：C:\path\to\file 或 C:/path/to/file
 */
const isLocalFilePath = (text: string): boolean => {
  const trimmed = text.trim()
  if (trimmed.length < 2) return false
  // Unix/macOS/Linux 绝对路径
  if (/^\/[^\s<>*?"]+$/.test(trimmed) && trimmed.length > 1) return true
  // 用户主目录路径
  if (/^~\/[^\s<>*?"]+$/.test(trimmed)) return true
  // Windows 路径 (C:\ 或 C:/)
  if (/^[A-Za-z]:[\\/][^\s<>*?"]*$/.test(trimmed)) return true
  return false
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
 * 后处理 HTML：将文本节点中的裸文件路径转为可点击链接
 * 仅处理不在 <a>、<code>、<pre> 标签内的文本
 */
const wrapBareFilePaths = (html: string): string => {
  // 匹配常见文件路径模式（支持中文、日文、韩文、欧洲字符等 Unicode 路径）
  // Unix/macOS: /path/to/file（至少两级路径或带扩展名的单级路径）
  // Windows: C:\path\to\file 或 C:/path/to/file
  // Home: ~/path/to/file
  const filePathPattern = /(?:\/(?:[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]% ]+\/)*[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]% ]+\.[\w]{1,10}|~\/[\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]%/\\ ]+|[A-Za-z]:[\\/][\w\u4e00-\u9fff\u3000-\u303f\u00C0-\u024F.\-+@#$()[\]%/\\ ]+)/g

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

    return part.replace(filePathPattern, (match) => {
      const trimmed = match.trim()
      if (!isLocalFilePath(trimmed)) return match
      return `<a class="file-path-link" data-file-path="${escapeAttr(trimmed)}" title="点击打开文件">${match}</a>`
    })
  }).join('')
}

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
    
    // 转义 HTML 特殊字符用于显示
    const escapedCode = code
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
    
    // 始终渲染按钮，通过事件委托在点击时获取代码内容
    const copyBtn = `<button class="code-copy-btn" data-action="copy" title="复制代码"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg></button>`
    
    const sendBtn = `<button class="code-send-btn" data-action="send" title="发送到终端"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 10 4 15 9 20"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/></svg></button>`
    
    return `<div class="code-block"><div class="code-header"><span>${lang}</span><div class="code-actions">${sendBtn}${copyBtn}</div></div><pre><code>${escapedCode}</code></pre></div>`
  }

  // 自定义行内代码渲染 - 检测文件路径并添加可点击标记
  renderer.codespan = (codeOrToken: string | { text: string }) => {
    const text = typeof codeOrToken === 'object' ? (codeOrToken.text || '') : codeOrToken
    // 解码 HTML 实体后检测是否为文件路径
    const decoded = decodeHtmlEntities(text)

    if (isLocalFilePath(decoded)) {
      return `<code class="inline-code file-path-link" data-file-path="${escapeAttr(decoded)}" title="点击打开文件">${text}</code>`
    }

    return `<code class="inline-code">${text}</code>`
  }

  // 自定义链接渲染 - 检测文件路径链接
  renderer.link = (hrefOrToken: string | { href: string; title?: string | null; text: string; tokens?: unknown[] }, title?: string | null, text?: string) => {
    let href: string, linkTitle: string, linkText: string

    if (typeof hrefOrToken === 'object' && hrefOrToken !== null) {
      href = hrefOrToken.href || ''
      linkTitle = hrefOrToken.title || ''
      // 新版 marked 的 text 可能包含已渲染的 HTML
      linkText = hrefOrToken.text || ''
    } else {
      href = hrefOrToken as string
      linkTitle = title || ''
      linkText = text || ''
    }

    const decodedHref = decodeHtmlEntities(href)

    // 文件路径链接：使用 data-file-path 标记，通过事件委托处理点击
    if (isLocalFilePath(decodedHref)) {
      const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ' title="点击打开文件"'
      return `<a class="file-path-link" data-file-path="${escapeAttr(decodedHref)}"${titleAttr}>${linkText}</a>`
    }

    // 普通链接：在新标签页打开
    const titleAttr = linkTitle ? ` title="${escapeAttr(linkTitle)}"` : ''
    return `<a href="${escapeAttr(href)}"${titleAttr} target="_blank" rel="noopener noreferrer">${linkText}</a>`
  }

  // 配置 marked
  marked.setOptions({
    renderer,
    breaks: true,  // 支持换行
    gfm: true      // 支持 GitHub 风格 Markdown
  })

  // 渲染 Markdown 格式
  const renderMarkdown = (text: string): string => {
    if (!text) return ''
    
    try {
      let html = marked.parse(text) as string
      // 后处理：将文本中的裸文件路径转为可点击链接
      html = wrapBareFilePaths(html)
      return html
    } catch (e) {
      // 如果解析失败，返回转义后的纯文本
      return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>')
    }
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
      if (filePath && window.electronAPI?.shell?.openPath) {
        try {
          const errorMsg = await window.electronAPI.shell.openPath(filePath)
          if (errorMsg) {
            console.error('打开文件失败:', errorMsg)
          }
        } catch (error) {
          console.error('打开文件失败:', error)
        }
      }
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
      try {
        await navigator.clipboard.writeText(code)
        console.log('代码已复制')
      } catch (error) {
        console.error('复制代码失败:', error)
      }
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

  // 复制消息
  const copyMessage = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content)
      // 可以添加一个提示
    } catch (error) {
      console.error('复制失败:', error)
    }
  }

  return {
    renderMarkdown,
    handleCodeBlockClick,
    copyMessage
  }
}
