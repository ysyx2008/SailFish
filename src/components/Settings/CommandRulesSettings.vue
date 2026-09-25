<script setup lang="ts">
/**
 * 命令规则：系统怎么给一条命令定风险。
 *
 * 「工作区路径分区」里的可配置项（额外自由区、区外写确认）改的是风险策略对象，
 * 与「风险策略」页共用一份存储；放在这里是因为它们决定的是定级的输入，
 * 而不是定完级之后的处置。
 */
import { ref, onMounted, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Trash2, RefreshCw, Search, ShieldAlert, FolderLock, HardDrive, Terminal, Plus } from 'lucide-vue-next'
import type { RiskLevel } from '@shared/types/agent'
import { SettingsPage, SettingRow, SettingToggle, SettingHelp } from './kit'
import AppSelect from '../common/AppSelect.vue'
import { useRiskPolicy, DEFAULT_POLICY } from './composables/useRiskPolicy'
import { useRiskLevelLabels } from './composables/useRiskLevelLabels'
import { useUnsavedGuard } from './composables/useUnsavedGuard'

type BuiltInRulesView = {
  argvCommands: Array<{
    cmd: string
    baseLevel: RiskLevel
    safeFlags: string[]
    pathMode: 'all' | 'fixed' | 'none'
    writesTo: boolean
  }>
  hardBlockedPaths: {
    systemPatterns: Array<{
      description: string
      severity: 'critical' | 'hardened'
    }>
    devNullExemptions: string[]
    userDataRoot: string
    userDataAllowed: string[]
    userDataReadOnly: string[]
  }
  workspaceZones: {
    workspaceRoot: string
    free: string[]
    protectedDirs: string[]
    protectedFiles: string[]
  }
}

const { t } = useI18n()
const { riskLabel, riskClass } = useRiskLevelLabels()

// —— 内置安全规则（只读）——
const builtinRules = ref<BuiltInRulesView | null>(null)
const builtinLoading = ref(false)
const builtinError = ref(false)
const builtinFilter = ref('')
const builtinActiveGroup = ref<RiskLevel | 'all'>('all')

// —— 用户命令规则 ——
type UserCommandRuleRow = {
  cmd: string
  baseLevel: RiskLevel
  writesTo: boolean
  pathMode: 'all' | 'fixed' | 'none'
  safeFlags: string[]
}
const userCommandRules = ref<UserCommandRuleRow[]>([])
const userRulesLoading = ref(false)
const userRuleSaving = ref(false)
const userRuleError = ref('')
const newUserRuleCmd = ref('')
const newUserRuleLevel = ref<RiskLevel>('safe')
const newUserRuleWrites = ref(false)
const newUserRuleFlags = ref('')
const USER_RULE_LEVELS: RiskLevel[] = ['safe', 'moderate', 'dangerous', 'blocked']

async function loadUserCommandRules() {
  userRulesLoading.value = true
  try {
    userCommandRules.value = await window.electronAPI.commandRules.list()
  } catch {
    userCommandRules.value = []
  } finally {
    userRulesLoading.value = false
  }
}

async function addUserCommandRule() {
  const cmd = newUserRuleCmd.value.trim()
  userRuleError.value = ''
  if (!cmd || userRuleSaving.value) return
  userRuleSaving.value = true
  try {
    const result = await window.electronAPI.commandRules.upsert({
      cmd,
      baseLevel: newUserRuleLevel.value,
      writesTo: newUserRuleWrites.value,
      safeFlags: newUserRuleFlags.value,
    })
    if (!result.ok) {
      if (result.error === 'builtin_conflict') {
        userRuleError.value = t('settings.security.userCommandRules.errBuiltin')
      } else if (result.error === 'invalid_level') {
        userRuleError.value = t('settings.security.userCommandRules.errLevel')
      } else {
        userRuleError.value = t('settings.security.userCommandRules.errGeneric')
      }
      return
    }
    newUserRuleCmd.value = ''
    newUserRuleFlags.value = ''
    newUserRuleWrites.value = false
    newUserRuleLevel.value = 'safe'
    await loadUserCommandRules()
  } catch {
    userRuleError.value = t('settings.security.userCommandRules.errGeneric')
  } finally {
    userRuleSaving.value = false
  }
}

