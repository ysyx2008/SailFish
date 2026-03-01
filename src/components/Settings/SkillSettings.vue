<script setup lang="ts">
import { ref, onMounted, onUnmounted, computed, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { RefreshCw, FolderOpen, Eye, X, Download, Trash2, ArrowUpCircle, Search, Star } from 'lucide-vue-next'

const props = defineProps<{
  pendingInstallSkillId?: string
}>()

const { t, locale } = useI18n()

interface BuiltinSkill {
  id: string
  name: string
  description: string
  enabled: boolean
}

interface UserSkill {
  id: string
  name: string
  description: string
  version?: string
  enabled: boolean
  content: string
  filePath: string
  lastModified: number
}

interface MarketSkillItem {
  id: string
  name: string
  description: string
  version: string
  author: string
  category?: string
  tags?: string[]
  featured?: boolean
  installed: boolean
  installedVersion?: string
  hasUpdate: boolean
}

interface SkillCategory {
  id: string
  name: string
  nameEn: string
  icon: string
}

type SubTab = 'my' | 'market'
const activeSubTab = ref<SubTab>('my')

// 内置技能
const builtinSkills = ref<BuiltinSkill[]>([])

// 我的技能
const skills = ref<UserSkill[]>([])
const loading = ref(false)
const skillsDir = ref('')

// 技能市场
const marketSkills = ref<MarketSkillItem[]>([])
const categories = ref<SkillCategory[]>([])
const marketLoading = ref(false)
const marketError = ref('')
const searchQuery = ref('')
const activeCategory = ref('all')
const operatingSkills = ref<Set<string>>(new Set())

// Registry URL
const registryUrl = ref('')
const registryUrlEditing = ref(false)
const registryUrlInput = ref('')

// 预览弹窗（我的技能）
const showPreview = ref(false)
const previewSkill = ref<UserSkill | null>(null)
const previewContent = ref('')

// 市场技能详情弹窗
const showDetail = ref(false)
const detailSkill = ref<MarketSkillItem | null>(null)
const detailContent = ref('')
const detailLoading = ref(false)

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    if (showDetail.value) {
      e.stopImmediatePropagation()
      showDetail.value = false
      detailSkill.value = null
    } else if (showPreview.value) {
      e.stopImmediatePropagation()
      showPreview.value = false
      previewSkill.value = null
    }
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})

const enabledCount = computed(() =>
  builtinSkills.value.filter(s => s.enabled).length +
  skills.value.filter(s => s.enabled).length
)

const featuredSkills = computed(() => marketSkills.value.filter(s => s.featured))

const filteredSkills = computed(() => {
  let list = marketSkills.value

  if (activeCategory.value !== 'all') {
    list = list.filter(s => s.category === activeCategory.value)
  }

  if (searchQuery.value.trim()) {
    const q = searchQuery.value.toLowerCase()
    list = list.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.tags?.some(t => t.toLowerCase().includes(q))
    )
  }

  return list
})

const categoryLabel = (cat: SkillCategory) =>
  locale.value.startsWith('zh') ? cat.name : cat.nameEn

const categoryCount = (catId: string) =>
  marketSkills.value.filter(s => s.category === catId).length

// ========== 内置技能 ==========

const loadBuiltinSkills = async () => {
  try {
    builtinSkills.value = await window.electronAPI.builtinSkill.list()
  } catch (error) {
    console.error('Failed to load builtin skills:', error)
  }
}

const toggleBuiltinSkill = async (skill: BuiltinSkill) => {
  const newEnabled = !skill.enabled
  try {
    const success = await window.electronAPI.builtinSkill.toggle(skill.id, newEnabled)
    if (success) {
      skill.enabled = newEnabled
    }
  } catch (error) {
    console.error('Failed to toggle builtin skill:', error)
  }
}

// ========== 我的技能 ==========

const loadSkills = async () => {
  loading.value = true
  try {
    skills.value = await window.electronAPI.userSkill.list()
    skillsDir.value = await window.electronAPI.userSkill.getSkillsDir()
  } catch (error) {
    console.error('Failed to load skills:', error)
  } finally {
    loading.value = false
  }
}

