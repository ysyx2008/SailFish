<script setup lang="ts">
/**
 * 关切运营总览仪表盘
 *
 * 作为 WatchPanel 左侧「总览」独立页展示。
 * 一屏看清：异常关切 → 运行中 → 即将执行 → 最近流水。
 * 「即将执行」与右侧流水为主从：点左侧关切按 watchId 拉取该关切历史，不跳配置页。
 *
 * 关切列表 / 全局用户关切流水由父组件注入（存储层已与唤醒分桶）；
 * 聚焦某关切时本组件按 watchId 再拉该关切历史。
 */

import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import {
  AlertTriangle, RefreshCw, Clock, History,
  CheckCircle2, ChevronRight, AlertCircle, RotateCcw, Pause, Square, Eye, Plus
} from 'lucide-vue-next'
import type { WatchDefinition, WatchHistoryRecord, WatchTrigger } from '@shared/types'
import { watchSkipReasonText } from './watch-skip-reason'

const props = defineProps<{
  watches: WatchDefinition[]
  history: WatchHistoryRecord[]
  runningWatches: Set<string>
}>()

const emit = defineEmits<{
  'select-watch': [id: string]
  'view-history-detail': [record: WatchHistoryRecord]
  'retry-watch': [id: string]
  'disable-watch': [id: string]
  'cancel-watch': [id: string]
  'focus-anomalies': []
  'view-all-history': []
  'view-more-history': [watchId: string]
  'go-templates': []
}>()

const { t, locale } = useI18n()

const BUILTIN_WATCH_IDS = new Set(['__wakeup__', '__daily_patrol__'])

/** 无 nextRun 的事件型触发器（监听即活，不是「没在跑」） */
const EVENT_TRIGGER_TYPES = new Set([
  'file_change', 'webhook', 'email', 'calendar', 'im_connected',
  'app_lifecycle', 'command_probe', 'http_probe', 'milestone', 'watch_failure', 'manual',
])

/** 即将执行选中：右侧流水按该关切拉取（总览内主从，不跳配置） */
const focusedWatchId = ref<string | null>(null)
const focusedHistory = ref<WatchHistoryRecord[]>([])
const focusedHistoryLoading = ref(false)
let focusedHistorySeq = 0

const RECENT_HISTORY_LIMIT = 20

// 30s tick：相对时间 / 即将执行列表随时间前进
const nowTick = ref(Date.now())
let tickTimer: ReturnType<typeof setInterval> | null = null
onMounted(() => {
  tickTimer = setInterval(() => { nowTick.value = Date.now() }, 30_000)
})
onUnmounted(() => {
  if (tickTimer) clearInterval(tickTimer)
})

const anomalies = computed<WatchDefinition[]>(() =>
  props.watches
    .filter(w => w.enabled && (w.lastRun?.status === 'failed' || w.lastRun?.status === 'timeout'))
    .sort((a, b) => (b.lastRun?.at ?? 0) - (a.lastRun?.at ?? 0))
)

const running = computed<WatchDefinition[]>(() =>
  props.watches.filter(w => props.runningWatches.has(w.id))
)

const upcoming = computed<WatchDefinition[]>(() => {
  const now = nowTick.value
  return props.watches
    .filter(w => w.enabled && typeof w.nextRun === 'number' && (w.nextRun as number) > now)
    .sort((a, b) => (a.nextRun ?? 0) - (b.nextRun ?? 0))
})

/** 关切被删或不在即将列表时清掉选中，避免右侧悬空过滤 */
watch(upcoming, (list) => {
  const id = focusedWatchId.value
  if (id && !list.some(w => w.id === id)) focusedWatchId.value = null
})

