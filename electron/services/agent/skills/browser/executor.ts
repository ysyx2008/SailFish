/**
 * 浏览器技能执行器
 */

import * as path from 'path'
import * as os from 'os'
import type { ToolResult, AgentConfig } from '../../types'
import type { ToolExecutorConfig } from '../../tool-executor'
import { t } from '../../i18n'
import { getTerminalStateService } from '../../../terminal-state.service'
import {
  getSession,
  createSession,
  closeSession,
  getCurrentPage,
  getTabsInfo,
  switchToTab,
  saveStorageState,
  listStorageProfiles,
  hasStorageState,
  DEFAULT_PROFILE
} from './session'
import { getSnapshot, resolveRef, getSnapshotStats } from './snapshot'
import type { Page } from 'playwright-core'

/**
 * 执行浏览器技能工具
 */
export async function executeBrowserTool(
  toolName: string,
  ptyId: string,
  args: Record<string, unknown>,
  toolCallId: string,
  config: AgentConfig,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  switch (toolName) {
    case 'browser_launch':
      return await browserLaunch(ptyId, args, executor)
    case 'browser_snapshot':
      return await browserSnapshot(ptyId, args, executor)
    case 'browser_goto':
      return await browserGoto(ptyId, args, executor)
    case 'browser_screenshot':
      return await browserScreenshot(ptyId, args, executor)
    case 'browser_get_content':
      return await browserGetContent(ptyId, args, executor)
    case 'browser_click':
      return await browserClick(ptyId, args, executor)
    case 'browser_type':
      return await browserType(ptyId, args, executor)
    case 'browser_scroll':
      return await browserScroll(ptyId, args, executor)
    case 'browser_wait':
      return await browserWait(ptyId, args, executor)
    case 'browser_evaluate':
      return await browserEvaluate(ptyId, args, executor)
    case 'browser_list_tabs':
      return await browserListTabs(ptyId, args, executor)
    case 'browser_switch_tab':
      return await browserSwitchTab(ptyId, args, executor)
    case 'browser_save_login':
      return await browserSaveLogin(ptyId, args, executor)
    case 'browser_list_profiles':
      return await browserListProfiles(ptyId, args, executor)
    case 'browser_close':
      return await browserClose(ptyId, args, executor)
    default:
      return { success: false, output: '', error: t('error.unknown_tool', { name: toolName }) }
  }
}

/**
 * 解析文件路径
 */
function resolvePath(ptyId: string, filePath: string): string {
  if (path.isAbsolute(filePath)) {
    return filePath
  }
  const terminalStateService = getTerminalStateService()
  const cwd = terminalStateService.getCwd(ptyId)
  return path.resolve(cwd, filePath)
}

/**
 * 确保会话存在
 */
function ensureSession(ptyId: string): NonNullable<ReturnType<typeof getSession>> {
  const session = getSession(ptyId)
  if (!session) {
    throw new Error('浏览器未启动。请先调用 browser_launch 启动浏览器。')
  }
  return session
}

/**
 * 解析选择器：支持 @ref 和传统选择器
 * 如果是 @ref 格式，返回 Playwright Locator；否则返回 null（调用方使用原始选择器）
 */
function resolveSelector(page: Page, selector: string, ptyId: string) {
  const session = getSession(ptyId)
  if (!session) return null
  return resolveRef(page, selector, session.refs)
}

/**
 * 启动浏览器
 */
