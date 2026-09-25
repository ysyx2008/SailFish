<script setup lang="ts">
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useConfigStore, type SshSession, type SshEncoding, type JumpHostConfig } from '../stores/config'
import { showAlert } from '../composables/useConfirm'
import AppSelect from './common/AppSelect.vue'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  session: SshSession | null
  /** 新建时预选的分组；编辑已有主机时忽略 */
  defaultGroupId?: string
}>()

const emit = defineEmits<{
  save: [session: Partial<SshSession>]
  close: []
}>()

const encodingOptions: SshEncoding[] = [
  'utf-8', 'gbk', 'gb2312', 'gb18030', 'big5',
  'shift_jis', 'euc-jp', 'euc-kr',
  'iso-8859-1', 'iso-8859-15', 'windows-1252',
  'koi8-r', 'windows-1251'
]

const nameInputRef = ref<HTMLInputElement | null>(null)

const authOptions = computed(() => [
  { value: 'password', label: t('session.form.authPassword') },
  { value: 'privateKey', label: t('session.form.authKey') },
])

const groupOptions = computed(() => [
  { value: '', label: t('session.defaultGroup') },
  ...configStore.sessionGroups.map(group => ({
    value: group.id,
    label: group.jumpHost
      ? `${group.name} (${t('session.form.jumpHost')}: ${group.jumpHost.host})`
      : group.name,
  })),
])

const jumpHostModeOptions = computed(() => [
  { value: 'inherit', label: t('session.form.jumpHostInherit') },
  { value: 'custom', label: t('session.form.jumpHostCustom') },
  { value: 'disabled', label: t('session.form.jumpHostDisable') },
])

const encodingSelectOptions = computed(() =>
  encodingOptions.map(enc => ({ value: enc, label: t(`session.form.encodings.${enc}`) }))
)

type JumpHostMode = 'inherit' | 'custom' | 'disabled'
const jumpHostMode = ref<JumpHostMode>('inherit')
const jumpHostForm = ref<Partial<JumpHostConfig>>({
  host: '',
  port: 22,
  username: '',
  authType: 'password'
})

const formData = ref<Partial<SshSession>>({
  name: '',
  host: '',
  port: 22,
  username: 'root',
  authType: 'password',
  password: '',
  privateKeyPath: '',
  passphrase: '',
  groupId: '',
  encoding: 'utf-8'
})

const inheritedJumpHost = computed(() => {
  const groupId = formData.value.groupId
  if (!groupId) return undefined
  const group = configStore.sessionGroups.find(g => g.id === groupId)
  if (!group?.jumpHost) return undefined
  return { groupName: group.name, host: group.jumpHost.host, port: group.jumpHost.port }
})

watch(() => props.session, (session) => {
  if (session) {
    formData.value = { ...session }
    if (session.jumpHostOverride === null) {
      jumpHostMode.value = 'disabled'
      jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
    } else if (session.jumpHostOverride) {
      jumpHostMode.value = 'custom'
      jumpHostForm.value = { ...session.jumpHostOverride }
    } else {
      jumpHostMode.value = 'inherit'
      jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
    }
  } else {
    formData.value = {
      name: '',
      host: '',
      port: 22,
      username: 'root',
      authType: 'password',
      password: '',
      privateKeyPath: '',
      passphrase: '',
      groupId: props.defaultGroupId || '',
      encoding: 'utf-8'
    }
    jumpHostMode.value = 'inherit'
    jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
  }
  nextTick(() => nameInputRef.value?.focus())
}, { immediate: true })

const onJumpHostModeChange = (mode: JumpHostMode) => {
  jumpHostMode.value = mode
  if (mode === 'custom' && !jumpHostForm.value.host) {
    jumpHostForm.value = { host: '', port: 22, username: '', authType: 'password' }
  }
}

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.preventDefault()
    e.stopPropagation()
    e.stopImmediatePropagation()
    emit('close')
  }
}

onMounted(() => {
  document.addEventListener('keydown', handleKeydown, true)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown, true)
})

const saveSession = async () => {
  if (!formData.value.name?.trim()) {
    await showAlert(t('common.warning'), t('session.validation.nameRequired'))
    return
  }
  if (!formData.value.host?.trim()) {
    await showAlert(t('common.warning'), t('session.validation.hostRequired'))
    return
  }
  if (!formData.value.username?.trim()) {
    await showAlert(t('common.warning'), t('session.validation.usernameRequired'))
    return
  }

  const data = { ...formData.value }
  if (jumpHostMode.value === 'custom') {
    if (!jumpHostForm.value.host || !jumpHostForm.value.username) {
      await showAlert(t('common.warning'), t('session.pleaseInputJumpHostInfo'))
      return
    }
    data.jumpHostOverride = jumpHostForm.value as JumpHostConfig
  } else if (jumpHostMode.value === 'disabled') {
    data.jumpHostOverride = null
  } else {
    data.jumpHostOverride = undefined
  }

  emit('save', data)
}

</script>

