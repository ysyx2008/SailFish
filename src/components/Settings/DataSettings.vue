<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { marked } from 'marked'
import { Bot, HardDrive, CalendarRange, History, Download, Upload, Clock, AlertTriangle, Search, X, ChevronDown, ChevronRight, ExternalLink, Monitor, Server, Coins, ArrowUpRight, ArrowDownLeft, Zap, FolderSymlink, RotateCcw, Terminal } from 'lucide-vue-next'
import { applyCjkFriendlyMarkdown } from '../../utils/cjk-friendly-marked'

applyCjkFriendlyMarkdown()

const { t } = useI18n()
const isSteamBuild = __STEAM_BUILD__

import type { AgentRecord } from '@shared/types'
import { showConfirm } from '../../composables/useConfirm'
import { SettingsPage, SettingsGroup, SettingRow, SettingInput, SettingNotice } from './kit'

// 存储统计
const storageStats = ref<{
  chatFiles: number
  agentFiles: number
  agentSessions: number
  totalSize: number
  oldestRecord?: string
  newestRecord?: string
} | null>(null)

// 数据目录路径
const dataPath = ref('')
// 是否使用自定义数据目录
const isCustomDataDir = ref(false)
// 是否正在提交迁移请求
const isMigratingDataDir = ref(false)

// Shell CLI（sailfish）
const isDarwin = ref(typeof process !== 'undefined' ? false : false)
const shellCliStatus = ref<{
  installed: boolean
  shimPath: string | null
  target: string | null
  binDir: string
  mode: 'packaged' | 'development'
} | null>(null)
const shellCliBusy = ref(false)

const loadShellCliStatus = async () => {
  try {
    // platform via preload-less: navigator
    isDarwin.value = navigator.platform?.toLowerCase().includes('mac') ?? false
    if (!isDarwin.value || !window.electronAPI.shellCli) return
    shellCliStatus.value = await window.electronAPI.shellCli.status()
  } catch (e) {
    console.error('Failed to load shell CLI status:', e)
  }
}

const installShellCli = async () => {
  if (!window.electronAPI.shellCli) return
  shellCliBusy.value = true
  try {
    const res = await window.electronAPI.shellCli.install()
    if (!res.ok) {
      showMessage('error', t('dataSettings.shellCliFailed', { error: res.error || '' }))
      return
    }
    showMessage('success', t('dataSettings.shellCliInstallOk'))
    if (res.pathHint && res.binDir) {
      showMessage('success', t('dataSettings.shellCliPathHint', { binDir: res.binDir }))
    }
    await loadShellCliStatus()
  } finally {
    shellCliBusy.value = false
  }
}

const uninstallShellCli = async () => {
  if (!window.electronAPI.shellCli) return
  shellCliBusy.value = true
  try {
    const res = await window.electronAPI.shellCli.uninstall()
    if (!res.ok) {
      showMessage('error', t('dataSettings.shellCliFailed', { error: res.error || '' }))
      return
    }
    showMessage('success', t('dataSettings.shellCliUninstallOk'))
    await loadShellCliStatus()
  } finally {
    shellCliBusy.value = false
  }
}

// 加载状态
const isLoading = ref(false)
const isExporting = ref(false)
const isImporting = ref(false)

// 消息提示
const message = ref<{ type: 'success' | 'error'; text: string } | null>(null)

// ========== 历史记录查看 ==========
const showHistoryViewer = ref(false)
const historyLoading = ref(false)
const agentRecords = ref<AgentRecord[]>([])
const searchKeyword = ref('')
const selectedDateRange = ref<'today' | 'week' | 'month' | 'all'>('week')
const expandedAgentIds = ref<Set<string>>(new Set())

// 日期范围计算
const getDateRange = () => {
  const now = new Date()
  const today = now.toISOString().split('T')[0]
  
  switch (selectedDateRange.value) {
    case 'today':
      return { start: today, end: today }
    case 'week': {
      const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)
      return { start: weekAgo.toISOString().split('T')[0], end: today }
    }
    case 'month': {
      const monthAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)
      return { start: monthAgo.toISOString().split('T')[0], end: today }
    }
    case 'all':
    default:
      return { start: undefined, end: undefined }
  }
}

// 加载历史记录
const loadHistory = async () => {
  historyLoading.value = true
  try {
    const { start, end } = getDateRange()
    agentRecords.value = await window.electronAPI.history.getAgentRecords(start, end) || []
  } catch (e) {
    console.error('Failed to load history:', e)
    showMessage('error', t('dataSettings.loadHistoryFailed'))
  } finally {
    historyLoading.value = false
  }
}

// 切换日期范围时加载
const switchDateRange = (range: 'today' | 'week' | 'month' | 'all') => {
  selectedDateRange.value = range
  loadHistory()
}

// 打开历史查看器
const openHistoryViewer = async () => {
  showHistoryViewer.value = true
  await loadHistory()
}

// 关闭历史查看器
const closeHistoryViewer = () => {
  showHistoryViewer.value = false
  agentRecords.value = []
  searchKeyword.value = ''
  expandedAgentIds.value.clear()
}

