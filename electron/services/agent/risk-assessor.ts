/**
 * 命令风险评估
 */
import type { RiskLevel } from './types'

/**
 * 命令处理信息
 */
export interface CommandHandlingInfo {
  /** 处理策略 */
  strategy: 'allow' | 'auto_fix' | 'timed_execution' | 'block'
  /** 原因说明 */
  reason?: string
  /** 修正后的命令（用于 auto_fix 策略）*/
  fixedCommand?: string
  /** 建议的超时时间（用于 timed_execution 策略，毫秒）*/
  suggestedTimeout?: number
  /** 超时后的处理方式 */
  timeoutAction?: 'ctrl_c' | 'ctrl_d' | 'q'
  /** 建议/提示信息 */
  hint?: string
}

/**
 * 分析命令并返回处理建议
 */
export function analyzeCommand(command: string): CommandHandlingInfo {
  const cmd = command.trim()
  const cmdLower = cmd.toLowerCase()
  const cmdName = cmdLower.split(/\s+/)[0]

  // ==================== 完全禁止的命令（有更好的工具替代）====================
  const blockedCommands: Record<string, string> = {
    'vim': '请使用 write_file 工具或 sed 命令编辑文件',
    'vi': '请使用 write_file 工具或 sed 命令编辑文件',
    'nvim': '请使用 write_file 工具或 sed 命令编辑文件',
    'nano': '请使用 write_file 工具或 sed 命令编辑文件',
    'emacs': '请使用 write_file 工具或 sed 命令编辑文件',
    'mc': '请使用 ls、cd、cp、mv 等命令',
    'ranger': '请使用 ls、cd、cp、mv 等命令',
    'tmux': '不支持在 Agent 中使用终端复用器',
    'screen': '不支持在 Agent 中使用终端复用器',
  }
  
  if (blockedCommands[cmdName]) {
    return {
      strategy: 'block',
      reason: `${cmdName} 是全屏交互式程序`,
      hint: blockedCommands[cmdName]
    }
  }

  // ==================== 可以自动修正的命令 ====================
  
  // ping 没有 -c 参数 → 添加 -c 4
  if (/\bping\s+/.test(cmdLower) && !/\s-c\s*\d/.test(cmdLower)) {
    // 找到 ping 后的目标，添加 -c 4
    const fixedCommand = cmd.replace(/\b(ping\s+)/, '$1-c 4 ')
    return {
      strategy: 'auto_fix',
      reason: 'ping 不带 -c 会持续运行',
      fixedCommand,
      hint: '已自动添加 -c 4 限制次数'
    }
  }

  // apt/yum/dnf install 没有 -y → 添加 -y
  const pkgInstallMatch = cmdLower.match(/\b(apt(?:-get)?|yum|dnf)\s+install\b/)
  if (pkgInstallMatch && !/\s-y\b|\s--yes\b/.test(cmdLower)) {
    const pkgManager = pkgInstallMatch[1]
    const fixedCommand = cmd.replace(
      new RegExp(`\\b(${pkgManager}\\s+install)\\b`, 'i'),
      '$1 -y'
    )
    return {
      strategy: 'auto_fix',
      reason: `${pkgManager} install 需要确认`,
      fixedCommand,
      hint: '已自动添加 -y 参数'
    }
  }

  // | less 或 | more → 移除分页器
  if (/\|\s*(less|more)\s*$/.test(cmdLower)) {
    const fixedCommand = cmd.replace(/\s*\|\s*(less|more)\s*$/, '')
    return {
      strategy: 'auto_fix',
      reason: 'less/more 是交互式分页器',
      fixedCommand,
      hint: '已移除分页器，直接输出'
    }
  }

  // less/more 文件 → cat 文件 | head -200
  if (/^(less|more)\s+/.test(cmdLower)) {
    const file = cmd.replace(/^(less|more)\s+/i, '')
    const fixedCommand = `cat ${file} | head -200`
    return {
      strategy: 'auto_fix',
      reason: 'less/more 是交互式分页器',
      fixedCommand,
      hint: '已改为 cat | head -200'
    }
  }

  // ==================== 自动转换为非交互式版本 ====================
  
  // top → 使用非交互式模式获取一次快照
  if (cmdName === 'top') {
    // macOS 和 Linux 的 top 参数不同
    // macOS: top -l 1 (list mode, 1 sample)
    // Linux: top -bn1 (batch mode, 1 iteration)
    // 我们生成一个兼容命令，让 shell 自己判断
    const fixedCommand = `(top -bn1 2>/dev/null || top -l 1 -n 0 2>/dev/null) | head -30`
    return {
      strategy: 'auto_fix',
      reason: 'top 是全屏程序，退出后会清屏',
      fixedCommand,
      hint: '已转换为非交互式模式 (top -bn1 或 top -l 1)'
    }
  }

  // htop → 没有非交互式模式，用 ps 替代
  if (cmdName === 'htop' || cmdName === 'btop') {
    const fixedCommand = `echo "=== CPU/内存占用 TOP 10 ===" && ps aux --sort=-%cpu 2>/dev/null | head -11 || ps aux -r | head -11`
    return {
      strategy: 'auto_fix',
      reason: `${cmdName} 是全屏程序，无非交互式模式`,
      fixedCommand,
      hint: '已替换为 ps aux 查看进程'
    }
  }

  // iotop → 用 iostat 替代
  if (cmdName === 'iotop') {
    const fixedCommand = `iostat -x 1 2 2>/dev/null || echo "iostat 未安装，尝试使用 sar" && sar -d 1 1 2>/dev/null || echo "请安装 sysstat 包"`
    return {
      strategy: 'auto_fix',
      reason: 'iotop 是全屏程序',
      fixedCommand,
      hint: '已替换为 iostat'
    }
  }

  // iftop → 用 ss 或 netstat 替代
  if (cmdName === 'iftop') {
    const fixedCommand = `ss -tunp 2>/dev/null | head -20 || netstat -tunp 2>/dev/null | head -20`
    return {
      strategy: 'auto_fix',
      reason: 'iftop 是全屏程序',
      fixedCommand,
      hint: '已替换为 ss/netstat 查看网络连接'
    }
  }

  // nmon → 用 vmstat 替代
  if (cmdName === 'nmon') {
    const fixedCommand = `echo "=== 系统状态 ===" && vmstat 1 3 && echo "=== 内存 ===" && free -h 2>/dev/null || vm_stat`
    return {
      strategy: 'auto_fix',
      reason: 'nmon 是全屏程序',
      fixedCommand,
      hint: '已替换为 vmstat + free'
    }
  }

  // watch 命令 → 直接执行被监控的命令一次
  if (/^watch\s+/.test(cmdLower)) {
    // 提取 watch 后面的实际命令
    const watchedCmd = cmd.replace(/^watch\s+(-n\s*\d+\s+)?(-d\s+)?/i, '').trim()
    if (watchedCmd) {
      return {
        strategy: 'auto_fix',
        reason: 'watch 会持续刷新',
        fixedCommand: watchedCmd,
        hint: `已移除 watch，直接执行: ${watchedCmd}`
      }
    }
  }

  // tail -f → 执行 5 秒收集输出
  if (/\btail\s+.*(-[fF]|--follow)/.test(cmd)) {
    return {
      strategy: 'timed_execution',
      reason: 'tail -f 会持续监听',
      suggestedTimeout: 5000,
      timeoutAction: 'ctrl_c',
      hint: '将监听 5 秒后自动退出'
    }
  }

  // journalctl -f → 执行 5 秒
  if (/\bjournalctl\s+.*(-f|--follow)/.test(cmd)) {
    return {
      strategy: 'timed_execution',
      reason: 'journalctl -f 会持续监听',
      suggestedTimeout: 5000,
      timeoutAction: 'ctrl_c',
      hint: '将监听 5 秒后自动退出'
    }
  }

  // docker logs -f → 执行 5 秒
  if (/\bdocker\s+logs\s+.*(-f|--follow)/.test(cmd)) {
    return {
      strategy: 'timed_execution',
      reason: 'docker logs -f 会持续监听',
      suggestedTimeout: 5000,
      timeoutAction: 'ctrl_c',
      hint: '将监听 5 秒后自动退出'
    }
  }

  // kubectl logs -f → 执行 5 秒
  if (/\bkubectl\s+logs\s+.*(-f|--follow)/.test(cmd)) {
    return {
      strategy: 'timed_execution',
      reason: 'kubectl logs -f 会持续监听',
      suggestedTimeout: 5000,
      timeoutAction: 'ctrl_c',
      hint: '将监听 5 秒后自动退出'
    }
  }

  // ==================== 正常执行 ====================
  return { strategy: 'allow' }
}