async function browserLaunch(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const url = args.url as string | undefined
  const headless = args.headless as boolean | undefined
  const profile = args.profile as string | undefined

  const profileHint = profile ? ` (配置: ${profile})` : ''
  executor.addStep({
    type: 'tool_call',
    content: url ? `启动浏览器并访问 ${url}${profileHint}` : `启动浏览器${profileHint}`,
    toolName: 'browser_launch',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    // 检查是否有保存的登录状态（指定的配置或默认配置）
    const effectiveProfile = profile || DEFAULT_PROFILE
    const hadStorageState = hasStorageState(effectiveProfile)
    
    const session = await createSession(ptyId, { headless, url, profile })
    
    let result = `浏览器已启动 (${session.browserInfo.name})`
    if (hadStorageState) {
      if (profile) {
        result += `\n✅ 已恢复登录配置 "${profile}" 的登录状态`
      } else {
        result += `\n✅ 已恢复上次的登录状态`
      }
    }
    if (url) {
      result += `\n已打开 ${url}`
    }
    result += `\n\n💡 使用 browser_snapshot 获取页面元素和 ref 编号，可大幅提升操作准确性`
    result += `\n💡 关闭浏览器时会自动保存登录状态`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_launch'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '启动浏览器失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_launch'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 获取页面无障碍树快照
 */
async function browserSnapshot(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const interactive = args.interactive as boolean | undefined
  const compact = args.compact as boolean | undefined
  const maxDepth = args.max_depth as number | undefined
  const selector = args.selector as string | undefined

  executor.addStep({
    type: 'tool_call',
    content: interactive ? '获取可交互元素快照' : '获取页面快照',
    toolName: 'browser_snapshot',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    const { tree, refs } = await getSnapshot(page, {
      interactive,
      compact,
      maxDepth,
      selector,
    })
    
    // 将 ref 映射存入 session，供后续工具使用
    session.refs = refs
    
    const stats = getSnapshotStats(tree, refs)
    const title = await page.title()
    const currentUrl = page.url()
    
    // 显示标签页信息
    const tabsInfo = await getTabsInfo(session)
    const tabsHint = tabsInfo.length > 1
      ? `\n(当前第 ${session.currentPageIndex + 1}/${tabsInfo.length} 个标签页)`
      : ''
    
    const statsLine = `[${stats.totalRefs} 个 ref, 其中 ${stats.interactiveRefs} 个可交互, ~${stats.estimatedTokens} tokens]`
    const result = `页面: ${title}\nURL: ${currentUrl}${tabsHint}\n${statsLine}\n\n${tree}`

    executor.addStep({
      type: 'tool_result',
      content: `快照已获取：${stats.totalRefs} 个 ref`,
      toolName: 'browser_snapshot'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取快照失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_snapshot'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 导航到 URL
 */
async function browserGoto(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const url = args.url as string
  const waitUntil = (args.wait_until as 'load' | 'domcontentloaded' | 'networkidle') || 'load'

  if (!url) {
    return { success: false, output: '', error: '缺少 url 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `导航到 ${url}`,
    toolName: 'browser_goto',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    await page.goto(url, { waitUntil })
    
    const title = await page.title()
    const result = `已导航到 ${url}\n标题: ${title}\n\n💡 使用 browser_snapshot 获取页面元素和 ref 编号`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_goto'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '导航失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_goto'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 截图
 */
async function browserScreenshot(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const savePath = args.path as string | undefined
  const fullPage = args.full_page as boolean | undefined
  const selector = args.selector as string | undefined

  executor.addStep({
    type: 'tool_call',
    content: selector ? `截取元素 ${selector}` : (fullPage ? '截取整页' : '截取可视区域'),
    toolName: 'browser_screenshot',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    // 确定保存路径
    const screenshotPath = savePath 
      ? resolvePath(ptyId, savePath)
      : path.join(os.tmpdir(), `screenshot_${Date.now()}.png`)

    if (selector) {
      // 截取指定元素（支持 @ref）
      const locator = resolveSelector(page, selector, ptyId) || page.locator(selector)
      await locator.screenshot({ path: screenshotPath })
    } else {
      // 截取页面
      await page.screenshot({ 
        path: screenshotPath, 
        fullPage: fullPage ?? false 
      })
    }

    const result = `截图已保存到: ${screenshotPath}`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_screenshot'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '截图失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_screenshot'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 获取页面内容
 */
async function browserGetContent(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const format = (args.format as 'text' | 'html' | 'markdown') || 'text'
  const selector = args.selector as string | undefined
  const maxLength = (args.max_length as number) || 10000

  executor.addStep({
    type: 'tool_call',
    content: selector ? `获取 ${selector} 的${format}内容` : `获取页面${format}内容`,
    toolName: 'browser_get_content',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    let content: string

    if (selector) {
      const element = resolveSelector(page, selector, ptyId) || page.locator(selector)
      if (format === 'html' || format === 'markdown') {
        content = await element.innerHTML()
      } else {
        content = await element.innerText()
      }
    } else {
      if (format === 'html' || format === 'markdown') {
        content = await page.content()
      } else {
        content = await page.innerText('body')
      }
    }

    // 简单的 HTML 到 Markdown 转换
    if (format === 'markdown') {
      content = htmlToSimpleMarkdown(content)
    }

    // 记录原始长度
    const originalLength = content.length

    // 截断过长内容
    if (content.length > maxLength) {
      content = content.substring(0, maxLength) + `\n\n... (内容过长，已截断，共 ${originalLength} 字符)`
    }

    const title = await page.title()
    const currentUrl = page.url()
    
    // 显示标签页信息
    const tabsInfo = await getTabsInfo(session)
    const tabsHint = tabsInfo.length > 1 
      ? `\n(当前第 ${session.currentPageIndex + 1}/${tabsInfo.length} 个标签页)` 
      : ''
    
    const result = `页面: ${title}\nURL: ${currentUrl}${tabsHint}\n\n${content}`

    executor.addStep({
      type: 'tool_result',
      content: `获取了 ${originalLength} 字符的内容`,
      toolName: 'browser_get_content'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取内容失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_get_content'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 简单的 HTML 到 Markdown 转换
 */
function htmlToSimpleMarkdown(html: string): string {
  return html
    .replace(/<h1[^>]*>(.*?)<\/h1>/gi, '# $1\n')
    .replace(/<h2[^>]*>(.*?)<\/h2>/gi, '## $1\n')
    .replace(/<h3[^>]*>(.*?)<\/h3>/gi, '### $1\n')
    .replace(/<h4[^>]*>(.*?)<\/h4>/gi, '#### $1\n')
    .replace(/<strong[^>]*>(.*?)<\/strong>/gi, '**$1**')
    .replace(/<b[^>]*>(.*?)<\/b>/gi, '**$1**')
    .replace(/<em[^>]*>(.*?)<\/em>/gi, '*$1*')
    .replace(/<i[^>]*>(.*?)<\/i>/gi, '*$1*')
    .replace(/<a[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi, '[$2]($1)')
    .replace(/<li[^>]*>(.*?)<\/li>/gi, '- $1\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<p[^>]*>(.*?)<\/p>/gi, '$1\n\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

/**
 * 点击元素
 */
async function browserClick(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const selector = args.selector as string
  const waitForNavigation = args.wait_for_navigation as boolean | undefined

  if (!selector) {
    return { success: false, output: '', error: '缺少 selector 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `点击 ${selector}`,
    toolName: 'browser_click',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    const tabCountBefore = session.pages.length
    
    // 尝试 @ref 解析，否则用原始选择器
    const locator = resolveSelector(page, selector, ptyId)
    
    if (locator) {
      // 使用 ref 定位
      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'load' }),
          locator.click()
        ])
      } else {
        await locator.click()
      }
    } else {
      // 回退到传统选择器
      if (waitForNavigation) {
        await Promise.all([
          page.waitForNavigation({ waitUntil: 'load' }),
          page.click(selector)
        ])
      } else {
        await page.click(selector)
      }
    }
    
    // 等待一下，看是否有新标签页打开
    await new Promise(resolve => setTimeout(resolve, 500))
    
    // 检查是否有新标签页打开
    const tabCountAfter = session.pages.length
    let result = `已点击 ${selector}`
    if (tabCountAfter > tabCountBefore) {
      const newPage = getCurrentPage(session)
      const newTitle = await newPage.title().catch(() => '(加载中)')
      const newUrl = newPage.url()
      result += `\n\n⚠️ 点击后打开了新标签页！已自动切换到新标签页。\n新标签页: ${newTitle}\nURL: ${newUrl}\n当前共 ${tabCountAfter} 个标签页`
    }
    
    // 点击后 ref 可能过期，提示 AI 重新 snapshot
    result += `\n\n💡 页面可能已变化，建议重新调用 browser_snapshot 获取最新状态`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_click'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '点击失败'
    // 如果是 ref 操作失败，给出更友好的提示
    const hint = selector.startsWith('@') 
      ? `\n💡 ref 可能已过期，请重新调用 browser_snapshot 获取最新 ref` 
      : ''
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}${hint}`,
      toolName: 'browser_click'
    })
    return { success: false, output: '', error: `${errorMsg}${hint}` }
  }
}

/**
 * 输入文本
 */
async function browserType(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const selector = args.selector as string
  const text = args.text as string
  const clearFirst = args.clear_first !== false // 默认 true
  const pressEnter = args.press_enter as boolean | undefined

  if (!selector || text === undefined) {
    return { success: false, output: '', error: '缺少 selector 或 text 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `在 ${selector} 输入文本`,
    toolName: 'browser_type',
    toolArgs: { selector, text: text.length > 50 ? text.substring(0, 50) + '...' : text },
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    // 尝试 @ref 解析
    const locator = resolveSelector(page, selector, ptyId)
    
    if (locator) {
      if (clearFirst) {
        await locator.fill(text)
      } else {
        await locator.pressSequentially(text)
      }
      if (pressEnter) {
        await locator.press('Enter')
      }
    } else {
      if (clearFirst) {
        await page.fill(selector, text)
      } else {
        await page.type(selector, text)
      }
      if (pressEnter) {
        await page.press(selector, 'Enter')
      }
    }

    const result = pressEnter 
      ? `已输入文本并按下回车` 
      : `已输入文本`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_type'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '输入失败'
    const hint = selector.startsWith('@')
      ? `\n💡 ref 可能已过期，请重新调用 browser_snapshot 获取最新 ref`
      : ''
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}${hint}`,
      toolName: 'browser_type'
    })
    return { success: false, output: '', error: `${errorMsg}${hint}` }
  }
}

/**
 * 滚动页面
 */
async function browserScroll(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const direction = (args.direction as 'up' | 'down' | 'top' | 'bottom') || 'down'
  const distance = (args.distance as number) || 500

  executor.addStep({
    type: 'tool_call',
    content: `滚动页面 ${direction}`,
    toolName: 'browser_scroll',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    switch (direction) {
      case 'top':
        await page.evaluate(() => window.scrollTo(0, 0))
        break
      case 'bottom':
        await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight))
        break
      case 'up':
        await page.evaluate((d) => window.scrollBy(0, -d), distance)
        break
      case 'down':
      default:
        await page.evaluate((d) => window.scrollBy(0, d), distance)
        break
    }

    const result = `已滚动 ${direction}`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_scroll'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '滚动失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_scroll'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 等待
 */
async function browserWait(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const selector = args.selector as string | undefined
  const timeout = (args.timeout as number) || 30000
  const delay = args.delay as number | undefined

  executor.addStep({
    type: 'tool_call',
    content: delay ? `等待 ${delay}ms` : (selector ? `等待元素 ${selector}` : '等待'),
    toolName: 'browser_wait',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    if (delay) {
      await new Promise(resolve => setTimeout(resolve, delay))
    } else if (selector) {
      // @ref 不支持 waitForSelector，使用 locator.waitFor 代替
      const locator = resolveSelector(page, selector, ptyId)
      if (locator) {
        await locator.waitFor({ state: 'visible', timeout })
      } else {
        await page.waitForSelector(selector, { timeout })
      }
    } else {
      return { success: false, output: '', error: '请指定 selector 或 delay' }
    }

    const result = selector ? `元素 ${selector} 已出现` : `已等待 ${delay}ms`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_wait'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '等待超时'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_wait'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 执行 JavaScript
 */
async function browserEvaluate(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const script = args.script as string

  if (!script) {
    return { success: false, output: '', error: '缺少 script 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `执行 JavaScript`,
    toolName: 'browser_evaluate',
    toolArgs: { script: script.length > 100 ? script.substring(0, 100) + '...' : script },
    riskLevel: 'moderate'
  })

  try {
    const session = ensureSession(ptyId)
    const page = getCurrentPage(session)
    
    // 处理可能的 return 语句，并包装成可执行的表达式
    let cleanScript = script.trim()
    if (cleanScript.startsWith('return ')) {
      cleanScript = cleanScript.slice(7)
    }
    
    // 使用 Function 构造器包装，支持更复杂的语法
    const result = await page.evaluate((code) => {
      try {
        // 先尝试作为表达式求值
        return eval(code)
      } catch {
        // 如果失败，尝试作为语句块执行
        const fn = new Function(code)
        return fn()
      }
    }, cleanScript)
    
    const output = result !== undefined ? JSON.stringify(result, null, 2) : '(无返回值)'

    executor.addStep({
      type: 'tool_result',
      content: `执行完成`,
      toolName: 'browser_evaluate',
      toolResult: output
    })

    return { success: true, output }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '执行失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_evaluate'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 列出所有标签页
 */
async function browserListTabs(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '列出所有标签页',
    toolName: 'browser_list_tabs',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const tabs = await getTabsInfo(session)
    
    const lines = tabs.map(tab => 
      `${tab.active ? '→ ' : '  '}[${tab.index}] ${tab.title}\n     ${tab.url}`
    )
    
    const result = `共 ${tabs.length} 个标签页：\n\n${lines.join('\n\n')}`

    executor.addStep({
      type: 'tool_result',
      content: `共 ${tabs.length} 个标签页，当前在第 ${session.currentPageIndex} 个`,
      toolName: 'browser_list_tabs'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取标签页列表失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_list_tabs'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 切换标签页
 */
async function browserSwitchTab(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const index = args.index as number

  if (index === undefined || index === null) {
    return { success: false, output: '', error: '缺少 index 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `切换到标签页 ${index}`,
    toolName: 'browser_switch_tab',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    
    if (index < 0 || index >= session.pages.length) {
      return { 
        success: false, 
        output: '', 
        error: `标签页索引超出范围。当前共 ${session.pages.length} 个标签页（索引 0-${session.pages.length - 1}）` 
      }
    }
    
    switchToTab(session, index)
    
    const page = getCurrentPage(session)
    const title = await page.title()
    const url = page.url()
    
    const result = `已切换到标签页 ${index}\n标题: ${title}\nURL: ${url}`

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_switch_tab'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '切换标签页失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_switch_tab'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 保存登录状态
 */
async function browserSaveLogin(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  const profile = args.profile as string

  if (!profile) {
    return { success: false, output: '', error: '缺少 profile 参数' }
  }

  executor.addStep({
    type: 'tool_call',
    content: `保存登录状态为 "${profile}"`,
    toolName: 'browser_save_login',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const session = ensureSession(ptyId)
    const storagePath = await saveStorageState(session, profile)
    
    const result = `✅ 登录状态已保存为 "${profile}"\n\n下次使用时，调用 browser_launch { profile: "${profile}" } 即可恢复登录状态`

    executor.addStep({
      type: 'tool_result',
      content: `登录状态已保存: ${storagePath}`,
      toolName: 'browser_save_login'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '保存登录状态失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_save_login'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 列出所有登录配置
 */
async function browserListProfiles(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '列出已保存的登录配置',
    toolName: 'browser_list_profiles',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const profiles = listStorageProfiles()
    
    let result: string
    if (profiles.length === 0) {
      result = '暂无保存的登录配置。\n\n登录网站后，使用 browser_save_login 保存登录状态。'
    } else {
      result = `已保存的登录配置（${profiles.length} 个）：\n\n${profiles.map(p => `- ${p}`).join('\n')}\n\n使用 browser_launch { profile: "配置名" } 启动浏览器并恢复登录状态`
    }

    executor.addStep({
      type: 'tool_result',
      content: `${profiles.length} 个配置`,
      toolName: 'browser_list_profiles'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '获取配置列表失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_list_profiles'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

/**
 * 关闭浏览器
 */
async function browserClose(
  ptyId: string,
  args: Record<string, unknown>,
  executor: ToolExecutorConfig
): Promise<ToolResult> {
  executor.addStep({
    type: 'tool_call',
    content: '关闭浏览器',
    toolName: 'browser_close',
    toolArgs: args,
    riskLevel: 'safe'
  })

  try {
    const { closed, savedProfile } = await closeSession(ptyId)
    
    let result: string
    if (!closed) {
      result = '没有打开的浏览器'
    } else if (savedProfile) {
      if (savedProfile === DEFAULT_PROFILE) {
        result = `浏览器已关闭\n✅ 登录状态已自动保存，下次启动浏览器时会自动恢复`
      } else {
        result = `浏览器已关闭\n✅ 登录状态已自动保存到配置 "${savedProfile}"`
      }
    } else {
      result = '浏览器已关闭'
    }

    executor.addStep({
      type: 'tool_result',
      content: result,
      toolName: 'browser_close'
    })

    return { success: true, output: result }
  } catch (error) {
    const errorMsg = error instanceof Error ? error.message : '关闭失败'
    executor.addStep({
      type: 'tool_result',
      content: `错误: ${errorMsg}`,
      toolName: 'browser_close'
    })
    return { success: false, output: '', error: errorMsg }
  }
}

