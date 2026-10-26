/**
 * 只读判定
 *
 * 「安全」不等于「只读」：写到临时目录或私有目录的命令，审计也可能判为安全；
 * `git commit` 在命令表里也是安全级。评审员在本机核查、伙计在远程跑命令，都只接受只读的命令。
 *
 * 四条都要满足：
 * 1. 完整解析，没有不认识的命令；
 * 2. 整体和每个命令本身都是安全级；
 * 3. 没有写文件的重定向（丢弃输出除外，目标看不出值的也不行），没有放到后台运行的写法；
 * 4. 没有任何命令带「会写文件」或「要跑一段程序」的标记；命令表上限定了子命令或位置参数的，也得守住。
 *
 * 处境不同，判法不同：
 * - 本机：用本机的当前目录和本机 shell，只支持 bash/zsh 这类能完整解析重定向的 shell；
 * - 远程：按 POSIX shell 解析，不给自由区和工作区，`~` 不展开成本机主目录，不读用户自定义的命令规则；
 *   另外不接受转手执行别的命令的写法（sudo、env 一类）、看不出值的参数（变量、命令替换），
 *   以及命令前面带变量赋值（`LD_PRELOAD=… ls`、`GIT_EXTERNAL_DIFF=… git diff`）。
 */
import { assessShellRisk, defaultAuditContext, remoteAuditContext } from './assess-shell'
import { extractAuditedCalls, findReadOnlyHazard } from './extract-calls'
import { getArgvCommandRule } from './resolve-argv-rule'
import type { AuditContext, AuditedCall, CommandRiskAssessment } from './types'
import { getBuiltinArgvCommandRule } from './whitelist'

export type ReadOnlySituation =
  | { kind: 'local'; cwd?: string }
  | { kind: 'remote' }

function notSafeReason(assessment: CommandRiskAssessment): string {
  const call = assessment.calls.find(c => c.commandLevel !== 'safe') ?? assessment.calls.find(c => c.level !== 'safe')
  const detail = call ? `${call.cmd ? `${call.cmd}：` : ''}${call.reasons.join('；')}` : assessment.level
  return `命令审计认为它不是只读（${detail}）。`
}

/** 命令表上对这次调用的只读限制。不满足返回原因 */
function violatesRuleLimits(call: AuditedCall, ctx: AuditContext): string | null {
  const rule = ctx.target === 'remote' ? getBuiltinArgvCommandRule(call.cmd) : getArgvCommandRule(call.cmd)
  if (!rule) return `${call.cmd} 不在命令表里。`
  if (rule.writesTo) return `${call.cmd} 会写文件。`
  const forbidden = call.flags.find(f => rule.readOnlyForbiddenFlags?.has(f))
  if (forbidden) return `${call.cmd} ${forbidden} 会让命令去执行别处配置里的程序。`
  if (rule.inlineProgram) return `${call.cmd} 要跑一段程序，程序里能写文件、调别的命令，看不出它做什么。`
  if (rule.readOnlySubcommands) {
    const [sub] = call.paths
    if (sub === undefined || !rule.readOnlySubcommands.has(sub)) {
      return `${call.cmd}${sub ? ` ${sub}` : ''} 不是查看类的子命令。`
    }
  }
  const limit = rule.readOnlyOperands
  if (limit) {
    if (limit.max !== undefined && call.paths.length > limit.max) return `${call.cmd} 带的参数会改动东西。`
    if (limit.pattern && call.paths.some(p => !limit.pattern!.test(p))) return `${call.cmd} 带的参数会改动东西。`
  }
  return null
}

/** 只读就返回 null，否则返回拒绝理由 */
export async function checkReadOnlyCommand(
  command: string,
  situation: ReadOnlySituation = { kind: 'local' },
): Promise<string | null> {
  const remote = situation.kind === 'remote'
  const ctx = remote ? remoteAuditContext() : defaultAuditContext(situation.cwd)
  if (!remote && ctx.shell !== 'bash') return '本机核查只支持 bash/zsh 这类 shell。'

  const assessment = await assessShellRisk(command, ctx)
  if (!assessment.parsed || assessment.hasUnknown) return '命令没能完整解析，或含不认识的命令。'
  if (assessment.level !== 'safe' || assessment.calls.some(c => c.commandLevel !== 'safe')) {
    return notSafeReason(assessment)
  }

  const hazard = await findReadOnlyHazard(command, ctx, remote)
  if (hazard) return hazard

  const { calls } = await extractAuditedCalls(command, ctx)

  for (const call of calls) {
    if (remote) {
      if (call.wrapper) return `${call.wrapper.name} 这类转手执行别的命令的写法，远程不接受。`
      if (call.dynamicPaths) return '命令里有看不出值的参数（变量、命令替换），远程不接受。'
    }
    const violation = violatesRuleLimits(call, ctx)
    if (violation) return violation
  }
  return null
}
