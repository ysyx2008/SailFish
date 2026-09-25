<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { ExternalLink, Play, RotateCcw, Upload, Volume2 } from 'lucide-vue-next'
import { useConfigStore } from '../../stores/config'
import { applyMasterCueEnabled, clampCueVolume, CUE_SOUND_KINDS, CUE_VOLUME_MAX, CUE_VOLUME_STEP, type CueSoundKind } from '@shared/types'
import { playCueSound } from '../../composables/useCueSound'
import AppSelect from '../common/AppSelect.vue'
import { WEB_SEARCH_PROVIDERS, webSearchKeyFromModelProfiles, type WebSearchProviderId } from '@shared/types'
import {
  useSpeechPackInstall,
  retainSpeechPackInstallUi,
  releaseSpeechPackInstallUi,
  refreshSpeechPackStatus,
} from '../../composables/useSpeechPackInstall'

const { t } = useI18n()

const props = defineProps<{
  initialSection?: string
}>()

const configStore = useConfigStore()

const CUE_MAX_BYTES = Math.floor(1.5 * 1024 * 1024)
const cueError = ref('')

const cueEnabled = computed({
  get: () => configStore.cueSoundSettings.enabled !== false,
  set: (enabled: boolean) => {
    void configStore.saveCueSoundSettings(
      applyMasterCueEnabled(configStore.cueSoundSettings, enabled),
    )
  },
})

const cueVolumeDraft = ref<number | null>(null)
const toCueVolumePercent = (raw: number) => Math.round(clampCueVolume(raw / 100) * 100)
const cueVolumePercent = computed(() =>
  cueVolumeDraft.value ?? toCueVolumePercent((configStore.cueSoundSettings.volume ?? 1) * 100),
)

const onCueVolumeInput = (event: Event) => {
  cueVolumeDraft.value = toCueVolumePercent(Number((event.target as HTMLInputElement).value))
}

const onCueVolumeCommit = (event: Event) => {
  const percent = toCueVolumePercent(Number((event.target as HTMLInputElement).value))
  cueVolumeDraft.value = null
  void configStore.saveCueSoundSettings({
    ...configStore.cueSoundSettings,
    volume: percent / 100,
  })
  previewCue('complete')
}

const isKindOn = (kind: CueSoundKind) => configStore.cueSoundSettings.kindEnabled[kind] !== false

const setKindOn = (kind: CueSoundKind, on: boolean) => {
  void configStore.saveCueSoundSettings({
    ...configStore.cueSoundSettings,
    kindEnabled: { ...configStore.cueSoundSettings.kindEnabled, [kind]: on },
  })
}

const isCustomCue = (kind: CueSoundKind) => Boolean(configStore.cueSoundSettings.custom[kind])

const previewCue = (kind: CueSoundKind) => {
  playCueSound(kind, { force: true })
}

async function ingestCustomCue(kind: CueSoundKind, file: File) {
  cueError.value = ''
  if (file.size > CUE_MAX_BYTES) {
    cueError.value = t('settings.cueSounds.fileTooLarge')
    return
  }
  try {
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onload = () => resolve(String(reader.result || ''))
      reader.onerror = () => reject(reader.error)
      reader.readAsDataURL(file)
    })
    if (!dataUrl.startsWith('data:')) {
      cueError.value = t('settings.cueSounds.fileInvalid')
      return
    }
    await configStore.saveCueSoundSettings({
      ...configStore.cueSoundSettings,
      custom: { ...configStore.cueSoundSettings.custom, [kind]: dataUrl },
    })
    playCueSound(kind, { force: true })
  } catch {
    cueError.value = t('settings.cueSounds.fileInvalid')
  }
}

const replaceCue = (kind: CueSoundKind) => {
  const input = document.createElement('input')
  input.type = 'file'
  input.accept = 'audio/wav,audio/mpeg,audio/ogg,audio/mp4,audio/aac,.wav,.mp3,.ogg,.m4a,.aac'
  input.onchange = () => {
    const file = input.files?.[0]
    if (file) void ingestCustomCue(kind, file)
  }
  input.click()
}

const resetCue = (kind: CueSoundKind) => {
  const custom = { ...configStore.cueSoundSettings.custom }
  delete custom[kind]
  void configStore.saveCueSoundSettings({
    ...configStore.cueSoundSettings,
    custom,
  })
}

onMounted(() => {
  initTtsState()
  retainSpeechPackInstallUi()
  void refreshSpeechPackStatus()
  if (props.initialSection === 'speechPack') {
    nextTick(() => scrollToSpeechPack())
  }
  applyWebSearchFromStore()
})

