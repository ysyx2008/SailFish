<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { resolveAssignedByPresentation } from '../utils/assigned-by-presentation'
import { resolveAssistantName } from '../utils/assistant-name'

/**
 * 对话顶栏正中的一行字：这场任务是谁派出来的。
 * 只写事实，没有按钮、不能关；没记下出身的任务（老任务、用户自己开的）不出现。
 * 派出方写智能体自己的名字（用户起了名用用户的，没起用默认名），与侧栏同一个口径。
 *
 * 不一直挂着：打开（或切回）这场对话时淡入，停一阵就淡出；用户在对话上滚动，又淡入，停一阵再淡出。
 * 它只是顶栏里的一行字（没有底色、不占高度），要放进父级那条横向排布的顶栏里，在剩下的空位里居中。
 */
const props = withDefaults(defineProps<{
  assignedBy?: string
  /** 这场对话此刻是否在用户眼前；从不在变成在，算刚打开，再淡入一次 */
  active?: boolean
  /** 对话列表的滚动容器；用户在它上面滚，这行字就淡入 */
  scrollSource?: HTMLElement | null
}>(), {
  active: true,
  scrollSource: null,
})

/** 最后一次触发之后，这行字再停留多久才淡出 */
const HOLD_MS = 1600

const { t } = useI18n()
const presentation = computed(() => resolveAssignedByPresentation(props.assignedBy))
const assistantName = computed(() => resolveAssistantName())

const rootEl = ref<HTMLElement | null>(null)
const shown = ref(false)
let hideTimer: ReturnType<typeof setTimeout> | null = null

function clearHideTimer() {
  if (hideTimer) clearTimeout(hideTimer)
  hideTimer = null
}

/** 淡入（已经在了就只是重新计时），停够 HOLD_MS 后淡出 */
function reveal() {
  if (!presentation.value || !props.active) return
  shown.value = true
  clearHideTimer()
  hideTimer = setTimeout(() => {
    hideTimer = null
    shown.value = false
  }, HOLD_MS)
}

function hideNow() {
  clearHideTimer()
  shown.value = false
}

// 对话出现在眼前（打开、切回来），或这场的出身刚读到：淡入一次。移开则立刻淡出。
const inView = computed(() => (presentation.value ? props.active : false))

function syncWithView(visibleNow: boolean) {
  if (!visibleNow) {
    hideNow()
    return
  }
  // 先让浏览器按「看不见」的样子排过一遍版，之后切到「露出」才会有淡入的过渡，而不是直接出现。
  // 必须在元素已经渲染出来之后做，所以首次要等挂载完成（watch 的 immediate 在组件创建时就同步跑了，那时还没有元素）
  void rootEl.value?.offsetHeight
  reveal()
}

// 之后的变化：等本轮渲染完（出身刚读到时元素就是这一轮才出来的）
watch(inView, syncWithView, { flush: 'post' })
onMounted(() => syncWithView(inView.value))

// 用户自己在对话上滚动才算：滚轮、触摸板、触屏、拖滚动条。
// 对话输出时自己往下滚（跟底）不算——只听用户的输入，不听 scroll 本身，
// 拖滚动条是个例外：按住期间的 scroll 才算。
watch(
  () => props.scrollSource,
  (el, _old, onCleanup) => {
    if (!el) return
    let gripping = false
    const onUserInput = () => reveal()
    const onMouseDown = (e: MouseEvent) => {
      // 左键按在容器自己身上、而不是里头的内容上：滚动条
      if (e.button === 0 && e.target === el) {
        gripping = true
        reveal()
      }
    }
    // 松手收不到的情形（拖到窗口外松开、切走窗口）也要复位，否则之后输出时的自动滚动会被当成用户在拖
    const endGrip = () => { gripping = false }
    const onScroll = () => { if (gripping) reveal() }

    el.addEventListener('wheel', onUserInput, { passive: true })
    el.addEventListener('touchmove', onUserInput, { passive: true })
    el.addEventListener('mousedown', onMouseDown, { passive: true })
    el.addEventListener('scroll', onScroll, { passive: true })
    window.addEventListener('mouseup', endGrip)
    window.addEventListener('blur', endGrip)
    onCleanup(() => {
      el.removeEventListener('wheel', onUserInput)
      el.removeEventListener('touchmove', onUserInput)
      el.removeEventListener('mousedown', onMouseDown)
      el.removeEventListener('scroll', onScroll)
      window.removeEventListener('mouseup', endGrip)
      window.removeEventListener('blur', endGrip)
    })
  },
  { immediate: true },
)

onBeforeUnmount(clearHideTimer)
</script>

<template>
  <div
    v-if="presentation"
    ref="rootEl"
    class="assigned-by-hint"
    :class="{ 'is-shown': shown }"
    role="note"
  >
    <component :is="presentation.icon" :size="12" :stroke-width="2" />
    <span>{{ t(presentation.hintLineKey, { name: assistantName }) }}</span>
  </div>
</template>

<style scoped>
.assigned-by-hint {
  /* 放在父级顶栏（一条横向排布的栏）里：顶栏上其它内容（如主机信息）排完后剩下的空位都归它，
     字在这段空位里居中——顶栏上没有别的内容时就正好在整条顶栏的正中；
     有别的内容也不会压到它们。只占剩下的空位，不撑高顶栏 */
  flex: 1 1 0;
  min-width: 0;
  /* 两侧各让出一段（连同顶栏自己的内边距约 100px）给钉在窗口角上的按钮
     （侧栏开关、对话栏开关、Windows 窗口按钮）；顶栏很窄时放不下就省略 */
  margin: 0 88px;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  font-size: 12.5px;
  line-height: 1.3;
  /* 只有字：用顶栏里次要文字的灰色，图标沿用文字的灰，和侧栏里同一个图标一致；没有底色，不带蓝 */
  color: var(--text-secondary);
  white-space: nowrap;
  /* 不拦鼠标；这条顶栏同时是窗口拖动条，这行字所在的一段也要照样拖得动。
     顶栏对直接子元素统一设了「不可拖」，这里必须压过它 */
  pointer-events: none;
  -webkit-app-region: drag !important;

  /* 淡出：只是看不见，节点还在——读屏软件照样读得到这条信息；
     文字不可选，免得拖选时带出一段看不见的字 */
  user-select: none;
  opacity: 0;
  transition: opacity 0.4s ease;
}

.assigned-by-hint.is-shown {
  opacity: 1;
  transition: opacity 0.25s ease;
}

.assigned-by-hint span {
  /* 名字是用户自己起的，可能很长：只留一行，放不下就省略 */
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assigned-by-hint svg {
  flex-shrink: 0;
}
</style>
