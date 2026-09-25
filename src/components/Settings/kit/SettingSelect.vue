<script setup lang="ts">
/**
 * 下拉选择：选项较多、不适合摊成一排档位时用。
 * 实际菜单由页面内列表画出，避免 Windows 系统下拉超出窗口后变成黑块。
 */
import AppSelect from '../../common/AppSelect.vue'

withDefaults(
  defineProps<{
    modelValue: string
    options: ReadonlyArray<{ value: string; label: string }>
    disabled?: boolean
    /** 撑满可用宽度，用于上下排布的表单字段 */
    block?: boolean
  }>(),
  { disabled: false, block: false }
)

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>

<template>
  <AppSelect
    :model-value="modelValue"
    :options="options"
    :disabled="disabled"
    :block="block"
    size="compact"
    @update:model-value="emit('update:modelValue', $event)"
  />
</template>