onUnmounted(() => {
  releaseSpeechPackInstallUi()
})

watch(() => props.initialSection, (section) => {
  if (section === 'speechPack') {
    nextTick(() => scrollToSpeechPack())
  }
})

// ==================== TTS 语音合成 ====================

interface TtsPresetVoice { id: string; name: string }
interface TtsPreset {
  id: string
  providerId: string
  name: string
  group: 'international' | 'domestic' | 'other'
  apiUrl: string
  models: string[]
  defaultModel: string
  voices: TtsPresetVoice[]
  defaultVoice: string
  keyUrl: string
  keyPlaceholder: string
  keyLabel?: string
  modelLabel?: string
  modelPlaceholder?: string
}

const ttsPresets: TtsPreset[] = [
  {
    id: 'openai',
    providerId: 'openai-compat',
    name: 'OpenAI',
    group: 'international',
    apiUrl: 'https://api.openai.com/v1/audio/speech',
    models: ['tts-1', 'tts-1-hd'],
    defaultModel: 'tts-1',
    voices: [
      { id: 'alloy', name: 'Alloy' }, { id: 'ash', name: 'Ash' },
      { id: 'ballad', name: 'Ballad' }, { id: 'coral', name: 'Coral' },
      { id: 'echo', name: 'Echo' }, { id: 'fable', name: 'Fable' },
      { id: 'nova', name: 'Nova' }, { id: 'onyx', name: 'Onyx' },
      { id: 'sage', name: 'Sage' }, { id: 'shimmer', name: 'Shimmer' },
    ],
    defaultVoice: 'alloy',
    keyUrl: 'https://platform.openai.com/api-keys',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'volcengine',
    providerId: 'volcengine-tts',
    name: t('settings.tts.presets.volcengine'),
    group: 'domestic',
    apiUrl: 'https://openspeech.bytedance.com/api/v1/tts',
    models: [],
    defaultModel: '',
    voices: [
      { id: 'zh_female_cancan_mars_bigtts', name: '灿灿 (Shiny)' },
      { id: 'zh_male_xudong_conversation_wvae_bigtts', name: '快乐小东' },
      { id: 'zh_female_qinqienvsheng_moon_bigtts', name: '亲切女声' },
    ],
    defaultVoice: 'zh_female_cancan_mars_bigtts',
    keyUrl: 'https://console.volcengine.com/speech/app',
    keyPlaceholder: 'Access Token',
    keyLabel: 'Access Token',
    modelLabel: 'App ID',
    modelPlaceholder: t('settings.tts.volcengineAppIdHint'),
  },
  {
    id: 'dashscope',
    providerId: 'dashscope-tts',
    name: t('settings.tts.presets.dashscope'),
    group: 'domestic',
    apiUrl: 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation',
    models: ['qwen3-tts-flash', 'qwen3-tts-instruct-flash'],
    defaultModel: 'qwen3-tts-flash',
    voices: [
      { id: 'Cherry', name: '芊悦 (Cherry)' }, { id: 'Ethan', name: '晨煦 (Ethan)' },
      { id: 'Nofish', name: '不吃鱼 (Nofish)' }, { id: 'Ryan', name: '甜茶 (Ryan)' },
      { id: 'Katerina', name: '卡捷琳娜 (Katerina)' }, { id: 'Elias', name: '墨讲师 (Elias)' },
    ],
    defaultVoice: 'Cherry',
    keyUrl: 'https://bailian.console.aliyun.com/?tab=model#/api-key',
    keyPlaceholder: 'sk-...',
  },
  {
    id: 'custom',
    providerId: 'openai-compat',
    name: t('settings.tts.presets.custom'),
    group: 'other',
    apiUrl: '', models: [], defaultModel: '',
    voices: [], defaultVoice: '',
    keyUrl: '', keyPlaceholder: '',
  },
]

const ttsEnabled = ref(false)
const ttsPresetId = ref('openai')
const ttsApiUrl = ref('')
const ttsApiKey = ref('')
const ttsModel = ref('')
const ttsVoice = ref('')
const ttsSpeed = ref(1.0)
const ttsAutoSpeak = ref(false)
const ttsIsTesting = ref(false)
const ttsTestError = ref('')
const ttsSaved = ref(false)
let ttsInitializing = true

