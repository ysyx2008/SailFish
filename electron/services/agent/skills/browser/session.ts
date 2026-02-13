/**
 * 浏览器会话管理
 * 每个终端（ptyId）最多一个浏览器会话
 */

import type { Browser, BrowserContext, Page } from 'playwright-core'
import { chromium, firefox } from 'playwright-core'
import { detectBrowser, type BrowserInfo } from './detector'
import type { RefMap } from './snapshot'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

// 浏览器 profile 存储目录（持久化上下文）
const getProfilesDir = () => path.join(app.getPath('userData'), 'browser-profiles')

// 旧版 storageState JSON 目录（用于迁移检测）
const getLegacyStorageDir = () => path.join(app.getPath('userData'), 'browser-storage')

// 默认 profile 名称
export const DEFAULT_PROFILE = '_default_'

export interface BrowserSession {
  browser: Browser | null  // 持久化上下文时为 null
  context: BrowserContext
  pages: Page[]
  currentPageIndex: number
  browserInfo: BrowserInfo
  createdAt: number
  lastActivityAt: number
  profile?: string  // 登录配置名称（对应持久化 profile 目录）
  /** 当前快照的 ref 映射（每次 snapshot 更新） */
  refs: RefMap
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
 * 获取 profile 目录路径（用于 launchPersistentContext 的 userDataDir）
 */
function getProfileDir(profileName: string): string {
  const dir = getProfilesDir()
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true })
  }
  // 清理目录名，移除不安全字符
  const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')
  return path.join(dir, safeName)
}

/**
 * 保存登录状态（持久化上下文会自动保存，此函数用于向后兼容和显式导出）
 */
export async function saveStorageState(session: BrowserSession, profileName: string): Promise<string> {
  // 持久化上下文会自动保存所有状态到 profile 目录
  // 此处仅返回 profile 目录路径
  const profileDir = getProfileDir(profileName)
  console.log(`[BrowserSession] Profile state auto-saved to ${profileDir}`)
  return profileDir
}

/**
 * 检查是否有已保存的 profile（持久化上下文目录或旧版 storageState JSON）
 */
export function hasStorageState(profileName: string): boolean {
  const profileDir = getProfileDir(profileName)
  if (fs.existsSync(profileDir)) {
    return true
  }
  // 兼容旧版 storageState JSON
  const legacyDir = getLegacyStorageDir()
  const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const legacyPath = path.join(legacyDir, `${safeName}.json`)
  return fs.existsSync(legacyPath)
}

/**
 * 列出所有保存的登录配置
 */
export function listStorageProfiles(): string[] {
  const profiles = new Set<string>()
  
  // 新版：profile 目录
  const profilesDir = getProfilesDir()
  if (fs.existsSync(profilesDir)) {
    for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        profiles.add(entry.name)
      }
    }
  }
  
  // 旧版兼容：storageState JSON
  const legacyDir = getLegacyStorageDir()
  if (fs.existsSync(legacyDir)) {
    for (const f of fs.readdirSync(legacyDir)) {
      if (f.endsWith('.json')) {
        profiles.add(f.replace('.json', ''))
      }
    }
  }
  
  return Array.from(profiles)
}

/**
 * 删除登录配置
 */
