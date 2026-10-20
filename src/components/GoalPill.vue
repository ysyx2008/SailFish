<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { Check, ChevronDown, Coins, Hourglass, Pause, Play, Target, TriangleAlert, X } from 'lucide-vue-next'
import { showConfirm } from '../composables/useConfirm'
import { goalClearNeedsConfirm } from '../composables/goal/clear'
import { formatExactTokens, formatGoalElapsed, formatGoalTokenUsage } from '../composables/goal/format'
import { ensureGoalLiveListener, hasLiveGoalDecision, liveGoalOrSeed, liveRevealTick, rememberLiveGoalFor } from '../composables/goal/live'
import type { GoalContract, TerminalType } from '@shared/types'

/**
 * 输入框上方的目标卡片：挂着什么目标、现在什么状态、花了多少时间和 token。
 * 一行放得下就一眼看全；目标正文太长时只显示开头，点一下展开全文，再点收回。
 * 停下来需要用户的几种状态，把「继续」做成明确的按钮。
 */
const props = defineProps<{
  agentKey: string
  aliasKeys?: string[]
  sessionId?: string
  terminalType?: TerminalType
  sshHost?: string
  seedGoal?: GoalContract
  resumeGoal?: () => void | Promise<void>
}>()

const { t } = useI18n()
const now = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | undefined

const lookupKeys = computed(() => [props.agentKey, ...(props.aliasKeys ?? [])].filter(Boolean))
const goal = computed(() => liveGoalOrSeed(lookupKeys.value, props.seedGoal))

const load = async () => {
  if (!lookupKeys.value.length) return
  try {
    for (const key of lookupKeys.value) {
      const fetched = await window.electronAPI.goal?.get(key, props.sessionId)
      if (fetched) {
        rememberLiveGoalFor(lookupKeys.value, fetched)
        return
      }
    }
  } catch {
    return
  }
  if (hasLiveGoalDecision(lookupKeys.value)) return
  if (props.seedGoal) rememberLiveGoalFor(lookupKeys.value, props.seedGoal)
}

watch(() => [props.agentKey, props.sessionId, props.seedGoal?.goalId], () => { void load() }, { immediate: true })
watch(() => liveRevealTick(props.agentKey), (tick, prev) => {
  if (!tick || tick === prev) return
  void load()
})

onMounted(() => {
  ensureGoalLiveListener()
  void load()
  tickTimer = setInterval(() => { now.value = Date.now() }, 1000)
})

onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const liveGoal = computed(() => {
  if (!goal.value) return undefined
  if (goal.value.status !== 'active') return goal.value
  const extra = Math.max(0, Math.floor((now.value - goal.value.updatedAt) / 1000))
  return { ...goal.value, timeUsedSeconds: goal.value.timeUsedSeconds + extra }
})

const STATUS_ICONS = {
  active: Target,
  paused: Pause,
  achieved: Check,
  blocked: TriangleAlert,
  usage_limited: Hourglass,
  budget_limited: Coins,
} as const

const statusIcon = computed(() => {
  const status = liveGoal.value?.status
  return status ? STATUS_ICONS[status] : Target
})
const statusLabel = computed(() => (liveGoal.value ? t(`goal.status.${liveGoal.value.status}`) : ''))
const elapsedText = computed(() => (liveGoal.value ? formatGoalElapsed(liveGoal.value.timeUsedSeconds) : ''))
const tokenText = computed(() => (liveGoal.value ? formatGoalTokenUsage(liveGoal.value) : ''))
const tokenTitle = computed(() => (
  liveGoal.value ? t('goal.tokensExact', { count: formatExactTokens(liveGoal.value.tokensUsed) }) : ''
))
const ariaLabel = computed(() => (
  liveGoal.value ? t('goal.statusAria', { status: statusLabel.value, objective: liveGoal.value.objective }) : ''
))

/** 设了预算才有进度条 */
const budgetRatio = computed(() => {
  const current = liveGoal.value
  if (!current || current.tokenBudget === undefined || current.tokenBudget <= 0) return undefined
  return Math.min(1, Math.max(0, current.tokensUsed / current.tokenBudget))
})

/** 目标正文：一行放不下才可以点开；展开着时一直可以点回去 */
const objectiveEl = ref<HTMLElement | null>(null)
const expanded = ref(false)
const overflowing = ref(false)
const expandable = computed(() => overflowing.value || expanded.value)

