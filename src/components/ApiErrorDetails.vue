<script setup lang="ts">
import { ChevronRight } from 'lucide-vue-next'
import { useI18n } from 'vue-i18n'
import type { ApiFailureDetail } from '@shared/types'
defineProps<{ detail: ApiFailureDetail }>()
const { t } = useI18n()
</script>

<template>
  <details class="api-error-details">
    <summary>
      <ChevronRight :size="14" class="api-error-chevron" aria-hidden="true" />
      <span>{{ t('ai.apiErrorDetails') }}</span>
    </summary>
    <div class="api-error-body">
      <div class="api-error-meta">
        <span>{{ detail.model }}</span>
        <template v-if="detail.statusCode"><span aria-hidden="true">·</span><span>HTTP {{ detail.statusCode }}</span></template>
        <template v-if="detail.code"><span aria-hidden="true">·</span><span>{{ detail.code }}</span></template>
      </div>
      <pre>{{ detail.message }}</pre>
    </div>
  </details>
</template>

<style scoped>
.api-error-details {
  min-width: 0;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.5;
  white-space: normal;
}
summary {
  display: flex;
  align-items: center;
  gap: 4px;
  width: fit-content;
  max-width: 100%;
  list-style: none;
  cursor: pointer;
  border-radius: 3px;
}
summary::-webkit-details-marker { display: none; }
summary:hover { color: var(--text-primary); }
summary:focus-visible { outline: 2px solid var(--accent-primary); outline-offset: 2px; }
.api-error-chevron { flex-shrink: 0; }
details[open] .api-error-chevron { transform: rotate(90deg); }
.api-error-body {
  display: grid;
  gap: 6px;
  margin-top: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
}
.api-error-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0 6px;
  min-width: 0;
  overflow-wrap: anywhere;
}
.api-error-meta > span { min-width: 0; }
pre {
  margin: 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  font: inherit;
  line-height: 1.6;
  user-select: text;
}
</style>
