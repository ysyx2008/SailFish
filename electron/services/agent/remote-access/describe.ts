/**
 * 批准卡里「远程访问」那部分的纯文本写法：命令行和 IM 没有桌面那张卡，用它把同样的内容摆给人看。
 * 顺序和桌面一致：摘要，命令清单，最后按分组归好的主机。
 * 伙计的清单不一样时，按块写，每块各自一份摘要、命令和主机。
 */
import type { RemoteAccessHost, RemoteAccessRequest } from '@shared/types'
import { t } from '../i18n'

function hostLines(hosts: readonly RemoteAccessHost[]): string[] {
  const byGroup = new Map<string, RemoteAccessHost[]>()
  for (const host of hosts) {
    const key = host.group ?? t('remote.card_ungrouped')
    byGroup.set(key, [...(byGroup.get(key) ?? []), host])
  }
  const lines: string[] = []
  for (const [group, groupHosts] of byGroup) {
    lines.push(`  ${group}`)
    for (const host of groupHosts) lines.push(`    ${host.name} ${host.address}`)
  }
  return lines
}

export function describeRemoteAccess(request: RemoteAccessRequest): string[] {
  const counts = { hosts: request.hosts.length, commands: request.commands.length }
  if (request.assignments && !request.forWorker) {
    return [
      t('remote.card_summary_dispatch', { workers: request.workerCount ?? 0, ...counts }),
      ...request.assignments.flatMap((block, i) => [
        t('remote.card_assignment', { index: i + 1, workers: block.workerCount, hosts: block.hosts.length, commands: block.commands.length }),
        t('remote.card_commands'),
        ...block.commands.map((command, j) => `  ${j + 1}. ${command}`),
        t('remote.card_hosts'),
        ...hostLines(block.hosts),
      ]),
    ]
  }
  return [
    request.forWorker
      ? t('remote.card_summary_followup', { name: request.forWorker, ...counts })
      : t('remote.card_summary_dispatch', { workers: request.workerCount ?? 0, ...counts }),
    t('remote.card_commands'),
    ...request.commands.map((command, i) => `  ${i + 1}. ${command}`),
    t('remote.card_hosts'),
    ...hostLines(request.hosts),
  ]
}
