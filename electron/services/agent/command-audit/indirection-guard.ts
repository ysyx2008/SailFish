/**
 * 间接执行守卫（indirection guard）
 *
 * 设计定位：命令拦截是"安全性补充"，主防线是 executionMode（strict/relaxed/free）。
 * - 真正高风险场景 → 用户切 strict（全确认）
 * - 日常使用 → relaxed（危险命令确认）
 * - 信任 AI 自主 → free（自担风险）
 *
 * 本守卫把"确实危险的间接执行模式"鉴别出来标记为 dangerous，让 strict/relaxed 弹确认时
 * 理由清楚。free 模式照常放行——用户既然选了信任，不该由 guard 越俎代庖硬拦。
 *
 * 通道无关：assessAuditedCall 调用，shell 通道 AST 解析后归一化为 AuditedCall。
 *
 * 两层检测（AND 关系）：
 *   1. 角色分类：解释器内联 / 包装器 / 调度器 → dangerous
 *   2. 结构性 flag 规则（cmd 感知）：find -exec / -delete，解释器 + -e/-c 等 → dangerous
 *
 * blocked 级别留给路径守卫（写 /etc、/、/System 等系统路径），那是真正的硬墙。
 *
 * 反例驱动设计：
 *   - node -e "代码" —— 第 1 层 Interpreter-inline 命中 → dangerous
 *   - sudo env bash -c "..." —— wrapper 链命中（shell 通道已 unwrap，wrapper.name 暴露）→ dangerous
 *   - find . -exec rm -rf {} \; —— 第 2 层结构性 flag 命中 → dangerous
 *   - git -c core.x=y status —— 不命中（git -c 是配置项，合法）
 *   - busybox sh -c "..." —— busybox 不在白名单 → moderate + hasUnknown（relaxed 弹确认）
 */
import type { AuditedCall, CallRiskAssessment } from './types'
import { t } from '../i18n'
import { basenameCommand } from './whitelist'

/** 解释器 cmd：整段参数为不可静态审计的脚本体 */
const INTERPRETER_INLINE_CMDS = new Set(['invoke-expression', 'iex'])

/** 解释器 + 内联执行 flag：内联代码不可静态审计 */
const INTERPRETER_INLINE_FLAGS: Record<string, ReadonlySet<string>> = {
  // shell 解释器
  bash: new Set(['-c']),
  sh: new Set(['-c']),
  zsh: new Set(['-c']),
  dash: new Set(['-c']),
  ksh: new Set(['-c']),
  mksh: new Set(['-c']),
  fish: new Set(['-c']),
  // 脚本解释器
  node: new Set(['-e', '--eval']),
  python: new Set(['-c']),
  python3: new Set(['-c']),
  perl: new Set(['-e', '-E']),
  ruby: new Set(['-e']),
  php: new Set(['-r']),
  lua: new Set(['-e']),
  osascript: new Set(['-e']),
  // Windows
  powershell: new Set(['-Command', '-c', '--command']),
  pwsh: new Set(['-Command', '-c', '--command']),
}

/** 包装器 cmd：本身不干活，转手执行别的命令 */
const WRAPPER_CMDS = new Set([
  'sudo', 'env', 'xargs', 'nice', 'nohup', 'time', 'command',
  'builtin', 'exec', 'stdbuf', 'ionice', 'flock', 'chroot',
])

/** 调度器 cmd：调度外部执行，不可静态审计 */
const ORCHESTRATOR_CMDS = new Set([
  'docker', 'kubectl', 'ssh', 'make', 'nix-shell', 'bubblewrap',
  'podman', 'buildah', 'toolbox', 'npx',
])

/**
 * 带条件性执行语义的 flag 规则（cmd 感知，避免误伤合法用途）
 */
const STRUCTURAL_FLAG_RULES: Record<string, (call: AuditedCall) => string | null> = {
  // find 的 -exec / -delete / -ok 在运行时执行任意命令或批量删除
  find: (call) => {
    for (const f of call.flags) {
      if (f === '-exec' || f === '-execdir' || f === '-ok' || f === '-okdir') {
        const name = f === '-exec' ? 'exec' : f === '-execdir' ? 'execdir' : f === '-ok' ? 'ok' : 'okdir'
        return t('risk.reason.find_exec', { name })
      }
      if (f === '-delete') {
        return t('risk.reason.find_delete')
      }
    }
    return null
  },
  // tar --to-command=CMD 在解压时执行任意命令
  tar: (call) => {
    for (const f of call.flags) {
      if (f === '--to-command') return t('risk.reason.tar_to_command')
    }
    return null
  },
  // git rebase --exec=CMD 会执行任意命令（git -c 是配置项，合法）
  git: (call) => {
    for (const f of call.flags) {
      if (f === '--exec') return t('risk.reason.git_rebase_exec')
    }
    return null
  },
}

/** 判断 cmd 是否为已知解释器（用于角色分类层） */
function isInterpreterInline(call: AuditedCall): string | null {
  const flagSet = INTERPRETER_INLINE_FLAGS[call.cmd]
  if (!flagSet || flagSet.size === 0) return null
  for (const f of call.flags) {
    if (flagSet.has(f)) {
      return t('risk.reason.interpreter_inline', { cmd: call.cmd, flag: f })
    }
  }
  return null
}