const refreshSkills = async () => {
  loading.value = true
  try {
    skills.value = await window.electronAPI.userSkill.refresh()
  } catch (error) {
    console.error('Failed to refresh skills:', error)
  } finally {
    loading.value = false
  }
}

const toggleSkill = async (skill: UserSkill) => {
  const newEnabled = !skill.enabled
  const success = await window.electronAPI.userSkill.toggle(skill.id, newEnabled)
  if (success) {
    skill.enabled = newEnabled
  }
}

const openFolder = async () => {
  await window.electronAPI.userSkill.openFolder()
}

const viewSkill = async (skill: UserSkill) => {
  previewSkill.value = skill
  try {
    const content = await window.electronAPI.userSkill.getContent(skill.id)
    previewContent.value = content || skill.content
  } catch {
    previewContent.value = skill.content
  }
  showPreview.value = true
}

const closePreview = () => {
  showPreview.value = false
  previewSkill.value = null
  previewContent.value = ''
}

const formatTime = (timestamp: number) => new Date(timestamp).toLocaleString()

// ========== 技能市场 ==========

const loadMarketSkills = async (force = false) => {
  marketLoading.value = true
  marketError.value = ''
  try {
    marketSkills.value = await window.electronAPI.skillMarket.list(force)
    const registry = await window.electronAPI.skillMarket.fetchRegistry(force)
    if (registry.categories) {
      categories.value = registry.categories
    }
  } catch (error: any) {
    marketError.value = error.message || 'Unknown error'
    console.error('Failed to load market:', error)
  } finally {
    marketLoading.value = false
  }
}

const viewMarketSkill = async (skill: MarketSkillItem) => {
  detailSkill.value = skill
  detailContent.value = ''
  detailLoading.value = true
  showDetail.value = true

  // 如果已安装，从本地读取内容
  if (skill.installed) {
    try {
      const content = await window.electronAPI.userSkill.getContent(skill.id)
      if (content) {
        detailContent.value = content
        detailLoading.value = false
        return
      }
    } catch (e) {
      console.warn('Failed to load installed skill content:', e)
    }
  }

  detailLoading.value = false
}

const closeDetail = () => {
  showDetail.value = false
  detailSkill.value = null
  detailContent.value = ''
}