// 格式化时间
const formatTime = (timestamp: number) => {
  const { locale } = useI18n()
  const date = new Date(timestamp)
  return date.toLocaleString(locale.value, {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

// 格式化时长
const formatDuration = (ms: number) => {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  return `${(ms / 60000).toFixed(1)}min`
}

// 过滤 Agent 记录
const filteredAgentRecords = computed(() => {
  if (!searchKeyword.value.trim()) return agentRecords.value
  const keyword = searchKeyword.value.toLowerCase()
  return agentRecords.value.filter(r => 
    r.userTask.toLowerCase().includes(keyword) ||
    r.finalResult?.toLowerCase().includes(keyword) ||
    r.sshHost?.toLowerCase().includes(keyword)
  )
})

// 切换展开 Agent 详情
const toggleAgentExpand = (id: string) => {
  if (expandedAgentIds.value.has(id)) {
    expandedAgentIds.value.delete(id)
  } else {
    expandedAgentIds.value.add(id)
  }
}

// 渲染 markdown
const renderMarkdown = (content: string) => {
  try {
    return marked.parse(content, { breaks: true, async: false })
  } catch {
    return content
  }
}

// 获取步骤类型图标
const getStepIcon = (type: string) => {
  switch (type) {
    case 'thinking': return '🤔'
    case 'tool_call': return '🔧'
    case 'tool_result': return '📋'
    case 'message': return '💬'
    case 'error': return '❌'
    default: return '📌'
  }
}

// 获取状态标签样式
const getStatusClass = (status: string) => {
  switch (status) {
    case 'completed': return 'status-completed'
    case 'failed': return 'status-failed'
    case 'aborted': return 'status-aborted'
    default: return ''
  }
}

// 获取状态文本
const getStatusText = (status: string) => {
  switch (status) {
    case 'completed': return t('dataSettings.statusCompleted')
    case 'failed': return t('dataSettings.statusFailed')
    case 'aborted': return t('dataSettings.statusAborted')
    default: return status
  }
}

// ========== Token 用量统计 ==========
interface TokenPeriodStats {
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  cache_hit_tokens: number
  cache_miss_tokens: number
  taskCount: number
}

interface TokenUsageStatsData {
  total: TokenPeriodStats
  today: TokenPeriodStats
  last7Days: TokenPeriodStats
  last30Days: TokenPeriodStats
  daily: Array<{ date: string } & TokenPeriodStats>
}

const tokenUsageStats = ref<TokenUsageStatsData | null>(null)
const showDailyDetail = ref(false)

const loadTokenUsageStats = async () => {
  try {
    tokenUsageStats.value = await window.electronAPI.history.getTokenUsageStats()
  } catch (e) {
    console.error('Failed to load token usage stats:', e)
  }
}

const formatTokenCount = (count: number): string => {
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}K`
  return count.toString()
}

const hasTokenData = computed(() => {
  return tokenUsageStats.value && tokenUsageStats.value.total.total_tokens > 0
})

const getCacheHitRate = (stats: TokenPeriodStats): number | null => {
  if (stats.cache_hit_tokens === 0 && stats.cache_miss_tokens === 0) return null
  if (stats.prompt_tokens === 0) return null
  return Math.round(stats.cache_hit_tokens / stats.prompt_tokens * 100)
}

// 加载存储统计
const loadStorageStats = async () => {
  try {
    storageStats.value = await window.electronAPI.history.getStorageStats()
    dataPath.value = await window.electronAPI.history.getDataPath()
  } catch (e) {
    console.error('Failed to load storage stats:', e)
  }
}

// 格式化文件大小
const formatSize = (bytes: number): string => {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// 打开数据目录
const openDataFolder = async () => {
  try {
    await window.electronAPI.history.openDataFolder()
  } catch (e) {
    showMessage('error', t('dataSettings.openFolderFailed'))
  }
}

// 加载数据目录信息（当前/是否自定义/上次迁移错误）
const loadDataDirInfo = async () => {
  try {
    const info = await window.electronAPI.dataDir.getInfo()
    dataPath.value = info.current
    isCustomDataDir.value = info.isCustom
    if (info.lastError) {
      if (info.lastError === 'restore_canceled') {
        showMessage('success', t('dataSettings.restoreCanceled'))
      } else {
        showMessage('error', t('dataSettings.migrateErrorLast', {
          error: formatBackupError(info.lastError),
        }))
      }
    }
  } catch (e) {
    console.error('Failed to load data dir info:', e)
  }
}

// 把后端返回的错误码映射成可读文案
const dataDirErrorText = (code?: string): string => {
  switch (code) {
    case 'invalid_path': return t('dataSettings.migrateErrInvalid')
    case 'same_as_current': return t('dataSettings.migrateErrSame')
    case 'nested': return t('dataSettings.migrateErrNested')
    case 'not_writable': return t('dataSettings.migrateErrNotWritable')
    case 'already_default': return t('dataSettings.migrateErrAlreadyDefault')
    default: return t('dataSettings.migrateFailed', { error: code || '' })
  }
}

// 迁移前的统一确认：若有任务在运行需额外提示中断
const confirmRestartForMigration = async (): Promise<boolean> => {
  let running = false
  try {
    running = await window.electronAPI.dataDir.hasRunningAgents()
  } catch { /* 查询失败按无运行处理 */ }
  const msg = running
    ? t('dataSettings.changeDirConfirmRunning')
    : t('dataSettings.changeDirConfirmRestart')
  return showConfirm({
    type: 'warning',
    title: t('common.confirm'),
    message: msg,
  })
}

// 更改数据目录
const changeDataDir = async () => {
  if (isMigratingDataDir.value) return
  isMigratingDataDir.value = true
  try {
    const picked = await window.electronAPI.dataDir.pickTarget()
    if (picked.canceled || !picked.target) return
    if (picked.nonEmpty && !(await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('dataSettings.changeDirConfirmNonEmpty'),
    }))) return
    if (!(await confirmRestartForMigration())) return

    const res = await window.electronAPI.dataDir.migrate(picked.target)
    if (res.ok) {
      showMessage('success', t('dataSettings.migrateStarting'))
    } else {
      showMessage('error', dataDirErrorText(res.error))
    }
  } catch (e) {
    showMessage('error', t('dataSettings.migrateFailed', { error: String(e) }))
  } finally {
    isMigratingDataDir.value = false
  }
}

// 恢复到默认数据目录
const resetDataDir = async () => {
  if (isMigratingDataDir.value) return
  if (!(await confirmRestartForMigration())) return
  isMigratingDataDir.value = true
  try {
    const res = await window.electronAPI.dataDir.reset()
    if (res.ok) {
      showMessage('success', t('dataSettings.migrateStarting'))
    } else {
      showMessage('error', dataDirErrorText(res.error))
    }
  } catch (e) {
    showMessage('error', t('dataSettings.migrateFailed', { error: String(e) }))
  } finally {
    isMigratingDataDir.value = false
  }
}

// ========== 完整备份 / 恢复 ==========
const backupProgress = ref<{
  pct: number
  file: string
  bytes: number
  totalBytes: number
} | null>(null)
let cleanupBackupProgress: (() => void) | null = null

const formatBackupError = (code?: string): string => {
  switch (code) {
    case 'busy': return t('dataSettings.backupBusy')
    case 'target_exists': return t('dataSettings.backupTargetExists')
    case 'not_found': return t('dataSettings.restoreErrNotFound')
    case 'not_archive': return t('dataSettings.restoreErrNotArchive')
    case 'not_directory': return t('dataSettings.restoreErrNotArchive')
    case 'invalid_marker': return t('dataSettings.restoreErrInvalid')
    case 'nested': return t('dataSettings.restoreErrNested')
    case 'migration_pending': return t('dataSettings.restoreErrMigrationPending')
    case 'restore_canceled': return t('dataSettings.restoreCanceled')
    default: return code || t('dataSettings.backupFailed')
  }
}

const startFullBackup = async () => {
  if (!window.electronAPI.dataBackup || isExporting.value) return
  try {
    const running = await window.electronAPI.dataDir.hasRunningAgents()
    if (running && !(await showConfirm({
      type: 'warning',
      title: t('common.confirm'),
      message: t('dataSettings.backupConfirmRunning'),
    }))) return
  } catch { /* ignore */ }

  // 选路径阶段：只锁按钮，不显示进度/取消（取消应走系统对话框）
  isExporting.value = true
  backupProgress.value = null
  cleanupBackupProgress?.()
  cleanupBackupProgress = window.electronAPI.dataBackup.onProgress((p) => {
    backupProgress.value = p
  })
  try {
    const result = await window.electronAPI.dataBackup.export()
    if (result.canceled) {
      // 仅打包中取消才提示；关对话框/拒绝覆盖保持安静
      if (result.cancelReason === 'export') {
        showMessage('success', t('dataSettings.backupCanceled'))
      }
    } else if (result.success) {
      const pathText = result.path || ''
      showMessage('success', result.skippedUnreadable
        ? t('dataSettings.backupOkPartial', { path: pathText, count: result.skippedUnreadable })
        : t('dataSettings.backupOk', { path: pathText }))
    } else {
      showMessage('error', formatBackupError(result.error))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.backupFailed')}: ${e}`)
  } finally {
    cleanupBackupProgress?.()
    cleanupBackupProgress = null
    backupProgress.value = null
    isExporting.value = false
  }
}

