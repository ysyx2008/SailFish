/**
 * 接在伙计任务后面的处境说明：能连哪些主机、批准过哪些命令。只陈述事实。
 */
import { t } from '../i18n'
import type { RemoteGrant } from './remote-grant'
import { formatCommands, formatHosts } from './worker-remote-access'

export function describeRemoteScope(grant: RemoteGrant): string {
  return t('remote.situation', { hosts: formatHosts(grant), commands: formatCommands(grant) })
}