// 兼容旧接口
export interface InteractiveCommandInfo {
  isInteractive: boolean
  type?: 'fullscreen' | 'continuous' | 'input_required' | 'pager'
  reason?: string
  alternative?: string
}

export function detectInteractiveCommand(command: string): InteractiveCommandInfo {
  const info = analyzeCommand(command)
  if (info.strategy === 'block') {
    return {
      isInteractive: true,
      type: 'fullscreen',
      reason: info.reason,
      alternative: info.hint
    }
  }
  return { isInteractive: false }
}

/**
 * 评估命令风险等级
 */
export function assessCommandRisk(command: string): RiskLevel {
  const cmd = command.toLowerCase().trim()

  // 黑名单 - 直接拒绝
  const blocked = [
    /rm\s+(-[rf]+\s+)*\/(?:\s|$)/,    // rm -rf /
    /rm\s+(-[rf]+\s+)*\/\*/,           // rm -rf /*
    /:\(\)\{.*:\|:.*\}/,               // fork bomb
    /mkfs\./,                           // 格式化磁盘
    /dd\s+.*of=\/dev\/[sh]d[a-z]/,     // dd 写入磁盘
    />\s*\/dev\/[sh]d[a-z]/,           // 重定向到磁盘
    /chmod\s+777\s+\//,                 // chmod 777 /
    /chown\s+.*\s+\//,                  // chown /
    />\s*\/etc\/(passwd|shadow|sudoers)/, // 清空系统关键文件
  ]
  if (blocked.some(p => p.test(cmd))) return 'blocked'

  // 高危 - 需要确认
  const dangerous = [
    /\brm\s+(-[rf]+\s+)*/,             // rm 命令
    /\bkill\s+(-9\s+)?/,               // kill 命令
    /\bkillall\b/,                      // killall
    /\bpkill\b/,                        // pkill
    /\bchmod\s+/,                       // chmod
    /\bchown\s+/,                       // chown
    /\bshutdown\b/,                     // shutdown
    /\breboot\b/,                       // reboot
    /\bhalt\b/,                         // halt
    /\bpoweroff\b/,                     // poweroff
    /\bsystemctl\s+(stop|restart|disable)/, // systemctl 危险操作
    /\bservice\s+\w+\s+(stop|restart)/,     // service 停止/重启
    /\bapt\s+remove/,                   // apt remove
    /\byum\s+remove/,                   // yum remove
    /\bdnf\s+remove/,                   // dnf remove
    />\s*\/etc\//,                      // 重定向到 /etc
    />\s*\/var\//,                      // 重定向到 /var
    /\bcurl\s+.*\|\s*(ba)?sh/,          // curl ... | bash (远程代码执行)
    /\bwget\s+.*-O\s*-?\s*\|\s*(ba)?sh/, // wget -O- | sh (远程代码执行)
  ]
  if (dangerous.some(p => p.test(cmd))) return 'dangerous'

  // 中危 - 显示但可自动执行
  const moderate = [
    /\bmv\s+/,                          // mv
    /\bcp\s+/,                          // cp
    /\bmkdir\s+/,                       // mkdir
    /\btouch\s+/,                       // touch
    /\bsystemctl\s+(start|enable|status)/, // systemctl 非危险操作
    /\bservice\s+\w+\s+start/,          // service start
    /\bapt\s+install/,                  // apt install
    /\byum\s+install/,                  // yum install
    /\bdnf\s+install/,                  // dnf install
    /\bnpm\s+install/,                  // npm install
    /\bpip\s+install/,                  // pip install
    /\bgit\s+(pull|push|commit)/        // git 修改操作
  ]
  if (moderate.some(p => p.test(cmd))) return 'moderate'

  // 安全 - 直接执行
  return 'safe'
}
