/**
 * 智能进度检测器
 * 解析命令输出中的进度信息，支持多种格式
 */

export interface ProgressInfo {
  /** 进度类型 */
  type: 'percentage' | 'fraction' | 'count' | 'stage' | 'eta'
  /** 进度值 (0-100) */
  value: number
  /** 当前值（分数形式） */
  current?: number
  /** 总数（分数形式） */
  total?: number
  /** 当前阶段名称 */
  stage?: string
  /** 预计剩余时间 */
  eta?: string
  /** 速度（下载/构建） */
  speed?: string
  /** 原始匹配文本 */
  rawMatch?: string
}

export interface CommandProgress {
  /** 命令类型 */
  commandType: 'build' | 'download' | 'install' | 'test' | 'compile' | 'deploy' | 'generic'
  /** 进度信息 */
  progress: ProgressInfo | null
  /** 是否为不确定进度（如 spinning） */
  isIndeterminate: boolean
  /** 最后更新时间 */
  lastUpdate: number
  /** 状态描述 */
  statusText?: string
}

// 进度模式识别正则
const PROGRESS_PATTERNS = {
  // 百分比模式: 50%, 50.5%, (50%), [50%], 50 %
  percentage: /(?:^|\s|\[|\()(\d{1,3}(?:\.\d+)?)\s*%(?:\]|\))?/,
  
  // 分数模式: 5/10, [5/10], (5 of 10), Step 5 of 10
  fraction: /(?:^|\s|\[|\()(\d+)\s*(?:\/|of)\s*(\d+)(?:\]|\))?/i,
  
  // ETA 模式: ETA: 5m, eta 30s, ~2min remaining, 剩余 5分钟
  eta: /(?:eta|remaining|left|剩余)[:\s]*(\d+\s*[smh分秒]|\d+:\d+(?::\d+)?)/i,
  
  // 速度模式: 5.2 MB/s, 100 KB/s, 1.5 MiB/s
  speed: /(\d+(?:\.\d+)?\s*(?:KB|MB|GB|KiB|MiB|GiB)\/s)/i,
  
  // 编译进度: Compiling [5/10], Building module 5/10, [5/10] Building
  compile: /(?:compiling|building|processing|linking).*?(\d+)\s*(?:\/|of)\s*(\d+)/i,
  
  // npm/yarn 进度条: [###-------] 30%, ████████░░
  npmProgress: /\[([#=]+)([- ]*)\]\s*(\d+)%/,
  
  // 下载进度: Downloading... 50%, 正在下载 50%
  download: /(?:downloading|fetching|pulling|下载).*?(\d+)\s*%/i,
  
  // 测试进度: Tests: 5 passed, 2 failed, 10 total
  testProgress: /tests?[:\s]*(\d+)\s*(?:passed|✓|通过).*?(\d+)\s*total/i,
  
  // Go mod 下载: go: downloading xxx v1.2.3
  goDownload: /go:\s*downloading\s+(\S+)/,
  
  // Cargo 构建: Compiling xxx v1.2.3 (5/10)
  cargoProgress: /(?:Compiling|Downloading|Building).*?\((\d+)\/(\d+)\)/,
  
  // pip 安装: Installing collected packages: xxx (5/10)
  pipProgress: /(?:Installing|Collecting).*?(\d+)\/(\d+)/,
  
  // Docker 构建: Step 5/10 :
  dockerProgress: /Step\s+(\d+)\/(\d+)/i,
  
  // Maven 构建: [INFO] Building xxx [5/10]
  mavenProgress: /Building.*?\[(\d+)\/(\d+)\]/,
  
  // Gradle 构建: > Task :xxx (5 of 10)
  gradleProgress: /Task.*?\((\d+)\s+of\s+(\d+)\)/i,
}

// Spinner 字符检测
const SPINNER_CHARS = /[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷⠁⠂⠄⡀⢀⠠⠐⠈|\\\/\-]/

// 命令类型检测关键词
const COMMAND_TYPE_PATTERNS: Record<CommandProgress['commandType'], RegExp> = {
  build: /\b(npm|yarn|pnpm)\s+(run\s+)?build\b|\bvite\s+build\b|\bnext\s+build\b|\bwebpack\b/i,
  download: /\b(wget|curl|aria2c|axel)\b.*(-o|-O|--output)|下载/i,
  install: /\b(npm|yarn|pnpm|pip|pip3|apt|apt-get|yum|dnf|brew|cargo)\s+install\b/i,
  test: /\b(npm|yarn|pnpm)\s+(run\s+)?test\b|\b(jest|mocha|pytest|go\s+test|cargo\s+test)\b/i,
  compile: /\b(gcc|g\+\+|clang|make|cmake|cargo\s+build|go\s+build|javac|tsc|swc)\b/i,
  deploy: /\b(deploy|kubectl\s+apply|docker\s+push|helm\s+install|ansible)\b/i,
  generic: /.*/,
}

/**
 * 检测命令类型
 */
export function detectCommandType(command: string): CommandProgress['commandType'] {
  const cmd = command.toLowerCase()
  
  for (const [type, pattern] of Object.entries(COMMAND_TYPE_PATTERNS)) {
    if (type !== 'generic' && pattern.test(cmd)) {
      return type as CommandProgress['commandType']
    }
  }
  
  return 'generic'
}

/**
 * 从输出中检测进度
 * @param output 命令输出内容
 * @param command 原始命令（可选，用于确定命令类型）
 */
export function detectProgress(output: string, command?: string): CommandProgress {
  // 只分析最后 30 行，避免处理过多内容
  const lines = output.split('\n').slice(-30)
  let progress: ProgressInfo | null = null
  let isIndeterminate = false
  let statusText: string | undefined
  
  // 从最新的行开始检测
  for (const line of [...lines].reverse()) {
    const trimmedLine = line.trim()
    if (!trimmedLine) continue
    
    // 1. 尝试百分比模式
    const percentMatch = trimmedLine.match(PROGRESS_PATTERNS.percentage)
    if (percentMatch) {
      const value = parseFloat(percentMatch[1])
      if (value >= 0 && value <= 100) {
        progress = {
          type: 'percentage',
          value,
          rawMatch: percentMatch[0]
        }
        statusText = extractStatusText(trimmedLine)
        break
      }
    }
    
    // 2. 尝试各种分数模式
    const fractionPatterns = [
      PROGRESS_PATTERNS.fraction,
      PROGRESS_PATTERNS.compile,
      PROGRESS_PATTERNS.cargoProgress,
      PROGRESS_PATTERNS.dockerProgress,
      PROGRESS_PATTERNS.mavenProgress,
      PROGRESS_PATTERNS.gradleProgress,
    ]
    
    for (const pattern of fractionPatterns) {
      const match = trimmedLine.match(pattern)
      if (match) {
        const current = parseInt(match[1])
        const total = parseInt(match[2])
        if (current > 0 && total > 0 && current <= total) {
          progress = {
            type: 'fraction',
            value: Math.round((current / total) * 100),
            current,
            total,
            rawMatch: match[0]
          }
          statusText = extractStatusText(trimmedLine)
          break
        }
      }
    }
    if (progress) break
    
    // 3. npm 进度条模式
    const npmMatch = trimmedLine.match(PROGRESS_PATTERNS.npmProgress)
    if (npmMatch) {
      progress = {
        type: 'percentage',
        value: parseInt(npmMatch[3]),
        rawMatch: npmMatch[0]
      }
      break
    }
    
    // 4. 下载进度
    const downloadMatch = trimmedLine.match(PROGRESS_PATTERNS.download)
    if (downloadMatch) {
      progress = {
        type: 'percentage',
        value: parseInt(downloadMatch[1]),
        rawMatch: downloadMatch[0]
      }
      statusText = '下载中'
      break
    }
    
    // 5. 测试进度
    const testMatch = trimmedLine.match(PROGRESS_PATTERNS.testProgress)
    if (testMatch) {
      const passed = parseInt(testMatch[1])
      const total = parseInt(testMatch[2])
      if (total > 0) {
        progress = {
          type: 'fraction',
          value: Math.round((passed / total) * 100),
          current: passed,
          total,
          rawMatch: testMatch[0]
        }
        statusText = `测试: ${passed}/${total} 通过`
        break
      }
    }
  }
  
  // 从所有行中提取 ETA 和速度信息
  if (progress) {
    for (const line of lines) {
      if (!progress.eta) {
        const etaMatch = line.match(PROGRESS_PATTERNS.eta)
        if (etaMatch) {
          progress.eta = etaMatch[1]
        }
      }
      
      if (!progress.speed) {
        const speedMatch = line.match(PROGRESS_PATTERNS.speed)
        if (speedMatch) {
          progress.speed = speedMatch[1]
        }
      }
    }
  }
  
  // 检测无确定进度的 spinner（表示正在执行但无法确定进度）
  if (!progress) {
    const recentLines = lines.slice(-5).join('')
    if (SPINNER_CHARS.test(recentLines)) {
      isIndeterminate = true
      statusText = extractStatusFromSpinner(lines.slice(-5))
    }
  }
  
  return {
    commandType: detectCommandType(command || ''),
    progress,
    isIndeterminate,
    lastUpdate: Date.now(),
    statusText
  }
}

/**
 * 从行中提取状态文本
 */
function extractStatusText(line: string): string | undefined {
  // 移除进度数字和特殊字符，保留有意义的文本
  const cleaned = line
    .replace(/\[.*?\]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/\d+%/g, '')
    .replace(/\d+\/\d+/g, '')
    .replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏⣾⣽⣻⢿⡿⣟⣯⣷▓░█▒]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  
  if (cleaned.length > 5 && cleaned.length < 100) {
    return cleaned
  }
  return undefined
}

/**
 * 从 spinner 行中提取状态
 */
function extractStatusFromSpinner(lines: string[]): string | undefined {
  for (const line of lines) {
    const cleaned = line.replace(SPINNER_CHARS, '').trim()
    if (cleaned.length > 3 && cleaned.length < 80) {
      // 移除常见的前缀
      return cleaned
        .replace(/^(info|warn|error|debug)[:>\s]*/i, '')
        .replace(/^[\-\*\•]\s*/, '')
        .trim() || undefined
    }
  }
  return undefined
}

/**
 * 判断进度是否有实质性更新
 */
export function hasProgressChanged(
  oldProgress: CommandProgress | null,
  newProgress: CommandProgress
): boolean {
  if (!oldProgress) return true
  if (!oldProgress.progress && newProgress.progress) return true
  if (oldProgress.progress && !newProgress.progress) return true
  if (oldProgress.isIndeterminate !== newProgress.isIndeterminate) return true
  
  if (oldProgress.progress && newProgress.progress) {
    // 进度变化超过 1% 才算更新
    if (Math.abs(oldProgress.progress.value - newProgress.progress.value) >= 1) return true
    // ETA 变化
    if (oldProgress.progress.eta !== newProgress.progress.eta) return true
  }
  
  return false
}

/**
 * 格式化进度为显示文本
 */
export function formatProgressText(progress: CommandProgress): string {
  if (progress.isIndeterminate) {
    return progress.statusText || '执行中...'
  }
  
  if (!progress.progress) {
    return ''
  }
  
  const p = progress.progress
  let text = ''
  
  if (p.type === 'fraction' && p.current !== undefined && p.total !== undefined) {
    text = `${p.current}/${p.total} (${p.value}%)`
  } else {
    text = `${p.value}%`
  }
  
  if (p.eta) {
    text += ` · ETA: ${p.eta}`
  }
  
  if (p.speed) {
    text += ` · ${p.speed}`
  }
  
  if (progress.statusText) {
    text += ` - ${progress.statusText}`
  }
  
  return text
}

