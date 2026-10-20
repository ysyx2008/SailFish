<script setup lang="ts">
/**
 * 密钥输入框（API Key / Secret / Token）。账号密码不用它。
 * 设计目标见 Settings/SPEC「密钥有统一的输入框，密码不在其内」。
 *
 * 平时遮住，只露开头 3 位和末尾 4 位；点进去改时换成可编辑的真实内容；右侧眼睛看全文。
 * 「留空」有含义的框（比如搜索沿用模型密钥）传 reusedValue：框本身仍是空的，
 * 只在占位里显示正在用的那一把。
 *
 * 眼睛的状态记在组件里；换了所编辑的对象（切服务商、换一条配置）时，调用方用 :key 让它重新开始。
 */
import { computed, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { Eye, EyeOff } from 'lucide-vue-next'
import { describeSecretField } from './secret-field'

defineOptions({ inheritAttrs: false })

const props = defineProps<{
  /** 没填过的配置里可能是 undefined，按空处理 */
  modelValue?: string
  /** 框留空时实际在用的那一把；不会写进 modelValue */
  reusedValue?: string
  placeholder?: string
}>()

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const { t } = useI18n()

const focused = ref(false)
const revealed = ref(false)

const view = computed(() =>
  describeSecretField({
    value: props.modelValue ?? '',
    reusedValue: props.reusedValue,
    focused: focused.value,
    revealed: revealed.value,
    placeholder: props.placeholder,
  }),
)

const toggleLabel = computed(() => (revealed.value ? t('common.secretInput.hide') : t('common.secretInput.show')))

function onInput(event: Event) {
  emit('update:modelValue', (event.target as HTMLInputElement).value)
}
</script>

<template>
  <div class="secret-input">
    <input
      v-bind="$attrs"
      :value="view.shown"
      :type="view.inputType"
      :readonly="view.readonly"
      class="input"
      :class="{ 'secret-reused': view.showsReused }"
      spellcheck="false"
      autocomplete="off"
      autocapitalize="off"
      :placeholder="view.placeholder"
      @focus="focused = true"
      @blur="focused = false"
      @input="onInput"
    />
    <button
      type="button"
      class="secret-toggle"
      :title="toggleLabel"
      :aria-label="toggleLabel"
      :aria-pressed="revealed"
      @click="revealed = !revealed"
    >
      <EyeOff v-if="revealed" :size="14" />
      <Eye v-else :size="14" />
    </button>
  </div>
</template>

<style scoped>
.secret-input {
  position: relative;
}

/* 设置面板里的输入框都是这一档尺寸（页面自己的样式管不到这里面，所以在这儿写一遍） */
.secret-input .input {
  width: 100%;
  padding: 8px 32px 8px 12px;
  font-size: 13px;
  background: var(--bg-secondary);
  border-radius: 6px;
}

/* 沿用着别处的密钥时，占位里的头尾用和已填内容一样的字色，不让它看上去像空着 */
.secret-reused::placeholder {
  color: var(--text-primary);
  opacity: 1;
}

.secret-toggle {
  position: absolute;
  right: 6px;
  top: 50%;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  padding: 2px;
  background: none;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
}

.secret-toggle:hover {
  color: var(--text-primary);
}
</style>
