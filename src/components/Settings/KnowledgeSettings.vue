<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Loader2, AlertTriangle } from 'lucide-vue-next'
import { showConfirm, showAlert } from '../../composables/useConfirm'
import {
  SettingsPage,
  SettingsGroup,
  SettingRow,
  SettingInput,
  SettingToggle,
  SettingSelect,
  SettingNotice,
} from './kit'

const { t } = useI18n()
const api = window.electronAPI as any

// ==================== 类型 ====================

interface KnowledgeSettings {
  enabled: boolean
  embeddingMode: 'local' | 'mcp'
  localModel: 'auto' | 'lite' | 'standard' | 'large'
  embeddingDevice?: 'auto' | 'cpu' | 'gpu' | 'coreml' | 'cuda' | 'dml' | 'webgpu'
  embeddingMcpServerId?: string
  autoSaveUploads: boolean
  chunkStrategy: 'fixed' | 'semantic' | 'paragraph'
  searchTopK: number
  enableRerank: boolean
  enableHostMemory: boolean
  mcpKnowledgeServerId?: string
  cardProfileId?: string
  recallFolder?: string
}

// ==================== 设置状态 ====================

const settings = ref<KnowledgeSettings>({
  enabled: true,
  embeddingMode: 'local',
  localModel: 'lite',
  embeddingDevice: 'auto',
  autoSaveUploads: true,
  chunkStrategy: 'paragraph',
  searchTopK: 10,
  enableRerank: true,
  enableHostMemory: true,
  cardProfileId: '',
  recallFolder: '',
})

const loading = ref(true)
const saving = ref(false)
const isKnowledgeInitialized = ref(false)

// ==================== 记忆长度上限 ====================

const contextKnowledgeMaxChars = ref(5000)
const contextKnowledgeMaxCharsDraft = ref<number | ''>(5000)
const contextKnowledgeMaxCharsMin = ref(1000)
const contextKnowledgeMaxCharsMax = ref(20000)
const contextKnowledgeMaxCharsSaving = ref(false)

// ==================== 知识库状态 ====================

const cardProfiles = ref<{ id: string; name: string }[]>([])
const clearing = ref(false)
const repairing = ref(false)
const repairProgress = ref<{ current: number; total: number; filename: string } | null>(null)
const kbDocumentIds = ref<string[]>([])

const cardProfileOptions = computed(() => [
  { value: '', label: t('knowledgeManager.cardProfileOff') },
  ...cardProfiles.value.map(profile => ({ value: profile.id, label: profile.name })),
])

// ==================== 设置加载/保存 ====================

const loadSettings = async () => {
  try {
    loading.value = true
    isKnowledgeInitialized.value = await api.knowledge.isInitialized()
    settings.value = await api.knowledge.getSettings()
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    if (settings.value.mcpKnowledgeServerId) {
      settings.value.mcpKnowledgeServerId = ''
      await saveSettings()
    }
    if (!settings.value.enabled) {
      settings.value.enabled = true
      await saveSettings()
    }
    settings.value.cardProfileId = settings.value.cardProfileId || ''
    settings.value.recallFolder = settings.value.recallFolder || ''
    const profiles = await api.config.getAiProfiles()
    cardProfiles.value = (profiles || []).map((profile: { id: string; name?: string }) => ({
      id: profile.id,
      name: profile.name || profile.id,
    }))
    await loadMemoryLimits()
  } catch (error) {
    console.error('加载设置失败:', error)
  } finally {
    loading.value = false
  }
}

const saveSettings = async () => {
  try {
    saving.value = true
    settings.value.localModel = 'lite'
    settings.value.embeddingMode = 'local'
    settings.value.mcpKnowledgeServerId = ''
    const plainSettings = JSON.parse(JSON.stringify(settings.value))
    const result = await api.knowledge.updateSettings(plainSettings)
    if (!result.success) {
      console.error('保存设置失败:', result.error)
    }
  } catch (error) {
    console.error('保存设置异常:', error)
  } finally {
    saving.value = false
  }
}

const onAutoSaveUploads = async (enabled: boolean) => {
  settings.value.autoSaveUploads = enabled
  await saveSettings()
}

const onEmbeddingDevice = async (device: string) => {
  settings.value.embeddingDevice = device as KnowledgeSettings['embeddingDevice']
  await saveSettings()
}

const embeddingDeviceOptions = computed(() => [
  { value: 'auto', label: t('knowledgeSettings.embeddingDeviceAuto') },
  { value: 'cpu', label: t('knowledgeSettings.embeddingDeviceCpu') },
])

// ==================== 数据加载 ====================