watch(focusedWatchId, async (id) => {
  const seq = ++focusedHistorySeq
  if (!id) {
    focusedHistory.value = []
    focusedHistoryLoading.value = false
    return
  }
  focusedHistory.value = []
  focusedHistoryLoading.value = true
  try {
    const list = await window.electronAPI.watch.getHistory(id, RECENT_HISTORY_LIMIT)
    if (seq !== focusedHistorySeq) return
    focusedHistory.value = Array.isArray(list) ? list : []
  } catch (e) {
    console.error('Failed to load focused watch history:', e)
    if (seq !== focusedHistorySeq) return
    focusedHistory.value = []
  } finally {
    if (seq === focusedHistorySeq) focusedHistoryLoading.value = false
  }
})

const focusedWatch = computed(() =>
  focusedWatchId.value
    ? props.watches.find(w => w.id === focusedWatchId.value) ?? null
    : null
)

const recentHistory = computed<WatchHistoryRecord[]>(() => {
  if (focusedWatchId.value) {
    return focusedHistory.value
  }
  // 父组件 history 已是用户关切账（不含唤醒）；再滤掉遗留内置巡检
  return [...props.history]
    .filter(r => !BUILTIN_WATCH_IDS.has(r.watchId))
    .sort((a, b) => b.at - a.at)
    .slice(0, RECENT_HISTORY_LIMIT)
})

const recentSectionTitle = computed(() => {
  const w = focusedWatch.value
  if (!w) return t('watch.sectionRecent')
  return t('watch.overviewRecentForWatch', { name: w.name })
})

const isHealthy = computed(() => anomalies.value.length === 0 && running.value.length === 0)

const hasAnyWatch = computed(() => props.watches.length > 0)

function hasEventOnlyTriggers(triggers: WatchTrigger[]): boolean {
  if (!triggers.length) return false
  return triggers.every(tr => EVENT_TRIGGER_TYPES.has(tr.type))
}

/** 启用中、无 nextRun、仅事件型触发的关切（仍在监听） */
const listeningEventWatches = computed(() =>
  props.watches.filter(w =>
    w.enabled
    && !props.runningWatches.has(w.id)
    && !(typeof w.nextRun === 'number' && w.nextRun > nowTick.value)
    && hasEventOnlyTriggers(w.triggers)
  )
)

const upcomingEmptyHint = computed(() => {
  if (listeningEventWatches.value.length > 0) {
    return t('watch.overviewListeningOnly', { n: listeningEventWatches.value.length })
  }
  return t('watch.overviewNoUpcoming')
})

function toggleFocusUpcoming(id: string) {
  focusedWatchId.value = focusedWatchId.value === id ? null : id
}

function clearFocus() {
  focusedWatchId.value = null
}