async function removeUserCommandRule(cmd: string) {
  await window.electronAPI.commandRules.remove(cmd)
  await loadUserCommandRules()
}

const builtinFilteredCommands = computed(() => {
  if (!builtinRules.value) return []
  const q = builtinFilter.value.trim().toLowerCase()
  let list = builtinRules.value.argvCommands
  if (builtinActiveGroup.value !== 'all') {
    list = list.filter(c => c.baseLevel === builtinActiveGroup.value)
  }
  if (!q) return list
  return list.filter(c => c.cmd.toLowerCase().includes(q))
})

const builtinGroupCounts = computed(() => {
  if (!builtinRules.value) return { safe: 0, moderate: 0, dangerous: 0, blocked: 0, all: 0 }
  const counts = { safe: 0, moderate: 0, dangerous: 0, blocked: 0, all: builtinRules.value.argvCommands.length }
  for (const c of builtinRules.value.argvCommands) {
    counts[c.baseLevel]++
  }
  return counts
})

async function loadBuiltinRules() {
  builtinLoading.value = true
  builtinError.value = false
  try {
    builtinRules.value = await window.electronAPI.allowlist.getBuiltInRules()
  } catch {
    builtinError.value = true
  } finally {
    builtinLoading.value = false
  }
}

function pathModeLabel(mode: 'all' | 'fixed' | 'none'): string {
  if (mode === 'all') return t('settings.security.builtinRules.pathModeAll')
  if (mode === 'fixed') return t('settings.security.builtinRules.pathModeFixed')
  return t('settings.security.builtinRules.pathModeNone')
}

function setBuiltinGroup(group: RiskLevel | 'all') {
  builtinActiveGroup.value = group
}

function groupLabel(group: RiskLevel | 'all'): string {
  if (group === 'all') return t('settings.security.builtinRules.groupAll')
  if (group === 'safe') return t('settings.security.builtinRules.groupSafe')
  if (group === 'moderate') return t('settings.security.builtinRules.groupModerate')
  if (group === 'dangerous') return t('settings.security.builtinRules.groupDangerous')
  return t('settings.security.builtinRules.groupBlocked')
}

function groupCount(group: RiskLevel | 'all'): number {
  return builtinGroupCounts.value[group] ?? 0
}

// —— 工作区分区里的可配置项（与「风险策略」页共用同一份存储）——
const {
  policy,
  loaded: policyLoaded,
  loading: policyLoading,
  saving: policySaving,
  justSaved: policySaved,
  error: policyError,
  unsaved: policyUnsaved,
  load: loadPolicy,
  save: savePolicy,
} = useRiskPolicy()

useUnsavedGuard(policyUnsaved)

const newFreeDir = ref('')
const freeDirError = ref('')

/** 仅恢复路径相关策略，不动处置矩阵——那是「风险策略」页的事 */
function resetPathPolicy() {
  policy.value = {
    ...policy.value,
    outsideWritesUpgrade: DEFAULT_POLICY.outsideWritesUpgrade,
    extraFreeDirs: [],
  }
}

const pathPolicyDiffersFromDefault = computed(() =>
  policy.value.outsideWritesUpgrade !== DEFAULT_POLICY.outsideWritesUpgrade ||
  policy.value.extraFreeDirs.length > 0,
)

function isAbsoluteDirPath(dir: string): boolean {
  return dir.startsWith('/') || /^[A-Za-z]:[\\/]/.test(dir) || dir.startsWith('\\\\')
}

function addFreeDir() {
  const dir = newFreeDir.value.trim()
  freeDirError.value = ''
  if (!dir) return
  if (!isAbsoluteDirPath(dir)) {
    freeDirError.value = t('settings.security.riskPolicy.extraFreeDirsInvalid')
    return
  }
  if (!policy.value.extraFreeDirs.includes(dir)) {
    policy.value.extraFreeDirs = [...policy.value.extraFreeDirs, dir]
  }
  newFreeDir.value = ''
}

function removeFreeDir(dir: string) {
  policy.value.extraFreeDirs = policy.value.extraFreeDirs.filter(d => d !== dir)
}

onMounted(() => {
  loadBuiltinRules()
  loadUserCommandRules()
  loadPolicy()
})
</script>

