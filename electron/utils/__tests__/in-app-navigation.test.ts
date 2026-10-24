import { describe, expect, it } from 'vitest'
import { shouldStayInApp } from '../in-app-navigation'

describe('shouldStayInApp', () => {
  const dev = 'http://localhost:5173/'

  it('开发服务器和本地文件留在窗口里', () => {
    expect(shouldStayInApp(`${dev}file-manager.html`, dev)).toBe(true)
    expect(shouldStayInApp('file:///Applications/SailFish/dist/index.html', dev)).toBe(true)
  })

  it('外部地址不留在窗口里', () => {
    expect(shouldStayInApp('https://example.com/marked.min.js', dev)).toBe(false)
    expect(shouldStayInApp('http://127.0.0.1:9/', undefined)).toBe(false)
  })

  it('没有开发服务器时，只有本地文件留在窗口里', () => {
    expect(shouldStayInApp('file:///tmp/index.html', undefined)).toBe(true)
    expect(shouldStayInApp('http://localhost:5173/', undefined)).toBe(false)
  })
})