const ttsSelectedPreset = computed(() =>
  ttsPresets.find(p => p.id === ttsPresetId.value) || ttsPresets[ttsPresets.length - 1]
)
const ttsIsCustom = computed(() => ttsPresetId.value === 'custom')
const ttsInternationalPresets = computed(() => ttsPresets.filter(p => p.group === 'international'))
const ttsDomesticPresets = computed(() => ttsPresets.filter(p => p.group === 'domestic'))
const ttsOtherPresets = computed(() => ttsPresets.filter(p => p.group === 'other'))
const ttsPresetOptions = computed(() => [
  ...ttsInternationalPresets.value.map(p => ({ value: p.id, label: p.name, group: t('settings.tts.groupInternational') })),
  ...ttsDomesticPresets.value.map(p => ({ value: p.id, label: p.name, group: t('settings.tts.groupDomestic') })),
  ...ttsOtherPresets.value.map(p => ({ value: p.id, label: p.name, group: t('settings.tts.groupOther') })),
])
const ttsModelOptions = computed(() => ttsSelectedPreset.value.models.map(m => ({ value: m, label: m })))
const ttsVoiceOptions = computed(() => ttsSelectedPreset.value.voices.map(v => ({ value: v.id, label: v.name })))

const ttsDirty = computed(() => {
  const s = configStore.ttsSettings
  return ttsPresetId.value !== (s.preset || 'openai')
    || ttsApiUrl.value !== s.apiUrl
    || ttsApiKey.value !== s.apiKey
    || ttsModel.value !== s.model
    || ttsVoice.value !== s.voice
    || ttsSpeed.value !== s.speed
})

const initTtsState = () => {
  ttsInitializing = true
  const s = configStore.ttsSettings
  ttsEnabled.value = s.enabled
  ttsPresetId.value = s.preset || 'openai'
  ttsApiUrl.value = s.apiUrl
  ttsApiKey.value = s.apiKey
  ttsModel.value = s.model
  ttsVoice.value = s.voice
  ttsSpeed.value = s.speed
  ttsAutoSpeak.value = s.autoSpeak
  ttsSaved.value = false
  nextTick(() => { ttsInitializing = false })
}

watch(ttsPresetId, (newId) => {
  if (ttsInitializing) return
  const preset = ttsPresets.find(p => p.id === newId)
  if (!preset || newId === 'custom') return
  ttsApiUrl.value = preset.apiUrl
  ttsModel.value = preset.defaultModel
  ttsVoice.value = preset.defaultVoice
  ttsSaved.value = false
})

watch(ttsEnabled, () => {
  if (ttsInitializing) return
  saveTtsToggles()
})

watch(ttsAutoSpeak, () => {
  if (ttsInitializing) return
  saveTtsToggles()
})

async function saveTtsToggles() {
  const s = configStore.ttsSettings
  await configStore.saveTtsSettings({
    ...s,
    enabled: ttsEnabled.value,
    autoSpeak: ttsAutoSpeak.value,
  })
}

async function saveTtsConfig() {
  await configStore.saveTtsSettings({
    enabled: ttsEnabled.value,
    providerId: ttsSelectedPreset.value.providerId,
    preset: ttsPresetId.value,
    apiUrl: ttsApiUrl.value,
    apiKey: ttsApiKey.value,
    model: ttsModel.value,
    voice: ttsVoice.value,
    speed: ttsSpeed.value,
    autoSpeak: ttsAutoSpeak.value,
  })
  ttsSaved.value = true
  setTimeout(() => { ttsSaved.value = false }, 2000)
}

function openTtsKeyUrl() {
  const url = ttsSelectedPreset.value.keyUrl
  if (url) window.open(url, '_blank')
}

async function testTts() {
  const text = t('settings.tts.defaultTestText')
  ttsIsTesting.value = true
  ttsTestError.value = ''
  try {
    await saveTtsConfig()
    const result = await window.electronAPI.tts.synthesize(text, {
      voice: ttsVoice.value,
      model: ttsModel.value,
      speed: ttsSpeed.value,
    })
    if (!result.success) {
      ttsTestError.value = result.error || t('settings.tts.testFailed')
      return
    }
    if (result.audio) {
      const ctx = new AudioContext()
      const buffer = await ctx.decodeAudioData(result.audio.slice(0))
      const source = ctx.createBufferSource()
      source.buffer = buffer
      source.connect(ctx.destination)
      source.start(0)
      source.onended = () => ctx.close()
    }
  } catch (err) {
    ttsTestError.value = err instanceof Error ? err.message : String(err)
  } finally {
    ttsIsTesting.value = false
  }
}

// ==================== 语音识别模型包（可选） ====================
// 安装状态在 useSpeechPackInstall 模块级共享：关闭设置页不中断下载

const {
  busy: speechPackBusy,
  error: speechPackError,
  progress: speechPackProgress,
  progressDetail: speechPackProgressDetail,
  status: speechPackStatus,
  urls: speechPackUrls,
  installSpeechPackOnline,
  importSpeechPack,
  uninstallSpeechPack,
  openSpeechPackUrl,
  formatSpeechPackBytes: formatBytes,
} = useSpeechPackInstall()

