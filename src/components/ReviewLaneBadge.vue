<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'

const { t } = useI18n()
const branch = ref<string | null>(null)

onMounted(async () => {
  const lane = await window.electronAPI?.app?.getReviewLane?.()
  branch.value = lane?.branch ?? null
})
</script>

<template>
  <div v-if="branch" class="review-lane-badge" :title="t('app.reviewLaneTip')">
    {{ t('app.reviewLane', { branch }) }}
  </div>
</template>

<style scoped>
.review-lane-badge {
  position: fixed;
  top: 6px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 10001;
  max-width: 50vw;
  padding: 3px 12px;
  border-radius: 999px;
  background: #f59e0b;
  color: #1f1300;
  font-size: 12px;
  font-weight: 600;
  line-height: 18px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  box-shadow: 0 1px 4px rgba(0, 0, 0, 0.35);
  -webkit-app-region: no-drag;
  user-select: none;
}
</style>
