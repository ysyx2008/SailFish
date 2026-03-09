<script setup lang="ts">
import { ref, watch, nextTick } from 'vue'
import { useI18n } from 'vue-i18n'
import { X } from 'lucide-vue-next'
import type { SessionGroup, JumpHostConfig } from '../stores/config'

const { t } = useI18n()

const props = defineProps<{
  group: SessionGroup | null
}>()

const emit = defineEmits<{
  save: [data: { name: string; jumpHost?: JumpHostConfig }]
  delete: [group: SessionGroup]
  close: []
}>()

const groupNameInputRef = ref<HTMLInputElement | null>(null)

const formData = ref<{
  name: string
  jumpHost?: Partial<JumpHostConfig>
}>({
  name: '',
  jumpHost: undefined
})

watch(() => props.group, (group) => {
  if (group) {
    formData.value = {
      name: group.name,
      jumpHost: group.jumpHost ? { ...group.jumpHost } : undefined
    }
  } else {
    formData.value = {
      name: '',
      jumpHost: undefined
    }
  }
  nextTick(() => groupNameInputRef.value?.focus())
}, { immediate: true })

const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Escape') {
    e.stopImmediatePropagation()
    emit('close')
  }
}

const toggleJumpHost = (enabled: boolean) => {
  if (enabled) {
    formData.value.jumpHost = {
      host: '',
      port: 22,
      username: '',
      authType: 'password'
    }
  } else {
    formData.value.jumpHost = undefined
  }
}

const saveGroup = () => {
  if (!formData.value.name) {
    alert(t('session.pleaseInputGroupName'))
    return
  }

  if (formData.value.jumpHost) {
    const jh = formData.value.jumpHost
    if (!jh.host || !jh.username) {
      alert(t('session.pleaseInputJumpHostInfo'))
      return
    }
  }

  emit('save', {
    name: formData.value.name,
    jumpHost: formData.value.jumpHost as JumpHostConfig | undefined
  })
}

const deleteGroup = () => {
  if (props.group) {
    emit('delete', props.group)
  }
}
</script>

<template>
  <div class="modal-overlay" @click.self="emit('close')" @keydown="handleKeydown">
    <div class="modal session-modal">
      <div class="modal-header">
        <h3>{{ group ? t('session.editGroup') : (formData.name ? t('session.configGroup') : t('session.newGroup')) }}</h3>
        <button class="btn-icon" @click="emit('close')" :title="t('common.close')">
          <X :size="16" />
        </button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">{{ t('session.form.groupName') }} *</label>
          <input ref="groupNameInputRef" v-model="formData.name" type="text" class="input" :placeholder="t('session.form.groupNamePlaceholder')" />
        </div>
        
        <!-- 跳板机配置 -->
        <div class="form-section">
          <div class="form-section-header">
            <label class="checkbox-label">
              <input 
                type="checkbox" 
                :checked="!!formData.jumpHost"
                @change="toggleJumpHost(($event.target as HTMLInputElement).checked)"
              />
              <span>{{ t('session.form.jumpHostEnable') }}</span>
            </label>
            <span class="form-section-hint">{{ t('session.form.jumpHostHint') }}</span>
          </div>
          
          <template v-if="formData.jumpHost">
            <div class="form-row">
              <div class="form-group" style="flex: 2">
                <label class="form-label">{{ t('session.form.jumpHostHost') }} *</label>
                <input v-model="formData.jumpHost.host" type="text" class="input" :placeholder="t('session.form.hostPlaceholder')" />
              </div>
              <div class="form-group" style="flex: 1">
                <label class="form-label">{{ t('session.form.port') }}</label>
                <input v-model.number="formData.jumpHost.port" type="number" class="input" />
              </div>
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.username') }} *</label>
              <input v-model="formData.jumpHost.username" type="text" class="input" :placeholder="t('session.form.usernamePlaceholder')" />
            </div>
            <div class="form-group">
              <label class="form-label">{{ t('session.form.authType') }}</label>
              <select v-model="formData.jumpHost.authType" class="select">
                <option value="password">{{ t('session.form.authPassword') }}</option>
                <option value="privateKey">{{ t('session.form.authKey') }}</option>
              </select>
            </div>
            <div v-if="formData.jumpHost.authType === 'password'" class="form-group">
              <label class="form-label">{{ t('session.form.password') }}</label>
              <input v-model="formData.jumpHost.password" type="password" class="input" />
            </div>
            <template v-else>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.privateKeyPath') }}</label>
                <input v-model="formData.jumpHost.privateKeyPath" type="text" class="input" :placeholder="t('session.form.privateKeyPathPlaceholder')" />
              </div>
              <div class="form-group">
                <label class="form-label">{{ t('session.form.passphraseOptional') }}</label>
                <input v-model="formData.jumpHost.passphrase" type="password" class="input" />
              </div>
            </template>
          </template>
        </div>
      </div>
      <div class="modal-footer">
        <button v-if="group" class="btn btn-danger" @click="deleteGroup">{{ t('session.deleteGroup') }}</button>
        <div style="flex: 1"></div>
        <button class="btn" @click="emit('close')">{{ t('common.cancel') }}</button>
        <button class="btn btn-primary" @click="saveGroup">{{ t('common.save') }}</button>
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

.form-section {
  margin-top: 16px;
  padding: 12px;
  background: var(--bg-tertiary);
  border-radius: 8px;
}

.form-section-header {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 12px;
}

.form-section-hint {
  font-size: 11px;
  color: var(--text-muted);
  margin-left: 22px;
}

.checkbox-label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-primary);
  cursor: pointer;
}

.checkbox-label input[type="checkbox"] {
  width: 14px;
  height: 14px;
  cursor: pointer;
}

.btn-danger {
  background: #e53e3e;
  color: white;
}

.btn-danger:hover {
  background: #c53030;
}
</style>
