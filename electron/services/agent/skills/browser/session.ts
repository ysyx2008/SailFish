/**
 * 浏览器会话管理
 * 每个终端（ptyId）最多一个浏览器会话
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { chromium, firefox } from 'playwright-core'
import { detectBrowser, type BrowserInfo } from './detector'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// 登录状态存储目录
const getStorageDir = () => path.join(app.getPath('userData'), 'browser-storage')

// 默认 profile 名称
export const DEFAULT_PROFILE = '_default_'

export interface BrowserSession {
  browser: Browser
  context: BrowserContext
  pages: Page[]
  currentPageIndex: number
  browserInfo: BrowserInfo
  createdAt: number
  lastActivityAt: number
  profile?: string  // 登录配置名称，关闭时自动保存
}

/**
 * 获取当前活动页面
 */
export function getCurrentPage(session: BrowserSession): Page {
  return session.pages[session.currentPageIndex]
}

/**
 * 获取所有标签页信息
 */
export async function getTabsInfo(session: BrowserSession): Promise<{ index: number; url: string; title: string; active: boolean }[]> {
  const tabs = []
  for (let i = 0; i < session.pages.length; i++) {
    const page = session.pages[i]
    try {
      tabs.push({
        index: i,
        url: page.url(),
        title: await page.title(),
        active: i === session.currentPageIndex
      })
    } catch {
      // 页面可能已关闭
      tabs.push({
        index: i,
        url: '(已关闭)',
        title: '(已关闭)',
        active: false
      })
    }
  }
  return tabs
}

/**
 * 切换到指定标签页
 */
export function switchToTab(session: BrowserSession, index: number): boolean {
  if (index >= 0 && index < session.pages.length) {
    session.currentPageIndex = index
    // 将页面带到前台
    session.pages[index].bringToFront().catch(() => {})
    return true
  }
  return false
}

/**
 * 获取存储文件路径
 */
function getStoragePath(profileName: string): string {
  const dir = getStorageDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 清理文件名，移除不安全字符
  const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(dir, `${safeName}.json`)
}

/**
 * 保存登录状态
 */
export async function saveStorageState(session: BrowserSession, profileName: string): Promise<string> {
  const storagePath = getStoragePath(profileName)
  await session.context.storageState({ path: storagePath })
  console.log(`[BrowserSession] Saved storage state to ${storagePath}`)
  return storagePath
}

/**
 * 检查是否有保存的登录状态
 */
export function hasStorageState(profileName: string): boolean {
  const storagePath = getStoragePath(profileName)
  return fs.existsSync(storagePath)
}

/**
 * 列出所有保存的登录配置
 */
export function listStorageProfiles(): string[] {
  const dir = getStorageDir()
  if (!fs.existsSync(dir)) {
    return []
  }
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.json'))
    .map(f => f.replace('.json', ''))
}

/**
 * 删除登录配置
 */
export function deleteStorageProfile(profileName: string): boolean {
  const storagePath = getStoragePath(profileName)
  if (fs.existsSync(storagePath)) {
    fs.unlinkSync(storagePath)
    return true
  }
  return false
}

// 会话存储（ptyId -> BrowserSession）
const sessions = new Map<string, BrowserSession>()

// 会话超时时间：5 分钟
const SESSION_TIMEOUT = 5 * 60 * 1000

// 超时检查定时器
let timeoutChecker: NodeJS.Timeout | null = null

/**
 * 启动超时检查器
 */
function startTimeoutChecker() {
  if (timeoutChecker) return
  
  timeoutChecker = setInterval(async () => {
    const now = Date.now()
    for (const [ptyId, session] of Array.from(sessions.entries())) {
      if (now - session.lastActivityAt > SESSION_TIMEOUT) {
        console.log(`[BrowserSession] Session ${ptyId} timed out, closing...`)
        await closeSession(ptyId)
      }
    }
    
    // 如果没有会话了，停止检查器
    if (sessions.size === 0 && timeoutChecker) {
      clearInterval(timeoutChecker)
      timeoutChecker = null
    }
  }, 60 * 1000) // 每分钟检查一次
}

/**
 * 检查会话是否存在
 */
export function isSessionOpen(ptyId: string): boolean {
  return sessions.has(ptyId)
}

/**
 * 获取会话
 */
export function getSession(ptyId: string): BrowserSession | undefined {
  const session = sessions.get(ptyId)
  if (session) {
    session.lastActivityAt = Date.now()
  }
  return session
}

/**
 * 创建新会话
 */
