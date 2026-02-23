/**
 * 浏览器路径检测器
 * 自动检测系统中已安装的浏览器
 */

import * as fs from 'fs'
import { execSync } from 'child_process'
import { createLogger } from '../../../../utils/logger'

const log = createLogger('BrowserDetector')

export interface BrowserInfo {
  name: string
  type: 'chromium' | 'firefox' | 'webkit'
  executablePath: string
}

/**
 * 检测系统中已安装的浏览器
 * 返回第一个可用的浏览器，优先级：Chrome > Edge > Firefox
 */
export function detectBrowser(): BrowserInfo | null {
  const platform = process.platform
  
  const browsers = getBrowserPaths(platform)
  
  for (const browser of browsers) {
    if (fs.existsSync(browser.executablePath)) {
      log.info(`Found ${browser.name} at ${browser.executablePath}`)
      return browser
    }
  }
  
  // Linux: 尝试使用 which 命令查找
  if (platform === 'linux') {
    const linuxBrowsers = [
      { cmd: 'google-chrome', name: 'Google Chrome', type: 'chromium' as const },
      { cmd: 'google-chrome-stable', name: 'Google Chrome', type: 'chromium' as const },
      { cmd: 'chromium', name: 'Chromium', type: 'chromium' as const },
      { cmd: 'chromium-browser', name: 'Chromium', type: 'chromium' as const },
      { cmd: 'microsoft-edge', name: 'Microsoft Edge', type: 'chromium' as const },
      { cmd: 'firefox', name: 'Firefox', type: 'firefox' as const }
    ]
    
    for (const browser of linuxBrowsers) {
      try {
        const result = execSync(`which ${browser.cmd}`, { encoding: 'utf-8' }).trim()
        if (result) {
          log.info(`Found ${browser.name} at ${result}`)
          return {
            name: browser.name,
            type: browser.type,
            executablePath: result
          }
        }
      } catch {
        // which 命令失败，继续尝试下一个
      }
    }
  }
  
  log.warn('No browser found')
  return null
}

/**
 * 获取各平台的浏览器路径列表
 */
function getBrowserPaths(platform: string): BrowserInfo[] {
  switch (platform) {
    case 'darwin': // macOS
      return [
        {
          name: 'Google Chrome',
          type: 'chromium',
          executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
        },
        {
          name: 'Microsoft Edge',
          type: 'chromium',
          executablePath: '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
        },
        {
          name: 'Chromium',
          type: 'chromium',
          executablePath: '/Applications/Chromium.app/Contents/MacOS/Chromium'
        },
        {
          name: 'Firefox',
          type: 'firefox',
          executablePath: '/Applications/Firefox.app/Contents/MacOS/firefox'
        }
      ]
      
    case 'win32': // Windows
      return [
        {
          name: 'Google Chrome',
          type: 'chromium',
          executablePath: 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
        },
        {
          name: 'Google Chrome (x86)',
          type: 'chromium',
          executablePath: 'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
        },
        {
          name: 'Microsoft Edge',
          type: 'chromium',
          executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe'
        },
        {
          name: 'Microsoft Edge',
          type: 'chromium',
          executablePath: 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
        },
        {
          name: 'Firefox',
          type: 'firefox',
          executablePath: 'C:\\Program Files\\Mozilla Firefox\\firefox.exe'
        },
        {
          name: 'Firefox (x86)',
          type: 'firefox',
          executablePath: 'C:\\Program Files (x86)\\Mozilla Firefox\\firefox.exe'
        }
      ]
      
    case 'linux':
      return [
        {
          name: 'Google Chrome',
          type: 'chromium',
          executablePath: '/usr/bin/google-chrome'
        },
        {
          name: 'Google Chrome',
          type: 'chromium',
          executablePath: '/usr/bin/google-chrome-stable'
        },
        {
          name: 'Chromium',
          type: 'chromium',
          executablePath: '/usr/bin/chromium'
        },
        {
          name: 'Chromium',
          type: 'chromium',
          executablePath: '/usr/bin/chromium-browser'
        },
        {
          name: 'Microsoft Edge',
          type: 'chromium',
          executablePath: '/usr/bin/microsoft-edge'
        },
        {
          name: 'Firefox',
          type: 'firefox',
          executablePath: '/usr/bin/firefox'
        }
      ]
      
    default:
      return []
  }
}

/**
 * 获取检测到的浏览器列表
 */
export function listAvailableBrowsers(): BrowserInfo[] {
  const platform = process.platform
  const browsers = getBrowserPaths(platform)
  
  return browsers.filter(browser => fs.existsSync(browser.executablePath))
}

