<script setup lang="ts">
/** 原成员卡片内嵌于真实层级，按视口加载，展开后的占位记住实际高度。 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import type { SubAgentResult } from '@shared/types'
import type { OrgNode } from '../../utils/organization-view'
import { isSubAgentExpanded, memberDetailStepId, subAgentExpansionKey, subAgentExpansionHeight, rememberSubAgentHeight } from '../../utils/sub-agent-expansion'
import OrganizationMemberDetail from './OrganizationMemberDetail.vue'
import { useTeamVisibility } from './team-viewport'
const props = defineProps<{ node: OrgNode; stepId: string; sessionId?: string; snapshotFor?: (name: string) => SubAgentResult | undefined }>()
const emit = defineEmits<{ open: [] }>()
const { t } = useI18n()
const { element, visible } = useTeamVisibility()
const content = ref<HTMLElement | null>(null)
const expansionKey = computed(() => subAgentExpansionKey(memberDetailStepId(props.sessionId, props.stepId, props.node.member.name), props.node.member.id))
const height = ref(subAgentExpansionHeight(expansionKey.value))
const expanded = computed(() => isSubAgentExpanded(expansionKey.value))
watch([expanded, expansionKey], ([open]) => { height.value = open ? subAgentExpansionHeight(expansionKey.value) : 56 })
const snapshot = computed<SubAgentResult>(() => props.snapshotFor?.(props.node.member.name) ?? {
  ...props.node.member,
  steps: props.node.member.activity ? [props.node.member.activity] : [],
})
let observer: ResizeObserver | undefined
watch(content, el => {
  observer?.disconnect()
  observer = undefined
  if (!el) return
  const measure = () => {
    if (el !== content.value || !el.isConnected) return
    const measured = Math.max(56, el.getBoundingClientRect().height + 1)
    // 重新挂载时记录仍在读取，暂时的加载行不能缩掉此前的展开占位。收起时再释放。
    height.value = expanded.value ? Math.max(height.value, measured) : measured
    if (expanded.value) rememberSubAgentHeight(expansionKey.value, height.value)
  }
  measure()
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver(measure)
  observer.observe(el)
}, { flush: 'post' })
onBeforeUnmount(() => { observer?.disconnect(); observer = undefined })
</script>

<template>
  <div ref="element" class="tmt-member" :data-member="node.member.name" :aria-label="node.member.name" role="group" :style="visible ? { minHeight: `${height}px` } : { height: `${height}px` }">
    <div v-if="visible" ref="content" class="tmt-content">
      <OrganizationMemberDetail inline :step-id="stepId" :session-id="sessionId" :member="node.member" :snapshot="snapshot" :focus-active="false" />
      <button v-if="expanded" type="button" class="tmt-details" @click="emit('open')">{{ t('ai.organization.memberDetails') }}</button>
    </div>
  </div>
</template>

<style scoped>
.tmt-member { min-height: 56px; box-sizing: border-box; border-bottom: 1px solid var(--border-color); }
.tmt-content { display: flow-root; min-height: 55px; }
.tmt-details { display: block; margin: 0 10px 8px auto; border: 0; background: transparent; color: var(--accent-primary); font: inherit; font-size: 11px; cursor: pointer; }
.tmt-details:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
</style>
