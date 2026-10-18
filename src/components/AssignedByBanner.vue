<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveAssignedByPresentation } from '../utils/assigned-by-presentation'

/**
 * 对话顶上的一行字：这场任务是谁派出来的。
 * 只写事实，没有按钮、不能关；没记下出身的任务（老任务、用户自己开的）不出现。
 */
const props = defineProps<{
  assignedBy?: string
}>()

const { t } = useI18n()
const presentation = computed(() => resolveAssignedByPresentation(props.assignedBy))
</script>

<template>
  <div v-if="presentation" class="assigned-by-banner" role="note">
    <component :is="presentation.icon" :size="12" :stroke-width="2" />
    <span>{{ t(presentation.bannerKey) }}</span>
  </div>
</template>

<style scoped>
.assigned-by-banner {
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 6px 12px;
  font-size: 12.5px;
  line-height: 1.3;
  color: var(--text-secondary);
  /* 底色带一点主题强调色，和对话区分开；不用警告色，不喧宾夺主 */
  background: color-mix(in srgb, var(--accent-primary) 8%, var(--bg-primary));
  border-bottom: 1px solid color-mix(in srgb, var(--accent-primary) 18%, var(--border-color));
}

.assigned-by-banner svg {
  flex-shrink: 0;
  color: var(--accent-primary);
}
</style>