function formatTimeAgo(ts: number): string {
  const now = nowTick.value
  const diff = now - ts
  if (diff < 0) return formatUpcoming(ts)
  const sec = Math.floor(diff / 1000)
  if (sec < 10) return t('watch.timeJustNow')
  if (sec < 60) return t('watch.timeSecAgo', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('watch.timeMinAgo', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('watch.timeHrAgo', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('watch.timeDayAgo', { n: day })
  return formatAbsoluteShort(ts)
}

function formatUpcoming(ts: number): string {
  const now = nowTick.value
  const diff = ts - now
  if (diff <= 0) return t('watch.timeNow')
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return t('watch.timeInSec', { n: sec })
  const min = Math.floor(sec / 60)
  if (min < 60) return t('watch.timeInMin', { n: min })
  const hr = Math.floor(min / 60)
  if (hr < 24) return t('watch.timeInHr', { n: hr })
  const day = Math.floor(hr / 24)
  if (day < 7) return t('watch.timeInDay', { n: day })
  return formatAbsoluteShort(ts)
}

function formatAbsoluteShort(ts: number): string {
  const d = new Date(ts)
  const opts: Intl.DateTimeFormatOptions = { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false }
  return new Intl.DateTimeFormat(locale.value, opts).format(d)
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  const sec = ms / 1000
  if (sec < 60) return `${sec.toFixed(1)}s`
  const min = Math.floor(sec / 60)
  const restSec = Math.floor(sec - min * 60)
  return restSec > 0 ? `${min}m ${restSec}s` : `${min}m`
}

function historyStatusClass(s: string): string {
  switch (s) {
    case 'completed': return 'success'
    case 'failed':
    case 'timeout':   return 'error'
    case 'cancelled':
    case 'skipped':   return 'warning'
    case 'running':   return 'running'
    default:          return 'idle'
  }
}

function historyStatusLabel(s: string): string {
  switch (s) {
    case 'completed': return t('watch.statusCompleted')
    case 'failed':    return t('watch.statusFailed')
    case 'timeout':   return t('watch.statusTimeout')
    case 'cancelled': return t('watch.statusCancelled')
    case 'skipped':   return t('watch.statusSkipped')
    case 'running':   return t('watch.statusRunning')
    default:          return s
  }
}

function anomalySummary(w: WatchDefinition): string {
  const last = w.lastRun
  if (!last) return ''
  if (last.error) return last.error
  if (last.status === 'timeout') return t('watch.statusTimeout')
  return ''
}

function runningDurationText(w: WatchDefinition): string {
  void nowTick.value
  // lastRun.at 在 status=running 时才是这次开始时间；失败/完成时间不得拿来冒充已运行多久
  const last = w.lastRun
  if (!last || last.status !== 'running' || typeof last.at !== 'number') return ''
  const ms = Date.now() - last.at
  if (ms < 0) return ''
  return formatDuration(ms)
}

const HISTORY_SUMMARY_MAX = 60
function historySummary(r: WatchHistoryRecord): string {
  const text = (r.error || (r.skipReason ? watchSkipReasonText(r.skipReason) : '') || r.output || '').trim()
  if (!text) return ''
  return text.length > HISTORY_SUMMARY_MAX ? text.slice(0, HISTORY_SUMMARY_MAX) + '…' : text
}

function selectWatchById(id: string) {
  emit('select-watch', id)
}

/** 打开该关切最近一次失败/超时流水；没有则进详情 */
function viewAnomalyFailure(w: WatchDefinition) {
  const failed = props.history
    .filter(r => r.watchId === w.id && (r.status === 'failed' || r.status === 'timeout'))
    .sort((a, b) => b.at - a.at)[0]
  if (failed) emit('view-history-detail', failed)
  else selectWatchById(w.id)
}
</script>

<template>
  <div class="watch-overview">
    <header class="overview-hero">
      <div class="hero-left">
        <h2 class="overview-title">{{ t('watch.overviewHeader') }}</h2>
        <p class="overview-subtitle">{{ t('watch.overviewSubtitle') }}</p>
      </div>

      <div class="hero-right">
        <div v-if="isHealthy" class="health-pill health-pill-good">
          <CheckCircle2 :size="14" />
          <span>{{ t('watch.overviewHealthAllGood') }}</span>
        </div>
        <template v-else>
          <button
            v-if="anomalies.length > 0"
            class="health-pill health-pill-error"
            :title="t('watch.errorCountBadge', { n: anomalies.length })"
            @click="emit('focus-anomalies')"
          >
            <AlertTriangle :size="14" />
            <span class="health-pill-num">{{ anomalies.length }}</span>
            <span class="health-pill-label">{{ t('watch.overviewMiniAnomaly') }}</span>
          </button>
          <div v-if="running.length > 0" class="health-pill health-pill-running">
            <RefreshCw :size="14" class="spinning" />
            <span class="health-pill-num">{{ running.length }}</span>
            <span class="health-pill-label">{{ t('watch.overviewMiniRunning') }}</span>
          </div>
        </template>
      </div>
    </header>

    <!-- 空态：还没有关切 -->
    <section v-if="!hasAnyWatch" class="overview-section overview-empty-cta">
      <div class="ov-empty ov-empty-cta">
        <AlertCircle :size="16" />
        <span>{{ t('watch.noWatchesYet') }}</span>
        <button class="ov-cta-btn" @click="emit('go-templates')">
          <Plus :size="14" />
          {{ t('watch.overviewGoTemplates') }}
        </button>
      </div>
    </section>

    <template v-else>
      <!-- 异常关切 -->
      <section v-if="anomalies.length > 0" class="overview-section">
        <div class="section-header">
          <AlertTriangle :size="16" class="section-icon icon-error" />
          <span class="section-title">{{ t('watch.sectionAnomalies') }}</span>
          <span class="section-count count-error">{{ anomalies.length }}</span>
        </div>
        <div class="section-body">
          <div
            v-for="w in anomalies"
            :key="w.id"
            class="ov-row ov-row-error"
          >
            <span class="ov-row-dot"></span>
            <button class="ov-row-main ov-row-clickable" @click="selectWatchById(w.id)">
              <div class="ov-row-line1">
                <span class="ov-row-name">{{ w.name }}</span>
                <span class="ov-row-time">{{ w.lastRun ? formatTimeAgo(w.lastRun.at) : '' }}</span>
              </div>
              <div class="ov-row-line2" v-if="anomalySummary(w)">{{ anomalySummary(w) }}</div>
            </button>
            <div class="ov-row-actions">
              <button
                class="ov-action-btn"
                :title="t('watch.viewFailure')"
                @click.stop="viewAnomalyFailure(w)"
              >
                <Eye :size="13" />
              </button>
              <button
                class="ov-action-btn"
                :disabled="runningWatches.has(w.id)"
                :title="t('watch.retryWatch')"
                @click.stop="emit('retry-watch', w.id)"
              >
                <RotateCcw :size="13" :class="{ spinning: runningWatches.has(w.id) }" />
              </button>
              <button
                class="ov-action-btn ov-action-mute"
                :title="t('watch.disableWatch')"
                @click.stop="emit('disable-watch', w.id)"
              >
                <Pause :size="13" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 正在执行 -->
      <section v-if="running.length > 0" class="overview-section">
        <div class="section-header">
          <RefreshCw :size="16" class="section-icon icon-running spinning" />
          <span class="section-title">{{ t('watch.sectionRunning') }}</span>
          <span class="section-count count-running">{{ running.length }}</span>
        </div>
        <div class="section-body">
          <div
            v-for="w in running"
            :key="w.id"
            class="ov-row ov-row-running"
          >
            <span class="ov-row-dot"></span>
            <button class="ov-row-main ov-row-clickable" @click="selectWatchById(w.id)">
              <div class="ov-row-line1">
                <span class="ov-row-name">{{ w.name }}</span>
                <span class="ov-row-time" v-if="runningDurationText(w)">
                  {{ t('watch.runningFor', { d: runningDurationText(w) }) }}
                </span>
              </div>
              <div class="ov-row-line2 muted">{{ t('watch.liveOutputHint') }}</div>
            </button>
            <div class="ov-row-actions">
              <button
                class="ov-action-btn ov-action-danger"
                :title="t('watch.cancelRunning')"
                @click.stop="emit('cancel-watch', w.id)"
              >
                <Square :size="12" />
              </button>
            </div>
          </div>
        </div>
      </section>

      <!-- 即将执行 | 最近流水：宽屏双栏主从；列表不折叠，超出滚动 -->
      <div class="overview-main-grid">
        <section class="overview-section overview-section-fill">
          <div class="section-header">
            <Clock :size="16" class="section-icon" />
            <span class="section-title">{{ t('watch.sectionUpcoming') }}</span>
            <span class="section-count" v-if="upcoming.length > 0">{{ upcoming.length }}</span>
          </div>
          <div class="section-body">
            <button
              v-for="(w, idx) in upcoming"
              :key="w.id"
              class="ov-row"
              :class="{
                'ov-row-next': idx === 0 && focusedWatchId !== w.id,
                'ov-row-focused': focusedWatchId === w.id,
              }"
              :aria-pressed="focusedWatchId === w.id"
              :title="formatAbsoluteShort(w.nextRun as number)"
              @click="toggleFocusUpcoming(w.id)"
            >
              <span
                class="ov-row-dot"
                :class="focusedWatchId === w.id || idx === 0 ? 'dot-next' : 'dot-upcoming'"
              ></span>
              <div class="ov-row-main">
                <div class="ov-row-line1">
                  <span class="ov-row-name">
                    <span v-if="idx === 0" class="next-badge">{{ t('watch.overviewNextRunLabel') }}</span>
                    {{ w.name }}
                  </span>
                  <span class="ov-row-time ov-row-time-accent">{{ formatUpcoming(w.nextRun as number) }}</span>
                </div>
              </div>
            </button>
            <div v-if="upcoming.length === 0" class="ov-empty">
              <Clock :size="14" />
              <span>{{ upcomingEmptyHint }}</span>
            </div>
          </div>
        </section>

        <section class="overview-section overview-section-fill">
          <div class="section-header">
            <History :size="16" class="section-icon" />
            <span class="section-title" :title="recentSectionTitle">{{ recentSectionTitle }}</span>
            <span class="section-count">{{ recentHistory.length }}</span>
            <template v-if="focusedWatchId">
              <button class="section-link" @click="clearFocus">
                {{ t('watch.overviewBack') }}
              </button>
              <button class="section-link" @click="emit('view-more-history', focusedWatchId)">
                {{ t('watch.overviewViewMore') }}
              </button>
            </template>
            <button
              v-else-if="recentHistory.length > 0"
              class="section-link"
              @click="emit('view-all-history')"
            >
              {{ t('watch.overviewViewAllHistory') }}
            </button>
          </div>
          <div class="section-body">
            <button
              v-for="r in recentHistory"
              :key="r.id"
              class="ov-row"
              :class="`ov-row-${historyStatusClass(r.status)}`"
              @click="emit('view-history-detail', r)"
            >
              <span class="ov-row-dot"></span>
              <div class="ov-row-main">
                <div class="ov-row-line1">
                  <span class="ov-row-name">{{ focusedWatchId ? historyStatusLabel(r.status) : r.watchName }}</span>
                  <span class="ov-row-time">{{ formatTimeAgo(r.at) }}</span>
                </div>
                <div
                  class="ov-row-line2 muted"
                  v-if="!focusedWatchId || r.duration > 0 || historySummary(r)"
                >
                  <template v-if="focusedWatchId">
                    <span v-if="r.duration > 0">{{ formatDuration(r.duration) }}</span>
                    <span class="hist-sep" v-if="r.duration > 0 && historySummary(r)">·</span>
                    <span class="hist-summary" v-if="historySummary(r)">{{ historySummary(r) }}</span>
                  </template>
                  <template v-else>
                    <span class="hist-status">{{ historyStatusLabel(r.status) }}</span>
                    <span class="hist-sep" v-if="r.duration > 0">·</span>
                    <span v-if="r.duration > 0">{{ formatDuration(r.duration) }}</span>
                    <span class="hist-sep" v-if="historySummary(r)">·</span>
                    <span class="hist-summary" v-if="historySummary(r)">{{ historySummary(r) }}</span>
                  </template>
                </div>
              </div>
              <ChevronRight :size="14" class="ov-row-arrow" />
            </button>
            <div v-if="focusedHistoryLoading" class="ov-empty">
              <RefreshCw :size="14" class="spinning" />
              <span>{{ t('watch.loading') }}</span>
            </div>
            <div v-else-if="recentHistory.length === 0" class="ov-empty">
              <AlertCircle :size="14" />
              <span>{{ focusedWatchId ? t('watch.overviewNoHistoryForWatch') : t('watch.noHistoryYet') }}</span>
            </div>
          </div>
        </section>
      </div>
    </template>
  </div>
</template>

<style scoped>
.watch-overview {
  height: 100%;
  display: flex;
  flex-direction: column;
  padding: 18px 22px 20px;
  overflow: hidden;
  gap: 14px;
  min-height: 0;
}

.overview-main-grid {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
  align-items: stretch;
}

@media (max-width: 900px) {
  .overview-main-grid {
    grid-template-columns: 1fr;
    overflow: visible;
    flex: none;
  }
  .watch-overview {
    overflow-y: auto;
  }
  .overview-section-fill {
    min-height: auto;
    overflow: visible;
  }
  .overview-section-fill .section-body {
    overflow: visible;
    flex: none;
  }
}

.overview-hero {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  flex-shrink: 0;
}
.hero-left { min-width: 0; }
.overview-title {
  margin: 0 0 4px 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
}
.overview-subtitle {
  margin: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.hero-right {
  display: flex;
  gap: 8px;
  flex-shrink: 0;
  align-items: center;
}

.health-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  color: var(--text-secondary);
  cursor: default;
}
button.health-pill { cursor: pointer; }
button.health-pill:hover { filter: brightness(1.08); }

.health-pill-good {
  color: var(--brand-vital, #2ecc71);
  background: rgba(46, 204, 113, 0.1);
  border-color: rgba(46, 204, 113, 0.28);
}
.health-pill-error {
  color: var(--brand-alert, #e74c3c);
  background: rgba(231, 76, 60, 0.12);
  border-color: rgba(231, 76, 60, 0.32);
}
.health-pill-running {
  color: var(--accent-primary);
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
  border-color: rgba(var(--accent-rgb, 137, 180, 250), 0.32);
}
.health-pill-num { font-weight: 700; font-variant-numeric: tabular-nums; }
.health-pill-label { opacity: 0.85; }

.overview-section {
  display: flex;
  flex-direction: column;
  border: 1px solid var(--border-color);
  border-radius: 10px;
  background: var(--bg-secondary);
  min-width: 0;
}

.overview-section:not(.overview-section-fill) {
  flex-shrink: 0;
}

.overview-section-fill {
  min-height: 0;
  overflow: hidden;
}

.overview-section-fill .section-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
}

.section-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  border-bottom: 1px solid var(--border-color);
  background: var(--bg-tertiary, var(--bg-secondary));
  position: sticky;
  top: 0;
  z-index: 1;
  border-radius: 10px 10px 0 0;
}
.section-icon { color: var(--text-secondary); flex-shrink: 0; }
.section-icon.icon-error { color: var(--brand-alert, #e74c3c); }
.section-icon.icon-running { color: var(--accent-primary); }
.section-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.section-count {
  font-size: 11px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  padding: 2px 8px;
  border-radius: 9px;
  background: var(--bg-hover);
  color: var(--text-secondary);
  min-width: 22px;
  text-align: center;
}
.section-count.count-error {
  background: rgba(231, 76, 60, 0.18);
  color: var(--brand-alert, #e74c3c);
}
.section-count.count-running {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.2);
  color: var(--accent-primary);
}
.section-link {
  border: 0;
  background: transparent;
  font-size: 12px;
  color: var(--accent-primary);
  cursor: pointer;
  padding: 2px 4px;
}
.section-link:hover { text-decoration: underline; }

.section-body {
  display: flex;
  flex-direction: column;
}

.ov-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 14px;
  border: 0;
  background: transparent;
  text-align: left;
  cursor: pointer;
  border-top: 1px solid var(--border-color);
  transition: background 0.12s;
  width: 100%;
  color: inherit;
  box-sizing: border-box;
}
.ov-row:first-of-type { border-top: 0; }
.ov-row:hover { background: var(--bg-hover); }
.ov-row-next {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.06);
}
.ov-row-focused {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.14);
  box-shadow: inset 3px 0 0 var(--accent-primary);
}
.ov-row-focused:hover {
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.18);
}

