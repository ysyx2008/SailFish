/**
 * 交给专家的客观事实：命令审计怎么看每一条命令。
 *
 * 这只描述命令的写法，不是门——解析器不懂运维上下文，可能漏判也可能多判，
 * 最终怎么处理由专家判断。
 */
import { checkReadOnlyCommand, ensureShellAstReady } from '../../command-audit'

export interface CommandFact {
  command: string
  /** 解析下来是只读的；否则是命令审计给的原因 */
  readOnly: true | { notReadOnlyBecause: string }
}

export async function describeCommands(commands: readonly string[]): Promise<CommandFact[]> {
  await ensureShellAstReady()
  const facts: CommandFact[] = []
  for (const command of commands) {
    const reason = await checkReadOnlyCommand(command, { kind: 'remote' })
    facts.push({ command, readOnly: reason === null ? true : { notReadOnlyBecause: reason } })
  }
  return facts
}

export function formatCommandFacts(facts: readonly CommandFact[]): string {
  return facts
    .map((f, i) => `${i + 1}. ${f.command}\n   解析器：${f.readOnly === true ? '解析为只读' : `不算只读——${f.readOnly.notReadOnlyBecause}`}`)
    .join('\n')
}