const cancelFullBackup = async () => {
  if (!window.electronAPI.dataBackup || !backupProgress.value) return
  const confirmed = await showConfirm({
    type: 'warning',
    title: t('common.confirm'),
    message: t('dataSettings.backupCancelConfirm'),
  })
  if (!confirmed) return
  await window.electronAPI.dataBackup.cancel()
}

const startFullRestore = async () => {
  if (!window.electronAPI.dataBackup || isImporting.value) return
  isImporting.value = true
  try {
    const result = await window.electronAPI.dataBackup.requestRestore()
    if (result.canceled) {
      // 取消选文件或拒绝确认
    } else if (result.success) {
      showMessage('success', t('dataSettings.restoreRestarting'))
    } else {
      showMessage('error', formatBackupError(result.error))
    }
  } catch (e) {
    showMessage('error', `${t('dataSettings.restoreFailed')}: ${e}`)
  } finally {
    isImporting.value = false
  }
}

// 清理旧记录
const cleanupOldRecords = async (days: number) => {
  const confirmMsg = days === 0 
    ? t('dataSettings.confirmClearAll')
    : t('dataSettings.confirmCleanup', { days })
  
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('common.confirm'),
    message: confirmMsg,
  })
  if (!confirmed) {
    return
  }
  
  isLoading.value = true
  try {
    const result = await window.electronAPI.history.cleanup(days)
    showMessage('success', t('dataSettings.cleanupResult', { chatDeleted: result.chatDeleted, agentDeleted: result.agentDeleted }))
    await loadStorageStats()
  } catch (e) {
    showMessage('error', `${t('dataSettings.cleanupFailed')}: ${e}`)
  } finally {
    isLoading.value = false
  }
}

// ========== Agent 临时文件自动清理 ==========
const scratchCleanupDays = ref<number | ''>(7)
const scratchSaving = ref(false)

const loadScratchConfig = async () => {
  try {
    const v = await window.electronAPI.config.get('scratchCleanupMaxAgeDays')
    scratchCleanupDays.value = typeof v === 'number' ? v : 7
  } catch (e) {
    console.error('Failed to load scratch cleanup config:', e)
  }
}

const saveScratchConfig = async () => {
  if (scratchSaving.value) return
  let v = Math.floor(Number(scratchCleanupDays.value))
  if (Number.isNaN(v) || v < 0) v = 0
  if (v > 365) v = 365
  scratchCleanupDays.value = v
  scratchSaving.value = true
  try {
    await window.electronAPI.config.set('scratchCleanupMaxAgeDays', v)
    showMessage('success', t('dataSettings.scratchCleanupSaved'))
  } catch (e) {
    showMessage('error', String(e))
  } finally {
    scratchSaving.value = false
  }
}