<template>
  <SettingsPage
    :title="t('settings.tabs.commandRules')"
    :desc="t('settings.security.builtinRules.description')"
  >
    <div class="builtin-content">
      <div v-if="builtinLoading" class="builtin-loading">
        <RefreshCw :size="24" class="spinning" />
        <p>{{ t('settings.security.builtinRules.loading') }}</p>
      </div>
      <div v-else-if="builtinError" class="builtin-error">
        <ShieldAlert :size="24" />
        <p>{{ t('settings.security.builtinRules.loadError') }}</p>
        <button class="btn btn-sm" @click="loadBuiltinRules">{{ t('settings.security.builtinRules.retry') }}</button>
      </div>
      <template v-else-if="builtinRules">
        <!-- 我的命令规则 -->
        <div class="rule-block">
          <div class="rule-block-header">
            <Terminal :size="15" />
            <h5>{{ t('settings.security.userCommandRules.title') }}</h5>
            <span class="rule-count">{{ t('settings.security.builtinRules.count', { n: userCommandRules.length }) }}</span>
          </div>
          <p class="rule-block-desc">{{ t('settings.security.userCommandRules.description') }}</p>

          <div class="user-rule-form">
            <input
              v-model="newUserRuleCmd"
              type="text"
              class="input-field user-rule-cmd"
              :placeholder="t('settings.security.userCommandRules.cmdPlaceholder')"
              @keyup.enter="addUserCommandRule"
            />
            <AppSelect
              :model-value="newUserRuleLevel"
              size="compact"
              :options="USER_RULE_LEVELS.map(lvl => ({ value: lvl, label: riskLabel(lvl) }))"
              @update:model-value="newUserRuleLevel = $event as RiskLevel"
            />
            <label class="user-rule-writes">
              <input v-model="newUserRuleWrites" type="checkbox" />
              <span>{{ t('settings.security.userCommandRules.writesLabel') }}</span>
              <SettingHelp :title="t('settings.security.userCommandRules.writesLabel')">
                {{ t('settings.security.userCommandRules.writesTip') }}
              </SettingHelp>
            </label>
            <div class="user-rule-flags-wrap">
              <input
                v-model="newUserRuleFlags"
                type="text"
                class="input-field user-rule-flags"
                :placeholder="t('settings.security.userCommandRules.flagsPlaceholder')"
                @keyup.enter="addUserCommandRule"
              />
              <SettingHelp :title="t('settings.security.userCommandRules.flagsFieldLabel')">
                {{ t('settings.security.userCommandRules.flagsTip') }}
              </SettingHelp>
            </div>
            <button
              class="btn btn-sm btn-primary"
              :disabled="userRuleSaving || !newUserRuleCmd.trim()"
              @click="addUserCommandRule"
            >
              <Plus :size="14" />
              {{ t('settings.security.userCommandRules.add') }}
            </button>
          </div>
          <p v-if="userRuleError" class="add-error">{{ userRuleError }}</p>

          <div v-if="userRulesLoading" class="builtin-empty">{{ t('settings.security.builtinRules.loading') }}</div>
          <div v-else-if="userCommandRules.length === 0" class="builtin-empty">
            {{ t('settings.security.userCommandRules.empty') }}
          </div>
          <div v-else class="cmd-grid cmd-grid-user">
            <div class="cmd-grid-head">
              <div class="cmd-cell cmd-col-cmd">{{ t('settings.security.builtinRules.colCmd') }}</div>
              <div class="cmd-cell cmd-col-level cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colBaseLevel') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colBaseLevel')">
                  {{ t('settings.security.builtinRules.colBaseLevelTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-flags cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colSafeFlags') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colSafeFlags')">
                  {{ t('settings.security.builtinRules.colSafeFlagsTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-path cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colPathMode') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colPathMode')">
                  {{ t('settings.security.builtinRules.colPathModeTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-writes cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colWritesTo') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colWritesTo')">
                  {{ t('settings.security.builtinRules.colWritesToTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-actions"></div>
            </div>
            <div v-for="rule in userCommandRules" :key="rule.cmd" class="cmd-grid-row">
              <div class="cmd-cell cmd-col-cmd"><code>{{ rule.cmd }}</code></div>
              <div class="cmd-cell cmd-col-level">
                <span class="risk-tag" :class="riskClass(rule.baseLevel)">{{ riskLabel(rule.baseLevel) }}</span>
              </div>
              <div class="cmd-cell cmd-col-flags">
                <code v-if="rule.safeFlags.length">{{ rule.safeFlags.join(' ') }}</code>
                <span v-else class="muted">—</span>
              </div>
              <div class="cmd-cell cmd-col-path">{{ pathModeLabel(rule.pathMode) }}</div>
              <div class="cmd-cell cmd-col-writes">
                <span :class="rule.writesTo ? 'writes-yes' : 'muted'">
                  {{ rule.writesTo ? t('settings.security.builtinRules.writesYes') : t('settings.security.builtinRules.writesNo') }}
                </span>
              </div>
              <div class="cmd-cell cmd-col-actions">
                <button
                  class="btn btn-sm btn-icon"
                  :title="t('common.delete')"
                  @click="removeUserCommandRule(rule.cmd)"
                >
                  <Trash2 :size="14" />
                </button>
              </div>
            </div>
          </div>
        </div>

        <!-- 命令风险基线 -->
        <div class="rule-block">
          <div class="rule-block-header">
            <Terminal :size="15" />
            <h5>{{ t('settings.security.builtinRules.argvCommands') }}</h5>
            <span class="rule-count">{{ t('settings.security.builtinRules.count', { n: builtinGroupCounts.all }) }}</span>
          </div>
          <p class="rule-block-desc">{{ t('settings.security.builtinRules.argvCommandsDesc') }}</p>
          <div class="rule-toolbar">
            <div class="search-box">
              <Search :size="14" class="search-icon" />
              <input
                v-model="builtinFilter"
                type="text"
                class="input-field filter-input"
                :placeholder="t('settings.security.builtinRules.searchPlaceholder')"
              />
            </div>
            <div class="group-tabs">
              <button
                v-for="g in (['all', 'blocked', 'dangerous', 'moderate', 'safe'] as const)"
                :key="g"
                class="group-tab"
                :class="['risk-' + g, { active: builtinActiveGroup === g }]"
                @click="setBuiltinGroup(g)"
              >
                <span class="group-label">{{ groupLabel(g) }}</span>
                <span class="group-count">{{ groupCount(g) }}</span>
              </button>
            </div>
          </div>
          <div v-if="builtinFilteredCommands.length === 0" class="builtin-empty">
            {{ t('settings.security.builtinRules.noMatch') }}
          </div>
          <div v-else class="cmd-grid">
            <div class="cmd-grid-head">
              <div class="cmd-cell cmd-col-cmd">{{ t('settings.security.builtinRules.colCmd') }}</div>
              <div class="cmd-cell cmd-col-level cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colBaseLevel') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colBaseLevel')">
                  {{ t('settings.security.builtinRules.colBaseLevelTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-flags cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colSafeFlags') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colSafeFlags')">
                  {{ t('settings.security.builtinRules.colSafeFlagsTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-path cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colPathMode') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colPathMode')">
                  {{ t('settings.security.builtinRules.colPathModeTip') }}
                </SettingHelp>
              </div>
              <div class="cmd-cell cmd-col-writes cmd-col-head">
                <span>{{ t('settings.security.builtinRules.colWritesTo') }}</span>
                <SettingHelp :title="t('settings.security.builtinRules.colWritesTo')">
                  {{ t('settings.security.builtinRules.colWritesToTip') }}
                </SettingHelp>
              </div>
            </div>
            <div v-for="rule in builtinFilteredCommands" :key="rule.cmd" class="cmd-grid-row">
              <div class="cmd-cell cmd-col-cmd"><code>{{ rule.cmd }}</code></div>
              <div class="cmd-cell cmd-col-level">
                <span class="risk-tag" :class="riskClass(rule.baseLevel)">{{ riskLabel(rule.baseLevel) }}</span>
              </div>
              <div class="cmd-cell cmd-col-flags">
                <code v-if="rule.safeFlags.length">{{ rule.safeFlags.join(' ') }}</code>
                <span v-else class="muted">—</span>
              </div>
              <div class="cmd-cell cmd-col-path">{{ pathModeLabel(rule.pathMode) }}</div>
              <div class="cmd-cell cmd-col-writes">
                <span :class="rule.writesTo ? 'writes-yes' : 'muted'">
                  {{ rule.writesTo ? t('settings.security.builtinRules.writesYes') : t('settings.security.builtinRules.writesNo') }}
                </span>
              </div>
            </div>
          </div>
        </div>

        <!-- 硬封路径 -->
        <div class="rule-block">
          <div class="rule-block-header">
            <HardDrive :size="15" />
            <h5>{{ t('settings.security.builtinRules.hardBlockedPaths') }}</h5>
          </div>
          <p class="rule-block-desc">{{ t('settings.security.builtinRules.hardBlockedPathsDesc') }}</p>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.systemPatternsCritical') }}</div>
            <ul class="path-list">
              <li
                v-for="(p, i) in builtinRules.hardBlockedPaths.systemPatterns.filter(x => x.severity === 'critical')"
                :key="'c' + i"
                class="path-list-item path-list-item--critical"
              >
                <code>{{ p.description }}</code>
              </li>
            </ul>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.systemPatternsHardened') }}</div>
            <ul class="path-list">
              <li
                v-for="(p, i) in builtinRules.hardBlockedPaths.systemPatterns.filter(x => x.severity === 'hardened')"
                :key="'h' + i"
                class="path-list-item path-list-item--hardened"
              >
                <code>{{ p.description }}</code>
              </li>
            </ul>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.devNullExemptions') }}</div>
            <ul class="path-list">
              <li
                v-for="e in builtinRules.hardBlockedPaths.devNullExemptions"
                :key="e"
                class="path-list-item path-list-item--exempt"
              >
                <code>{{ e }}</code>
              </li>
            </ul>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.userDataGuard') }}</div>
            <div class="path-list-section">
              <div class="path-list-label">{{ t('settings.security.builtinRules.userDataAllowed') }}</div>
              <ul class="path-list">
                <li
                  v-for="e in builtinRules.hardBlockedPaths.userDataAllowed"
                  :key="e"
                  class="path-list-item path-list-item--exempt"
                >
                  <code>{{ e }}</code>
                </li>
              </ul>
            </div>
            <div class="path-list-section">
              <div class="path-list-label">{{ t('settings.security.builtinRules.userDataReadOnly') }}</div>
              <ul class="path-list">
                <li
                  v-for="e in builtinRules.hardBlockedPaths.userDataReadOnly"
                  :key="e"
                  class="path-list-item path-list-item--exempt"
                >
                  <code>{{ e }}</code>
                </li>
              </ul>
            </div>
            <div class="kv-row">
              <span class="kv-key">{{ t('settings.security.builtinRules.userDataRule') }}</span>
              <span class="kv-value">{{ t('settings.security.builtinRules.userDataRuleText') }}</span>
            </div>
            <div class="kv-row">
              <span class="kv-key">userData</span>
              <span class="kv-value"><code class="path-code">{{ builtinRules.hardBlockedPaths.userDataRoot }}</code></span>
            </div>
          </div>
        </div>

        <!-- 工作区分区（内置说明 + 可配置：额外自由区 / 区外写） -->
        <div class="rule-block">
          <div class="rule-block-header">
            <FolderLock :size="15" />
            <h5>{{ t('settings.security.builtinRules.workspaceZones') }}</h5>
          </div>
          <p class="rule-block-desc">{{ t('settings.security.builtinRules.workspaceZonesDesc') }}</p>
          <div class="kv-row workspace-root-row">
            <span class="kv-key">{{ t('settings.security.builtinRules.workspaceRoot') }}</span>
            <span class="kv-value"><code class="path-code">{{ builtinRules.workspaceZones.workspaceRoot }}</code></span>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneFree') }}</div>
            <ul class="path-list">
              <li
                v-for="z in builtinRules.workspaceZones.free"
                :key="z"
                class="path-list-item path-list-item--free"
              >
                <code>{{ z.endsWith('/') ? z : `${z}/` }}</code>
              </li>
            </ul>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneProtected') }}</div>
            <ul
              v-if="builtinRules.workspaceZones.protectedDirs.length || builtinRules.workspaceZones.protectedFiles.length"
              class="path-list"
            >
              <li
                v-for="d in builtinRules.workspaceZones.protectedDirs"
                :key="'d-' + d"
                class="path-list-item path-list-item--protected"
              >
                <code>{{ d.endsWith('/') ? d : `${d}/` }}</code>
              </li>
              <li
                v-for="f in builtinRules.workspaceZones.protectedFiles"
                :key="'f-' + f"
                class="path-list-item path-list-item--protected"
              >
                <code>{{ f }}</code>
              </li>
            </ul>
          </div>
          <div class="rule-subblock">
            <div class="rule-subtitle">{{ t('settings.security.builtinRules.zoneOutside') }}</div>
            <p class="rule-text">{{ t('settings.security.builtinRules.zoneOutsideText') }}</p>
            <p class="rule-text muted">{{ t('settings.security.builtinRules.zoneSystemText') }}</p>
            <SettingRow
              v-if="policyLoaded && !policyError"
              clickable
              bare
              :label="t('settings.security.riskPolicy.outsideWritesUpgrade')"
              :desc="t('settings.security.riskPolicy.outsideWritesUpgradeDesc')"
            >
              <SettingToggle v-model="policy.outsideWritesUpgrade" />
            </SettingRow>
          </div>

          <div v-if="policyLoaded && !policyError" class="rule-subblock workspace-config">
            <div class="rule-subtitle">{{ t('settings.security.riskPolicy.extraFreeDirs') }}</div>
            <p class="rule-text muted">{{ t('settings.security.riskPolicy.extraFreeDirsDesc') }}</p>
            <div class="add-entry-form">
              <input
                v-model="newFreeDir"
                type="text"
                class="input-field add-command-input"
                :placeholder="t('settings.security.riskPolicy.extraFreeDirsPlaceholder')"
                @keydown.enter.prevent="addFreeDir"
              />
              <button class="btn btn-sm" :disabled="!newFreeDir.trim()" @click="addFreeDir">
                <Plus :size="14" />
                {{ t('common.add') }}
              </button>
            </div>
            <p v-if="freeDirError" class="add-error">{{ freeDirError }}</p>
            <div v-if="policy.extraFreeDirs.length" class="free-dir-list">
              <div v-for="dir in policy.extraFreeDirs" :key="dir" class="free-dir-item">
                <code>{{ dir }}</code>
                <button class="btn btn-sm btn-icon" @click="removeFreeDir(dir)" :title="t('common.delete')">
                  <Trash2 :size="12" />
                </button>
              </div>
            </div>
            <div class="policy-actions">
              <button class="btn btn-sm" @click="resetPathPolicy" :disabled="!pathPolicyDiffersFromDefault">
                {{ t('settings.security.riskPolicy.resetPath') }}
              </button>
              <button
                class="btn btn-sm btn-primary"
                @click="savePolicy"
                :disabled="policySaving || !policyUnsaved"
              >
                {{ policySaving ? t('common.saving') : t('common.save') }}
              </button>
              <span v-if="policySaved" class="policy-saved">{{ t('settings.security.riskPolicy.saved') }}</span>
              <span v-else-if="policyUnsaved" class="policy-unsaved">{{ t('settings.security.riskPolicy.unsaved') }}</span>
            </div>
          </div>
          <div v-else-if="policyLoading" class="rule-text muted">
            {{ t('settings.security.builtinRules.loading') }}
          </div>
        </div>
      </template>
    </div>
  </SettingsPage>
</template>

<style scoped>
.search-box {
  position: relative;
  flex: 1;
  min-width: 200px;
}

.search-icon {
  position: absolute;
  left: 10px;
  top: 50%;
  transform: translateY(-50%);
  color: var(--text-muted);
  pointer-events: none;
}

.filter-input {
  width: 100%;
  box-sizing: border-box;
}

.risk-tag {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: 4px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.risk-tag.risk-safe {
  color: #22c55e;
  background: rgba(34, 197, 94, 0.12);
}

.risk-tag.risk-moderate {
  color: #f59e0b;
  background: rgba(245, 158, 11, 0.12);
}

.risk-tag.risk-dangerous {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.12);
}

.risk-tag.risk-blocked {
  color: #6b7280;
  background: rgba(107, 114, 128, 0.12);
}

.btn-icon.danger {
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 6px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s;
}

.btn-icon.danger:hover {
  color: var(--accent-red, #ef4444);
  background: rgba(239, 68, 68, 0.1);
}

/* —— 内置规则面板 —— */
.builtin-content {
  margin-top: 12px;
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.builtin-loading,
.builtin-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  padding: 24px;
  color: var(--text-muted);
}

.builtin-error .btn {
  margin-top: 4px;
}

.rule-block {
  background: var(--bg-secondary);
  border-radius: 8px;
  padding: 14px;
  border: 1px solid var(--border-color);
}

.rule-block-header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
}

.rule-block-header h5 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
}

.rule-count {
  font-size: 11px;
  color: var(--text-muted);
  padding: 1px 6px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-left: auto;
}

.rule-block-desc {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 12px 0;
  line-height: 1.5;
}

.rule-toolbar {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
  flex-wrap: wrap;
}

.rule-toolbar .search-box {
  min-width: 160px;
  max-width: 240px;
}

.group-tabs {
  display: flex;
  gap: 4px;
  flex-wrap: wrap;
}

.group-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 10px;
  font-size: 11px;
  border-radius: 12px;
  border: 1px solid var(--border-color);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.15s;
  font-weight: 500;
}

.group-tab:hover {
  border-color: var(--accent-primary);
  color: var(--text-primary);
}

.group-label {
  font-size: 11px;
}

.group-count {
  font-size: 10px;
  font-weight: 600;
  opacity: 0.85;
}

.group-tab.active {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  border-color: var(--accent-primary);
}

.group-tab.risk-all.active {
  background: var(--accent-primary);
  color: var(--accent-contrast);
  border-color: var(--accent-primary);
}

.group-tab.risk-safe.active {
  background: #22c55e;
  color: #fff;
  border-color: #22c55e;
}

.group-tab.risk-moderate.active {
  background: #f59e0b;
  color: #fff;
  border-color: #f59e0b;
}

.group-tab.risk-dangerous.active {
  background: #ef4444;
  color: #fff;
  border-color: #ef4444;
}

.group-tab.risk-blocked.active {
  background: #6b7280;
  color: #fff;
  border-color: #6b7280;
}

.builtin-empty {
  padding: 16px;
  text-align: center;
  font-size: 12px;
  color: var(--text-muted);
}

.cmd-grid {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 360px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
}

.cmd-grid-user .cmd-grid-head,
.cmd-grid-user .cmd-grid-row {
  grid-template-columns: 80px 108px 1fr 140px 96px 40px;
}

.user-rule-form {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
  margin-bottom: 10px;
}

.user-rule-writes {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text-secondary);
  white-space: nowrap;
}

.user-rule-flags-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: 1 1 160px;
  min-width: 140px;
}

.user-rule-flags-wrap .user-rule-flags {
  flex: 1;
  min-width: 0;
}

.cmd-col-actions {
  display: flex;
  justify-content: flex-end;
  align-items: center;
}

.cmd-col-head {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  min-width: 0;
}

.cmd-col-head > span {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-grid-head {
  display: grid;
  grid-template-columns: 80px 108px 1fr 140px 96px;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  position: sticky;
  top: 0;
  z-index: 1;
  font-size: 10px;
  font-weight: 600;
  color: var(--text-muted);
  text-transform: none;
  letter-spacing: 0.2px;
  border-bottom: 1px solid var(--border-color);
}

.cmd-grid-row {
  display: grid;
  grid-template-columns: 80px 108px 1fr 140px 96px;
  gap: 8px;
  padding: 6px 10px;
  background: var(--bg-secondary);
  font-size: 12px;
  align-items: center;
  border-bottom: 1px solid var(--border-color);
}

.cmd-grid-row:last-child {
  border-bottom: none;
}

.cmd-grid-row:hover {
  background: var(--bg-tertiary);
}

.cmd-cell {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.cmd-cell code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12px;
  color: var(--text-primary);
  word-break: break-all;
  white-space: normal;
}

.cmd-col-flags code {
  color: var(--text-secondary);
  font-size: 11px;
}

.cmd-col-path {
  color: var(--text-secondary);
  font-size: 11px;
}

.cmd-col-writes {
  text-align: center;
  font-size: 11px;
}

.writes-yes {
  color: #f59e0b;
  font-weight: 500;
}

.muted {
  color: var(--text-muted);
}

.rule-subblock {
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px dashed var(--border-color);
}

.rule-subblock:first-of-type {
  border-top: none;
  padding-top: 0;
  margin-top: 0;
}

.rule-subtitle {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  margin-bottom: 6px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.path-list-section {
  margin-bottom: 10px;
}

.path-list-label {
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.path-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  overflow: hidden;
  background: var(--bg-secondary);
}

.path-list-item {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px 7px 8px;
  border-left: 3px solid transparent;
  border-bottom: 1px solid var(--border-color);
  font-size: 12px;
}

.path-list-item:last-child {
  border-bottom: none;
}

.path-list-item code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  color: var(--text-primary);
  word-break: break-all;
  line-height: 1.4;
}

.path-list-item--critical {
  border-left-color: #ef4444;
  background: rgba(239, 68, 68, 0.06);
}

.path-list-item--critical code {
  color: #ef4444;
}

.path-list-item--hardened {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.05);
}

.path-list-item--hardened code {
  color: #f59e0b;
}

.path-list-item--exempt,
.path-list-item--free {
  border-left-color: #22c55e;
  background: rgba(34, 197, 94, 0.05);
}

.path-list-item--exempt code,
.path-list-item--free code {
  color: #22c55e;
}

.path-list-item--protected {
  border-left-color: #f59e0b;
  background: rgba(245, 158, 11, 0.05);
}

.path-list-item--protected code {
  color: #f59e0b;
}

.kv-row {
  display: flex;
  align-items: flex-start;
  gap: 12px;
  margin-bottom: 6px;
  font-size: 12px;
}

.workspace-root-row {
  margin: 4px 0 12px;
}

.kv-row:last-child {
  margin-bottom: 0;
}

.kv-key {
  flex-shrink: 0;
  width: 90px;
  color: var(--text-muted);
}

.kv-value {
  flex: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  align-items: center;
  color: var(--text-secondary);
}

.path-code {
  font-family: 'SF Mono', Menlo, Consolas, monospace;
  font-size: 11px;
  color: var(--text-muted);
  word-break: break-all;
  white-space: normal;
}

.rule-text {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 4px 0 0 0;
  line-height: 1.5;
}

.rule-text.muted {
  color: var(--text-muted);
  font-size: 11px;
}

@keyframes spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}

.spinning {
  animation: spin 1s linear infinite;
}

.policy-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 12px;
}

.policy-saved {
  font-size: 12px;
  color: #22c55e;
}

.policy-unsaved {
  font-size: 12px;
  color: var(--text-muted);
}

.add-entry-form {
  display: flex;
  gap: 8px;
  align-items: center;
  margin-bottom: 12px;
}

/* 与下方搜索框同款主题输入（覆盖浏览器默认白底） */
.input-field {
  width: 100%;
  padding: 8px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--bg-secondary);
  color: var(--text-primary);
  font-size: 13px;
  outline: none;
  box-sizing: border-box;
  transition: border-color 0.2s;
}

/* 必须写在 .input-field 的 padding / width 简写之后，否则会被覆盖 */
.input-field.filter-input {
  padding-left: 32px;
}

.input-field.user-rule-cmd {
  flex: 0 1 140px;
  width: auto;
  min-width: 100px;
  max-width: 180px;
}

.input-field.user-rule-level {
  flex: 0 0 auto;
  width: auto;
  min-width: 0;
  max-width: 7.5em;
}

.input-field.user-rule-flags {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
}

.input-field::placeholder {
  color: var(--text-muted);
}

.input-field:focus {
  border-color: var(--accent-primary);
}

.add-command-input {
  flex: 1;
  min-width: 0;
  width: auto;
}

.add-error {
  color: #ef4444;
  font-size: 12px;
  margin: -4px 0 12px 0;
}

.workspace-config {
  margin-top: 4px;
  padding-top: 12px;
  border-top: 1px dashed var(--border-color);
}

.free-dir-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 8px;
}

.free-dir-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--bg-primary);
}

.free-dir-item code {
  font-size: 11px;
  word-break: break-all;
  color: var(--text-secondary);
}
</style>