const measureOverflow = () => {
  const el = objectiveEl.value
  if (!el || expanded.value) return
  overflowing.value = el.scrollWidth > el.clientWidth + 1
}

const toggleObjective = () => {
  if (!expandable.value) return
  expanded.value = !expanded.value
  if (!expanded.value) void nextTick(measureOverflow)
}

// 卡片出现 / 窗口宽度变化时重新量；换了目标或改了正文就收回
watch(objectiveEl, (el, _prev, onCleanup) => {
  if (!el) {
    overflowing.value = false
    expanded.value = false
    return
  }
  const observer = typeof ResizeObserver === 'function' ? new ResizeObserver(measureOverflow) : undefined
  observer?.observe(el)
  onCleanup(() => observer?.disconnect())
  measureOverflow()
})
// 多源写法：只有 id 或正文真的变了才触发。用「返回数组的函数」当源，每次重算（用时每秒在跳）都算变，展开会被秒收回去。
watch([() => goal.value?.goalId, () => goal.value?.objective], () => {
  expanded.value = false
  void nextTick(measureOverflow)
})

const canPause = computed(() => liveGoal.value?.status === 'active')
const canResume = computed(() => {
  const status = liveGoal.value?.status
  if (status === 'paused' || status === 'blocked' || status === 'usage_limited') return true
  // 已达成的可以重新打开；预算已经花完的不行（后端同样拒绝）
  const current = liveGoal.value
  return status === 'achieved'
    && !(current?.tokenBudget !== undefined && current.tokensUsed >= current.tokenBudget)
})

const action = () => ({
  agentKey: props.agentKey,
  sessionId: props.sessionId,
  terminalType: props.terminalType,
  sshHost: props.sshHost,
})

const pause = async () => {
  const result = await window.electronAPI.goal?.pause(action())
  if (result?.ok) rememberLiveGoalFor(lookupKeys.value, result.goal)
}

const resume = async () => {
  if (props.resumeGoal) {
    await props.resumeGoal()
    void load()
    return
  }
  const result = await window.electronAPI.goal?.resume(action())
  if (result?.ok) rememberLiveGoalFor(lookupKeys.value, result.goal)
}

const clear = async () => {
  if (goalClearNeedsConfirm(liveGoal.value)) {
    const ok = await showConfirm({
      title: t('goal.clear'),
      message: t('goal.clearConfirm'),
      type: 'danger',
      confirmText: t('goal.clear'),
      cancelText: t('common.cancel'),
    })
    if (!ok) return
  }
  const result = await window.electronAPI.goal?.clear(action())
  if (result?.ok) rememberLiveGoalFor(lookupKeys.value, null)
}
</script>

<template>
  <Transition name="goal-dock" appear>
    <div v-if="liveGoal" class="goal-dock">
      <div class="goal-dock-clip">
        <div
          class="goal-card"
          :class="{ 'is-expanded': expanded }"
          data-testid="goal-pill"
          :data-status="liveGoal.status"
          role="group"
          :aria-label="ariaLabel"
        >
          <span class="goal-badge" aria-hidden="true">
            <component :is="statusIcon" :size="11" :stroke-width="2.6" />
          </span>

          <button
            type="button"
            class="goal-objective"
            data-testid="goal-pill-objective"
            :disabled="!expandable"
            :aria-expanded="expandable ? expanded : undefined"
            :title="expandable && !expanded ? liveGoal.objective : undefined"
            @click="toggleObjective"
          >
            <span ref="objectiveEl" class="goal-objective-text">{{ liveGoal.objective }}</span>
            <ChevronDown v-if="expandable" class="goal-chevron" :size="12" :stroke-width="2.4" aria-hidden="true" />
          </button>

          <span class="goal-meta">
            <span class="goal-status">{{ statusLabel }}</span>
            <i class="goal-sep" aria-hidden="true" />
            <span class="goal-figure" data-testid="goal-pill-time">{{ elapsedText }}</span>
            <template v-if="tokenText">
              <i class="goal-sep goal-optional" aria-hidden="true" />
              <span class="goal-figure goal-optional" data-testid="goal-pill-tokens" :title="tokenTitle">
                {{ tokenText }}<span class="goal-unit">{{ t('goal.tokensUnit') }}</span>
              </span>
            </template>
          </span>

          <div class="goal-actions">
            <button
              v-if="canResume"
              type="button"
              class="goal-btn goal-btn-primary"
              data-testid="goal-pill-resume"
              @click="resume"
            >
              <Play :size="10" :stroke-width="2.4" fill="currentColor" />
              <span>{{ t('goal.resume') }}</span>
            </button>
            <button
              v-if="canPause"
              type="button"
              class="goal-btn"
              data-testid="goal-pill-pause"
              :title="t('goal.pause')"
              :aria-label="t('goal.pause')"
              @click="pause"
            >
              <Pause :size="13" :stroke-width="2.2" />
            </button>
            <button
              type="button"
              class="goal-btn"
              data-testid="goal-pill-clear"
              :title="t('goal.clear')"
              :aria-label="t('goal.clear')"
              @click="clear"
            >
              <X :size="13" :stroke-width="2.2" />
            </button>
          </div>

          <span v-if="budgetRatio !== undefined" class="goal-meter" aria-hidden="true">
            <i :style="{ width: `${Math.round(budgetRatio * 100)}%` }" />
          </span>
        </div>
      </div>
    </div>
  </Transition>