function scrollToSpeechPack() {
  document.getElementById('speech-pack-section')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

// ==================== Web 搜索 ====================

const webSearchEnabled = ref(false)
const webSearchProviderId = ref<WebSearchProviderId>('bocha')
const webSearchApiKeys = ref<Partial<Record<WebSearchProviderId, string>>>({})
const webSearchApiExtras = ref<Partial<Record<WebSearchProviderId, Record<string, string>>>>({})
const webSearchSaved = ref(false)
let webSearchInitializing = true

const webSearchProviderList = WEB_SEARCH_PROVIDERS
const webSearchProviderOptions = computed(() =>
  webSearchProviderList.map(p => ({ value: p.id, label: p.name }))
)
const webSearchSelectedProvider = computed(() =>
  WEB_SEARCH_PROVIDERS.find(p => p.id === webSearchProviderId.value)
)

const webSearchApiKey = computed({
  get: () => webSearchApiKeys.value[webSearchProviderId.value] || '',
  set: (v: string) => { webSearchApiKeys.value = { ...webSearchApiKeys.value, [webSearchProviderId.value]: v } },
})

function getWebSearchExtra(key: string): string {
  return webSearchApiExtras.value[webSearchProviderId.value]?.[key] || ''
}
function setWebSearchExtra(key: string, value: string) {
  const current = { ...(webSearchApiExtras.value[webSearchProviderId.value] || {}) }
  current[key] = value
  webSearchApiExtras.value = { ...webSearchApiExtras.value, [webSearchProviderId.value]: current }
}

const webSearchKeyUrls: Record<string, string> = {
  bocha: 'https://open.bochaai.com/api-keys',
  zhipu: 'https://open.bigmodel.cn/apikey/platform',
  kimi: 'https://platform.kimi.com/console/api-keys',
  jina: 'https://jina.ai/api-dashboard/key-manager',
  tavily: 'https://app.tavily.com/home',
  google: 'https://developers.google.com/custom-search/v1/introduction',
}
const webSearchKeyUrl = computed(() => webSearchKeyUrls[webSearchProviderId.value] || '')

const webSearchModelKeyHint = computed(() => {
  if (webSearchApiKey.value.trim()) return ''
  const reused = webSearchKeyFromModelProfiles(
    webSearchProviderId.value,
    configStore.aiProfiles,
    configStore.activeAiProfileId,
  )
  if (!reused) return ''
  return t(`settings.webSearch.useModelKey.${webSearchProviderId.value}`)
})

const webSearchDirty = computed(() => {
  const s = configStore.webSearchSettings
  return webSearchProviderId.value !== s.providerId
    || JSON.stringify(webSearchApiKeys.value) !== JSON.stringify(s.apiKeys || {})
    || JSON.stringify(webSearchApiExtras.value) !== JSON.stringify(s.apiExtras || {})
})

let webSearchApplied = ''

function applyWebSearchFromStore() {
  const s = configStore.webSearchSettings
  const next = JSON.stringify({
    enabled: !!s.enabled,
    providerId: s.providerId,
    apiKeys: s.apiKeys || {},
    apiExtras: s.apiExtras || {},
  })
  if (next === webSearchApplied) return
  webSearchApplied = next
  webSearchInitializing = true
  webSearchEnabled.value = s.enabled
  webSearchProviderId.value = s.providerId
  webSearchApiKeys.value = { ...(s.apiKeys || {}) }
  webSearchApiExtras.value = { ...(s.apiExtras || {}) }
  nextTick(() => { webSearchInitializing = false })
}

watch(() => configStore.webSearchSettings, () => {
  applyWebSearchFromStore()
}, { deep: true })

watch(webSearchEnabled, () => {
  if (webSearchInitializing) return
  saveWebSearchConfig()
})

async function saveWebSearchConfig() {
  await configStore.saveWebSearchSettings({
    enabled: webSearchEnabled.value,
    providerId: webSearchProviderId.value,
    apiKeys: { ...webSearchApiKeys.value },
    apiExtras: { ...webSearchApiExtras.value },
  })
  webSearchSaved.value = true
  setTimeout(() => { webSearchSaved.value = false }, 2000)
}

function openWebSearchKeyUrl() {
  const url = webSearchKeyUrl.value
  if (url) window.open(url, '_blank')
}
</script>

<template>
  <div class="voice-settings">
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.cueSounds.title') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="cueEnabled"
            @change="cueEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">{{ t('settings.cueSounds.description') }}</p>
      <div class="cue-sound-panel">
        <div class="cue-volume">
          <Volume2 :size="15" class="cue-volume-icon" />
          <div class="cue-volume-track">
            <span class="cue-volume-tick" aria-hidden="true" />
            <input
              type="range"
              min="0"
              :max="CUE_VOLUME_MAX * 100"
              :step="CUE_VOLUME_STEP * 100"
              class="cue-volume-slider"
              :style="{ '--fill': `${cueVolumePercent / CUE_VOLUME_MAX}%` }"
              :value="cueVolumePercent"
              :aria-label="t('settings.cueSounds.volume')"
              @input="onCueVolumeInput"
              @change="onCueVolumeCommit"
            />
          </div>
          <span class="cue-volume-value">{{ cueVolumePercent }}%</span>
        </div>
        <div class="cue-sound-list">
        <div v-for="kind in CUE_SOUND_KINDS" :key="kind" class="cue-sound-row">
          <div class="cue-sound-label">
            <span>{{ t(`settings.cueSounds.${kind}`) }}</span>
            <label class="toggle-switch toggle-switch-sm" :class="{ 'is-disabled': !cueEnabled }">
              <input
                type="checkbox"
                :checked="isKindOn(kind)"
                :disabled="!cueEnabled"
                @change="setKindOn(kind, ($event.target as HTMLInputElement).checked)"
              />
              <span class="toggle-slider"></span>
            </label>
            <span v-if="isCustomCue(kind)" class="form-hint">{{ t('settings.cueSounds.replaced') }}</span>
          </div>
          <div class="cue-sound-actions">
            <button type="button" class="btn btn-sm" @click="previewCue(kind)">
              <Play :size="12" />
              {{ t('settings.cueSounds.preview') }}
            </button>
            <button type="button" class="btn btn-sm" @click="replaceCue(kind)">
              <Upload :size="12" />
              {{ t('settings.cueSounds.replace') }}
            </button>
            <button
              type="button"
              class="btn btn-sm"
              :disabled="!isCustomCue(kind)"
              @click="resetCue(kind)"
            >
              <RotateCcw :size="12" />
              {{ t('settings.cueSounds.reset') }}
            </button>
          </div>
        </div>
        </div>
      </div>
      <p v-if="cueError" class="tts-error-msg">{{ cueError }}</p>
    </div>

    <!-- 语音合成（TTS） -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.tts.title') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="ttsEnabled"
            @change="ttsEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">{{ t('settings.tts.description') }}</p>

      <template v-if="ttsEnabled">
        <div class="tts-form-fields">
          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.provider') }}</label>
            <AppSelect v-model="ttsPresetId" :options="ttsPresetOptions" size="field" block />
          </div>

          <div v-if="ttsIsCustom" class="form-group">
            <label class="form-label">{{ t('settings.tts.apiUrl') }}</label>
            <input v-model="ttsApiUrl" type="text" class="input" placeholder="https://api.example.com/v1/audio/speech" />
            <span class="form-hint">{{ t('settings.tts.apiUrlHint') }}</span>
          </div>

          <div class="form-group">
            <div class="form-label-row">
              <label class="form-label">{{ ttsSelectedPreset.keyLabel || t('settings.tts.apiKey') }}</label>
              <button
                v-if="ttsSelectedPreset.keyUrl"
                class="get-key-btn"
                @click="openTtsKeyUrl"
              >
                <ExternalLink :size="12" />
                <span>{{ t('settings.tts.getKey') }}</span>
              </button>
            </div>
            <input v-model="ttsApiKey" type="password" class="input" :placeholder="ttsSelectedPreset.keyPlaceholder || 'API Key'" />
          </div>

          <div class="form-row">
            <div class="form-group flex-1">
              <label class="form-label">{{ ttsSelectedPreset.modelLabel || t('settings.tts.model') }}</label>
              <AppSelect v-if="ttsModelOptions.length > 0" v-model="ttsModel" :options="ttsModelOptions" size="field" block />
              <input v-else v-model="ttsModel" type="text" class="input" :placeholder="ttsSelectedPreset.modelPlaceholder || t('settings.tts.modelPlaceholder')" />
            </div>
            <div class="form-group flex-1">
              <label class="form-label">{{ t('settings.tts.voice') }}</label>
              <AppSelect v-if="ttsVoiceOptions.length > 0" v-model="ttsVoice" :options="ttsVoiceOptions" size="field" block />
              <input v-else v-model="ttsVoice" type="text" class="input" :placeholder="t('settings.tts.voicePlaceholder')" />
            </div>
          </div>

          <div class="form-group">
            <label class="form-label">{{ t('settings.tts.speed') }}: {{ ttsSpeed.toFixed(1) }}x</label>
            <input v-model.number="ttsSpeed" type="range" min="0.5" max="2.0" step="0.1" class="tts-range-slider" />
          </div>

          <div class="form-group tts-auto-speak">
            <label class="toggle-switch toggle-switch-sm">
              <input
                type="checkbox"
                :checked="ttsAutoSpeak"
                @change="ttsAutoSpeak = ($event.target as HTMLInputElement).checked"
              />
              <span class="toggle-slider"></span>
            </label>
            <div>
              <span class="tts-auto-speak-label">{{ t('settings.tts.autoSpeak') }}</span>
              <span class="form-hint">{{ t('settings.tts.autoSpeakHint') }}</span>
            </div>
          </div>

          <div class="form-group">
            <div class="tts-test-row">
              <button
                class="btn btn-primary btn-sm"
                :disabled="ttsIsTesting || !ttsApiKey"
                @click="testTts"
              >
                {{ ttsIsTesting ? t('settings.tts.testing') : t('settings.tts.testPlay') }}
              </button>
              <button
                class="btn btn-sm"
                :class="ttsSaved ? 'btn-success' : 'btn-save'"
                :disabled="!ttsDirty && !ttsSaved"
                @click="saveTtsConfig"
              >
                {{ ttsSaved ? t('settings.tts.saved') : t('settings.tts.save') }}
              </button>
              <span v-if="ttsDirty" class="form-hint tts-dirty-hint">{{ t('settings.tts.unsaved') }}</span>
            </div>
            <div v-if="ttsTestError" class="tts-error-msg">{{ ttsTestError }}</div>
          </div>
        </div>
      </template>
    </div>

    <!-- 语音识别模型（可选按需安装） -->
    <div id="speech-pack-section" class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.speechPack.title') }}</h4>
      </div>
      <p class="section-desc">{{ t('settings.speechPack.description') }}</p>

      <div class="speech-pack-row">
        <div class="speech-pack-status" :class="{ ready: speechPackStatus?.available }">
          <span class="speech-pack-dot" />
          <span v-if="speechPackStatus?.available">
            {{ t('settings.speechPack.installed', {
              version: speechPackStatus.packVersion || speechPackStatus.recommendedVersion,
              size: formatBytes(speechPackStatus.approxSizeBytes),
            }) }}
            <template v-if="speechPackStatus.source === 'bundled'"> · {{ t('settings.speechPack.sourceBundled') }}</template>
          </span>
          <span v-else>
            {{ t('settings.speechPack.notInstalled', {
              size: formatBytes(speechPackStatus?.approxSizeBytes || 305000000),
            }) }}
          </span>
        </div>

        <div class="speech-pack-actions">
          <template v-if="!speechPackStatus?.available">
            <button
              type="button"
              class="btn btn-primary btn-sm"
              :disabled="speechPackBusy"
              @click="installSpeechPackOnline"
            >
              {{ speechPackBusy ? t('settings.speechPack.installing') : t('settings.speechPack.installOnline') }}
            </button>
            <button
              type="button"
              class="btn btn-secondary btn-sm"
              :disabled="speechPackBusy"
              @click="importSpeechPack"
            >
              {{ t('settings.speechPack.importLocal') }}
            </button>
          </template>
          <button
            v-else
            type="button"
            class="btn btn-secondary btn-sm"
            :disabled="speechPackBusy"
            @click="uninstallSpeechPack"
          >
            {{ t('settings.speechPack.uninstall') }}
          </button>
        </div>
      </div>

      <div v-if="speechPackBusy" class="speech-pack-progress-wrap">
        <div class="speech-pack-progress">
          <div class="speech-pack-progress-bar" :style="{ width: `${speechPackProgress.percent}%` }" />
        </div>
        <span class="form-hint">{{ speechPackProgress.message || t('settings.speechPack.working') }}</span>
        <span v-if="speechPackProgressDetail" class="form-hint speech-pack-progress-detail">{{ speechPackProgressDetail }}</span>
      </div>

      <div v-if="!speechPackStatus?.available" class="speech-pack-offline">
        <span class="form-hint">{{ t('settings.speechPack.offlineLinks') }}</span>
        <button type="button" class="get-key-btn" :disabled="!speechPackUrls" @click="openSpeechPackUrl('oss')">
          <ExternalLink :size="12" />
          <span>{{ t('settings.speechPack.linkOss') }}</span>
        </button>
        <button type="button" class="get-key-btn" :disabled="!speechPackUrls" @click="openSpeechPackUrl('github')">
          <ExternalLink :size="12" />
          <span>{{ t('settings.speechPack.linkGithub') }}</span>
        </button>
      </div>

      <div v-if="speechPackError" class="tts-error-msg">{{ speechPackError }}</div>
    </div>

    <!-- Web 搜索 -->
    <div class="settings-section">
      <div class="section-header">
        <h4>{{ t('settings.webSearch.title') }}</h4>
        <label class="toggle-switch">
          <input
            type="checkbox"
            :checked="webSearchEnabled"
            @change="webSearchEnabled = ($event.target as HTMLInputElement).checked"
          />
          <span class="toggle-slider"></span>
        </label>
      </div>
      <p class="section-desc">{{ t('settings.webSearch.description') }}</p>

      <template v-if="webSearchEnabled">
        <div class="websearch-form-fields">
          <div class="form-group">
            <label class="form-label">{{ t('settings.webSearch.provider') }}</label>
            <AppSelect v-model="webSearchProviderId" :options="webSearchProviderOptions" size="field" block />
            <span class="form-hint">{{ t(`settings.webSearch.providers.${webSearchProviderId}`) }}</span>
          </div>

          <div v-if="webSearchSelectedProvider?.requiresApiKey" class="form-group">
            <div class="form-label-row">
              <label class="form-label">API Key</label>
              <button
                v-if="webSearchKeyUrl"
                class="get-key-btn"
                @click="openWebSearchKeyUrl"
              >
                <ExternalLink :size="12" />
                <span>{{ t('settings.webSearch.getKey') }}</span>
              </button>
            </div>
            <input v-model="webSearchApiKey" type="password" class="input" placeholder="API Key" />
            <span v-if="webSearchModelKeyHint" class="form-hint">{{ webSearchModelKeyHint }}</span>
          </div>

          <div
            v-for="field in webSearchSelectedProvider?.extraFields || []"
            :key="field.key"
            class="form-group"
          >
            <label class="form-label">{{ t(`settings.webSearch.fields.${field.key}`) }}</label>
            <AppSelect
              v-if="field.options?.length"
              size="field"
              block
              :model-value="getWebSearchExtra(field.key) || field.defaultValue || ''"
              :options="field.options.map(opt => ({ value: opt.value, label: t(`settings.webSearch.options.${opt.value}`) }))"
              @update:model-value="setWebSearchExtra(field.key, $event)"
            />
            <input
              v-else
              :value="getWebSearchExtra(field.key)"
              type="text"
              class="input"
              :placeholder="t(`settings.webSearch.placeholders.${field.key}`)"
              @input="setWebSearchExtra(field.key, ($event.target as HTMLInputElement).value)"
            />
          </div>

          <div class="form-group">
            <button
              class="btn btn-sm"
              :class="webSearchSaved ? 'btn-success' : 'btn-save'"
              :disabled="!webSearchDirty && !webSearchSaved"
              @click="saveWebSearchConfig"
            >
              {{ webSearchSaved ? t('settings.webSearch.saved') : t('settings.webSearch.save') }}
            </button>
            <span v-if="webSearchDirty" class="form-hint websearch-dirty-hint">{{ t('settings.webSearch.unsaved') }}</span>
          </div>
        </div>
      </template>
    </div>
  </div>
</template>

<style scoped>
.voice-settings {
  display: flex;
  flex-direction: column;
  gap: 20px;
}


.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  min-height: 28px;
  margin-bottom: 8px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
  line-height: 1.5;
}

