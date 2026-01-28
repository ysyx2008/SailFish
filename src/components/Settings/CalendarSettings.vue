<script setup lang="ts">
import { ref, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { Plus, Pencil, Trash2, X, Calendar, CheckCircle, AlertCircle } from 'lucide-vue-next'
import { useConfigStore, type CalendarAccount, type CalendarProvider, CALENDAR_PROVIDER_CONFIGS } from '../../stores/config'
import { v4 as uuidv4 } from 'uuid'

const { t } = useI18n()
const configStore = useConfigStore()

// 状态
const showForm = ref(false)
const editingAccount = ref<CalendarAccount | null>(null)
const testingConnection = ref(false)
const testResult = ref<{ success: boolean; message: string } | null>(null)

// 表单数据
const formData = ref<Partial<CalendarAccount> & { password?: string }>({
  name: '',
  username: '',
  provider: 'wecom',
  password: '',
  serverUrl: ''
})

// 计算属性
const accounts = computed(() => configStore.calendarAccounts)

// 服务商选项
const providerOptions: { value: CalendarProvider; label: string; icon: string }[] = [
  { value: 'wecom', label: '企业微信', icon: '💼' },
  { value: 'google', label: 'Google Calendar', icon: '📅' },
  { value: 'icloud', label: 'Apple iCloud', icon: '🍎' },
  { value: 'outlook', label: 'Microsoft Outlook', icon: '📧' },
  { value: 'caldav', label: '自定义 CalDAV', icon: '⚙️' }
]

// 重置表单
const resetForm = () => {
  formData.value = {
    name: '',
    username: '',
    provider: 'wecom',
    password: '',
    serverUrl: ''
  }
  editingAccount.value = null
  testResult.value = null
}

// 打开新增表单
const openNewAccount = () => {
  resetForm()
  showForm.value = true
}

// 打开编辑表单
const openEditAccount = async (account: CalendarAccount) => {
  editingAccount.value = account
  formData.value = {
    ...account,
    password: '' // 密码不回显，需要重新输入才会更新
  }
  testResult.value = null
  showForm.value = true
}

// 服务商变更时自动填充服务器配置
const onProviderChange = () => {
  const provider = formData.value.provider
  if (provider && provider !== 'caldav') {
    formData.value.serverUrl = CALENDAR_PROVIDER_CONFIGS[provider].serverUrl
  } else {
    formData.value.serverUrl = ''
  }
}

// 保存账户
const saveAccount = async () => {
  if (!formData.value.name || !formData.value.username) {
    return
  }

  // 自定义服务器需要填写服务器地址
  if (formData.value.provider === 'caldav') {
    if (!formData.value.serverUrl) {
      alert(t('calendarSettings.serverRequired'))
      return
    }
  }

  // 新建账户必须填写密码
  if (!editingAccount.value && !formData.value.password) {
    alert(t('calendarSettings.passwordRequired'))
    return
  }

  try {
    if (editingAccount.value) {
      // 更新账户
      const updatedAccount: CalendarAccount = {
        ...editingAccount.value,
        name: formData.value.name!,
        username: formData.value.username!,
        provider: formData.value.provider!,
        serverUrl: formData.value.serverUrl
      }
      await configStore.updateCalendarAccount(updatedAccount)

      // 如果输入了新密码，更新密钥链中的凭据
      if (formData.value.password) {
        await window.electronAPI.calendar?.setCredential(editingAccount.value.id, formData.value.password)
      }
    } else {
      // 新建账户
      const newAccount: CalendarAccount = {
        id: uuidv4(),
        name: formData.value.name!,
        username: formData.value.username!,
        provider: formData.value.provider!,
        serverUrl: formData.value.serverUrl
      }
      await configStore.addCalendarAccount(newAccount)

      // 保存密码到密钥链
      if (formData.value.password) {
        await window.electronAPI.calendar?.setCredential(newAccount.id, formData.value.password)
      }
    }

    showForm.value = false
    resetForm()
  } catch (error) {
    console.error('Failed to save calendar account:', error)
    alert(t('calendarSettings.saveFailed'))
  }
}

// 删除账户
const deleteAccount = async (account: CalendarAccount) => {
  if (!confirm(t('calendarSettings.confirmDelete', { name: account.name }))) {
    return
  }

  try {
    await configStore.deleteCalendarAccount(account.id)
  } catch (error) {
    console.error('Failed to delete calendar account:', error)
  }
}

// 测试连接
const testConnection = async () => {
  if (!formData.value.username || !formData.value.password) {
    testResult.value = {
      success: false,
      message: t('calendarSettings.testNeedPassword')
    }
    return
  }

  testingConnection.value = true
  testResult.value = null

  try {
    const serverUrl = formData.value.provider === 'caldav' 
      ? formData.value.serverUrl 
      : CALENDAR_PROVIDER_CONFIGS[formData.value.provider!].serverUrl

    const result = await window.electronAPI.calendar?.testConnection({
      username: formData.value.username,
      password: formData.value.password,
      provider: formData.value.provider,
      serverUrl
    })

    testResult.value = result || { success: false, message: t('calendarSettings.testFailed') }
  } catch (error) {
    testResult.value = {
      success: false,
      message: error instanceof Error ? error.message : t('calendarSettings.testFailed')
    }
  } finally {
    testingConnection.value = false
  }
}

// 获取服务商显示名称
const getProviderLabel = (provider: CalendarProvider): string => {
  const option = providerOptions.find(p => p.value === provider)
  return option?.label || provider
}

// 获取服务商图标
const getProviderIcon = (provider: CalendarProvider): string => {
  const option = providerOptions.find(p => p.value === provider)
  return option?.icon || '📅'
}
</script>

<template>
  <div class="calendar-settings">
    <div class="settings-header">
      <h3>{{ t('calendarSettings.title') }}</h3>
      <button class="btn btn-primary" @click="openNewAccount">
        <Plus :size="16" />
        {{ t('calendarSettings.addAccount') }}
      </button>
    </div>

    <p class="settings-description">
      {{ t('calendarSettings.description') }}
    </p>

    <!-- 账户列表 -->
    <div class="account-list">
      <div v-if="accounts.length === 0" class="empty-state">
        <Calendar :size="48" class="empty-icon" />
        <p>{{ t('calendarSettings.noAccounts') }}</p>
        <button class="btn btn-outline" @click="openNewAccount">
          <Plus :size="16" />
          {{ t('calendarSettings.addFirstAccount') }}
        </button>
      </div>

      <div
        v-for="account in accounts"
        :key="account.id"
        class="account-card"
      >
        <div class="account-icon">
          {{ getProviderIcon(account.provider) }}
        </div>
        <div class="account-info">
          <div class="account-name">{{ account.name }}</div>
          <div class="account-username">{{ account.username }}</div>
          <div class="account-meta">
            <span class="provider-tag">{{ getProviderLabel(account.provider) }}</span>
          </div>
        </div>
        <div class="account-actions">
          <button class="btn-icon" @click="openEditAccount(account)" :title="t('common.edit')">
            <Pencil :size="16" />
          </button>
          <button class="btn-icon danger" @click="deleteAccount(account)" :title="t('common.delete')">
            <Trash2 :size="16" />
          </button>
        </div>
      </div>
    </div>

    <!-- 添加/编辑表单弹窗 -->
    <div v-if="showForm" class="form-overlay" @click.self="showForm = false">
      <div class="form-modal">
        <div class="form-header">
          <h4>{{ editingAccount ? t('calendarSettings.editAccount') : t('calendarSettings.addAccount') }}</h4>
          <button class="btn-icon" @click="showForm = false">
            <X :size="18" />
          </button>
        </div>

        <div class="form-body">
          <!-- 显示名称 -->
          <div class="form-group">
            <label>{{ t('calendarSettings.accountName') }}</label>
            <input
              v-model="formData.name"
              type="text"
              :placeholder="t('calendarSettings.accountNamePlaceholder')"
            />
          </div>

          <!-- 服务商选择 -->
          <div class="form-group">
            <label>{{ t('calendarSettings.provider') }}</label>
            <select v-model="formData.provider" @change="onProviderChange">
              <option v-for="option in providerOptions" :key="option.value" :value="option.value">
                {{ option.icon }} {{ option.label }}
              </option>
            </select>
          </div>

          <!-- 自定义服务器配置 -->
          <div v-if="formData.provider === 'caldav'" class="server-config">
            <div class="form-group">
              <label>CalDAV {{ t('calendarSettings.serverUrl') }}</label>
              <input v-model="formData.serverUrl" type="text" placeholder="https://caldav.example.com" />
            </div>
          </div>

          <!-- 用户名 -->
          <div class="form-group">
            <label>{{ t('calendarSettings.username') }}</label>
            <input
              v-model="formData.username"
              type="text"
              :placeholder="t('calendarSettings.usernamePlaceholder')"
            />
          </div>

          <!-- 密码 -->
          <div class="form-group">
            <label>
              {{ t('calendarSettings.password') }}
              <span v-if="editingAccount" class="optional">({{ t('calendarSettings.leaveEmptyToKeep') }})</span>
            </label>
            <input
              v-model="formData.password"
              type="password"
              :placeholder="editingAccount ? t('calendarSettings.passwordPlaceholderEdit') : t('calendarSettings.passwordPlaceholder')"
            />
            <p class="form-hint">
              {{ formData.provider === 'wecom' ? t('calendarSettings.wecomPasswordHint') : t('calendarSettings.passwordHint') }}
            </p>
          </div>

          <!-- 测试连接 -->
          <div class="test-section">
            <button
              class="btn btn-outline"
              @click="testConnection"
              :disabled="testingConnection"
            >
              <span v-if="testingConnection" class="spinner"></span>
              {{ testingConnection ? t('calendarSettings.testing') : t('calendarSettings.testConnection') }}
            </button>
            <div v-if="testResult" class="test-result" :class="{ success: testResult.success, error: !testResult.success }">
              <CheckCircle v-if="testResult.success" :size="16" />
              <AlertCircle v-else :size="16" />
              {{ testResult.message }}
            </div>
          </div>
        </div>

        <div class="form-footer">
          <button class="btn btn-outline" @click="showForm = false">
            {{ t('common.cancel') }}
          </button>
          <button class="btn btn-primary" @click="saveAccount">
            {{ t('common.save') }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.calendar-settings {
  padding: 0;
}

.settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
}

.settings-header h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.settings-description {
  color: var(--text-secondary);
  font-size: 13px;
  margin-bottom: 20px;
}

/* 账户列表 */
.account-list {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.empty-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 40px 20px;
  color: var(--text-muted);
  text-align: center;
}

.empty-icon {
  opacity: 0.3;
  margin-bottom: 16px;
}

.empty-state p {
  margin-bottom: 16px;
}

.account-card {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 14px 16px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  transition: all 0.2s ease;
}

.account-card:hover {
  border-color: var(--accent-primary);
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
}

.account-icon {
  font-size: 28px;
  width: 48px;
  height: 48px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--bg-primary);
  border-radius: 10px;
}