// 显示消息
const showMessage = (type: 'success' | 'error', text: string) => {
  message.value = { type, text }
  setTimeout(() => {
    message.value = null
  }, 3000)
}

// 搜索框引用
const historySearchRef = ref<HTMLInputElement | null>(null)

// ESC 关闭历史记录弹窗
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape' && showHistoryViewer.value) {
    e.stopImmediatePropagation() // 阻止其他监听器被调用，防止同时关闭父级弹窗
    closeHistoryViewer()
  }
}

// 监听弹窗打开，自动聚焦到搜索框
watch(showHistoryViewer, async (isOpen) => {
  if (isOpen) {
    await nextTick()
    historySearchRef.value?.focus()
  }
})

onMounted(() => {
  loadStorageStats()
  loadTokenUsageStats()
  loadDataDirInfo()
  loadScratchConfig()
  loadShellCliStatus()
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
  cleanupBackupProgress?.()
  cleanupBackupProgress = null
})
</script>

<template>
  <SettingsPage :title="t('settings.tabs.data')" :desc="t('dataSettings.description')">
    <Transition name="msg">
      <SettingNotice v-if="message" :tone="message.type === 'error' ? 'danger' : 'success'">
        {{ message.text }}
      </SettingNotice>
    </Transition>

    <!-- Token 用量：内容是一排数据卡，外面不再套卡片 -->
    <SettingsGroup
      v-if="!isSteamBuild"
      variant="plain"
      :title="t('dataSettings.tokenUsage')"
      :footnote="t('dataSettings.tokenUsageHint')"
    >
      <div v-if="tokenUsageStats && hasTokenData" class="token-usage-section">
        <div class="token-period-grid">
          <div v-for="period in [
            { key: 'today', data: tokenUsageStats.today, iconClass: 'today' },
            { key: 'last7Days', data: tokenUsageStats.last7Days, iconClass: 'week' },
            { key: 'last30Days', data: tokenUsageStats.last30Days, iconClass: 'month' },
            { key: 'total', data: tokenUsageStats.total, iconClass: 'total' },
          ]" :key="period.key" :class="['token-period-card', { total: period.key === 'total' }]">
            <div class="token-period-header">
              <span class="token-period-label">{{ t(`dataSettings.token${period.key.charAt(0).toUpperCase() + period.key.slice(1)}`) }}</span>
              <component :is="period.key === 'total' ? Coins : Zap" :size="14" :class="['token-period-icon', period.iconClass]" />
            </div>
            <div class="token-period-value">{{ formatTokenCount(period.data.total_tokens) }}</div>
            <div class="token-period-detail">
              <span class="token-in"><ArrowUpRight :size="10" /> {{ formatTokenCount(period.data.prompt_tokens) }}</span>
              <span class="token-out"><ArrowDownLeft :size="10" /> {{ formatTokenCount(period.data.completion_tokens) }}</span>
              <span v-if="getCacheHitRate(period.data) !== null" class="token-cache">Cache {{ getCacheHitRate(period.data) }}%</span>
            </div>
          </div>
        </div>

        <div v-if="tokenUsageStats.daily.length > 0" class="token-daily-section">
          <button class="btn btn-ghost token-daily-toggle" @click="showDailyDetail = !showDailyDetail">
            <ChevronDown v-if="showDailyDetail" :size="14" />
            <ChevronRight v-else :size="14" />
            {{ t('dataSettings.tokenDailyDetail') }}
          </button>

          <Transition name="slide">
            <div v-if="showDailyDetail" class="token-daily-table-wrap">
              <table class="token-daily-table">
                <thead>
                  <tr>
                    <th>{{ t('dataSettings.tokenDate') }}</th>
                    <th class="num">{{ t('dataSettings.tokenInput') }}</th>
                    <th class="num">{{ t('dataSettings.tokenOutput') }}</th>
                    <th class="num">{{ t('dataSettings.tokenTotalCol') }}</th>
                    <th class="num">Cache</th>
                    <th class="num">{{ t('dataSettings.tokenTaskCount') }}</th>
                  </tr>
                </thead>
                <tbody>
                  <tr v-for="day in tokenUsageStats.daily" :key="day.date">
                    <td>{{ day.date }}</td>
                    <td class="num">{{ formatTokenCount(day.prompt_tokens) }}</td>
                    <td class="num">{{ formatTokenCount(day.completion_tokens) }}</td>
                    <td class="num total-cell">{{ formatTokenCount(day.total_tokens) }}</td>
                    <td class="num cache-cell">{{ getCacheHitRate(day) !== null ? getCacheHitRate(day) + '%' : '-' }}</td>
                    <td class="num">{{ day.taskCount }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </Transition>
        </div>
      </div>

      <div v-else-if="tokenUsageStats" class="token-empty">
        <Coins :size="24" class="empty-icon" />
        <span>{{ t('dataSettings.tokenNoData') }}</span>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
    </SettingsGroup>

    <!-- 存储统计：同上，内容本身是一排数据卡 -->
    <SettingsGroup variant="plain" :title="t('dataSettings.storageStats')">
      <template v-if="!isSteamBuild" #actions>
        <button class="btn btn-sm" @click="openHistoryViewer">
          <History :size="14" />
          {{ t('dataSettings.viewHistory') }}
        </button>
      </template>
      <div v-if="storageStats" class="stats-grid">
        <div v-if="!isSteamBuild" class="stat-card stat-agent">
          <div class="stat-icon-wrap agent">
            <Bot :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ storageStats.agentFiles }}</span>
            <span class="stat-label">{{ t('dataSettings.agentRecords') }} ({{ t('dataSettings.days') }})</span>
          </div>
        </div>
        <div v-if="!isSteamBuild" class="stat-card stat-sessions">
          <div class="stat-icon-wrap sessions">
            <History :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ storageStats.agentSessions }}</span>
            <span class="stat-label">{{ t('dataSettings.agentSessionTotal') }}</span>
          </div>
        </div>
        <div class="stat-card stat-size">
          <div class="stat-icon-wrap size">
            <HardDrive :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value">{{ formatSize(storageStats.totalSize) }}</span>
            <span class="stat-label">{{ t('dataSettings.totalSize') }}</span>
          </div>
        </div>
        <div class="stat-card stat-range">
          <div class="stat-icon-wrap range">
            <CalendarRange :size="18" />
          </div>
          <div class="stat-body">
            <span class="stat-value range-value">
              {{ storageStats.oldestRecord || t('dataSettings.noData') }} ~ {{ storageStats.newestRecord || t('dataSettings.noData') }}
            </span>
            <span class="stat-label">{{ t('dataSettings.recordRange') }}</span>
          </div>
        </div>
      </div>
      <div v-else class="loading">{{ t('dataSettings.loading') }}</div>
    </SettingsGroup>

    <!-- 数据目录 -->
    <SettingsGroup :title="t('dataSettings.dataDirectory')">
      <template v-if="isCustomDataDir" #actions>
        <span class="custom-badge">{{ t('dataSettings.customBadge') }}</span>
      </template>
      <SettingRow stacked :label="t('dataSettings.currentLocation')" :desc="t('dataSettings.dataDirHint')">
        <code class="path-text">{{ dataPath }}</code>
        <button class="btn btn-sm btn-icon" :title="t('dataSettings.openFolder')" :aria-label="t('dataSettings.openFolder')" @click="openDataFolder">
          <ExternalLink :size="14" />
        </button>
        <button class="btn btn-sm" :disabled="isMigratingDataDir" @click="changeDataDir">
          <FolderSymlink :size="14" />
          {{ t('dataSettings.changeDir') }}
        </button>
        <button v-if="isCustomDataDir" class="btn btn-sm" :disabled="isMigratingDataDir" @click="resetDataDir">
          <RotateCcw :size="14" />
          {{ t('dataSettings.resetDir') }}
        </button>
      </SettingRow>
    </SettingsGroup>

    <!-- 命令行工具 sailfish（macOS） -->
    <SettingsGroup v-if="isDarwin" :title="t('dataSettings.shellCli')" :desc="t('dataSettings.shellCliHint')">
      <SettingRow
        label="sailfish"
        :desc="shellCliStatus?.installed && shellCliStatus.shimPath
          ? t('dataSettings.shellCliInstalled', { path: shellCliStatus.shimPath })
          : t('dataSettings.shellCliNotInstalled')"
      >
        <button v-if="!shellCliStatus?.installed" class="btn btn-sm" :disabled="shellCliBusy" @click="installShellCli">
          <Terminal :size="14" />
          {{ t('dataSettings.shellCliInstall') }}
        </button>
        <button v-else class="btn btn-sm" :disabled="shellCliBusy" @click="uninstallShellCli">
          {{ t('dataSettings.shellCliUninstall') }}
        </button>
      </SettingRow>
    </SettingsGroup>

    <!-- 完整备份 / 恢复 -->
    <SettingsGroup :title="t('dataSettings.backupRestore')">
      <SettingRow :label="t('dataSettings.fullBackup')" :desc="t('dataSettings.fullBackupHint')">
        <button
          v-if="!backupProgress"
          class="btn btn-sm btn-primary"
          :disabled="isExporting || isImporting"
          @click="startFullBackup"
        >
          <Download :size="14" />
          {{ isExporting ? t('dataSettings.backupPreparing') : t('dataSettings.startAction') }}
        </button>
        <button v-else class="btn btn-sm" @click="cancelFullBackup">
          {{ t('dataSettings.backupCancel') }}
        </button>
      </SettingRow>

      <div v-if="backupProgress" class="backup-progress">
        <div class="backup-progress-bar">
          <div class="backup-progress-fill" :style="{ width: backupProgress.pct + '%' }" />
        </div>
        <div class="backup-progress-meta">
          <span class="backup-progress-file">{{ backupProgress.file || '…' }}</span>
          <span>
            {{ backupProgress.pct }}%
            <template v-if="backupProgress.totalBytes > 0">
              · {{ formatSize(backupProgress.bytes) }} / {{ formatSize(backupProgress.totalBytes) }}
            </template>
          </span>
        </div>
      </div>

      <SettingRow :label="t('dataSettings.fullRestore')" :desc="t('dataSettings.fullRestoreHint')">
        <button class="btn btn-sm" :disabled="isExporting || isImporting" @click="startFullRestore">
          <Upload :size="14" />
          {{ isImporting ? t('dataSettings.restorePreparing') : t('dataSettings.chooseFile') }}
        </button>
      </SettingRow>
    </SettingsGroup>

    <!-- Agent 临时文件自动清理 -->
    <SettingsGroup
      :title="t('dataSettings.scratchCleanup')"
      :footnote="scratchCleanupDays === 0 ? t('dataSettings.scratchCleanupDisabled') : undefined"
    >
      <SettingRow :label="t('dataSettings.scratchCleanupDays')" :desc="t('dataSettings.scratchCleanupHint')">
        <SettingInput v-model="scratchCleanupDays" type="number" compact :min="0" :max="365" />
        <button class="btn btn-sm btn-primary" :disabled="scratchSaving" @click="saveScratchConfig">
          {{ t('common.save') }}
        </button>
      </SettingRow>
    </SettingsGroup>

    <!-- 清理历史 -->
    <SettingsGroup :title="t('dataSettings.cleanupHistory')" :desc="t('dataSettings.cleanupHint')">
      <SettingRow :label="t('dataSettings.cleanupOldRecords')">
        <button class="btn btn-sm" :disabled="isLoading" @click="cleanupOldRecords(30)">
          {{ t('dataSettings.days30') }}
        </button>
        <button class="btn btn-sm" :disabled="isLoading" @click="cleanupOldRecords(90)">
          {{ t('dataSettings.days90') }}
        </button>
      </SettingRow>
      <SettingRow :label="t('dataSettings.clearAll')" :desc="t('dataSettings.clearAllDesc')">
        <button class="btn btn-sm btn-danger-fill" :disabled="isLoading" @click="cleanupOldRecords(0)">
          <AlertTriangle :size="14" />
          {{ t('dataSettings.clearAll') }}
        </button>
      </SettingRow>
    </SettingsGroup>

    <!-- 历史记录查看器弹窗 -->
    <Teleport to="body">
      <Transition name="modal">
        <div v-if="showHistoryViewer" class="history-modal-overlay settings-scope" @click.self="closeHistoryViewer">
          <div class="history-modal">
            <div class="history-modal-header">
              <div class="modal-title">
                <History :size="18" />
                <h3>{{ t('dataSettings.historyViewer') }}</h3>
              </div>
              <button class="close-btn" @click="closeHistoryViewer" aria-label="Close">
                <X :size="16" />
              </button>
            </div>
            
            <!-- 工具栏 -->
            <div class="history-toolbar">
              <div class="toolbar-left">
                <div class="history-type-badge">
                  <Bot :size="14" />
                  {{ t('dataSettings.agentTasks') }}
                </div>
                
                <div class="date-range-switcher">
                  <button 
                    v-for="range in [
                      { value: 'today', label: t('dataSettings.today') },
                      { value: 'week', label: t('dataSettings.last7Days') },
                      { value: 'month', label: t('dataSettings.last30Days') },
                      { value: 'all', label: t('dataSettings.all') }
                    ]" 
                    :key="range.value"
                    :class="['range-btn', { active: selectedDateRange === range.value }]"
                    @click="switchDateRange(range.value as 'today' | 'week' | 'month' | 'all')"
                  >
                    {{ range.label }}
                  </button>
                </div>
              </div>
              
              <div class="search-box">
                <Search :size="14" class="search-icon" />
                <input 
                  ref="historySearchRef"
                  v-model="searchKeyword"
                  type="text" 
                  :placeholder="t('dataSettings.searchPlaceholder')"
                  class="search-input"
                />
                <button v-if="searchKeyword" class="clear-search" @click="searchKeyword = ''">
                  <X :size="12" />
                </button>
              </div>
            </div>
            
            <!-- 内容区域 -->
            <div class="history-content">
              <div v-if="historyLoading" class="loading-state">
                <span class="spinner"></span>
                {{ t('dataSettings.loading') }}
              </div>
              
              <!-- Agent 记录 -->
              <div v-else class="agent-history">
                <div v-if="filteredAgentRecords.length === 0" class="empty-state">
                  <Bot :size="32" class="empty-icon" />
                  <span>{{ t('dataSettings.noAgentRecords') }}</span>
                </div>
                <div v-else class="agent-list">
                  <div 
                    v-for="record in filteredAgentRecords" 
                    :key="record.id"
                    class="agent-item"
                  >
                    <div class="agent-header" @click="toggleAgentExpand(record.id)">
                      <div class="agent-info">
                        <span :class="['status-badge', getStatusClass(record.status)]">
                          {{ getStatusText(record.status) }}
                        </span>
                        <span class="agent-task">{{ record.userTask }}</span>
                      </div>
                      <div class="agent-meta">
                        <span v-if="record.sshHost" class="agent-host">
                          <Server :size="12" /> {{ record.sshHost }}
                        </span>
                        <span v-else class="agent-host">
                          <Monitor :size="12" /> {{ t('dataSettings.local') }}
                        </span>
                        <span class="agent-time">{{ formatTime(record.timestamp) }}</span>
                        <span class="agent-duration">
                          <Clock :size="12" /> {{ formatDuration(record.duration) }}
                        </span>
                        <ChevronDown v-if="expandedAgentIds.has(record.id)" :size="14" class="expand-icon" />
                        <ChevronRight v-else :size="14" class="expand-icon" />
                      </div>
                    </div>
                    
                    <div v-if="expandedAgentIds.has(record.id)" class="agent-details">
                      <div class="steps-list">
                        <div class="steps-label">{{ t('dataSettings.executionSteps') }} ({{ record.steps.length }})</div>
                        <div 
                          v-for="step in record.steps" 
                          :key="step.id"
                          :class="['step-item', step.type]"
                        >
                          <div class="step-header">
                            <span class="step-icon">{{ getStepIcon(step.type) }}</span>
                            <span class="step-type">{{ step.type }}</span>
                            <span v-if="step.toolName" class="step-tool">{{ step.toolName }}</span>
                            <span class="step-time">{{ formatTime(step.timestamp) }}</span>
                          </div>
                          <div v-if="step.content" class="step-content">{{ step.content }}</div>
                          <div v-if="step.toolArgs" class="step-args">
                            <code>{{ JSON.stringify(step.toolArgs, null, 2) }}</code>
                          </div>
                          <div v-if="step.toolResult" class="step-result">
                            <pre>{{ step.toolResult }}</pre>
                          </div>
                        </div>
                      </div>
                      
                      <div v-if="record.finalResult" class="final-result">
                        <div class="result-label">{{ t('dataSettings.finalResult') }}</div>
                        <div class="result-content" v-html="renderMarkdown(record.finalResult)"></div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>
            
            <div class="history-footer">
              <span>
                {{ t('dataSettings.totalTasks', { count: filteredAgentRecords.length }) }}
              </span>
            </div>
          </div>
        </div>
      </Transition>
    </Teleport>
  </SettingsPage>