.form-label {
  display: block;
  margin-bottom: 6px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-primary);
}

.input {
  padding: 8px 12px;
  font-size: 13px;
  background: var(--bg-secondary);
  border-radius: 6px;
}

.form-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.get-key-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  font-size: 11px;
  color: var(--text-primary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.get-key-btn:hover {
  background: var(--bg-hover);
}

.form-row {
  display: flex;
  gap: 12px;
}

.flex-1 {
  flex: 1;
}

.form-hint {
  display: block;
  margin-top: 4px;
  font-size: 11px;
  color: var(--text-muted);
}

/* 开关基础样式走 main.css 的 .settings-scope 规范；
   本页仅保留 -sm / is-disabled 两个页面自有的修饰变体（见下方） */

/* 语音包 */
.speech-pack-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 10px;
  flex-wrap: wrap;
}
.speech-pack-status {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-secondary);
}
.speech-pack-status.ready {
  color: var(--text-primary);
}
.speech-pack-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--text-muted);
  flex-shrink: 0;
}
.speech-pack-status.ready .speech-pack-dot {
  background: var(--accent-success, #3ecf8e);
}
.speech-pack-actions {
  display: flex;
  gap: 8px;
  flex-wrap: wrap;
}
.speech-pack-progress-wrap {
  margin-top: 10px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.speech-pack-progress {
  height: 6px;
  background: var(--bg-tertiary);
  border-radius: 3px;
  overflow: hidden;
}
.speech-pack-progress-bar {
  height: 100%;
  background: var(--accent-primary, #4a9eff);
  transition: width 0.2s ease;
}
.speech-pack-offline {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
  flex-wrap: wrap;
}

/* TTS 表单 */
.cue-sound-panel {
  margin-top: 4px;
  padding: 12px 14px 6px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
}

.cue-volume {
  display: flex;
  align-items: center;
  gap: 10px;
  padding-bottom: 12px;
  margin-bottom: 2px;
  border-bottom: 1px solid var(--border-color);
}

.cue-volume-icon {
  flex-shrink: 0;
  color: var(--text-muted);
}

.cue-volume-track {
  position: relative;
  flex: 1;
  min-width: 0;
  height: 18px;
  display: flex;
  align-items: center;
}

.cue-volume-tick {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 1px;
  height: 8px;
  margin-top: -4px;
  background: var(--text-muted);
  opacity: 0.45;
  pointer-events: none;
}

.cue-volume-slider {
  -webkit-appearance: none;
  appearance: none;
  width: 100%;
  height: 3px;
  margin: 0;
  border-radius: 999px;
  background: linear-gradient(
    to right,
    var(--accent-primary) 0%,
    var(--accent-primary) var(--fill, 50%),
    color-mix(in srgb, var(--text-muted) 28%, transparent) var(--fill, 50%),
    color-mix(in srgb, var(--text-muted) 28%, transparent) 100%
  );
  outline: none;
  cursor: pointer;
}

.cue-volume-slider::-webkit-slider-thumb {
  -webkit-appearance: none;
  appearance: none;
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-primary);
  border: 2px solid var(--bg-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-muted) 35%, transparent);
}

.cue-volume-slider::-moz-range-thumb {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background: var(--text-primary);
  border: 2px solid var(--bg-primary);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--text-muted) 35%, transparent);
}

