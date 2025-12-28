/**
 * 命令风险评估
 */
import type { RiskLevel } from './types'
import { t } from './i18n'

/**
 * 命令处理信息
 */
export interface CommandHandlingInfo {
  /** 处理策略 */
  strategy: 'allow' | 'auto_fix' | 'timed_execution' | 'fire_and_forget' | 'block'
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
    'vim': t('risk.blocked_hint_editor'),
    'vi': t('risk.blocked_hint_editor'),
    'nvim': t('risk.blocked_hint_editor'),
    'nano': t('risk.blocked_hint_editor'),
    'emacs': t('risk.blocked_hint_editor'),
    'mc': t('risk.blocked_hint_fm'),
    'ranger': t('risk.blocked_hint_fm'),
    'tmux': t('risk.blocked_hint_tmux'),
    'screen': t('risk.blocked_hint_tmux'),
  }
  
  if (blockedCommands[cmdName]) {
    return {
      strategy: 'block',
      reason: t('risk.blocked_interactive', { cmd: cmdName }),
      hint: blockedCommands[cmdName]
    }
  }

  // ==================== 可以自动修正的命令 ====================
  
  // apt/yum/dnf install 没有 -y → 添加 -y（交互式确认难以可靠处理）
  const pkgInstallMatch = cmdLower.match(/\b(apt(?:-get)?|yum|dnf)\s+install\b/)
  if (pkgInstallMatch && !/\s-y\b|\s--yes\b/.test(cmdLower)) {
    const pkgManager = pkgInstallMatch[1]
    const fixedCommand = cmd.replace(
      new RegExp(`\\b(${pkgManager}\\s+install)\\b`, 'i'),
      '$1 -y'
    )
    return {
      strategy: 'auto_fix',
      reason: t('risk.pkg_needs_confirm', { pkg: pkgManager }),
      fixedCommand,
      hint: t('risk.auto_added_y')
    }
  }

  // ==================== 持续运行的命令（发送即返回）====================
  // 这类命令会持续运行，没有明确的"完成"信号，不应该等待超时
  // 发送后立即返回，让 Agent 用 get_terminal_context 查看输出，用 send_control_key 停止
  
  // tail -f / tail --follow
  if (/\btail\s+.*(-f|--follow)\b/.test(cmd) || /\btail\s+-[a-zA-Z]*f/.test(cmd)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.tail_continuous'),
      hint: t('risk.fire_and_forget_hint', { key: 'ctrl+c' })
    }
  }
  
  // ping（没有 -c 参数的）
  if (/\bping\s+/.test(cmdLower) && !/\s-c\s*\d+/.test(cmd)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.ping_continuous'),
      hint: t('risk.fire_and_forget_hint', { key: 'ctrl+c' })
    }
  }
  
  // watch 命令
  if (/\bwatch\s+/.test(cmdLower)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.watch_continuous'),
      hint: t('risk.fire_and_forget_hint', { key: 'ctrl+c' })
    }
  }
  
  // top/htop/btop 等监控工具
  if (/\b(top|htop|btop|atop|iotop|iftop|nload|bmon)\b/.test(cmdLower)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.monitor_tool', { cmd: cmdName }),
      hint: t('risk.monitor_exit_hint')
    }
  }
  
  // journalctl -f (follow 模式)
  if (/\bjournalctl\s+.*-f\b/.test(cmd) || /\bjournalctl\s+-[a-zA-Z]*f/.test(cmd)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.journalctl_continuous'),
      hint: t('risk.fire_and_forget_hint', { key: 'ctrl+c' })
    }
  }
  
  // dmesg -w (watch 模式)
  if (/\bdmesg\s+.*-w\b/.test(cmd) || /\bdmesg\s+-[a-zA-Z]*w/.test(cmd)) {
    return {
      strategy: 'fire_and_forget',
      reason: t('risk.dmesg_continuous'),
      hint: t('risk.fire_and_forget_hint', { key: 'ctrl+c' })
    }
  }

  // ==================== 正常执行 ====================
  return { strategy: 'allow' }
}

/**
 * 检测命令是否需要特权提升（sudo/su/doas 等）
 * 这类命令可能会提示用户输入密码
 */
export function isSudoCommand(command: string): boolean {
  const cmd = command.trim()
  const cmdLower = cmd.toLowerCase()
  
  // sudo 命令模式
  if (/^sudo\s+/.test(cmdLower)) return true
  if (/\|\s*sudo\s+/.test(cmdLower)) return true  // 管道到 sudo
  
  // su 命令模式
  if (/^su\s+(-c\s+)?/.test(cmdLower)) return true
  if (/^su$/.test(cmdLower)) return true
  
  // pkexec (polkit)
  if (/^pkexec\s+/.test(cmdLower)) return true
  
  // doas (OpenBSD/部分 Linux)
  if (/^doas\s+/.test(cmdLower)) return true
  
  // macOS 的 osascript 提权
  if (/osascript\s+.*administrator\s+privileges/i.test(cmdLower)) return true
  
  return false
}

/**
 * 密码提示检测模式（用于终端输出检测）
 */
export const PASSWORD_PROMPT_PATTERNS = [
  /password\s*:/i,
  /password\s+for\s+\w+/i,
  /\[sudo\]\s*password/i,
  /\w+'s\s*password/i,
  /enter\s*passphrase/i,
  /enter\s*password/i,
  /authentication\s*password/i,
  /login\s*password/i,
  /SUDO password/i,
  /authentication\s*token/i,
  /密码\s*[:：]/,
  /^\s*password\s*$/i,
]

/**
 * 检测终端输出中是否包含密码提示
 */
export function detectPasswordPrompt(output: string): { detected: boolean; prompt?: string } {
  const lines = output.split('\n')
  // 检查最后几行（密码提示通常在最后）
  const recentLines = lines.slice(-5)
  
  for (const line of recentLines) {
    for (const pattern of PASSWORD_PROMPT_PATTERNS) {
      if (pattern.test(line)) {
        return { detected: true, prompt: line.trim() }
      }
    }
  }
  
  return { detected: false }
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
    /\bgit\s+(pull|push|commit)/,       // git 修改操作
    /[^>]>\s*[^>]/,                     // 重定向覆盖文件（> file，但排除 >> 追加）
  ]
  if (moderate.some(p => p.test(cmd))) return 'moderate'

  // 安全 - 直接执行
  return 'safe'
}
