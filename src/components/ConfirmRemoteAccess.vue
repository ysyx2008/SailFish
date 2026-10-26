<script setup lang="ts">
/**
 * 确认卡里的「远程访问」一栏：批准后能原样跑哪些命令、哪些主机（按分组归好）。
 * 命令放前面：它们条数少、是真正被批准的东西；主机多时清单很长，放后面滚动查看。
 * 伙计的命令清单不一样时分块：每块写几个伙计、连哪几台、跑哪几条。
 */
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import type { RemoteAccessHost, RemoteAccessRequest } from '@shared/types'

const props = defineProps<{ request: RemoteAccessRequest }>()
const { t } = useI18n()

const ungrouped = '\0'

function groupHosts(hosts: readonly RemoteAccessHost[]) {
  const byGroup = new Map<string, RemoteAccessHost[]>()
  for (const host of hosts) {
    const key = host.group ?? ungrouped
    byGroup.set(key, [...(byGroup.get(key) ?? []), host])
  }
  return [...byGroup.entries()].map(([key, items]) => ({
    title: key === ungrouped ? t('ai.remoteAccess.ungrouped') : key,
    hosts: items,
  }))
}

const blocks = computed(() => {
  const { assignments, hosts, commands } = props.request
  if (assignments && !props.request.forWorker) {
    return assignments.map((block, i) => ({
      title: t('ai.remoteAccess.block', { index: i + 1, workers: block.workerCount, hosts: block.hosts.length, commands: block.commands.length }),
      commands: block.commands,
      groups: groupHosts(block.hosts),
    }))
  }
  return [{ title: '', commands, groups: groupHosts(hosts) }]
})

const summary = computed(() =>
  props.request.forWorker
    ? t('ai.remoteAccess.summaryFollowup', { name: props.request.forWorker, hosts: props.request.hosts.length, commands: props.request.commands.length })
    : t('ai.remoteAccess.summaryDispatch', { workers: props.request.workerCount ?? 0, hosts: props.request.hosts.length, commands: props.request.commands.length }),
)
</script>

<template>
  <div class="remote-access">
    <p class="remote-access-summary">{{ summary }}</p>
    <div v-for="(block, blockIndex) in blocks" :key="blockIndex" class="remote-access-block">
      <div v-if="block.title" class="remote-access-block-title">{{ block.title }}</div>
      <div class="remote-access-title">{{ t('ai.remoteAccess.commandsTitle') }}</div>
      <ol class="remote-access-commands">
        <li v-for="(command, index) in block.commands" :key="index"><code>{{ command }}</code></li>
      </ol>
      <div class="remote-access-title">{{ t('ai.remoteAccess.hostsTitle') }}</div>
      <div v-for="group in block.groups" :key="group.title" class="remote-access-group">
        <div class="remote-access-group-name">{{ group.title }}</div>
        <ul class="remote-access-list">
          <li v-for="host in group.hosts" :key="host.id">
            <span class="remote-access-host-name">{{ host.name }}</span>
            <span class="remote-access-host-address">{{ host.address }}</span>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.remote-access {
  padding: 10px;
  background: rgba(0, 0, 0, 0.3);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 6px;
  font-size: 12px;
  color: #fff;
  max-height: 320px;
  overflow-y: auto;
}

.remote-access-block + .remote-access-block {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.remote-access-block-title {
  font-weight: 600;
  color: rgba(255, 255, 255, 0.9);
}

.remote-access-summary {
  margin: 0 0 8px;
  color: rgba(255, 255, 255, 0.85);
}

.remote-access-title {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.5px;
  color: rgba(255, 255, 255, 0.6);
}

.remote-access-group-name {
  margin: 4px 0 2px;
  font-weight: 600;
  color: rgba(255, 255, 255, 0.85);
}

.remote-access-list,
.remote-access-commands {
  margin: 0;
  padding-left: 18px;
  line-height: 1.6;
}

.remote-access-list {
  list-style: none;
  padding-left: 8px;
}

.remote-access-host-name {
  margin-right: 8px;
}

.remote-access-host-address,
.remote-access-commands code {
  font-family: var(--font-mono);
  color: rgba(255, 255, 255, 0.75);
  word-break: break-all;
}

[data-color-scheme="light"] .remote-access {
  background: var(--bg-tertiary);
  border-color: var(--border-color);
  color: var(--text-primary);
}

[data-color-scheme="light"] .remote-access-block + .remote-access-block {
  border-top-color: var(--border-color);
}

[data-color-scheme="light"] .remote-access-block-title,
[data-color-scheme="light"] .remote-access-summary,
[data-color-scheme="light"] .remote-access-group-name {
  color: var(--text-primary);
}

[data-color-scheme="light"] .remote-access-title,
[data-color-scheme="light"] .remote-access-host-address,
[data-color-scheme="light"] .remote-access-commands code {
  color: var(--text-secondary);
}
</style>
