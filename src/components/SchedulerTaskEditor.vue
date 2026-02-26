<script setup lang="ts">
import { ref, computed, onMounted, onUnmounted, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { X, Clock, Server, Terminal, MessageSquare } from 'lucide-vue-next'

const { t } = useI18n()

import type { TerminalType } from '@shared/types'

type ScheduleType = 'cron' | 'interval' | 'once'
type TargetType = TerminalType

interface ScheduleConfig {
  type: ScheduleType
  expression: string
}

interface TargetConfig {
  type: TargetType
  sshSessionId?: string
  sshSessionName?: string
  workingDirectory?: string
}

interface TaskOptions {
  timeout: number
  requireConfirm: boolean
  notifyOnComplete: boolean
  notifyOnError: boolean
}

interface TaskRunRecord {
  at: number
  status: string
  duration: number
  output?: string
  error?: string
}

interface ScheduledTask {
  id: string
  name: string
  description?: string
  enabled: boolean
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options: TaskOptions
  createdAt: number
  updatedAt: number
  lastRun?: TaskRunRecord
  nextRun?: number
}

interface CreateTaskParams {
  name: string
  description?: string
  schedule: ScheduleConfig
  prompt: string
  target: TargetConfig
  options?: Partial<TaskOptions>
  enabled?: boolean
}

interface SshSession {
  id: string
  name: string
  host: string
  port: number
  username: string
}

const props = defineProps<{
  task: ScheduledTask | null
}>()

const emit = defineEmits<{
  save: [params: CreateTaskParams]
  cancel: []
}>()

// 表单数据
const name = ref('')
const description = ref('')
const scheduleType = ref<'cron' | 'interval' | 'once'>('cron')
const cronExpression = ref('0 9 * * *')
const intervalValue = ref(30)
const intervalUnit = ref<'m' | 'h' | 'd'>('m')
const onceDateTime = ref('')
const prompt = ref('')
const targetType = ref<'local' | 'ssh' | 'assistant'>('local')
const sshSessionId = ref('')
const workingDirectory = ref('')
const timeout = ref(300)
const notifyOnComplete = ref(false)
const notifyOnError = ref(true)
const enabled = ref(true)

// SSH 会话列表
const sshSessions = ref<SshSession[]>([])

// 加载 SSH 会话
const loadSshSessions = async () => {
  try {
    sshSessions.value = await window.electronAPI.scheduler.getSshSessions()
  } catch (error) {
    console.error('加载 SSH 会话失败:', error)
  }
}

// 编辑模式
const isEditing = computed(() => !!props.task)

// 表单标题
const formTitle = computed(() => 
  isEditing.value ? t('scheduler.editTask') : t('scheduler.createTask')
)

// 常用 cron 表达式预设
const cronPresets = [
  { label: '每天 9:00', value: '0 9 * * *' },
  { label: '每天 12:00', value: '0 12 * * *' },
  { label: '每天 18:00', value: '0 18 * * *' },
  { label: '每小时整点', value: '0 * * * *' },
  { label: '每 30 分钟', value: '*/30 * * * *' },
  { label: '工作日 9:00', value: '0 9 * * 1-5' },
  { label: '每周一 9:00', value: '0 9 * * 1' },
  { label: '每月 1 日 9:00', value: '0 9 1 * *' }
]

// 选中的 SSH 会话名称
const selectedSshSessionName = computed(() => {
  if (!sshSessionId.value) return ''
  const session = sshSessions.value.find((s: SshSession) => s.id === sshSessionId.value)
  return session?.name || ''
})

// 获取调度配置
const getScheduleConfig = (): ScheduleConfig => {
  if (scheduleType.value === 'cron') {
    return { type: 'cron', expression: cronExpression.value }
  } else if (scheduleType.value === 'interval') {
    return { type: 'interval', expression: `${intervalValue.value}${intervalUnit.value}` }
  } else {
    return { type: 'once', expression: onceDateTime.value }
  }
}

// 获取目标配置
const getTargetConfig = (): TargetConfig => {
  if (targetType.value === 'local') {
    return { 
      type: 'local',
      workingDirectory: workingDirectory.value || undefined
    }
  } else if (targetType.value === 'ssh') {
    return {
      type: 'ssh',
      sshSessionId: sshSessionId.value,
      sshSessionName: selectedSshSessionName.value
    }
  } else {
    return { type: 'assistant' }
  }
}

// 验证表单
const validateForm = (): string | null => {
  if (!name.value.trim()) {
    return t('scheduler.validation.nameRequired')
  }
  if (!prompt.value.trim()) {
    return t('scheduler.validation.promptRequired')
  }
  if (scheduleType.value === 'cron' && !cronExpression.value.trim()) {
    return t('scheduler.validation.cronRequired')
  }
  if (scheduleType.value === 'interval' && intervalValue.value <= 0) {
    return t('scheduler.validation.intervalRequired')
  }
  if (scheduleType.value === 'once' && !onceDateTime.value) {
    return t('scheduler.validation.dateTimeRequired')
  }
  if (targetType.value === 'ssh' && !sshSessionId.value) {
    return t('scheduler.validation.sshSessionRequired')
  }
  return null
}

// 保存
const handleSave = () => {
  const error = validateForm()
  if (error) {
    alert(error)
    return
  }

  const params: CreateTaskParams = {
    name: name.value.trim(),
    description: description.value.trim() || undefined,
    schedule: getScheduleConfig(),
    prompt: prompt.value.trim(),
    target: getTargetConfig(),
    options: {
      timeout: timeout.value,
      requireConfirm: false,
      notifyOnComplete: notifyOnComplete.value,
      notifyOnError: notifyOnError.value
    },
    enabled: enabled.value
  }

  emit('save', params)
}

// 取消
const handleCancel = () => {
  emit('cancel')
}

// 初始化表单
const initForm = () => {
  if (props.task) {
    name.value = props.task.name
    description.value = props.task.description || ''
    scheduleType.value = props.task.schedule.type
    
    if (props.task.schedule.type === 'cron') {
      cronExpression.value = props.task.schedule.expression
    } else if (props.task.schedule.type === 'interval') {
      const match = props.task.schedule.expression.match(/^(\d+)(m|h|d)$/)
      if (match) {
        intervalValue.value = parseInt(match[1])
        intervalUnit.value = match[2] as 'm' | 'h' | 'd'
      }
    } else {
      onceDateTime.value = props.task.schedule.expression
    }
    
    prompt.value = props.task.prompt
    targetType.value = props.task.target.type
    sshSessionId.value = props.task.target.sshSessionId || ''
    workingDirectory.value = props.task.target.workingDirectory || ''
    timeout.value = props.task.options.timeout
    notifyOnComplete.value = props.task.options.notifyOnComplete
    notifyOnError.value = props.task.options.notifyOnError
    enabled.value = props.task.enabled
  } else {
    // 默认值
    name.value = ''
    description.value = ''
    scheduleType.value = 'cron'
    cronExpression.value = '0 9 * * *'
    intervalValue.value = 30
    intervalUnit.value = 'm'
    onceDateTime.value = ''
    prompt.value = ''
    targetType.value = 'local'
    sshSessionId.value = ''
    workingDirectory.value = ''
    timeout.value = 300
    notifyOnComplete.value = false
    notifyOnError.value = true
    enabled.value = true
  }
}

// 选择预设
const selectPreset = (preset: typeof cronPresets[0]) => {
  cronExpression.value = preset.value
}

// 键盘事件
const handleKeydown = (event: KeyboardEvent) => {
  if (event.key === 'Escape') {
    handleCancel()
  }
}

onMounted(async () => {
  await loadSshSessions()
  initForm()
  document.addEventListener('keydown', handleKeydown)
})

onUnmounted(() => {
  document.removeEventListener('keydown', handleKeydown)
})

watch(() => props.task, () => {
  initForm()
})
</script>

<template>
  <div class="editor-overlay" @click.self="handleCancel">
    <div class="task-editor">
      <!-- 头部 -->
      <div class="editor-header">
        <h3>{{ formTitle }}</h3>
        <button class="btn-icon" @click="handleCancel">
          <X :size="18" />
        </button>
      </div>

      <!-- 表单 -->
      <div class="editor-body">
        <!-- 基本信息 -->
        <div class="form-section">
          <h4>{{ t('scheduler.basicInfo') }}</h4>
          
          <div class="form-row">
            <label class="form-label">{{ t('scheduler.taskName') }} *</label>
            <input 
              type="text" 
              v-model="name" 
              class="form-input"
              :placeholder="t('scheduler.taskNamePlaceholder')"
            />
          </div>

          <div class="form-row">
            <label class="form-label">{{ t('scheduler.taskDescription') }}</label>
            <input 
              type="text" 
              v-model="description" 
              class="form-input"
              :placeholder="t('scheduler.taskDescriptionPlaceholder')"
            />
          </div>

          <div class="form-row">
            <label class="form-label">
              <input type="checkbox" v-model="enabled" />
              {{ t('scheduler.enableTask') }}
            </label>
          </div>
        </div>

        <!-- 调度配置 -->
        <div class="form-section">
          <h4>
            <Clock :size="16" />
            {{ t('scheduler.scheduleConfig') }}
          </h4>

          <div class="form-row">
            <label class="form-label">{{ t('scheduler.scheduleType') }}</label>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" v-model="scheduleType" value="cron" />
                Cron {{ t('scheduler.expression') }}
              </label>
              <label class="radio-item">
                <input type="radio" v-model="scheduleType" value="interval" />
                {{ t('scheduler.interval') }}
              </label>
              <label class="radio-item">
                <input type="radio" v-model="scheduleType" value="once" />
                {{ t('scheduler.once') }}
              </label>
            </div>
          </div>

          <!-- Cron 表达式 -->
          <template v-if="scheduleType === 'cron'">
            <div class="form-row">
              <label class="form-label">Cron {{ t('scheduler.expression') }} *</label>
              <input 
                type="text" 
                v-model="cronExpression" 
                class="form-input"
                placeholder="0 9 * * *"
              />
            </div>
            <div class="form-row">
              <label class="form-label">{{ t('scheduler.presets') }}</label>
              <div class="presets">
                <button 
                  v-for="preset in cronPresets" 
                  :key="preset.value"
                  class="preset-btn"
                  :class="{ active: cronExpression === preset.value }"
                  @click="selectPreset(preset)"
                >
                  {{ preset.label }}
                </button>
              </div>
            </div>
          </template>

          <!-- 间隔 -->
          <template v-if="scheduleType === 'interval'">
            <div class="form-row">
              <label class="form-label">{{ t('scheduler.intervalConfig') }} *</label>
              <div class="interval-input">
                <span>{{ t('scheduler.every') }}</span>
                <input 
                  type="number" 
                  v-model.number="intervalValue" 
                  class="form-input interval-value"
                  min="1"
                />
                <select v-model="intervalUnit" class="form-select">
                  <option value="m">{{ t('scheduler.minutes') }}</option>
                  <option value="h">{{ t('scheduler.hours') }}</option>
                  <option value="d">{{ t('scheduler.days') }}</option>
                </select>
              </div>
            </div>
          </template>

          <!-- 一次性 -->
          <template v-if="scheduleType === 'once'">
            <div class="form-row">
              <label class="form-label">{{ t('scheduler.dateTime') }} *</label>
              <input 
                type="datetime-local" 
                v-model="onceDateTime" 
                class="form-input"
              />
            </div>
          </template>
        </div>

        <!-- 执行目标 -->
        <div class="form-section">
          <h4>
            <Server :size="16" />
            {{ t('scheduler.targetConfig') }}
          </h4>

          <div class="form-row">
            <label class="form-label">{{ t('scheduler.targetType') }}</label>
            <div class="radio-group">
              <label class="radio-item">
                <input type="radio" v-model="targetType" value="local" />
                <Terminal :size="14" />
                {{ t('scheduler.localTerminal') }}
              </label>
              <label class="radio-item">
                <input type="radio" v-model="targetType" value="ssh" />
                <Server :size="14" />
                SSH {{ t('scheduler.remoteHost') }}
              </label>
              <label class="radio-item" disabled>
                <input type="radio" v-model="targetType" value="assistant" disabled />
                <MessageSquare :size="14" />
                {{ t('scheduler.noTerminal') }}
              </label>
            </div>
          </div>

          <!-- 本地终端配置 -->
          <template v-if="targetType === 'local'">
            <div class="form-row">
              <label class="form-label">{{ t('scheduler.workingDirectory') }}</label>
              <input 
                type="text" 
                v-model="workingDirectory" 
                class="form-input"
                :placeholder="t('scheduler.workingDirectoryPlaceholder')"
              />
            </div>
          </template>

          <!-- SSH 配置 -->
          <template v-if="targetType === 'ssh'">
            <div class="form-row">
              <label class="form-label">SSH {{ t('scheduler.session') }} *</label>
              <select v-model="sshSessionId" class="form-select">
                <option value="">{{ t('scheduler.selectSshSession') }}</option>
                <option v-for="session in sshSessions" :key="session.id" :value="session.id">
                  {{ session.name }} ({{ session.username }}@{{ session.host }})
                </option>
              </select>
            </div>
          </template>
        </div>

        <!-- 任务指令 -->
        <div class="form-section">
          <h4>
            <MessageSquare :size="16" />
            {{ t('scheduler.taskPrompt') }}
          </h4>

          <div class="form-row">
            <label class="form-label">{{ t('scheduler.agentInstruction') }} *</label>
            <textarea 
              v-model="prompt" 
              class="form-textarea"
              rows="4"
              :placeholder="t('scheduler.promptPlaceholder')"
            ></textarea>
          </div>
        </div>

        <!-- 高级选项 -->
        <div class="form-section">
          <h4>{{ t('scheduler.advancedOptions') }}</h4>

          <div class="form-row">
            <label class="form-label">{{ t('scheduler.timeout') }} ({{ t('scheduler.seconds') }})</label>
            <input 
              type="number" 
              v-model.number="timeout" 
              class="form-input"
              min="30"
              max="3600"
            />
          </div>

          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="notifyOnComplete" />
              {{ t('scheduler.notifyOnComplete') }}
            </label>
          </div>

          <div class="form-row checkbox-row">
            <label>
              <input type="checkbox" v-model="notifyOnError" />
              {{ t('scheduler.notifyOnError') }}
            </label>
          </div>
        </div>
      </div>

      <!-- 底部 -->
      <div class="editor-footer">
        <button class="btn" @click="handleCancel">{{ t('scheduler.cancel') }}</button>
        <button class="btn btn-primary" @click="handleSave">
          {{ isEditing ? t('scheduler.save') : t('scheduler.create') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.editor-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
}

.task-editor {
  width: 560px;
  max-width: 95vw;
  max-height: 90vh;
  background: var(--bg-secondary);
  border-radius: 12px;
  box-shadow: 0 25px 50px rgba(0, 0, 0, 0.4);
  display: flex;
  flex-direction: column;
  overflow: hidden;
}

.editor-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
}

.editor-header h3 {
  font-size: 16px;
  font-weight: 600;
}

.editor-body {
  flex: 1;
  overflow-y: auto;
  padding: 20px;
}

.form-section {
  margin-bottom: 24px;
}

.form-section h4 {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  text-transform: uppercase;
  letter-spacing: 0.5px;
}

.form-row {
  margin-bottom: 16px;
}

.form-label {
  display: block;
  font-size: 13px;
  font-weight: 500;
  margin-bottom: 6px;
  color: var(--text-primary);
}

.form-input,
.form-select,
.form-textarea {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  transition: border-color 0.2s;
}

.form-input:focus,
.form-select:focus,
.form-textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.form-textarea {
  resize: vertical;
  min-height: 100px;
  font-family: inherit;
  line-height: 1.5;
}

.radio-group {
  display: flex;
  flex-wrap: wrap;
  gap: 16px;
}

.radio-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  cursor: pointer;
}

.radio-item[disabled] {
  opacity: 0.5;
  cursor: not-allowed;
}

.radio-item input {
  margin: 0;
}

.presets {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.preset-btn {
  padding: 6px 10px;
  font-size: 12px;
  border: 1px solid var(--border-color);
  border-radius: 4px;
  background: var(--bg-tertiary);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.preset-btn:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.preset-btn.active {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.interval-input {
  display: flex;
  align-items: center;
  gap: 8px;
}

.interval-input span {
  font-size: 13px;
}

.interval-value {
  width: 80px;
}

.checkbox-row {
  display: flex;
  align-items: center;
}

.checkbox-row label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  cursor: pointer;
}

.checkbox-row input {
  margin: 0;
}

.editor-footer {
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
  padding: 10px 16px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 6px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  cursor: pointer;
  transition: all 0.2s;
}

.btn:hover:not(:disabled) {
  background: var(--bg-hover);
}

.btn-primary {
  background: var(--accent-primary);
  border-color: var(--accent-primary);
  color: white;
}

.btn-primary:hover:not(:disabled) {
  background: var(--accent-secondary);
}

.btn-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.2s;
}

.btn-icon:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}
</style>