</template>

<style scoped>
/* 出现 / 消失：高度平滑展开，输入框不突然跳动。
   外层用负外边距抵掉父级的 8px 间距，卡片自己带 8px 下边距——收起到 0 时，整体占位正好是 0。 */
.goal-dock {
  display: grid;
  grid-template-rows: 1fr;
  flex-shrink: 0;
  margin-bottom: -8px;
  /* 窄的时候按这一条自己的宽度收信息，不看整个窗口 */
  container-type: inline-size;
}
.goal-dock-clip {
  min-height: 0;
  overflow: hidden;
}
.goal-dock-enter-active,
.goal-dock-leave-active {
  transition: grid-template-rows 0.28s cubic-bezier(0.2, 0.8, 0.2, 1), opacity 0.22s ease;
}
.goal-dock-enter-active .goal-card,
.goal-dock-leave-active .goal-card {
  transition: transform 0.28s cubic-bezier(0.2, 0.8, 0.2, 1);
}
.goal-dock-enter-from,
.goal-dock-leave-to {
  grid-template-rows: 0fr;
  opacity: 0;
}
.goal-dock-enter-from .goal-card,
.goal-dock-leave-to .goal-card {
  transform: translateY(8px) scale(0.985);
}

/* 状态色：推进中跟随主色，达成是绿，停下来要你看的统一用琥珀，暂停是中性灰 */
.goal-card {
  --goal-tint: var(--accent-primary);
  position: relative;
  box-sizing: border-box;
  display: flex;
  /* 一行高 24px；展开成多行后，徽章、状态、按钮都贴着第一行 */
  align-items: flex-start;
  gap: 9px;
  /* 收起时固定一行高，展开改成 auto：靠 interpolate-size 让高度平滑长开 */
  height: 36px;
  interpolate-size: allow-keywords;
  margin-bottom: 8px;
  padding: 5px 5px 5px 9px;
  color: var(--text-primary);
  border: 1px solid color-mix(in srgb, var(--goal-tint) 24%, var(--border-color));
  border-radius: 11px;
  background:
    linear-gradient(120deg, color-mix(in srgb, var(--goal-tint) 9%, transparent) 0%, transparent 55%),
    var(--bg-secondary);
  overflow: hidden;
  transition: border-color 0.3s ease, background-color 0.3s ease, height 0.26s cubic-bezier(0.2, 0.8, 0.2, 1);
}
/* 展开：状态、用时、按钮留在第一行，正文挪到下面独占整行（缩进到徽章右边），窗口再窄也不被一小段信息挤成窄条 */
.goal-card.is-expanded {
  height: auto;
  flex-wrap: wrap;
  row-gap: 1px;
}
.goal-card.is-expanded .goal-meta { order: 1; flex: 1 1 0; min-width: 0; }
.goal-card.is-expanded .goal-actions { order: 2; }
.goal-card.is-expanded .goal-objective {
  order: 3;
  flex: 0 0 calc(100% - 29px);
  margin-left: 29px;
}
.goal-card[data-status='paused'] { --goal-tint: var(--text-secondary); }
.goal-card[data-status='achieved'] { --goal-tint: var(--color-success); }
.goal-card[data-status='blocked'],
.goal-card[data-status='usage_limited'],
.goal-card[data-status='budget_limited'] { --goal-tint: var(--color-warning); }

