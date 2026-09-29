/**
 * 命令审计类型定义
 *
 * 设计原则：
 * - Fail-Closed：解析失败 / 动态命令 / 写操作未知 → dangerous；纯只读未知 → moderate + 强制确认
 * - 路径优先：先判断路径是否在工作区，再判断命令本身
 * - 沙箱分区：工作区内按 free/protected/workspace 三档调整风险
 */

import type { RiskLevel, ExecutionMode, CommandRiskPolicy } from '@shared/types/agent'

/**
 * 工作区路径分区
 *
 * 分区设计（C 方案）：
 * - free       scratch/、charts/、migrations/、系统临时目录（/tmp、os.tmpdir 等）— 读写删免确认
 * - protected  templates/、根目录人格配置 md — 写删需确认
 * - workspace  工作区内其他 — 写删需确认
 * - outside    工作区外 — safe 命令（如 cp）不升级；moderate/dangerous 保持原等级
 */
export type WorkspaceZone = 'free' | 'protected' | 'workspace' | 'outside'

/**
 * 命令审计上下文
 *
 * 审计时需要的环境信息：当前工作目录、工作区根、shell 类型。
 */
export interface AuditContext {
  /** 工作区根目录（agent-workspace/），用于路径分区判断 */
  workspaceRoot?: string
  /** 命令的当前工作目录（cwd 参数或 spawn cwd） */
  cwd?: string
  /** shell 类型，影响审计策略 */
  shell?: 'bash' | 'zsh' | 'sh' | 'powershell' | 'cmd' | 'unknown'
  /**
   * 当前执行模式（用于解析失败 / 未知命令 按 mode 选档位）。
   * 不传时回退旧行为：解析失败 dangerous、未知命令 moderate。
   */
  executionMode?: ExecutionMode
  /**
   * 解析失败 / 未知命令 的风险策略。
   * 不传时回退 DEFAULT_COMMAND_RISK_POLICY。
   */
  riskPolicy?: CommandRiskPolicy
}

/**
 * 已审计的命令调用（统一中间表示）
 *
 * shell 通道由 AST 解析后归一化为此结构。
 */
export interface AuditedCall {
  /** 命令名（已 unwrap wrapper，如 sudo rm 的 cmd 仍是 "rm"） */
  cmd: string
  /** 规范化后的 flags（合并短 flag：-rf → -r -f） */
  flags: string[]
  /** 非路径、非 flag 的位置参数 */
  args: string[]
  /** 路径参数（按在原命令中的位置标记，用于路径分区判断） */
  paths: string[]
  /** 重定向（> file、>> file、< file 等）—— 写重定向的路径参与风险判定 */
  redirects: AuditedRedirect[]
  /** wrapper 信息（sudo / bash -c / sh -c / eval 等）—— 已 unwrap */
  wrapper?: {
    name: string
    /** wrapper 的额外参数，如 sudo -u root 的 "root" */
    args?: string[]
    /** bash -c 'script' 中的内层脚本（已递归审计时为空，否则需递归） */
    script?: string
  }
  /** 原始命令文本（用于错误信息和日志） */
  raw: string
  /** shell 来源（AST 解析的 shell 类型） */
  source: 'bash' | 'zsh' | 'sh' | 'powershell'
  /** 存在 $VAR / $(...) 等无法静态解析的路径参数 */
  dynamicPaths?: boolean
  /** 出现过 `--`（其后都不是选项）。bash 解析时 `--` 本身不进 flags / paths；PowerShell 留在 flags 里 */
  endOfOptions?: boolean
}

/**
 * 命令重定向
 */
export interface AuditedRedirect {
  /** 重定向类型 */
  op: '>' | '>>' | '<' | '2>' | '2>>' | '&>' | '2>&1'
  /** 目标路径（重定向到文件时；2>&1 这类 fd 复制无路径） */
  target?: string
  /** 是否为写操作（>、>>、2>、&> 等会写文件） */
  isWrite: boolean
}

/**
 * 单条命令的审计结果
 */
export interface CallRiskAssessment {
  /** 最终风险等级（已经过路径调整） */
  level: RiskLevel
  /** 命令本身风险（未经路径调整） */
  commandLevel: RiskLevel
  /** 触发此风险等级的原因（用于确认卡片展示给用户） */
  reasons: string[]
  /** 路径分区分析（用于调试和审计日志） */
  pathZones?: WorkspaceZone[]
  /** 不在 argv 白名单（等级由 commandRiskPolicy 决定） */
  unknown?: boolean
  /** 子命令名（有 AuditedCall 时带上；orphan 重定向评估无此字段） */
  cmd?: string
  /**
   * 未知命令时是否按「会写文件」推断（有写重定向等）。
   * 供确认弹窗「加入规则」默认勾选 writesTo。
   */
  inferredWritesTo?: boolean
}

/**
 * 整条命令（可能包含多条子命令）的审计结果
 */
export interface CommandRiskAssessment {
  /** 最终风险等级（所有子命令的最高等级） */
  level: RiskLevel
  /** 每条子命令的审计详情 */
  calls: CallRiskAssessment[]
  /** 是否成功解析（false 表示走 Fail-Closed 保守路径） */
  parsed: boolean
  /** 解析失败原因（parsed=false 时） */
  parseError?: string
  /** 是否包含未识别子命令（等级由 commandRiskPolicy 决定） */
  hasUnknown?: boolean
}