export function deleteStorageProfile(profileName: string): boolean {
  let deleted = false
  
  // 删除新版 profile 目录
  const profileDir = getProfileDir(profileName)
  if (fs.existsSync(profileDir)) {
    fs.rmSync(profileDir, { recursive: true, force: true })
    deleted = true
  }
  
  // 删除旧版 storageState JSON
  const legacyDir = getLegacyStorageDir()
  const safeName = profileName.replace(/[^a-zA-Z0-9_-]/g, '_')
  const legacyPath = path.join(legacyDir, `${safeName}.json`)
  if (fs.existsSync(legacyPath)) {
    fs.unlinkSync(legacyPath)
    deleted = true
  }
  
  return deleted
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
 * 检查指定 profile 是否已被其他会话占用
 */
function isProfileInUse(profileName: string, excludePtyId?: string): string | undefined {
  for (const [ptyId, session] of sessions.entries()) {
    if (session.profile === profileName && ptyId !== excludePtyId) {
      return ptyId
    }
  }
  return undefined
}

/**
 * 为页面注册 close 事件监听，维护 session.pages 数组
 */
function registerPageCloseHandler(session: BrowserSession, page: Page, ptyId: string) {
  page.on('close', () => {
    const index = session.pages.indexOf(page)
    if (index > -1) {
      session.pages.splice(index, 1)
      if (session.currentPageIndex >= session.pages.length) {
        session.currentPageIndex = Math.max(0, session.pages.length - 1)
      }
      console.log(`[BrowserSession] Tab closed for ${ptyId}, now ${session.pages.length} tabs`)
    }
  })
}

/**
 * 创建新会话
 * 使用 launchPersistentContext 实现：
 * - 只打开一个浏览器窗口（而非 launch + newContext 导致的两个窗口）
 * - 自动持久化所有浏览器数据（cookies、localStorage、IndexedDB 等）
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
  
  // 使用指定的 profile 或默认 profile
  const profileName = options.profile || DEFAULT_PROFILE
  
  // 检查 profile 是否被其他终端占用（持久化上下文对 profile 目录加锁，不允许并发访问）
  const occupiedBy = isProfileInUse(profileName, ptyId)
  if (occupiedBy) {
    throw new Error(`登录配置 "${profileName}" 正被另一个终端使用（${occupiedBy}）。请先在该终端关闭浏览器，或使用不同的 profile 名称。`)
  }
  
  // 检测浏览器
  const browserInfo = detectBrowser()
  if (!browserInfo) {
    throw new Error('未找到可用的浏览器。请安装 Chrome、Edge 或 Firefox。')
  }
  
  const profileDir = getProfileDir(profileName)
  
  // 使用 launchPersistentContext：只打开一个窗口，且自动持久化所有浏览器数据
  const launchOptions = {
    executablePath: browserInfo.executablePath,
    headless: options.headless ?? false, // 默认显示窗口
    viewport: { width: 1280, height: 800 } as { width: number; height: number },
    locale: 'zh-CN',
    args: [
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-extensions'
    ]
  }
  
  let context: BrowserContext
  if (browserInfo.type === 'firefox') {
    context = await firefox.launchPersistentContext(profileDir, launchOptions)
  } else {
    context = await chromium.launchPersistentContext(profileDir, launchOptions)
  }
  
  // 持久化上下文可能自带多个页面，收集所有已有页面
  const existingPages = context.pages()
  const initialPages = existingPages.length > 0 ? [...existingPages] : [await context.newPage()]
  
  const session: BrowserSession = {
    browser: null,  // 持久化上下文不暴露独立的 Browser 对象
    context,
    pages: initialPages,
    currentPageIndex: 0,
    browserInfo,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    profile: profileName,
    refs: {},
  }
  
  // 为所有已有页面注册 close 事件监听
  for (const p of initialPages) {
    registerPageCloseHandler(session, p, ptyId)
  }
  
  // 监听新页面打开事件（点击链接打开新标签页）
  context.on('page', async (newPage) => {
    session.pages.push(newPage)
    session.currentPageIndex = session.pages.length - 1
    session.lastActivityAt = Date.now()
    console.log(`[BrowserSession] New tab opened for ${ptyId}, now ${session.pages.length} tabs, switched to tab ${session.currentPageIndex}`)
    registerPageCloseHandler(session, newPage, ptyId)
  })
  
  // 如果指定了 URL，导航到该 URL
  if (options.url) {
    const page = initialPages[0]
    await page.goto(options.url, { waitUntil: 'domcontentloaded' })
  }
  
  sessions.set(ptyId, session)
  startTimeoutChecker()
  
  console.log(`[BrowserSession] Created session for ${ptyId} using ${browserInfo.name}, profile: ${profileDir}`)
  return session
}

/**
 * 关闭会话
 * 持久化上下文会在关闭时自动保存所有浏览器数据到 profile 目录
 */
export async function closeSession(ptyId: string, _saveProfile: boolean = true): Promise<{ closed: boolean; savedProfile?: string }> {
  const session = sessions.get(ptyId)
  if (!session) {
    return { closed: false }
  }
  
  const savedProfile = session.profile
  
  try {
    // 持久化上下文：关闭 context 会同时关闭浏览器并自动保存所有数据
    await session.context.close()
    if (savedProfile) {
      console.log(`[BrowserSession] Closed session for ${ptyId}, profile "${savedProfile}" auto-saved`)
    }
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

