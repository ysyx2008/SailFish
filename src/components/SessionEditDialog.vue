<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import { useConfigStore, type SshSession, type SshEncoding } from '../stores/config'

const { t } = useI18n()
const configStore = useConfigStore()

const props = defineProps<{
  session: SshSession | null
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

watch(() => props.session, (session) => {
  if (session) {
    formData.value = { ...session }
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
      groupId: '',
      encoding: 'utf-8'
    }
  }
  nextTick(() => nameInputRef.value?.focus())
}, { immediate: true })

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('close')
  }
}

const saveSession = () => {
  if (!formData.value.name?.trim()) {
    alert(t('session.validation.nameRequired'))
    return
  }
  if (!formData.value.host?.trim()) {
    alert(t('session.validation.hostRequired'))
    return
  }
  if (!formData.value.username?.trim()) {
    alert(t('session.validation.usernameRequired'))
    return
  }
  emit('save', { ...formData.value })
}

</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
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
          <select v-model="formData.authType" class="select">
            <option value="password">{{ t('session.form.authPassword') }}</option>
            <option value="privateKey">{{ t('session.form.authKey') }}</option>
          </select>
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
          <select v-model="formData.groupId" class="select">
            <option value="">{{ t('session.defaultGroup') }}</option>
            <option v-for="group in configStore.sessionGroups" :key="group.id" :value="group.id">
              {{ group.name }}
              <template v-if="group.jumpHost"> ({{ t('session.form.jumpHost') }}: {{ group.jumpHost.host }})</template>
            </option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">{{ t('session.form.encoding') }}</label>
          <select v-model="formData.encoding" class="select">
            <option v-for="enc in encodingOptions" :key="enc" :value="enc">
              {{ t(`session.form.encodings.${enc}`) }}
            </option>
          </select>
          <span class="form-hint">{{ t('session.form.encodingHint') }}</span>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="saveSession">{{ t('common.save') }}</button>
      </div>
    </div>
  </div>
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
  font-size: 11px;
  color: var(--text-muted);
  margin-top: 4px;
}

</style>