const loadMemoryLimits = async () => {
  try {
    const result = await window.electronAPI.contextKnowledge.list()
    if (!result.success) return
    if (typeof result.maxDocChars === 'number' && result.maxDocChars > 0) {
      contextKnowledgeMaxChars.value = result.maxDocChars
      contextKnowledgeMaxCharsDraft.value = result.maxDocChars
    }
    if (typeof result.minDocChars === 'number' && result.minDocChars > 0) {
      contextKnowledgeMaxCharsMin.value = result.minDocChars
    }
    if (typeof result.maxDocCharsLimit === 'number' && result.maxDocCharsLimit > 0) {
      contextKnowledgeMaxCharsMax.value = result.maxDocCharsLimit
    }
  } catch (error) {
    console.error('加载记忆长度失败:', error)
  }
}

/** 清空全库只清知识库里的文件，记忆和主机画像不算 */
const loadKnowledgeDocs = async () => {
  try {
    const docs: Array<{ id: string; fileType: string }> = await api.knowledge.getDocuments() || []
    kbDocumentIds.value = docs
      .filter(doc => doc.fileType !== 'host-memory' && doc.fileType !== 'conversation')
      .map(doc => doc.id)
  } catch (error) {
    console.error('加载知识库失败:', error)
  }
}

const commitMemoryMaxChars = async () => {
  if (contextKnowledgeMaxCharsSaving.value) return
  if (contextKnowledgeMaxCharsDraft.value === '') {
    contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
    return
  }
  let v = Math.round(Number(contextKnowledgeMaxCharsDraft.value))
  if (!Number.isFinite(v)) v = contextKnowledgeMaxChars.value
  if (v < contextKnowledgeMaxCharsMin.value) v = contextKnowledgeMaxCharsMin.value
  if (v > contextKnowledgeMaxCharsMax.value) v = contextKnowledgeMaxCharsMax.value
  contextKnowledgeMaxCharsDraft.value = v
  if (v === contextKnowledgeMaxChars.value) return
  contextKnowledgeMaxCharsSaving.value = true
  try {
    const result = await window.electronAPI.contextKnowledge.setMaxDocChars(v)
    if (result.success) {
      contextKnowledgeMaxChars.value = result.maxDocChars
      contextKnowledgeMaxCharsDraft.value = result.maxDocChars
    } else {
      contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
    }
  } catch (error) {
    console.error('保存记忆长度失败:', error)
    contextKnowledgeMaxCharsDraft.value = contextKnowledgeMaxChars.value
  } finally {
    contextKnowledgeMaxCharsSaving.value = false
  }
}

const onCardProfile = async (profileId: string) => {
  settings.value.cardProfileId = profileId
  await saveSettings()
}

const onRecallFolder = async () => {
  settings.value.recallFolder = (settings.value.recallFolder || '').trim()
  await saveSettings()
}

const clearKnowledge = async () => {
  await loadKnowledgeDocs()
  const count = kbDocumentIds.value.length
  if (count === 0) {
    await showAlert(t('common.confirm'), t('knowledgeManager.emptyKnowledge'))
    return
  }
  const confirmed = await showConfirm({
    type: 'danger',
    title: t('knowledgeSettings.clearLabel'),
    message: t('knowledgeManager.confirmClear', { count }),
    confirmText: t('knowledgeSettings.clearAction'),
    typedPhrase: t('knowledgeSettings.clearConfirmPhrase'),
  })
  if (!confirmed) return
  try {
    clearing.value = true
    await api.knowledge.removeDocuments(kbDocumentIds.value)
  } catch (error) {
    console.error('Clear knowledge base failed:', error)
  } finally {
    await loadKnowledgeDocs()
    clearing.value = false
  }
}

const repairKnowledge = async () => {
  try {
    repairing.value = true
    repairProgress.value = null

    const unsubProgress = api.knowledge.onRepairProgress?.((data: { current: number; total: number; filename: string }) => {
      repairProgress.value = data
    })

    const result = await api.knowledge.repairIndex()

    unsubProgress?.()
    repairProgress.value = null

    if (result.success) {
      const secs = ((result.durationMs || 0) / 1000).toFixed(1)
      await showAlert(t('common.success'), t('knowledgeManager.repairSuccess', {
        added: result.added ?? 0,
        checked: result.checked ?? 0,
        secs,
      }))
    } else {
      await showAlert(t('common.error'), t('knowledgeManager.repairFailed') + ': ' + (result.error || t('knowledgeManager.unknownError')))
    }
  } catch (error) {
    console.error('Repair index failed:', error)
    await showAlert(t('common.error'), t('knowledgeManager.repairFailed'))
  } finally {
    repairing.value = false
    repairProgress.value = null
  }
}