</template>

<style scoped>
.msg-enter-active,
.msg-leave-active {
  transition: all 0.3s ease;
}
.msg-enter-from,
.msg-leave-to {
  opacity: 0;
  transform: translateY(-8px);
}

/* Stats grid */
.stats-grid {
  display: grid;
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 10px;
}

.stat-card {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.stat-card:hover {
  border-color: var(--border-color);
}

.stat-icon-wrap {
  width: 36px;
  height: 36px;
  border-radius: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.stat-icon-wrap.agent {
  background: rgba(var(--color-success-rgb), 0.12);
  color: var(--color-success);
}

.stat-icon-wrap.sessions {
  background: rgba(59, 130, 246, 0.12);
  color: #3b82f6;
}

.stat-icon-wrap.size {
  background: rgba(168, 85, 247, 0.12);
  color: #a855f7;
}

.stat-icon-wrap.range {
  background: rgba(251, 146, 60, 0.12);
  color: #fb923c;
}

.stat-body {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.stat-value {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  line-height: 1.2;
}

.stat-value.range-value {
  font-size: 12px;
  font-weight: 500;
  line-height: 1.35;
  white-space: normal;
}

.stat-label {
  font-size: 11px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.path-text {
  flex: 1;
  font-size: 12px;
  color: var(--text-secondary);
  word-break: break-all;
  line-height: 1.4;
}

.custom-badge {
  margin-left: auto;
  padding: 2px 8px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  background: rgba(var(--color-info-rgb), 0.12);
  color: var(--color-info);
}

.backup-progress {
  margin-bottom: 12px;
}

.backup-progress-bar {
  height: 8px;
  background: var(--bg-tertiary, rgba(0, 0, 0, 0.15));
  border-radius: 6px;
  overflow: hidden;
}

.backup-progress-fill {
  height: 100%;
  background: var(--accent-primary);
  border-radius: 6px;
  transition: width 0.15s ease;
}

.backup-progress-meta {
  display: flex;
  justify-content: space-between;
  margin-top: 8px;
  font-size: 11px;
  color: var(--text-secondary);
  gap: 12px;
}

.backup-progress-file {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  direction: rtl;
  text-align: left;
}

.loading {
  color: var(--text-muted);
  font-size: 13px;
  padding: 20px 0;
}

/* 填充式危险按钮（特殊语义：清理数据用） */
.btn-danger-fill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  font-size: 13px;
  border-radius: 6px;
  border: 1px solid rgba(var(--color-error-rgb), 0.3);
  background: rgba(var(--color-error-rgb), 0.08);
  color: var(--color-error);
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s;
}

.btn-danger-fill:hover:not(:disabled) {
  background: rgba(var(--color-error-rgb), 0.15);
  border-color: rgba(var(--color-error-rgb), 0.5);
}

.btn-danger-fill:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

/* Token usage */
.token-usage-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.token-period-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 10px;
}

.token-period-card {
  padding: 14px;
  background: var(--bg-secondary);
  border-radius: 8px;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.token-period-card:hover {
  border-color: var(--border-color);
}

.token-period-card.total {
  background: linear-gradient(135deg, rgba(var(--color-info-rgb), 0.06), rgba(168, 85, 247, 0.06));
}

.token-period-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.token-period-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.token-period-icon {
  opacity: 0.5;
}
.token-period-icon.today { color: var(--color-success); }
.token-period-icon.week { color: var(--color-info); }
.token-period-icon.month { color: var(--color-warning); }
.token-period-icon.total { color: #a855f7; }

.token-period-value {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  line-height: 1.2;
  margin-bottom: 6px;
}

.token-period-detail {
  display: flex;
  gap: 10px;
  font-size: 11px;
}

.token-in {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
}

.token-out {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--text-muted);
}

.token-cache {
  font-size: 10px;
  color: var(--color-success);
  margin-left: auto;
}

.token-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
  font-size: 13px;
}

.token-daily-section {
  margin-top: 4px;
}

.token-daily-toggle {
  width: 100%;
  justify-content: center;
  min-height: 30px;
  font-size: 12px;
}

.token-daily-table-wrap {
  margin-top: 8px;
  max-height: 320px;
  overflow-y: auto;
}

.token-daily-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}

.token-daily-table th {
  padding: 8px 10px;
  text-align: left;
  font-weight: 600;
  color: var(--text-secondary);
  border-bottom: 1px solid var(--border-color);
  font-size: 11px;
}

.token-daily-table th.num,
.token-daily-table td.num {
  text-align: right;
}

.token-daily-table td {
  padding: 7px 10px;
  color: var(--text-primary);
  border-bottom: 1px solid var(--border-color);
}

.token-daily-table td.total-cell {
  font-weight: 600;
}

.token-daily-table td.cache-cell {
  color: var(--color-success);
}

.token-daily-table tbody tr:hover {
  background: var(--bg-hover);
}

.token-daily-table tbody tr:last-child td {
  border-bottom: none;
}

.slide-enter-active,
.slide-leave-active {
  transition: all 0.25s ease;
  max-height: 400px;
}
.slide-enter-from,
.slide-leave-to {
  opacity: 0;
  max-height: 0;
}

@media (max-width: 900px) {
  .stats-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .token-period-grid {
    grid-template-columns: repeat(2, 1fr);
  }

  .actions .btn,
  .section-danger .cleanup-actions .btn {
    min-width: 0;
  }
}

/* ========== History modal ========== */
.modal-enter-active,
.modal-leave-active {
  transition: opacity 0.25s ease;
}
.modal-enter-active .history-modal,
.modal-leave-active .history-modal {
  transition: transform 0.25s ease;
}
.modal-enter-from,
.modal-leave-to {
  opacity: 0;
}
.modal-enter-from .history-modal {
  transform: scale(0.95) translateY(10px);
}
.modal-leave-to .history-modal {
  transform: scale(0.95) translateY(10px);
}

.history-modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 10000;
  backdrop-filter: blur(4px);
}