.account-info {
  flex: 1;
  min-width: 0;
}

.account-name {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.account-username {
  font-size: 13px;
  color: var(--text-secondary);
  margin-bottom: 6px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.account-meta {
  display: flex;
  gap: 8px;
}

.provider-tag {
  font-size: 11px;
  padding: 2px 8px;
  border-radius: 4px;
  background: var(--bg-primary);
  color: var(--text-muted);
}

.account-actions {
  display: flex;
  gap: 4px;
}

.btn-icon {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  background: transparent;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.btn-icon.danger:hover {
  background: rgba(239, 68, 68, 0.1);
  color: #ef4444;
}

/* 表单弹窗 */
.form-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
  animation: calendarFadeIn 0.2s ease;
}

.form-modal {
  width: 480px;
  max-width: 90vw;
  max-height: 85vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  animation: calendarSlideIn 0.2s ease;
}

.form-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.form-header h4 {
  font-size: 16px;
  font-weight: 600;
  margin: 0;
}

.form-body {
  padding: 20px;
  overflow-y: auto;
  flex: 1;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  color: var(--text-secondary);
  margin-bottom: 6px;
}

.form-group input[type="text"],
.form-group input[type="password"],
.form-group select {
  width: 100%;
  padding: 10px 12px;
  font-size: 14px;
  background: var(--bg-primary);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  color: var(--text-primary);
  transition: all 0.2s ease;
}

.form-group input:focus,
.form-group select:focus {
  outline: none;
  border-color: var(--accent-primary);
  box-shadow: 0 0 0 3px rgba(var(--accent-primary-rgb), 0.1);
}

.form-group .optional {
  font-weight: 400;
  color: var(--text-muted);
  font-size: 12px;
}

.form-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 6px;
  line-height: 1.4;
}

.server-config {
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-bottom: 16px;
}

/* 测试连接 */
.test-section {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 16px;
  background: var(--bg-tertiary);
  border-radius: 8px;
  margin-top: 8px;
}

.test-result {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
}

.test-result.success {
  color: #22c55e;
}

.test-result.error {
  color: #ef4444;
}

.spinner {
  width: 14px;
  height: 14px;
  border: 2px solid var(--border-color);
  border-top-color: var(--accent-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  margin-right: 6px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.form-footer {
  display: flex;
  justify-content: flex-end;
  gap: 12px;
  padding: 16px 20px;
  border-top: 1px solid var(--border-color);
}

/* 按钮样式 */
.btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 8px 16px;
  font-size: 13px;
  font-weight: 500;
  border-radius: 8px;
  border: none;
  cursor: pointer;
  transition: all 0.2s ease;
}

.btn-primary {
  background: var(--accent-primary);
  color: var(--bg-primary);
}

.btn-primary:hover {
  opacity: 0.9;
}

.btn-outline {
  background: transparent;
  border: 1px solid var(--border-color);
  color: var(--text-primary);
}

.btn-outline:hover {
  background: var(--bg-hover);
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

@keyframes calendarFadeIn {
  from { opacity: 0; }
  to { opacity: 1; }
}

@keyframes calendarSlideIn {
  from {
    transform: translateY(-20px);
    opacity: 0;
  }
  to {
    transform: translateY(0);
    opacity: 1;
  }
}
</style>
