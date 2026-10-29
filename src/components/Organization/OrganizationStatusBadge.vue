<script setup lang="ts">
/**
 * 组织图上的状态标记：一个小圆点/图标加两个字，不用色块。
 * 颜色只用来区分状态，真正说清楚靠文字。
 */
import { computed } from 'vue'
import { AlertTriangle, Check, Clock, Pause, X } from 'lucide-vue-next'
import type { OrgStatusBucket } from '../../utils/organization-view'

const props = withDefaults(defineProps<{
  bucket: OrgStatusBucket
  label: string
  /** 窄一点，用在顶部概览和团头 */
  compact?: boolean
}>(), { compact: false })

const icons = {
  waiting: Clock,
  completed: Check,
  failed: X,
  interrupted: Pause,
  problem: AlertTriangle,
}
const icon = computed(() => (props.bucket === 'empty' || props.bucket === 'running' ? undefined : icons[props.bucket]))
const dot = computed(() => props.bucket === 'running')
</script>

<template>
  <span
    class="org-status-badge"
    :class="[`is-${bucket}`, { 'is-compact': compact }]"
    :title="label"
  >
    <i v-if="dot" class="org-status-dot" aria-hidden="true" />
    <component
      :is="icon"
      v-else-if="icon"
      :size="compact ? 11 : 12"
      :stroke-width="2.5"
      aria-hidden="true"
    />
    <span class="org-status-label">{{ label }}</span>
  </span>
</template>

<style scoped>
.org-status-badge {
  --org-tone: var(--text-secondary);
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  color: var(--org-tone);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.4;
  white-space: nowrap;
}
.org-status-badge.is-compact {
  gap: 3px;
  font-size: 10.5px;
}
.org-status-badge.is-running { --org-tone: var(--accent-primary); }
.org-status-badge.is-waiting { --org-tone: var(--color-warning, #e5c07b); }
.org-status-badge.is-completed { --org-tone: var(--color-success, #98c379); }
.org-status-badge.is-failed,
.org-status-badge.is-problem { --org-tone: var(--color-danger, #e06c75); }
.org-status-badge.is-interrupted { --org-tone: var(--text-secondary); }

.org-status-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--org-tone);
}
</style>
