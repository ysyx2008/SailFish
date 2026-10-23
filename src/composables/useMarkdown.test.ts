import { describe, expect, it, vi } from 'vitest'

vi.mock('../stores/terminal', () => ({
  useTerminalStore: () => ({ activeTab: null }),
}))

import { useMarkdown } from './useMarkdown'

describe('对话 markdown 不把正文里的标签画成真标签', () => {
  const { renderMarkdown } = useMarkdown()

  it('行内代码里的图片标签只当文字', () => {
    const html = renderMarkdown('`<img src=x onerror="alert(1)">`')
    expect(html).not.toMatch(/<img\b/i)
    expect(html).toContain('&lt;img')
    expect(html).toContain('alert(1)')
  })

  it('代码块语言名里的标签只当文字', () => {
    const html = renderMarkdown('```<img src=x onerror=alert(1)>\nhello\n```')
    expect(html).not.toMatch(/<img\b/i)
    expect(html).toContain('&lt;img')
    expect(html).toContain('hello')
  })

  it('直接写在正文里的标签也不执行', () => {
    const html = renderMarkdown('<img src=x onerror=alert(1)>')
    expect(html).not.toMatch(/<img\b/i)
    expect(html).toContain('&lt;img')
  })

  it('行内的文件路径和网址仍然能点', () => {
    const pathHtml = renderMarkdown('`/Users/a/b.docx`')
    expect(pathHtml).toContain('file-path-link')
    expect(pathHtml).toContain('data-file-path="/Users/a/b.docx"')

    const urlHtml = renderMarkdown('`https://example.com/a?b=1&c=2`')
    expect(urlHtml).toContain('href="https://example.com/a?b=1&amp;c=2"')
    expect(urlHtml).toContain('https://example.com/a?b=1&amp;c=2')
  })
})