const installSkill = async (skill: MarketSkillItem) => {
  operatingSkills.value.add(skill.id)
  try {
    const result = await window.electronAPI.skillMarket.install(skill.id)
    if (result.success) {
      skill.installed = true
      skill.installedVersion = skill.version
      skill.hasUpdate = false
      await loadSkills()
    } else {
      alert(`${t('skillSettings.installFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.installFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

/** 从「我的技能」中移除/卸载技能（删除本地文件） */
const removeUserSkill = async (skill: UserSkill) => {
  if (!confirm(`${t('skillSettings.uninstall')} "${skill.name}"?`)) return
  try {
    const result = await window.electronAPI.skillMarket.uninstall(skill.id)
    if (result.success) {
      await loadSkills()
    } else {
      alert(`${t('skillSettings.uninstallFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.uninstallFailed')}: ${error.message}`)
  }
}

const uninstallSkill = async (skill: MarketSkillItem) => {
  if (!confirm(`${t('skillSettings.uninstall')} "${skill.name}"?`)) return
  operatingSkills.value.add(skill.id)
  try {
    const result = await window.electronAPI.skillMarket.uninstall(skill.id)
    if (result.success) {
      skill.installed = false
      skill.installedVersion = undefined
      skill.hasUpdate = false
      await loadSkills()
    } else {
      alert(`${t('skillSettings.uninstallFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.uninstallFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

const updateSkill = async (skill: MarketSkillItem) => {
  operatingSkills.value.add(skill.id)
  try {
    const result = await window.electronAPI.skillMarket.update(skill.id)
    if (result.success) {
      skill.installedVersion = skill.version
      skill.hasUpdate = false
      await loadSkills()
    } else {
      alert(`${t('skillSettings.updateFailed')}: ${result.error}`)
    }
  } catch (error: any) {
    alert(`${t('skillSettings.updateFailed')}: ${error.message}`)
  } finally {
    operatingSkills.value.delete(skill.id)
  }
}

const loadRegistryUrl = async () => {
  try {
    registryUrl.value = await window.electronAPI.skillMarket.getRegistryUrl()
    registryUrlInput.value = registryUrl.value
  } catch (e) {
    console.warn('Failed to load registry URL:', e)
  }
}

const saveRegistryUrl = async () => {
  try {
    await window.electronAPI.skillMarket.setRegistryUrl(registryUrlInput.value)
    registryUrl.value = registryUrlInput.value
    registryUrlEditing.value = false
    loadMarketSkills(true)
  } catch (error: any) {
    alert('Failed to save: ' + error.message)
  }
}

const switchTab = (tab: SubTab) => {
  activeSubTab.value = tab
  if (tab === 'market' && marketSkills.value.length === 0 && !marketLoading.value) {
    loadMarketSkills()
    loadRegistryUrl()
  }
}

const handlePendingInstall = async (skillId: string) => {
  activeSubTab.value = 'market'
  if (marketSkills.value.length === 0) {
    await Promise.all([loadMarketSkills(), loadRegistryUrl()])
  }
  const skill = marketSkills.value.find(s => s.id === skillId)
  if (!skill) return
  if (skill.installed) return
  await installSkill(skill)
}

onMounted(() => {
  loadBuiltinSkills()
  loadSkills()
})

watch(() => props.pendingInstallSkillId, (newId) => {
  if (newId) {
    handlePendingInstall(newId)
  }
}, { immediate: true })
</script>

<template>
  <div class="skill-settings">
    <!-- 子标签切换 -->
    <div class="sub-tabs">
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'my' }"
        @click="switchTab('my')"
      >
        🧩 {{ t('skillSettings.mySkills') }}
        <span class="tab-badge" v-if="enabledCount > 0">{{ enabledCount }}</span>
      </button>
      <button
        class="sub-tab"
        :class="{ active: activeSubTab === 'market' }"
        @click="switchTab('market')"
      >
        🏪 {{ t('skillSettings.market') }}
      </button>
    </div>

    <!-- ========== 我的技能 ========== -->
    <div v-if="activeSubTab === 'my'" class="my-skills-panel">
      <!-- 内置技能 -->
      <div class="settings-section" v-if="builtinSkills.length > 0">
        <div class="section-header">
          <div class="header-left">
            <h4>{{ t('skillSettings.builtinSkills') }}</h4>
          </div>
        </div>
        <p class="section-desc">{{ t('skillSettings.builtinSkillsDesc') }}</p>
        <div class="skill-list">
          <div
            v-for="skill in builtinSkills"
            :key="'builtin-' + skill.id"
            class="skill-item"
            :class="{ disabled: !skill.enabled }"
          >
            <div class="skill-toggle">
              <input
                type="checkbox"
                :checked="skill.enabled"
                @change="toggleBuiltinSkill(skill)"
                :title="t('skillSettings.toggleEnable')"
              />
            </div>
            <div class="skill-info">
              <div class="skill-name">{{ t(`skillSettings.builtinSkillNames.${skill.id}`, skill.name) }}</div>
              <div class="skill-desc" v-if="skill.description" :title="t(`skillSettings.builtinSkillDescs.${skill.id}`, skill.description)">{{ t(`skillSettings.builtinSkillDescs.${skill.id}`, skill.description) }}</div>
            </div>
          </div>
        </div>
      </div>

      <!-- 扩展技能 -->
      <div class="settings-section">
        <div class="section-header">
          <div class="header-left">
            <h4>{{ t('skillSettings.extensionSkills') }}</h4>
            <span class="enabled-badge" v-if="skills.filter(s => s.enabled).length > 0">
              {{ skills.filter(s => s.enabled).length }} {{ t('skillSettings.enabled') }}
            </span>
          </div>
          <div class="header-actions">
            <button class="btn btn-sm" @click="refreshSkills" :disabled="loading" :title="t('skillSettings.refresh')">
              <RefreshCw :size="14" :class="{ spinning: loading }" />
            </button>
            <button class="btn btn-primary btn-sm" @click="openFolder">
              <FolderOpen :size="14" />
              {{ t('skillSettings.openFolder') }}
            </button>
          </div>
        </div>
        <p class="section-desc">{{ t('skillSettings.extensionSkillsDesc') }}</p>

        <div class="skill-list">
          <div
            v-for="skill in skills"
            :key="skill.id"
            class="skill-item"
            :class="{ disabled: !skill.enabled }"
          >
            <div class="skill-toggle">
              <input
                type="checkbox"
                :checked="skill.enabled"
                @change="toggleSkill(skill)"
                :title="t('skillSettings.toggleEnable')"
              />
            </div>
            <div class="skill-info">
              <div class="skill-name">
                {{ skill.name }}
                <span class="skill-version" v-if="skill.version">v{{ skill.version }}</span>
              </div>
              <div class="skill-desc" v-if="skill.description" :title="skill.description">{{ skill.description }}</div>
            </div>
            <div class="skill-actions">
              <button class="btn-icon btn-sm" @click="viewSkill(skill)" :title="t('skillSettings.view')">
                <Eye :size="14" />
              </button>
              <button class="btn-icon btn-sm btn-danger-ghost" @click.stop="removeUserSkill(skill)" :title="t('skillSettings.uninstall')">
                <Trash2 :size="14" />
              </button>
            </div>
          </div>

          <div v-if="skills.length === 0 && !loading" class="empty-state">
            <div class="empty-icon">📁</div>
            <p>{{ t('skillSettings.noSkills') }}</p>
            <p class="tip">{{ t('skillSettings.noSkillsTip') }}</p>
            <button class="btn btn-outline btn-sm" @click="openFolder">{{ t('skillSettings.openFolder') }}</button>
          </div>

          <div v-if="loading && skills.length === 0" class="loading-state">
            <div class="spinner"></div>
            <p>{{ t('skillSettings.loading') }}</p>
          </div>
        </div>

        <div class="help-section">
          <h5>{{ t('skillSettings.howToAdd') }}</h5>
          <ol class="help-list">
            <li>{{ t('skillSettings.step1') }}</li>
            <li>{{ t('skillSettings.step2') }}</li>
            <li>{{ t('skillSettings.step3') }}</li>
          </ol>
          <div class="skill-format">
            <h6>{{ t('skillSettings.formatTitle') }}</h6>
            <pre class="format-example">---
name: {{ t('skillSettings.exampleName') }}
description: {{ t('skillSettings.exampleDesc') }}
version: 1.0
enabled: true
---

{{ t('skillSettings.exampleContent') }}</pre>
          </div>
        </div>
      </div>
    </div>

    <!-- ========== 技能市场 ========== -->
    <div v-if="activeSubTab === 'market'" class="settings-section">
      <div class="section-header">
        <div class="header-left">
          <h4>{{ t('skillSettings.market') }}</h4>
          <span class="count-badge" v-if="marketSkills.length > 0">{{ marketSkills.length }}</span>
        </div>
        <div class="header-actions">
          <button class="btn btn-sm" @click="loadMarketSkills(true)" :disabled="marketLoading" :title="t('skillSettings.refresh')">
            <RefreshCw :size="14" :class="{ spinning: marketLoading }" />
          </button>
        </div>
      </div>
      <p class="section-desc">{{ t('skillSettings.marketDesc') }}</p>

      <!-- 搜索栏 -->
      <div class="search-bar">
        <Search :size="14" class="search-icon" />
        <input
          v-model="searchQuery"
          type="text"
          :placeholder="t('skillSettings.searchPlaceholder')"
          class="search-input"
        />
      </div>

      <!-- 分类筛选条 -->
      <div class="category-bar" v-if="categories.length > 0 && !searchQuery.trim()">
        <button
          class="category-chip"
          :class="{ active: activeCategory === 'all' }"
          @click="activeCategory = 'all'"
        >
          {{ t('skillSettings.allCategories') }}
          <span class="chip-count">{{ marketSkills.length }}</span>
        </button>
        <button
          v-for="cat in categories"
          :key="cat.id"
          class="category-chip"
          :class="{ active: activeCategory === cat.id }"
          @click="activeCategory = cat.id"
        >
          <span class="chip-icon">{{ cat.icon }}</span>
          {{ categoryLabel(cat) }}
          <span class="chip-count">{{ categoryCount(cat.id) }}</span>
        </button>
      </div>

      <div class="market-content">
        <!-- 加载中 -->
        <div v-if="marketLoading && marketSkills.length === 0" class="loading-state">
          <div class="spinner"></div>
          <p>{{ t('skillSettings.marketLoading') }}</p>
        </div>

        <!-- 错误 -->
        <div v-else-if="marketError && marketSkills.length === 0" class="empty-state">
          <div class="empty-icon">⚠️</div>
          <p>{{ t('skillSettings.marketError') }}</p>
          <p class="tip">{{ marketError }}</p>
          <button class="btn btn-outline btn-sm" @click="loadMarketSkills(true)">{{ t('skillSettings.marketRetry') }}</button>
        </div>

        <!-- 空状态 -->
        <div v-else-if="marketSkills.length === 0 && !marketLoading" class="empty-state">
          <div class="empty-icon">🏪</div>
          <p>{{ t('skillSettings.marketEmpty') }}</p>
          <p class="tip">{{ t('skillSettings.marketEmptyTip') }}</p>
        </div>

        <template v-else>
          <!-- 精选推荐 -->
          <div v-if="featuredSkills.length > 0 && activeCategory === 'all' && !searchQuery.trim()" class="featured-section">
            <h5 class="featured-title">
              <Star :size="14" />
              {{ t('skillSettings.featuredTitle') }}
            </h5>
            <div class="featured-grid">
              <div
                v-for="skill in featuredSkills"
                :key="'f-' + skill.id"
                class="featured-card"
                @click="viewMarketSkill(skill)"
              >
                <div class="featured-card-header">
                  <span class="skill-name">{{ skill.name }}</span>
                  <span class="skill-version">v{{ skill.version }}</span>
                </div>
                <div class="featured-card-desc">{{ skill.description }}</div>
                <div class="featured-card-footer">
                  <span class="meta-item">{{ t('skillSettings.by') }} {{ skill.author }}</span>
                  <template v-if="operatingSkills.has(skill.id)">
                    <RefreshCw :size="12" class="spinning" />
                  </template>
                  <template v-else-if="skill.installed && !skill.hasUpdate">
                    <span class="installed-label">✓</span>
                  </template>
                  <template v-else-if="skill.hasUpdate">
                    <button class="btn btn-accent btn-xs" @click.stop="updateSkill(skill)">{{ t('skillSettings.updateBtn') }}</button>
                  </template>
                  <template v-else>
                    <button class="btn btn-primary btn-xs" @click.stop="installSkill(skill)">
                      <Download :size="12" />
                      {{ t('skillSettings.install') }}
                    </button>
                  </template>
                </div>
              </div>
            </div>
          </div>

          <!-- 技能列表 -->
          <div class="skill-list market-list">
            <div
              v-for="skill in filteredSkills"
              :key="skill.id"
              class="market-item"
              @click="viewMarketSkill(skill)"
            >
              <div class="market-item-body">
                <div class="market-item-header">
                  <span class="skill-name">{{ skill.name }}</span>
                  <span class="skill-version">v{{ skill.version }}</span>
                  <span v-if="skill.hasUpdate" class="update-badge">{{ t('skillSettings.updateAvailable') }}</span>
                </div>
                <div class="skill-desc" v-if="skill.description" :title="skill.description">{{ skill.description }}</div>
                <div class="market-item-meta">
                  <span class="meta-item">{{ t('skillSettings.by') }} {{ skill.author }}</span>
                  <span v-if="skill.category" class="meta-item tag">{{ skill.category }}</span>
                  <span v-for="tag in (skill.tags || []).slice(0, 3)" :key="tag" class="meta-item tag">{{ tag }}</span>
                </div>
              </div>
              <div class="market-item-actions" @click.stop>
                <template v-if="operatingSkills.has(skill.id)">
                  <button class="btn btn-sm" disabled>
                    <RefreshCw :size="14" class="spinning" />
                  </button>
                </template>
                <template v-else-if="skill.hasUpdate">
                  <button class="btn btn-accent btn-sm" @click="updateSkill(skill)">
                    <ArrowUpCircle :size="14" />
                    {{ t('skillSettings.updateBtn') }}
                  </button>
                  <button class="btn btn-danger-ghost btn-sm" @click="uninstallSkill(skill)" :title="t('skillSettings.uninstall')">
                    <Trash2 :size="14" />
                  </button>
                </template>
                <template v-else-if="skill.installed">
                  <span class="installed-label">{{ t('skillSettings.installed') }}</span>
                  <button class="btn btn-danger-ghost btn-sm" @click="uninstallSkill(skill)" :title="t('skillSettings.uninstall')">
                    <Trash2 :size="14" />
                  </button>
                </template>
                <template v-else>
                  <button class="btn btn-primary btn-sm" @click="installSkill(skill)">
                    <Download :size="14" />
                    {{ t('skillSettings.install') }}
                  </button>
                </template>
              </div>
            </div>

            <div v-if="filteredSkills.length === 0 && !marketLoading" class="empty-state compact">
              <p>{{ t('skillSettings.marketEmpty') }}</p>
            </div>
          </div>
        </template>
      </div>

      <!-- Registry URL -->
      <div class="registry-section">
        <h5>{{ t('skillSettings.registryUrl') }}</h5>
        <div class="registry-url-row">
          <input
            v-model="registryUrlInput"
            type="text"
            class="registry-input"
            :placeholder="t('skillSettings.registryUrlPlaceholder')"
            @focus="registryUrlEditing = true"
          />
          <button
            v-if="registryUrlEditing && registryUrlInput !== registryUrl"
            class="btn btn-primary btn-sm"
            @click="saveRegistryUrl"
          >
            {{ t('skillSettings.registrySave') }}
          </button>
        </div>
        <p class="tip">{{ t('skillSettings.registryUrlTip') }}</p>
      </div>
    </div>

    <!-- 预览弹窗（我的技能） -->
    <div v-if="showPreview && previewSkill" class="modal-overlay" @click.self="closePreview">
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title">
            <h4>{{ previewSkill.name }}</h4>
            <span class="preview-version" v-if="previewSkill.version">v{{ previewSkill.version }}</span>
          </div>
          <button class="btn-icon" @click="closePreview"><X :size="16" /></button>
        </div>
        <div class="modal-meta">
          <span v-if="previewSkill.description">{{ previewSkill.description }}</span>
          <span class="preview-time">{{ t('skillSettings.lastModified') }}: {{ formatTime(previewSkill.lastModified) }}</span>
        </div>
        <div class="modal-body">
          <pre>{{ previewContent }}</pre>
        </div>
      </div>
    </div>

    <!-- 详情弹窗（市场技能） -->
    <div v-if="showDetail && detailSkill" class="modal-overlay" @click.self="closeDetail">
      <div class="modal-box">
        <div class="modal-header">
          <div class="modal-title">
            <h4>{{ detailSkill.name }}</h4>
            <span class="preview-version">v{{ detailSkill.version }}</span>
            <span v-if="detailSkill.hasUpdate" class="update-badge">{{ t('skillSettings.updateAvailable') }}</span>
          </div>
          <button class="btn-icon" @click="closeDetail"><X :size="16" /></button>
        </div>
        <div class="modal-meta">
          <span>{{ detailSkill.description }}</span>
          <div class="modal-meta-row">
            <span class="meta-item">{{ t('skillSettings.by') }} {{ detailSkill.author }}</span>
            <span v-if="detailSkill.category" class="meta-item tag">{{ detailSkill.category }}</span>
            <span v-for="tag in detailSkill.tags" :key="tag" class="meta-item tag">{{ tag }}</span>
          </div>
        </div>
        <div class="modal-body">
          <div v-if="detailLoading" class="loading-state compact">
            <div class="spinner"></div>
            <p>{{ t('skillSettings.skillDetailLoading') }}</p>
          </div>
          <pre v-else-if="detailContent">{{ detailContent }}</pre>
          <div v-else class="detail-placeholder">
            <p class="tip">{{ t('skillSettings.skillDetailNotInstalled') }}</p>
          </div>
        </div>
        <div class="modal-footer" @click.stop>
          <template v-if="operatingSkills.has(detailSkill.id)">
            <button class="btn btn-sm" disabled><RefreshCw :size="14" class="spinning" /></button>
          </template>
          <template v-else-if="detailSkill.hasUpdate">
            <button class="btn btn-accent btn-sm" @click="updateSkill(detailSkill)">
              <ArrowUpCircle :size="14" /> {{ t('skillSettings.updateBtn') }}
            </button>
            <button class="btn btn-danger-ghost btn-sm" @click="uninstallSkill(detailSkill)">
              <Trash2 :size="14" /> {{ t('skillSettings.uninstall') }}
            </button>
          </template>
          <template v-else-if="detailSkill.installed">
            <span class="installed-label">✓ {{ t('skillSettings.installed') }}</span>
            <button class="btn btn-danger-ghost btn-sm" @click="uninstallSkill(detailSkill)">
              <Trash2 :size="14" /> {{ t('skillSettings.uninstall') }}
            </button>
          </template>
          <template v-else>
            <button class="btn btn-primary btn-sm" @click="installSkill(detailSkill)">
              <Download :size="14" /> {{ t('skillSettings.install') }}
            </button>
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.skill-settings {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 子标签页 */
.sub-tabs {
  display: flex;
  gap: 4px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 4px;
}

.sub-tab {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  background: transparent;
  border: none;
  border-radius: 6px;
  cursor: pointer;
  transition: all 0.2s ease;
}

.sub-tab:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.sub-tab.active {
  color: var(--text-primary);
  background: var(--bg-secondary);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.1);
}

.tab-badge, .count-badge {
  font-size: 11px;
  padding: 1px 6px;
  background: var(--accent-green);
  color: var(--bg-primary);
  border-radius: 10px;
  font-weight: 600;
}

.count-badge {
  background: var(--accent-primary);
}

/* 通用 */
.settings-section {
  background: var(--bg-tertiary);
  border-radius: 8px;
  padding: 16px;
}

.section-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.section-header h4 {
  font-size: 14px;
  font-weight: 600;
}

.enabled-badge {
  font-size: 11px;
  padding: 2px 8px;
  background: var(--accent-green);
  color: var(--bg-primary);
  border-radius: 10px;
}

.header-actions {
  display: flex;
  gap: 8px;
}

.section-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-bottom: 16px;
}

/* 搜索栏 */
.search-bar {
  position: relative;
  margin-bottom: 12px;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 8px 12px 8px 32px;
  font-size: 13px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  outline: none;
  transition: border-color 0.2s ease;
  box-sizing: border-box;
}

.search-input:focus {
  border-color: var(--accent-primary);
}

.search-input::placeholder {
  color: var(--text-muted);
}

/* 分类筛选条 */
.category-bar {
  display: flex;
  gap: 6px;
  margin-bottom: 14px;
  overflow-x: auto;
  padding-bottom: 4px;
  scrollbar-width: none;
}

.category-bar::-webkit-scrollbar {
  display: none;
}

.category-chip {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 12px;
  font-size: 12px;
  font-weight: 500;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.15s ease;
  flex-shrink: 0;
}

.category-chip:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.category-chip.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: var(--bg-primary);
}

.chip-icon {
  font-size: 13px;
}

.chip-count {
  font-size: 10px;
  opacity: 0.7;
}

.category-chip.active .chip-count {
  opacity: 0.9;
}

/* 精选推荐 */
.featured-section {
  margin-bottom: 16px;
}

.featured-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 10px;
  color: var(--text-primary);
}

.featured-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}

.featured-card {
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.featured-card:hover {
  border-color: var(--accent-primary);
  transform: translateY(-1px);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.featured-card-header {
  display: flex;
  align-items: center;
  gap: 6px;
}

.featured-card-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.4;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.featured-card-footer {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: auto;
}

/* 两组面板 */
.my-skills-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

/* 技能列表 */
.skill-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.skill-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
}

.skill-item:hover {
  border-color: var(--accent-primary);
}

.skill-item.disabled {
  opacity: 0.5;
}

.skill-toggle input {
  width: 16px;
  height: 16px;
  cursor: pointer;
}

.skill-info {
  flex: 1;
  min-width: 0;
}

.skill-name {
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  display: flex;
  align-items: center;
  gap: 8px;
}

.skill-version {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: normal;
}

.skill-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 4px;
  line-height: 1.5;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.skill-actions {
  display: flex;
  gap: 4px;
}

/* 市场技能卡片 */
.market-item {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  transition: all 0.2s ease;
  cursor: pointer;
}

.market-item:hover {
  border-color: var(--accent-primary);
}

.market-item-body {
  flex: 1;
  min-width: 0;
}

.market-item-header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.update-badge {
  font-size: 10px;
  padding: 1px 6px;
  background: var(--accent-orange, #f59e0b);
  color: #fff;
  border-radius: 8px;
  font-weight: 500;
}

.market-item-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 6px;
  flex-wrap: wrap;
}

.meta-item {
  font-size: 11px;
  color: var(--text-muted);
}

.meta-item.tag {
  padding: 1px 6px;
  background: var(--bg-tertiary);
  border-radius: 4px;
}

.market-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}

.installed-label {
  font-size: 12px;
  color: var(--accent-green);
  font-weight: 500;
}

/* Registry 区域 */
.registry-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.registry-section h5 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 8px;
}

