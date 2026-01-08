/**
 * Markdown 渲染 composable
 * 处理 Markdown 解析和代码块交互
 */
import { marked } from 'marked'
import { useTerminalStore } from '../stores/terminal'

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

  // 自定义行内代码渲染
  renderer.codespan = (code: string) => {
    return `<code class="inline-code">${code}</code>`
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
      return marked.parse(text) as string
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

  // 事件委托处理代码块按钮点击
  const handleCodeBlockClick = async (event: MouseEvent) => {
    const target = event.target as HTMLElement
    
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