.history-modal {
  width: 90%;
  max-width: 900px;
  max-height: 85vh;
  background: var(--bg-primary);
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.4);
  border: 1px solid var(--border-color);
}

.history-modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 10px;
  color: var(--text-primary);
}

.modal-title h3 {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
}

.close-btn {
  width: 30px;
  height: 30px;
  border: none;
  background: var(--bg-tertiary);
  border-radius: 8px;
  cursor: pointer;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s;
}

.close-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

/* Toolbar */
.history-toolbar {
  display: flex;
  gap: 12px;
  padding: 12px 20px;
  border-bottom: 1px solid var(--border-color);
  align-items: center;
  flex-wrap: wrap;
  justify-content: space-between;
}

.toolbar-left {
  display: flex;
  gap: 12px;
  align-items: center;
  flex-wrap: wrap;
}

.history-type-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--bg-tertiary);
  color: var(--text-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  padding: 6px 10px;
  font-size: 12px;
  font-weight: 500;
}

.date-range-switcher {
  display: flex;
  gap: 4px;
}

.range-btn {
  padding: 5px 10px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  border-radius: 6px;
  cursor: pointer;
  font-size: 12px;
  transition: all 0.2s;
}

.range-btn:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.range-btn.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.search-box {
  min-width: 180px;
  max-width: 280px;
  position: relative;
  display: flex;
  align-items: center;
}