.ov-row-dot {
  width: 8px; height: 8px; border-radius: 50%;
  margin-top: 6px;
  background: var(--text-muted);
  flex-shrink: 0;
}
.ov-row-success .ov-row-dot { background: var(--brand-vital, #2ecc71); }
.ov-row-error   .ov-row-dot { background: var(--brand-alert, #e74c3c); }
.ov-row-warning .ov-row-dot { background: #f39c12; }
.ov-row-running .ov-row-dot {
  background: var(--accent-primary);
  animation: ov-pulse 1.4s ease-in-out infinite;
}
.dot-upcoming { background: var(--accent-primary); opacity: 0.55; }
.dot-next { background: var(--accent-primary); }

.ov-row-main { flex: 1; min-width: 0; }

.ov-row-line1 {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
  font-size: 13px;
}
.ov-row-name {
  font-weight: 500;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.next-badge {
  flex-shrink: 0;
  font-size: 10px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 4px;
  background: rgba(var(--accent-rgb, 137, 180, 250), 0.18);
  color: var(--accent-primary);
}
.ov-row-time {
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
  font-variant-numeric: tabular-nums;
}
.ov-row-time-accent {
  color: var(--accent-primary);
  font-weight: 600;
}

.ov-row-line2 {
  margin-top: 3px;
  font-size: 12px;
  color: var(--text-secondary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ov-row-line2.muted { color: var(--text-muted); }
.ov-row-error .ov-row-line2 { color: var(--brand-alert, #e74c3c); }

.hist-status { font-weight: 500; }
.hist-sep { margin: 0 6px; }
.hist-summary { color: var(--text-muted); }

.ov-row-arrow {
  margin-top: 4px;
  color: var(--text-muted);
  flex-shrink: 0;
  opacity: 0.6;
}
.ov-row:hover .ov-row-arrow { opacity: 1; }

.ov-row-clickable {
  flex: 1;
  min-width: 0;
  background: transparent;
  border: 0;
  padding: 0;
  text-align: left;
  cursor: pointer;
  color: inherit;
}

.ov-row-actions {
  display: flex;
  gap: 4px;
  flex-shrink: 0;
  margin-top: 2px;
  opacity: 0;
  transition: opacity 0.12s;
}
.ov-row:hover .ov-row-actions { opacity: 1; }

.ov-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  border: 1px solid transparent;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 0.12s, border-color 0.12s, color 0.12s;
}
.ov-action-btn:hover {
  background: var(--bg-hover);
  border-color: var(--border-color);
  color: var(--text-primary);
}
.ov-action-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}
.ov-action-mute:hover {
  color: #f39c12;
  border-color: rgba(243, 156, 18, 0.35);
  background: rgba(243, 156, 18, 0.1);
}
.ov-action-danger:hover {
  color: var(--brand-alert, #e74c3c);
  border-color: rgba(231, 76, 60, 0.32);
  background: rgba(231, 76, 60, 0.12);
}

.ov-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 18px 14px;
  font-size: 12px;
  color: var(--text-muted);
}
.ov-empty-cta {
  flex-direction: column;
  gap: 12px;
  padding: 28px 14px;
}
.ov-cta-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 8px;
  border: 1px solid var(--border-color);
  background: var(--bg-hover);
  color: var(--text-primary);
  font-size: 12px;
  cursor: pointer;
}
.ov-cta-btn:hover {
  border-color: var(--accent-primary);
  color: var(--accent-primary);
}

@keyframes ov-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50%      { opacity: 0.4; transform: scale(0.85); }
}

.spinning { animation: ov-spin 1s linear infinite; }
@keyframes ov-spin { from { transform: rotate(0); } to { transform: rotate(360deg); } }
</style>