// ==================== 生命周期 ====================

let unsubscribeKnowledgeReady: (() => void) | null = null

onMounted(() => {
  loadSettings()
  unsubscribeKnowledgeReady = api.knowledge.onReady(() => {
    isKnowledgeInitialized.value = true
    loadSettings()
  })
})

onUnmounted(() => {
  unsubscribeKnowledgeReady?.()
})
</script>

<template>
  <SettingsPage :title="t('settings.tabs.knowledge')" :desc="t('knowledgeSettings.description')">
    <SettingNotice v-if="loading">{{ t('common.loading') }}</SettingNotice>
    <SettingNotice v-else-if="!isKnowledgeInitialized">
      <Loader2 class="spinner" :size="16" />
      <span>{{ t('knowledgeSettings.initializing') }}</span>
    </SettingNotice>

    <template v-else>
      <SettingsGroup :title="t('knowledgeSettings.memoryLengthGroup')">
        <SettingRow
          :label="t('knowledgeSettings.memoryMaxChars')"
          :desc="t('knowledgeSettings.memoryMaxCharsHint')"
        >
          <SettingInput
            v-model="contextKnowledgeMaxCharsDraft"
            type="number"
            compact
            :min="contextKnowledgeMaxCharsMin"
            :max="contextKnowledgeMaxCharsMax"
            :disabled="contextKnowledgeMaxCharsSaving"
            @change="commitMemoryMaxChars"
            @blur="commitMemoryMaxChars"
          />
          <span class="memory-max-unit">{{ t('knowledgeSettings.memoryMaxCharsUnit') }}</span>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.archiveGroup')">
        <SettingRow
          :label="t('knowledgeSettings.cardProfile')"
          :desc="t('knowledgeSettings.cardProfileDesc')"
        >
          <SettingSelect
            :model-value="settings.cardProfileId || ''"
            :options="cardProfileOptions"
            @update:model-value="onCardProfile"
          />
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.recallFolder')"
          :desc="t('knowledgeSettings.recallFolderDesc')"
        >
          <SettingInput
            :model-value="settings.recallFolder || ''"
            @update:model-value="settings.recallFolder = String($event)"
            :placeholder="t('knowledgeManager.folderPlaceholder')"
            @change="onRecallFolder"
            @blur="onRecallFolder"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.docProcessing')">
        <SettingRow
          clickable
          :label="t('knowledgeSettings.autoSaveUploads')"
          :desc="t('knowledgeSettings.autoSaveUploadsDesc')"
        >
          <SettingToggle
            :model-value="settings.autoSaveUploads"
            @update:model-value="onAutoSaveUploads"
          />
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.embeddingDevice')"
          :desc="t('knowledgeSettings.embeddingDeviceDesc')"
        >
          <SettingSelect
            :model-value="settings.embeddingDevice || 'auto'"
            :options="embeddingDeviceOptions"
            @update:model-value="onEmbeddingDevice"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup :title="t('knowledgeSettings.maintainGroup')">
        <SettingRow
          :label="t('knowledgeSettings.repairLabel')"
          :desc="t('knowledgeSettings.repairDesc')"
        >
          <button class="btn btn-sm" @click="repairKnowledge" :disabled="repairing">
            <template v-if="repairing">
              {{ repairProgress ? `${repairProgress.current}/${repairProgress.total}` : t('knowledgeManager.repairing') }}
            </template>
            <template v-else>{{ t('knowledgeSettings.repairAction') }}</template>
          </button>
        </SettingRow>
        <SettingRow
          :label="t('knowledgeSettings.clearLabel')"
          :desc="t('knowledgeSettings.clearDesc')"
        >
          <button
            class="btn btn-danger-fill"
            @click="clearKnowledge"
            :disabled="clearing"
          >
            <AlertTriangle :size="14" />
            {{ clearing ? t('knowledgeManager.clearing') : t('knowledgeSettings.clearAction') }}
          </button>
        </SettingRow>
      </SettingsGroup>
      </template>
    </SettingsPage>
</template>

<style scoped>
.spinner { animation: spin 1s linear infinite; }
@keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }

.memory-max-unit {
  font-size: var(--fs-desc);
  color: var(--text-secondary);
}

.btn-danger-fill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 600;
  border-radius: 6px;
  border: 1px solid rgba(var(--color-error-rgb), 0.45);
  background: var(--color-error);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.2s, border-color 0.2s, opacity 0.2s;
}

.btn-danger-fill:hover:not(:disabled) {
  filter: brightness(1.08);
}

.btn-danger-fill:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

</style>