<template>
  <Teleport to="body">
  <div class="modal-overlay">
    <div class="modal session-modal">
      <div class="modal-header">
        <h3>{{ session ? t('session.editHost') : t('session.newHost') }}</h3>
        <button class="btn-icon" @click="emit('close')" :title="t('common.close')">
          <X :size="16" />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">{{ t('session.form.name') }} *</label>
          <input ref="nameInputRef" v-model="formData.name" type="text" class="input" :placeholder="t('session.form.sessionNamePlaceholder')" />
        </div>
        <div class="form-row">
          <div class="form-group" style="flex: 2">
            <label class="form-label">{{ t('session.form.host') }} *</label>
            <input v-model="formData.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
          </div>
          <div class="form-group" style="flex: 1">
            <label class="form-label">{{ t('session.form.port') }}</label>
            <input v-model.number="formData.port" type="number" class="input" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.username') }} *</label>
          <input v-model="formData.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.authType') }}</label>
          <AppSelect
            :model-value="formData.authType || 'password'"
            :options="authOptions"
            size="field"
            block
            @update:model-value="formData.authType = $event as 'password' | 'privateKey'"
          />
        </div>
        <div v-if="formData.authType === 'password'" class="form-group">
          <label class="form-label">{{ t('session.form.password') }}</label>
          <input v-model="formData.password" type="password" class="input" />
        </div>
        <template v-else>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
            <input v-model="formData.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
          </div>
          <div class="form-group">
            <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
            <input v-model="formData.passphrase" type="password" class="input" />
          </div>
        </template>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.group') }}</label>
          <AppSelect
            :model-value="formData.groupId || ''"
            :options="groupOptions"
            size="field"
            block
            @update:model-value="formData.groupId = $event"
          />
        </div>
        <!-- 跳板机配置 -->
        <div class="form-section">
          <div class="form-group" style="margin-bottom: 0">
            <label class="form-label">{{ t('session.form.jumpHost') }}</label>
            <AppSelect
              :model-value="jumpHostMode"
              :options="jumpHostModeOptions"
              size="field"
              block
              @update:model-value="onJumpHostModeChange($event as JumpHostMode)"
            />
            <span v-if="jumpHostMode === 'inherit' && inheritedJumpHost" class="form-hint">
              {{ t('session.form.jumpHostInheritInfo', { group: inheritedJumpHost.groupName, host: inheritedJumpHost.host + ':' + inheritedJumpHost.port }) }}
            </span>
            <span v-else-if="jumpHostMode === 'inherit' && !inheritedJumpHost" class="form-hint">
              {{ t('session.form.jumpHostNoInherit') }}
            </span>
            <span v-if="jumpHostMode === 'custom'" class="form-hint">
              {{ t('session.form.jumpHostCustomHint') }}
            </span>
          </div>

          <template v-if="jumpHostMode === 'custom'">
            <div class="form-row" style="margin-top: 10px">
              <div class="form-group" style="flex: 2">
                <label class="form-label">{{ t('session.form.jumpHostHost') }} *</label>
                <input v-model="jumpHostForm.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
              </div>
              <div class="form-group" style="flex: 1">
                <label class="form-label">{{ t('session.form.port') }}</label>
                <input v-model.number="jumpHostForm.port" type="number" class="input" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.username') }} *</label>
              <input v-model="jumpHostForm.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.authType') }}</label>
              <AppSelect
                :model-value="jumpHostForm.authType || 'password'"
                :options="authOptions"
                size="field"
                block
                @update:model-value="jumpHostForm.authType = $event as 'password' | 'privateKey'"
              />
            </div>
            <div v-if="jumpHostForm.authType === 'password'" class="form-group">
              <label class="form-label">{{ t('session.form.password') }}</label>
              <input v-model="jumpHostForm.password" type="password" class="input" />
            </div>
            <template v-else>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
                <input v-model="jumpHostForm.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
                <input v-model="jumpHostForm.passphrase" type="password" class="input" />
              </div>
            </template>
            <div class="form-group jump-server-option">
              <label class="checkbox-label">
                <input
                  type="checkbox"
                  :checked="jumpHostForm.product === 'jumpserver'"
                  @change="jumpHostForm.product = ($event.target as HTMLInputElement).checked ? 'jumpserver' : undefined"
                />
                <span>{{ t('session.form.jumpHostIsJumpServer') }}</span>
              </label>
              <span class="form-hint">{{ t('session.form.jumpHostIsJumpServerHint') }}</span>
            </div>
          </template>
        </div>

        <div class="form-group">
          <label class="form-label">{{ t('session.form.encoding') }}</label>
          <AppSelect
            :model-value="formData.encoding || 'utf-8'"
            :options="encodingSelectOptions"
            size="field"
            block
            @update:model-value="formData.encoding = $event as SshEncoding"
          />
          <span class="form-hint">{{ t('session.form.encodingHint') }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="saveSession">{{ t('common.save') }}</button>
      </div>
    </div>
  </div>
  </Teleport>
</template>

<style scoped>
.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.modal {
  width: 420px;
  max-height: 80vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 20px 40px rgba(0, 0, 0, 0.3);
  overflow: hidden;
}

.modal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.modal-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.modal-body {
  padding: 20px;
  max-height: 60vh;
  overflow-y: auto;
}

.modal-footer {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

.form-row {
  display: flex;
  gap: 12px;
}

.form-hint {
  display: block;
  font-size: var(--fs-meta);
  color: var(--text-muted);
  margin-top: var(--sp-1);
}

.jump-server-option {
  margin-bottom: 0;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  font-family: var(--font-family);
  font-size: var(--fs-label);
  font-weight: 400;
  color: var(--text-secondary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  appearance: none;
  width: 14px;
  height: 14px;
  margin: 0;
  flex-shrink: 0;
  border: 1px solid var(--border-color);
  border-radius: 3px;
  background: var(--bg-primary);
  display: grid;
  place-items: center;
  cursor: pointer;
}

.checkbox-label input[type="checkbox"]:checked {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
}

.checkbox-label input[type="checkbox"]:checked::after {
  content: '';
  width: 3px;
  height: 7px;
  border: solid var(--accent-contrast);
  border-width: 0 1.5px 1.5px 0;
  transform: rotate(45deg) translate(-0.5px, -1px);
}

.form-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}


</style>
