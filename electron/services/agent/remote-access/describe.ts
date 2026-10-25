/**
 * 批准卡里「远程访问」那部分的纯文本写法：命令行和 IM 没有桌面那张卡，用它把同样的内容摆给人看。
 * 顺序和桌面一致：先是运维专家写的话（有的话），再摘要，再命令清单，最后按分组归好的主机。
 */
import type { RemoteAccessRequest } from '@shared/types'
import { t } from '../i18n'

export function describeRemoteAccess(request: RemoteAccessRequest): string[] {
  const counts = { hosts: request.hosts.length, commands: request.commands.length }
  const lines = [
    ...(request.expert ? [t('remote.card_expert'), `  ${request.expert.card.replace(/\n+/g, '\n  ')}`] : []),
    request.forWorker
      ? t('remote.card_summary_followup', { name: request.forWorker, ...counts })
      : t('remote.card_summary_dispatch', { workers: request.workerCount ?? 0, ...counts }),
    t('remote.card_commands'),
    ...request.commands.map((command, i) => `  ${i + 1}. ${command}`),
    t('remote.card_hosts'),
  ]
  const byGroup = new Map<string, RemoteAccessRequest['hosts']>()
  for (const host of request.hosts) {
    const key = host.group ?? t('remote.card_ungrouped')
    byGroup.set(key, [...(byGroup.get(key) ?? []), host])
  }
  for (const [group, hosts] of byGroup) {
    lines.push(`  ${group}`)
    for (const host of hosts) lines.push(`    ${host.name} ${host.address}`)
  }
  return lines
}