.goal-badge {
  position: relative;
  flex: none;
  display: grid;
  place-items: center;
  margin-top: 2px;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  color: var(--goal-tint);
  background: color-mix(in srgb, var(--goal-tint) 16%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--goal-tint) 32%, transparent);
  transition: color 0.3s ease, background-color 0.3s ease;
}
/* 推进中：徽章外圈有一段亮弧在慢慢转，别的状态都是静止的 */
.goal-card[data-status='active'] .goal-badge::before {
  content: '';
  position: absolute;
  inset: 0;
  border-radius: 50%;
  background: conic-gradient(from 0deg, transparent 0 40%, var(--goal-tint) 100%);
  -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
  mask: radial-gradient(farthest-side, transparent calc(100% - 1.5px), #000 calc(100% - 1px));
  animation: goal-orbit 1.8s linear infinite;
}

/* 目标正文：一行，放不下就省略；放不下的可以点开看全文，也可以停在上面看提示 */
.goal-objective {
  flex: 1 1 0;
  min-width: 0;
  display: flex;
  align-items: flex-start;
  gap: 4px;
  margin: 0;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: default;
}
.goal-objective:not(:disabled) { cursor: pointer; }
.goal-objective:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-primary) 60%, transparent);
  outline-offset: 2px;
}
.goal-objective-text {
  min-width: 0;
  padding: 3px 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 600;
  line-height: 18px;
}
.goal-chevron {
  flex: none;
  margin-top: 6px;
  color: var(--text-muted);
  transition: transform 0.26s cubic-bezier(0.2, 0.8, 0.2, 1), color 0.15s ease;
}
.goal-objective:not(:disabled):hover .goal-chevron { color: var(--text-primary); }

/* 展开：换行显示全文；再长的在卡片里滚动 */
.goal-card.is-expanded .goal-objective-text {
  flex: 1 1 auto;
  max-height: min(40vh, 220px);
  overflow-y: auto;
  overflow-wrap: anywhere;
  text-overflow: clip;
  white-space: normal;
}
.goal-card.is-expanded .goal-chevron { transform: rotate(180deg); }

/* 状态、用时、token：目标正文右边一小段，不抢正文 */
.goal-meta {
  flex: none;
  display: flex;
  align-items: center;
  height: 24px;
  gap: 6px;
  font-size: 12px;
  line-height: 1.3;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.goal-status {
  font-weight: 600;
  color: var(--goal-tint);
  transition: color 0.3s ease;
}
.goal-sep {
  flex: none;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: currentColor;
  opacity: 0.4;
}
.goal-figure {
  overflow: hidden;
  text-overflow: ellipsis;
}
.goal-unit {
  margin-left: 3px;
  font-size: 11px;
  color: var(--text-muted);
}

.goal-actions {
  flex: none;
  display: flex;
  align-items: center;
  gap: 2px;
}
.goal-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  height: 24px;
  min-width: 24px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 12px;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.goal-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
.goal-btn:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent-primary) 60%, transparent);
  outline-offset: 1px;
}
.goal-btn-primary {
  margin-right: 1px;
  padding: 0 9px 0 7px;
  font-weight: 600;
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 16%, transparent);
}
.goal-btn-primary:hover {
  color: var(--accent-primary);
  background: color-mix(in srgb, var(--accent-primary) 26%, transparent);
}

/* 设了 token 预算才有：卡片底边一条细进度 */
.goal-meter {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  height: 2px;
  background: color-mix(in srgb, var(--goal-tint) 14%, transparent);
}
.goal-meter > i {
  display: block;
  height: 100%;
  background: var(--goal-tint);
  transition: width 0.4s ease;
}

/* 窄了先收起「tokens」字样，再收起 token 数；状态和用时一直在 */
@container (max-width: 440px) {
  .goal-unit { display: none; }
}
@container (max-width: 340px) {
  .goal-optional { display: none; }
}

@keyframes goal-orbit {
  to { transform: rotate(360deg); }
}
@media (prefers-reduced-motion: reduce) {
  .goal-card[data-status='active'] .goal-badge::before {
    animation: none;
  }
  .goal-dock-enter-active,
  .goal-dock-leave-active,
  .goal-dock-enter-active .goal-card,
  .goal-dock-leave-active .goal-card,
  .goal-card,
  .goal-chevron {
    transition: none;
  }
}
</style>