/**
 * 判断是否经过包装器/调度器。
 *
 * 两种情况：
 * 1. wrapper 已被 shell-ast unwrap（call.wrapper.name 存在，call.cmd 是内层命令）：
 *    内层已知，跳过 guard（返回 null），让内层命令正常走白名单 + 路径审计。
 *    例如 sudo cat /etc/passwd -> call.cmd=cat, wrapper.name=sudo -> 按 cat 审计。
 *
 * 2. wrapper 未 unwrap（call.cmd 就是 wrapper 本身，内层被当参数）：
 *    内层不可知，无法静态审计，标 moderate。
 *    例如 xargs echo "x" -> call.cmd=xargs, echo 是参数 -> 无法审计内层。
 *
 * env 特例：单独执行（无 args）是打印环境变量的只读操作，safe。
 */
function isWrappedOrOrchestrated(call: AuditedCall, allowOrchestrator: boolean): string | null {
  // wrapper 已 unwrap：内层命令已知，跳过 guard 让内层走正常审计
  if (call.wrapper?.name) {
    return null
  }
  // cmd 本身是 wrapper / orchestrator（未 unwrap，内层不可知）
  // env 特例：单独执行（无 args）时是打印环境变量的只读操作，不标 moderate。
  // env bash -c "..." 会被 shell-ast unwrap，走上方 wrapper.name 分支。
  const isEnvReadOnly = call.cmd === 'env' && call.args.length === 0
  if (isEnvReadOnly) {
    return null
  }
  if (WRAPPER_CMDS.has(call.cmd)) {
    return t('risk.reason.wrapper_cmd', { cmd: call.cmd })
  }
  if (ORCHESTRATOR_CMDS.has(call.cmd) && !allowOrchestrator) {
    return t('risk.reason.orchestrator_cmd', { cmd: call.cmd })
  }
  return null
}

/**
 * 检查是否命中间接执行守卫
 *
 * 命中返回 { level, reason }；不命中返回 null，由调用方继续走原审计流程。
 */
export interface GuardHit {
  level: 'dangerous' | 'moderate'
  reason: string
}
export interface IndirectionGuardOptions {
  /**
   * 这次调用是命令表上的查看用子命令（`docker ps`）：调度器本身不再算「转手执行别的命令」。
   * 只放开调度器这一条，解释器内联、包装器、结构性 flag 照查。
   */
  allowOrchestrator?: boolean
}

export function checkIndirectionGuard(call: AuditedCall, opts: IndirectionGuardOptions = {}): GuardHit | null {
  // basename 化 cmd（/bin/zsh → zsh, C:\...\node.exe → node）
  // assessAuditedCall 里 getArgvCommandRule 才做 basename。
  // guard 在 rule 查找之前跑，所以这里自己 normalize 一次。
  const baseCmd = basenameCommand(call.cmd).toLowerCase()
  const normalizedCall = { ...call, cmd: baseCmd }

  if (INTERPRETER_INLINE_CMDS.has(baseCmd)) {
    return {
      level: 'dangerous',
      reason: t('risk.reason.interpreter_inline', { cmd: baseCmd, flag: '-script' }),
    }
  }

  // 第 1 层：角色分类（解释器内联 / 包装器 / 调度器）
  const inlineReason = isInterpreterInline(normalizedCall)
  if (inlineReason) {
    // shell 解释器（bash/sh/zsh 等）的内联代码会被 shell-ast 递归解析内层，
    // 走不到这里；能走到这里的都是非 shell 解释器（python/node/perl 等），
    // shell-ast 不懂这些语言的代码体，无法静态审计，降为 moderate。
    // strict 模式仍会确认，relaxed 放行。
    return { level: 'moderate', reason: inlineReason }
  }

  const wrapperReason = isWrappedOrOrchestrated(normalizedCall, opts.allowOrchestrator === true)
  if (wrapperReason) {
    // wrapper 未 unwrap（xargs/docker/npx 等），内层命令不可知，
    // 无法静态审计，降为 moderate。strict 确认，relaxed 放行。
    return { level: 'moderate', reason: wrapperReason }
  }

  // 第 2 层：结构性 flag 规则（cmd 感知）
  const flagRule = STRUCTURAL_FLAG_RULES[baseCmd]
  if (flagRule) {
    const flagReason = flagRule(normalizedCall)
    if (flagReason) return { level: 'dangerous', reason: flagReason }
  }

  return null
}

/**
 * 构造命中守卫时的评估结果。
 *
 * dangerous 在 strict/relaxed 模式下弹确认（理由清楚），free 模式放行
 * （用户选 free 即自担风险，guard 不越俎代庖硬拦）。
 * moderate 在 strict 模式下弹确认，relaxed 放行。
 * blocked 级别留给路径守卫（写系统路径等绝对禁止场景）。
 */
export function byGuard(level: 'dangerous' | 'moderate', reason: string): CallRiskAssessment {
  return {
    level,
    commandLevel: level,
    reasons: [reason],
  }
}

/** @deprecated 改用 byGuard(level, reason) */
export const dangerousByGuard = (reason: string): CallRiskAssessment => byGuard('dangerous', reason)
