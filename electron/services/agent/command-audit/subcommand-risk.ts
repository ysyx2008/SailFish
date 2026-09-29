/**
 * 按子命令和参数升级风险
 *
 * 命令表一个命令一条规则，只看命令名和 flag；有的命令（git）危险与否取决于子命令，
 * 在这里按命令名挂检查。只升不降：没命中就按命令表原来的等级。
 */
import type { RiskLevel } from '@shared/types/agent'
import { t, type TranslationKey } from '../i18n'
import type { AuditedCall } from './types'
import { basenameCommand, normalizeFlags } from './whitelist'

export interface SubcommandRisk {
  level: RiskLevel
  reason: string
}

interface Invocation {
  /** 子命令之后的位置参数（动态的不在里面） */
  operands: string[]
  flags: Set<string>
  endOfOptions: boolean
  /** 有 $VAR / $(...) 这类看不出值的参数 */
  dynamic: boolean
}

type GitLoss = 'uncommitted' | 'saved' | 'remote' | 'history'

const GIT_LOSS_REASON: Record<GitLoss, TranslationKey> = {
  uncommitted: 'risk.reason.git_loses_uncommitted',
  saved: 'risk.reason.git_loses_saved',
  remote: 'risk.reason.git_rewrites_remote',
  history: 'risk.reason.git_expires_reflog',
}

/**
 * 带值的 git 全局选项。bash 这边解析库会把值吃掉；PowerShell 这边值留在位置参数里，排在子命令前面。
 * 解析库把每个 `-C` / `-c` 都当全局选项（`switch -C` 的值也会被吃掉），所以下面的检查不靠这两个。
 */
const GIT_GLOBAL_VALUE_FLAGS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--config-env'])

function hasAny(inv: Invocation, ...flags: string[]): boolean {
  return flags.some(f => inv.flags.has(f))
}

const GIT_CHECKS = new Map<string, (inv: Invocation) => GitLoss | undefined>([
  ['reset', inv => (hasAny(inv, '--hard') ? 'uncommitted' : undefined)],
  ['checkout', inv => {
    if (hasAny(inv, '-f', '--force')) return 'uncommitted'
    // -B 把已有分支强制挪到新位置，原来的提交只剩操作记录里能找
    if (hasAny(inv, '-B')) return 'saved'
    if (hasAny(inv, '-b', '--orphan')) return undefined
    // 只有一个名字时分不清是分支还是文件，不猜；`.`、`<提交> <文件>`、`-- <文件>` 一定是退回文件
    const restoresPaths =
      inv.operands.includes('.') ||
      inv.operands.length >= 2 ||
      (inv.endOfOptions && (inv.operands.length > 0 || inv.dynamic))
    return restoresPaths ? 'uncommitted' : undefined
  }],
  ['restore', inv =>
    hasAny(inv, '-W', '--worktree') || !hasAny(inv, '-S', '--staged') ? 'uncommitted' : undefined],
  ['switch', inv => (hasAny(inv, '-f', '--force', '--discard-changes') ? 'uncommitted' : undefined)],
  ['clean', inv => (hasAny(inv, '-f', '--force') && !hasAny(inv, '-n', '--dry-run') ? 'uncommitted' : undefined)],
  ['stash', inv => (inv.operands[0] === 'drop' || inv.operands[0] === 'clear' ? 'saved' : undefined)],
  // -D 强删；-f 强制挪动或覆盖已有分支
  ['branch', inv => (hasAny(inv, '-D', '-f', '--force') ? 'saved' : undefined)],
  ['push', inv => {
    if (hasAny(inv, '-n', '--dry-run')) return undefined
    if (hasAny(inv, '-f', '--force', '--force-with-lease', '-d', '--delete', '--mirror', '--prune')) return 'remote'
    // refspec 以 + 开头是强推这一条，以 : 开头是删远端这一条
    return inv.operands.some(ref => ref.startsWith('+') || ref.startsWith(':')) ? 'remote' : undefined
  }],
  ['reflog', inv => (inv.operands[0] === 'expire' || inv.operands[0] === 'delete' ? 'history' : undefined)],
])

function gitPositionals(call: AuditedCall): string[] {
  if (call.source !== 'powershell') return call.paths
  const globalValues = call.flags.filter(f => GIT_GLOBAL_VALUE_FLAGS.has(f)).length
  return call.paths.slice(globalValues)
}

function assessGit(call: AuditedCall): SubcommandRisk | undefined {
  const [subcommand, ...operands] = gitPositionals(call)
  const check = subcommand === undefined ? undefined : GIT_CHECKS.get(subcommand)
  if (!check) return undefined
  const loss = check({
    operands,
    flags: new Set(normalizeFlags(call.flags)),
    endOfOptions: call.endOfOptions === true,
    dynamic: call.dynamicPaths === true,
  })
  if (!loss) return undefined
  return { level: 'dangerous', reason: t(GIT_LOSS_REASON[loss], { cmd: `git ${subcommand}` }) }
}

const SUBCOMMAND_CHECKS = new Map<string, (call: AuditedCall) => SubcommandRisk | undefined>([
  ['git', assessGit],
])

export function assessSubcommandRisk(call: AuditedCall): SubcommandRisk | undefined {
  return SUBCOMMAND_CHECKS.get(basenameCommand(call.cmd).toLowerCase())?.(call)
}
