<script setup lang="ts">
import { useI18n } from 'vue-i18n'
import type { ApiFailureDetail } from '@shared/types'
defineProps<{ detail: ApiFailureDetail }>()
const { t } = useI18n()
</script>
<template>
  <details class="api-error-details">
    <summary>{{ t('ai.apiErrorDetails') }}</summary>
    <div>{{ detail.model }}<template v-if="detail.statusCode"> · HTTP {{ detail.statusCode }}</template><template v-if="detail.code"> · {{ detail.code }}</template></div>
    <pre>{{ detail.message }}</pre>
  </details>
</template>
<style scoped>
.api-error-details { margin-top: 5px; color: var(--text-secondary); font-size: 12px; }
summary { cursor: pointer; }
pre { margin: 6px 0; white-space: pre-wrap; overflow-wrap: anywhere; font: inherit; user-select: text; }
</style>