.cue-volume-slider::-moz-range-track {
  height: 3px;
  background: transparent;
  border: none;
}

.cue-volume-value {
  flex-shrink: 0;
  min-width: 3.2em;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--text-muted);
  text-align: right;
  letter-spacing: 0.01em;
}

.cue-sound-list {
  display: flex;
  flex-direction: column;
}

.cue-sound-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  flex-wrap: wrap;
  padding: 10px 0;
}

.cue-sound-row + .cue-sound-row {
  border-top: 1px solid color-mix(in srgb, var(--border-color) 70%, transparent);
}

.cue-sound-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--text-primary);
}

.cue-sound-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cue-sound-actions .btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}

.tts-form-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 4px;
}

.tts-form-fields .form-group {
  margin-bottom: 0;
}

.tts-range-slider {
  width: 100%;
  accent-color: var(--accent-primary);
}

.tts-auto-speak {
  flex-direction: row !important;
  align-items: center;
  gap: 10px;
}

.tts-auto-speak-label {
  font-size: 13px;
  color: var(--text-primary);
}

.toggle-switch-sm {
  width: 36px;
  height: 20px;
  flex-shrink: 0;
}

.toggle-switch.is-disabled {
  opacity: 0.45;
}

.toggle-switch-sm .toggle-slider:before {
  height: 14px;
  width: 14px;
  left: 2px;
  bottom: 2px;
}

.toggle-switch-sm input:checked + .toggle-slider:before {
  transform: translateX(16px);
}

.tts-test-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.btn-save {
  background: var(--accent-primary, #4a9eff);
  color: white;
  border-color: transparent;
}

.btn-save:hover:not(:disabled) {
  background: var(--accent-primary, #4a9eff);
  filter: brightness(1.1);
}

.btn-save:disabled {
  opacity: 0.4;
}

.btn-success {
  background: var(--color-success);
  color: white;
  border-color: transparent;
}

.btn-success:hover:not(:disabled) {
  background: var(--color-success);
  filter: brightness(1.1);
}

.tts-dirty-hint {
  color: var(--accent-primary, #4a9eff) !important;
}

.tts-error-msg {
  margin-top: 6px;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-error);
  background: rgba(var(--color-error-rgb), 0.1);
  border-radius: 6px;
}

/* Web 搜索 */
.websearch-form-fields {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 4px;
}

.websearch-form-fields .form-group {
  margin-bottom: 0;
}

.websearch-dirty-hint {
  color: var(--accent-primary, #4a9eff) !important;
}
</style>