.search-icon {
  position: absolute;
  left: 10px;
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 7px 30px 7px 32px;
  border: 1px solid var(--border-color);
  background: var(--bg-tertiary);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 13px;
}

.search-input::placeholder {
  color: var(--text-muted);
}

.search-input:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.clear-search {
  position: absolute;
  right: 8px;
  cursor: pointer;
  color: var(--text-muted);
  border: none;
  background: none;
  padding: 2px;
  display: flex;
  align-items: center;
}

.clear-search:hover {
  color: var(--text-primary);
}

/* Content */
.history-content {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  min-height: 300px;
  user-select: text;
  -webkit-user-select: text;
}

.loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 10px;
  height: 200px;
  color: var(--text-muted);
}

.spinner {
  width: 20px;
  height: 20px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  height: 200px;
  color: var(--text-muted);
  font-size: 14px;
}

.empty-icon {
  opacity: 0.3;
}

/* Agent records */
.agent-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.agent-item {
  background: var(--bg-tertiary);
  border-radius: 10px;
  overflow: hidden;
  border: 1px solid transparent;
  transition: border-color 0.2s;
}

.agent-item:hover {
  border-color: var(--border-color);
}

.agent-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 12px 14px;
  cursor: pointer;
  transition: background 0.2s;
}

.agent-header:hover {
  background: var(--bg-hover);
}