/**
 * 系统路径黑名单条目（跨平台）
 *
 * severity 分两级：
 * - critical：删除或覆写 → blocked（硬墙）；改权限或属主 → dangerous。
 *   仅保留真正不可逆的系统级灾难路径：`/`（根）、`/boot`（引导）。
 *   删除或覆写这些路径 → blocked；改权限或属主 → dangerous（可恢复，先确认）。
 *   整串规则已对 `rm -rf /`、`dd of=/`、`mkfs /boot` 等模式做了兜底。
 *   格式化 `/dev/sdX`、非 C: 盘符不在硬墙内，走 dangerous 确认。
 *   Windows `format C:` 仍硬拒。
 * - hardened：写操作 → dangerous（弹确认，用户知情后可放行）。
 *   `/etc` `/dev` `/sys` `/proc` `/System` 等系统目录，写它们有风险但可恢复，
 *   或存在合法操作（如 `dd of=/dev/sdX` 烧录、`> /dev/null` 丢弃输出）。
 *
 * 注意：read-only 命令（cat、ls）对这些路径的读取是 safe，
 * 黑名单只对写操作（rm、mv、>、chmod 等）生效；chmod/chown/chgrp 在 critical 上不硬拒。
 *
 * /dev/null 等黑洞设备由 DEV_NULL_EXEMPTIONS 单独豁免为 safe。
 */
export interface SystemPathPattern {
  /** 匹配正则 */
  pattern: RegExp
  /** 人类可读描述（用于设置页只读展示） */
  description: string
  /**
   * 严重程度：
   * - critical：删除或覆写 hard block；改权限或属主为 dangerous
   * - hardened：写操作降为 dangerous（弹确认即可放行）
   */
  severity: 'critical' | 'hardened'
}

export const SYSTEM_PATH_PATTERNS: readonly SystemPathPattern[] = [
  // === critical：删/覆写 hard block；改权限或属主为 dangerous ===
  // Unix 文件系统根（整串规则已拦 rm -rf /，此为路径守卫兜底）
  { pattern: /^\/$/, description: '/ (文件系统根)', severity: 'critical' },
  // 引导分区（写错系统起不来）
  { pattern: /^\/boot(\/|$)/, description: '/boot 及其子目录', severity: 'critical' },
  // === hardened：写操作降为 dangerous（弹确认放行）===
  // 系统配置（可恢复，但影响系统服务）
  { pattern: /^\/etc(\/|$)/, description: '/etc 及其子目录', severity: 'hardened' },
  { pattern: /^\/private\/etc(\/|$)/, description: '/private/etc 及其子目录（macOS）', severity: 'hardened' },
  // 内核虚拟 / 设备文件（/dev/null 黑洞单独豁免；/dev/sdX 烧录是合法操作）
  { pattern: /^\/dev(\/|$)/, description: '/dev 及其子目录', severity: 'hardened' },
  { pattern: /^\/proc(\/|$)/, description: '/proc 及其子目录', severity: 'hardened' },
  { pattern: /^\/sys(\/|$)/, description: '/sys 及其子目录', severity: 'hardened' },
  // root 家目录（写它跟写普通家目录风险类似）
  { pattern: /^\/root(\/|$)/, description: '/root 及其子目录', severity: 'hardened' },
  // macOS 系统目录（APFS 封装后基本写不了，写了影响全局）
  { pattern: /^\/System(\/|$)/, description: '/System 及其子目录（macOS）', severity: 'hardened' },
  { pattern: /^\/Library(\/|$)/, description: '/Library 及其子目录（macOS）', severity: 'hardened' },
  // Windows 系统路径（可恢复，但影响系统）
  { pattern: /^[a-zA-Z]:\\$/, description: '盘符根目录（如 C:\\）', severity: 'hardened' },
  { pattern: /^[a-zA-Z]:\\Windows(\/|\\|$)/i, description: 'Windows\\ 及其子目录（任意盘符）', severity: 'hardened' },
  { pattern: /^[a-zA-Z]:\\Program Files(\/|\\|$)/i, description: 'Program Files\\ 及其子目录（任意盘符）', severity: 'hardened' },
  { pattern: /^[a-zA-Z]:\\Program Files \(x86\)(\/|\\|$)/i, description: 'Program Files (x86)\\ 及其子目录（任意盘符）', severity: 'hardened' },
]

/**
 * 黑洞/标准流设备白名单（写它们等于丢弃或重定向输出，完全无害）。
 *
 * 命中此处时写重定向直接判 safe，不进入路径守卫的系统路径判定。
 * 仅对「写重定向目标」生效（>、>>、2>、&> 等）；命令参数中
 * 出现 /dev/null 不影响命令本身的风险等级。
 */
export const DEV_NULL_EXEMPTIONS: readonly string[] = [
  '/dev/null',
  '/dev/stdout',
  '/dev/stderr',
]

/**
 * 保护文件名（在工作区根目录下）
 *
 * 这些是用户的人格/配置文件，Agent 误删会很麻烦，
 * 写/删操作走 moderate 需确认。
 */
export const PROTECTED_WORKSPACE_FILES = new Set([
  'IDENTITY.md',
  'SOUL.md',
  'USER.md',
  'HEARTBEAT.md',
  'CONTACTS.md',
])

/**
 * 工作区「自由区」目录名（读写删免确认）。
 *
 * 真相源；workspace-guard 用 first-segment 判定；file.ts 的 isAutoApproveWorkspacePath
 * 对同名目录免确认（含 scratch / charts / migrations）。
 */
export const WORKSPACE_FREE_DIRS = ['scratch', 'charts', 'migrations'] as const

/**
 * 保护目录（在工作区内）
 */
export const PROTECTED_WORKSPACE_DIRS = new Set([
  'templates',
])
