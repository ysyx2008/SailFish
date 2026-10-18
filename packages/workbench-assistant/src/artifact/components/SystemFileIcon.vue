<script setup lang="ts">
/**
 * 系统文件图标：有磁盘路径时显示本机图标，否则走默认插槽。
 */
import { ref, watch } from 'vue'
import { loadSystemFileIconUrl } from '../system-file-icon'

const props = withDefaults(defineProps<{
  filePath?: string | null
  cacheKey?: string
  size?: number
}>(), {
  size: 16,
})

const dataUrl = ref<string | null>(null)
let loadGen = 0

async function loadIcon() {
  const gen = ++loadGen
  const url = await loadSystemFileIconUrl({
    filePath: props.filePath,
    cacheKey: props.cacheKey,
  })
  if (gen === loadGen) dataUrl.value = url
}

watch(
  () => [props.filePath, props.cacheKey],
  () => { void loadIcon() },
  { immediate: true },
)
</script>

<template>
  <span class="system-file-icon-host">
    <img
      v-if="dataUrl"
      class="system-file-icon"
      :src="dataUrl"
      :width="size"
      :height="size"
      alt=""
      draggable="false"
      aria-hidden="true"
    >
    <slot v-else />
  </span>
</template>

<style scoped>
.system-file-icon-host {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  line-height: 0;
  width: v-bind('`${size}px`');
  height: v-bind('`${size}px`');
  vertical-align: middle;
}

.system-file-icon {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: contain;
}
</style>