.agent-info {
  display: flex;
  align-items: center;
  gap: 10px;
  flex: 1;
  min-width: 0;
}

.status-badge {
  padding: 3px 8px;
  border-radius: 5px;
  font-size: 11px;
  font-weight: 500;
  flex-shrink: 0;
}

.status-completed {
  background: rgba(var(--color-success-rgb), 0.12);
  color: var(--color-success);
}

.status-failed {
  background: rgba(var(--color-error-rgb), 0.12);
  color: var(--color-error);
}

.status-aborted {
  background: rgba(var(--color-warning-rgb), 0.12);
  color: var(--color-warning);
}

.agent-task {
  font-size: 13px;
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  user-select: text;
  -webkit-user-select: text;
}

.agent-meta {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11px;
  color: var(--text-muted);
  flex-shrink: 0;
}

.agent-host,
.agent-duration {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}

.expand-icon {
  color: var(--text-muted);
  transition: transform 0.2s;
}

/* Agent details */
.agent-details {
  padding: 14px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-secondary);
}

.final-result {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  border-left: 3px solid var(--color-success);
}

.result-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.result-content {
  font-size: 13px;
  line-height: 1.6;
  color: var(--text-primary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.result-content :deep(p) {
  margin: 0 0 8px 0;
}

.result-content :deep(p:last-child) {
  margin-bottom: 0;
}

.steps-list {
  max-height: 400px;
  overflow-y: auto;
}

.steps-label {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 10px;
}

.step-item {
  padding: 10px;
  margin-bottom: 8px;
  background: var(--bg-tertiary);
  border-radius: 6px;
  font-size: 12px;
}

.step-item:last-child {
  margin-bottom: 0;
}

.step-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  color: var(--text-secondary);
}

.step-icon {
  font-size: 14px;
}

.step-type {
  font-weight: 500;
  text-transform: capitalize;
}

.step-tool {
  padding: 1px 6px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-family: monospace;
}

.step-time {
  margin-left: auto;
  font-size: 11px;
  color: var(--text-muted);
}

.step-content {
  color: var(--text-primary);
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-args {
  margin-top: 6px;
}

.step-args code {
  display: block;
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

.step-result {
  margin-top: 6px;
}

.step-result pre {
  padding: 8px;
  background: var(--bg-secondary);
  border-radius: 4px;
  font-size: 11px;
  overflow-x: auto;
  max-height: 200px;
  margin: 0;
  color: var(--text-secondary);
  user-select: text;
  -webkit-user-select: text;
  cursor: text;
}

/* Footer */
.history-footer {
  padding: 10px 20px;
  border-top: 1px solid var(--border-color);
  font-size: 12px;
  color: var(--text-muted);
  text-align: center;
}
</style>