export async function createSession(
  ptyId: string,
  options: {
    headless?: boolean
    url?: string
    profile?: string  // 登录配置名称，用于恢复登录状态
  } = {}
): Promise<BrowserSession> {
  // 如果已有会话，先关闭
  if (sessions.has(ptyId)) {
    await closeSession(ptyId)
  }
  
  // 检测浏览器
  const browserInfo = detectBrowser()
  if (!browserInfo) {
    throw new Error('未找到可用的浏览器。请安装 Chrome、Edge 或 Firefox。')
  }
  
  // 启动浏览器
  const launchOptions = {
    executablePath: browserInfo.executablePath,
    headless: options.headless ?? false, // 默认显示窗口
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions'
    ]
  }
  
  let browser: Browser
  if (browserInfo.type === 'firefox') {
    browser = await firefox.launch(launchOptions)
  } else {
    browser = await chromium.launch(launchOptions)
  }
  
  // 使用指定的 profile 或默认 profile
  const profileName = options.profile || DEFAULT_PROFILE
  
  // 创建上下文和页面
  const contextOptions: Parameters<typeof browser.newContext>[0] = {
    viewport: { width: 1280, height: 800 },
    locale: 'zh-CN'
  }
  
  // 如果存在保存的状态，则加载
  if (hasStorageState(profileName)) {
    const storagePath = getStoragePath(profileName)
    contextOptions.storageState = storagePath
    console.log(`[BrowserSession] Loading storage state from ${storagePath}`)
  }
  
  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  
  const session: BrowserSession = {
    browser,
    context,
    pages: [page],
    currentPageIndex: 0,
    browserInfo,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    profile: profileName  // 保存 profile，关闭时自动保存状态
  }
  
  // 监听新页面打开事件（点击链接打开新标签页）
  context.on('page', async (newPage) => {
    session.pages.push(newPage)
    session.currentPageIndex = session.pages.length - 1
    session.lastActivityAt = Date.now()
    console.log(`[BrowserSession] New tab opened for ${ptyId}, now ${session.pages.length} tabs, switched to tab ${session.currentPageIndex}`)
    
    // 监听页面关闭事件
    newPage.on('close', () => {
      const index = session.pages.indexOf(newPage)
      if (index > -1) {
        session.pages.splice(index, 1)
        // 如果关闭的是当前页面，切换到最后一个页面
        if (session.currentPageIndex >= session.pages.length) {
          session.currentPageIndex = Math.max(0, session.pages.length - 1)
        }
        console.log(`[BrowserSession] Tab closed for ${ptyId}, now ${session.pages.length} tabs`)
      }
    })
  })
  
  // 监听初始页面关闭
  page.on('close', () => {
    const index = session.pages.indexOf(page)
    if (index > -1) {
      session.pages.splice(index, 1)
      if (session.currentPageIndex >= session.pages.length) {
        session.currentPageIndex = Math.max(0, session.pages.length - 1)
      }
    }
  })
  
  // 如果指定了 URL，导航到该 URL
  if (options.url) {
    await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  }
  
  sessions.set(ptyId, session)
  startTimeoutChecker()
  
  console.log(`[BrowserSession] Created session for ${ptyId} using ${browserInfo.name}`)
  return session
}

/**
 * 关闭会话
 * @param saveProfile 是否保存登录状态，默认 true（如果有 profile）
 */
export async function closeSession(ptyId: string, saveProfile: boolean = true): Promise<{ closed: boolean; savedProfile?: string }> {
  const session = sessions.get(ptyId)
  if (!session) {
    return { closed: false }
  }
  
  let savedProfile: string | undefined
  
  // 如果有 profile，自动保存登录状态
  if (saveProfile && session.profile) {
    try {
      await saveStorageState(session, session.profile)
      savedProfile = session.profile
      console.log(`[BrowserSession] Auto-saved storage state for profile "${session.profile}"`)
    } catch (error) {
      console.error(`[BrowserSession] Failed to save storage state for ${ptyId}:`, error)
    }
  }
  
  try {
    await session.browser.close()
  } catch (error) {
    console.error(`[BrowserSession] Error closing browser for ${ptyId}:`, error)
  }
  
  sessions.delete(ptyId)
  console.log(`[BrowserSession] Closed session for ${ptyId}`)
  return { closed: true, savedProfile }
}

/**
 * 关闭所有会话
 */
export async function closeAllSessions(): Promise<void> {
  const ptyIds = Array.from(sessions.keys())
  for (const ptyId of ptyIds) {
    await closeSession(ptyId)
  }
  
  if (timeoutChecker) {
    clearInterval(timeoutChecker)
    timeoutChecker = null
  }
}

/**
 * 获取会话摘要（用于调试）
 */
export function getSessionsSummary(): string {
  if (sessions.size === 0) {
    return '没有打开的浏览器会话'
  }
  
  const lines: string[] = []
  for (const [ptyId, session] of Array.from(sessions.entries())) {
    const age = Math.round((Date.now() - session.createdAt) / 1000)
    lines.push(`- ${ptyId}: ${session.browserInfo.name} (${age}s ago)`)
  }
  return lines.join('\n')
}

/**
 * 更新会话活动时间
 */
export function touchSession(ptyId: string): void {
  const session = sessions.get(ptyId)
  if (session) {
    session.lastActivityAt = Date.now()
  }
}