.registry-url-row {
  display: flex;
  gap: 8px;
}

.registry-input {
  flex: 1;
  padding: 6px 10px;
  font-size: 12px;
  font-family: var(--font-mono);
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: 6px;
  color: var(--text-primary);
  outline: none;
}

.registry-input:focus {
  border-color: var(--accent-primary);
}

.registry-input::placeholder {
  color: var(--text-muted);
}

.registry-section .tip {
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 状态 */
.empty-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.empty-state.compact {
  padding: 20px;
}

.empty-icon {
  font-size: 48px;
  margin-bottom: 16px;
}

.empty-state p {
  margin: 0 0 8px 0;
}

.empty-state .tip,
.tip {
  font-size: 12px;
  color: var(--text-muted);
}

.loading-state {
  padding: 40px 20px;
  text-align: center;
  color: var(--text-muted);
}

.loading-state.compact {
  padding: 20px;
}

.spinner {
  width: 24px;
  height: 24px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin: 0 auto 12px;
}

.spinning {
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

/* 帮助信息 */
.help-section {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.help-section h5 {
  font-size: 13px;
  font-weight: 600;
  margin-bottom: 12px;
}

.help-list {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0 0 16px 20px;
  line-height: 1.8;
}

.skill-format {
  background: var(--bg-secondary);
  border-radius: 6px;
  padding: 12px;
}

.skill-format h6 {
  font-size: 12px;
  font-weight: 500;
  margin-bottom: 8px;
  color: var(--text-secondary);
}

.format-example {
  font-family: var(--font-mono);
  font-size: 11px;
  background: var(--bg-primary);
  padding: 12px;
  border-radius: 4px;
  overflow-x: auto;
  margin: 0;
  color: var(--text-secondary);
  white-space: pre-wrap;
}

/* 弹窗 */
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.modal-box {
  width: 600px;
  max-width: 90vw;
  max-height: 80vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.modal-title {
  display: flex;
  align-items: center;
  gap: 8px;
}

.modal-title h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.preview-version {
  font-size: 12px;
  color: var(--text-muted);
}

.modal-meta {
  padding: 12px 16px;
  font-size: 12px;
  color: var(--text-muted);
  background: var(--bg-tertiary);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.modal-meta-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.preview-time {
  font-size: 11px;
}

.modal-body {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
}

.modal-body pre {
  font-family: var(--font-mono);
  font-size: 13px;
  line-height: 1.6;
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.detail-placeholder {
  text-align: center;
  padding: 20px;
}

.modal-footer {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
  padding: 12px 16px;
  border-top: 1px solid var(--border-color);
}

/* 按钮 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 12px;
  font-size: 13px;
  border-radius: 6px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
  background: var(--bg-secondary);
  color: var(--text-primary);
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 6px 10px;
  font-size: 12px;
}

.btn-xs {
  padding: 3px 8px;
  font-size: 11px;
}

.btn-primary {
  background: var(--accent-primary);
  color: var(--bg-primary);
}

.btn-primary:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-accent {
  background: var(--accent-orange, #f59e0b);
  color: #fff;
}

.btn-accent:hover:not(:disabled) {
  filter: brightness(1.1);
}

.btn-danger-ghost {
  background: transparent;
  color: var(--text-muted);
}

.btn-danger-ghost:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
}

.btn-icon {
  padding: 6px;
  background: transparent;
  border: none;
  cursor: pointer;
  color: var(--text-secondary);
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
