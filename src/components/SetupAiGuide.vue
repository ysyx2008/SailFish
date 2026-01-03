<script setup lang="ts">
/**
 * 引导向导 AI 对话侧边栏组件
 * 在步骤 3-5 时显示，AI 主动发送针对当前步骤的指导消息
 * 用户可以继续追问对话
 */
import { ref, watch, onMounted, nextTick, computed } from 'vue'
import { useI18n } from 'vue-i18n'
import { ArrowUp, Loader2, Bot } from 'lucide-vue-next'
import { useConfigStore } from '../stores/config'
import { useMarkdown } from '../composables/useMarkdown'

const props = defineProps<{
  step: number  // 当前步骤 (3-5)
}>()

const { t, locale } = useI18n()
const configStore = useConfigStore()
const { renderMarkdown } = useMarkdown()

// 消息列表
interface Message {
  id: string
  role: 'user' | 'assistant'
  content: string
}
const messages = ref<Message[]>([])

// 输入框
const inputText = ref('')
const inputRef = ref<HTMLTextAreaElement | null>(null)

// 消息列表容器
const messagesRef = ref<HTMLDivElement | null>(null)

// 加载状态
const isLoading = ref(false)

// 当前正在生成的消息 ID
const streamingMessageId = ref<string | null>(null)

// 解析消息内容，分离思考过程和正式回复
interface ParsedContent {
  thinking: string | null  // 思考过程
  reply: string           // 正式回复
}

const parseMessageContent = (content: string): ParsedContent => {
  if (!content) return { thinking: null, reply: content }
  
  let thinking: string | null = null
  let reply = content
  
  // 提取 <think>...</think> 中的内容
  const thinkMatch = content.match(/<think>([\s\S]*?)<\/think>/i)
  if (thinkMatch) {
    thinking = thinkMatch[1].trim()
    reply = content.replace(/<think>[\s\S]*?<\/think>/gi, '')
  }
  
  // 提取 <details>...</details> 中的内容（思考过程常用这个格式）
  const detailsMatch = content.match(/<details[\s\S]*?>([\s\S]*?)<\/details>/i)
  if (detailsMatch && !thinking) {
    // 移除 <summary> 标签
    let thinkContent = detailsMatch[1]
    thinkContent = thinkContent.replace(/<summary>[\s\S]*?<\/summary>/gi, '')
    thinkContent = thinkContent.replace(/<\/?blockquote>/gi, '')
    thinkContent = thinkContent.replace(/<\/?strong>/gi, '')
    thinking = thinkContent.trim()
    reply = content.replace(/<details[\s\S]*?<\/details>/gi, '')
  }
  
  // 处理未闭合的标签（流式输出时）
  if (!thinking) {
    const unclosedThink = content.match(/<think>([\s\S]*)$/i)
    if (unclosedThink) {
      thinking = unclosedThink[1].trim()
      reply = ''
    }
    
    const unclosedDetails = content.match(/<details[^>]*>([\s\S]*)$/i)
    if (unclosedDetails && !thinking) {
      let thinkContent = unclosedDetails[1]
      thinkContent = thinkContent.replace(/<summary>[\s\S]*?<\/summary>/gi, '')
      thinkContent = thinkContent.replace(/<\/?summary>/gi, '')
      thinkContent = thinkContent.replace(/<\/?blockquote>/gi, '')
      thinkContent = thinkContent.replace(/<\/?strong>/gi, '')
      thinking = thinkContent.trim()
      reply = ''
    }
  }
  
  // 清理多余空行
  reply = reply.replace(/\n{3,}/g, '\n\n').trim()
  
  return { thinking, reply }
}

// 记录每条消息的思考过程折叠状态（默认展开，所以记录的是已折叠的）
const collapsedThinking = ref<Set<string>>(new Set())

const toggleThinking = (messageId: string) => {
  if (collapsedThinking.value.has(messageId)) {
    collapsedThinking.value.delete(messageId)
  } else {
    collapsedThinking.value.add(messageId)
  }
}

// 检查思考过程是否展开（默认展开）
const isThinkingExpanded = (messageId: string) => {
  return !collapsedThinking.value.has(messageId)
}

// 步骤对应的初始指导 prompt
const getStepPrompt = (step: number): string => {
  const isEnglish = locale.value === 'en-US'
  
  const prompts: Record<number, string> = {
    3: isEnglish
      ? `You are the AI assistant for SFTerm (a smart terminal tool). The user is in the setup wizard at the "Import SSH Hosts" step.

Please proactively introduce this step in a friendly and concise manner:
1. Explain what this step does (import SSH host configurations from Xshell or other tools)
2. Explain when to use it (if they used Xshell before) or skip it (if they have no existing configs)
3. Encourage them to ask if they have questions

Keep your response under 100 words, be warm and helpful.`
      : `你是旗鱼终端（SFTerm）的 AI 助手。用户正在首次使用引导向导的「导入 SSH 主机」步骤。

请用简洁友好的语言主动介绍这一步的作用，并给出操作建议：
1. 解释这步是做什么的（从 Xshell 等工具导入 SSH 主机配置）
2. 说明什么情况需要导入（之前用过 Xshell）或跳过（没有现有配置）
3. 鼓励用户有问题随时提问

回复控制在 100 字以内，保持亲切友好的语气。`,
    
    4: isEnglish
      ? `You are the AI assistant for SFTerm. The user is in the setup wizard at the "Knowledge Base Settings" step.

Please proactively introduce this step in a friendly and concise manner:
1. Explain what the knowledge base does (store documents and host memories for smarter AI assistance)
2. Explain the encryption feature (password protects sensitive data)
3. Give your recommendation (enable it for better AI experience, can skip if unsure)

Keep your response under 100 words, be warm and helpful.`
      : `你是旗鱼终端的 AI 助手。用户正在首次使用引导向导的「知识库设置」步骤。

请用简洁友好的语言介绍知识库功能的价值，以及是否建议开启：
1. 解释知识库的作用（存储文档和主机记忆，让 AI 更智能）
2. 说明加密功能（密码保护敏感数据）
3. 给出你的建议（建议开启以获得更好的体验，不确定可以先跳过）

回复控制在 100 字以内，保持亲切友好的语气。`,
    
    5: isEnglish
      ? `You are the AI assistant for SFTerm. The user is in the setup wizard at the "MCP Services" step.

Please proactively introduce this step in a friendly and concise manner:
1. Briefly explain what MCP is (Model Context Protocol, lets AI access external tools)
2. Give your recommendation for beginners (can safely skip, configure later when needed)
3. Mention it can be configured later in settings

Keep your response under 100 words, be warm and helpful.`
      : `你是旗鱼终端的 AI 助手。用户正在首次使用引导向导的「MCP 服务」步骤。

请用简洁友好的语言解释 MCP 是什么，对新手来说是否需要配置：
1. 简单解释 MCP 是什么（Model Context Protocol，让 AI 能访问外部工具）
2. 给新手的建议（可以先跳过，有需要再配置）
3. 说明可以稍后在设置中配置

回复控制在 100 字以内，保持亲切友好的语气。`,

    6: isEnglish
      ? `You are the AI assistant for SFTerm. The user has completed the setup wizard and is at the final "Complete" step.

Please congratulate them warmly and give a brief overview:
1. Celebrate completing the setup
2. Briefly explain what they can do next:
   - Click "Finish" to enter the main interface
   - Create a local terminal or connect to SSH servers
   - Chat with AI assistant on the right side for command help
   - Try Agent mode to let AI execute complex tasks automatically
3. Encourage them to explore freely, settings can be adjusted anytime

Keep your response under 120 words, be warm and encouraging.`
      : `你是旗鱼终端的 AI 助手。用户已经完成了引导向导的所有配置，现在在「完成」页面。

请热情地祝贺他们，并给出简要的使用指引：
1. 祝贺用户完成配置
2. 简单介绍接下来可以做什么：
   - 点击「完成」进入主界面
   - 新建本地终端或连接 SSH 服务器
   - 在终端右侧与 AI 助手对话，获取命令帮助
   - 尝试助手模式，让 AI 自动执行复杂任务
3. 鼓励用户大胆探索，设置随时可调整

回复控制在 120 字以内，保持热情鼓励的语气。`
  }
  
  return prompts[step] || ''
}

// 滚动到底部
const scrollToBottom = async () => {
  await nextTick()
  if (messagesRef.value) {
    messagesRef.value.scrollTop = messagesRef.value.scrollHeight
  }
}

// 发送初始指导消息
const sendInitialGuidance = async (step: number) => {
  const prompt = getStepPrompt(step)
  if (!prompt) return
  
  isLoading.value = true
  
  // 创建 AI 消息占位
  const messageId = Date.now().toString()
  streamingMessageId.value = messageId
  messages.value.push({
    id: messageId,
    role: 'assistant',
    content: ''
  })
  await scrollToBottom()
  
  let firstChunk = true
  
  // 使用流式 API
  window.electronAPI.ai.chatStream(
    [{ role: 'user', content: prompt }],
    // onChunk
    (chunk: string) => {
      const message = messages.value.find(m => m.id === messageId)
      if (message) {
        if (firstChunk) {
          message.content = chunk
          firstChunk = false
        } else {
          message.content += chunk
        }
      }
      scrollToBottom()
    },
    // onComplete
    () => {
      isLoading.value = false
      streamingMessageId.value = null
    },
    // onError
    (error: string) => {
      console.error('发送初始指导失败:', error)
      const message = messages.value.find(m => m.id === messageId)
      if (message) {
        message.content = getDefaultGuidance(step)
      }
      isLoading.value = false
      streamingMessageId.value = null
    }
  )
}

// 获取默认指导文案（AI 调用失败时使用）
const getDefaultGuidance = (step: number): string => {
  const isEnglish = locale.value === 'en-US'
  
  const defaults: Record<number, string> = {
    3: isEnglish
      ? "👋 This step helps you import SSH host configurations from Xshell or other tools. If you've used Xshell before, click 'Import' to migrate your settings. Otherwise, feel free to skip - you can add hosts later!"
      : '👋 这一步可以帮你从 Xshell 等工具导入 SSH 主机配置。如果你之前用过 Xshell，点击「导入」就能快速迁移；如果没有现有配置，可以直接跳过，稍后再手动添加主机。',
    4: isEnglish
      ? "📚 The knowledge base lets AI remember your documents and host information for smarter assistance. Enable it for a better experience! Set a password to protect your data."
      : '📚 知识库可以让 AI 记住你的文档和主机信息，提供更智能的帮助。建议开启获得更好体验！开启后需要设置密码保护数据安全。',
    5: isEnglish
      ? "🔌 MCP (Model Context Protocol) lets AI access external tools like databases and file systems. For beginners, you can safely skip this - configure it later when you need extended capabilities!"
      : '🔌 MCP（Model Context Protocol）让 AI 能访问外部工具，如数据库、文件系统等。新手可以先跳过这步，有需要时再在设置中配置！',
    6: isEnglish
      ? "🎉 Congratulations! You've completed the setup. Click 'Finish' to start using SFTerm - open a terminal, connect to servers, or chat with AI. Have fun exploring!"
      : '🎉 恭喜你完成了所有配置！点击「完成」开始使用旗鱼终端吧——打开终端、连接服务器、和 AI 对话，尽情探索！'
  }
  
  return defaults[step] || ''
}

// 发送用户消息
const sendMessage = async () => {
  const text = inputText.value.trim()
  if (!text || isLoading.value) return
  
  // 添加用户消息
  messages.value.push({
    id: Date.now().toString(),
    role: 'user',
    content: text
  })
  inputText.value = ''
  await scrollToBottom()
  
  // 发送给 AI
  isLoading.value = true
  const messageId = (Date.now() + 1).toString()
  streamingMessageId.value = messageId
  messages.value.push({
    id: messageId,
    role: 'assistant',
    content: ''
  })
  await scrollToBottom()
  
  // 构建消息历史
  const chatMessages = messages.value
    .filter(m => m.id !== messageId)
    .map(m => ({
      role: m.role as 'user' | 'assistant',
      content: m.content
    }))
  
  // 添加系统上下文（包含完整的向导步骤信息）
  const systemPrompt = locale.value === 'en-US'
    ? `You are the AI assistant for SFTerm (a smart terminal tool). The user is in the setup wizard, currently at step ${props.step}.

The setup wizard has 6 steps in total:
1. Welcome - Introduction to SFTerm features
2. Configure AI Model - Set up LLM API (required, cannot skip)
3. Import SSH Hosts - Import from Xshell or other tools (current step: ${props.step === 3})
4. Knowledge Base - Enable local knowledge base for smarter AI (current step: ${props.step === 4})
5. MCP Services - Configure Model Context Protocol servers (current step: ${props.step === 5})
6. Complete - Summary and finish

Answer their questions in a helpful and friendly manner. Keep responses concise and accurate.`
    : `你是旗鱼终端的 AI 助手。用户正在首次使用引导向导，当前在第 ${props.step} 步。

引导向导一共有 6 个步骤：
1. 欢迎页 - 介绍旗鱼终端的功能特点
2. 配置大模型 - 设置 AI 大模型 API（必须完成，不能跳过）
3. 导入 SSH 主机 - 从 Xshell 等工具导入主机配置${props.step === 3 ? '（当前步骤）' : ''}
4. 知识库设置 - 启用本地知识库让 AI 更智能${props.step === 4 ? '（当前步骤）' : ''}
5. MCP 服务 - 配置 Model Context Protocol 服务器${props.step === 5 ? '（当前步骤）' : ''}
6. 完成 - 配置总结，开始使用

请友好地回答用户的问题，保持简洁准确。`
  
  const messagesWithSystem = [
    { role: 'system' as const, content: systemPrompt },
    ...chatMessages
  ]
  
  let firstChunk = true
  
  window.electronAPI.ai.chatStream(
    messagesWithSystem,
    // onChunk
    (chunk: string) => {
      const message = messages.value.find(m => m.id === messageId)
      if (message) {
        if (firstChunk) {
          message.content = chunk
          firstChunk = false
        } else {
          message.content += chunk
        }
      }
      scrollToBottom()
    },
    // onComplete
    () => {
      isLoading.value = false
      streamingMessageId.value = null
    },
    // onError
    (error: string) => {
      console.error('发送消息失败:', error)
      const message = messages.value.find(m => m.id === messageId)
      if (message) {
        message.content = locale.value === 'en-US' 
          ? '⚠️ Failed to get response. Please try again.'
          : '⚠️ 获取回复失败，请重试。'
      }
      isLoading.value = false
      streamingMessageId.value = null
    }
  )
}

// 处理键盘事件
const handleKeydown = (e: KeyboardEvent) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault()
    sendMessage()
  }
}

// 步骤变化时，清空对话并发送初始消息
watch(() => props.step, async (newStep) => {
  messages.value = []
  await sendInitialGuidance(newStep)
}, { immediate: true })

// 组件挂载时聚焦输入框
onMounted(() => {
  nextTick(() => {
    inputRef.value?.focus()
  })
})
</script>

<template>
  <div class="setup-ai-guide">
    <!-- 标题栏 -->
    <div class="guide-header">
      <Bot :size="18" class="guide-icon" />
      <span class="guide-title">{{ t('setup.aiGuide.title') }}</span>
    </div>
    
    <!-- 消息列表 -->
    <div ref="messagesRef" class="guide-messages">
      <div 
        v-for="message in messages" 
        :key="message.id"
        class="message"
        :class="message.role"
      >
        <div class="message-content">
          <!-- 思考过程（可折叠，默认展开） -->
          <div 
            v-if="parseMessageContent(message.content).thinking"
            class="thinking-section"
          >
            <div 
              class="thinking-toggle"
              @click="toggleThinking(message.id)"
            >
              <span class="thinking-icon">💭</span>
              <span class="thinking-label">{{ isThinkingExpanded(message.id) ? '收起思考过程' : '查看思考过程' }}</span>
              <span class="thinking-arrow">{{ isThinkingExpanded(message.id) ? '▲' : '▼' }}</span>
            </div>
            <div 
              v-if="isThinkingExpanded(message.id)"
              class="thinking-content"
            >
              {{ parseMessageContent(message.content).thinking }}
            </div>
          </div>
          <!-- 正式回复（markdown 渲染） -->
          <div 
            v-if="parseMessageContent(message.content).reply"
            class="reply-content"
            v-html="renderMarkdown(parseMessageContent(message.content).reply)"
          ></div>
          <span 
            v-if="message.id === streamingMessageId && isLoading" 
            class="cursor-blink"
          >▊</span>
        </div>
      </div>
      
      <!-- 加载中提示 -->
      <div v-if="isLoading && messages.length === 0" class="loading-hint">
        <Loader2 :size="16" class="spin" />
        <span>{{ t('setup.aiGuide.thinking') }}</span>
      </div>
    </div>
    
    <!-- 输入区域 -->
    <div class="guide-input">
      <textarea
        ref="inputRef"
        v-model="inputText"
        :placeholder="t('setup.aiGuide.placeholder')"
        :disabled="isLoading"
        @keydown="handleKeydown"
        rows="2"
      />
      <button 
        class="send-btn"
        :disabled="!inputText.trim() || isLoading"
        @click="sendMessage"
      >
        <ArrowUp :size="18" />
      </button>
    </div>
  </div>
</template>

<style scoped>
.setup-ai-guide {
  width: 320px;
  display: flex;
  flex-direction: column;
  background: var(--bg-secondary);
  border-left: 1px solid var(--border-color);
  overflow: hidden;
}

.guide-header {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 16px;
  border-bottom: 1px solid var(--border-color);
}

.guide-icon {
  color: var(--accent-primary);
}

.guide-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.guide-messages {
  flex: 1;
  overflow-y: auto;
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.message {
  display: flex;
}

.message.user {
  justify-content: flex-end;
}

.message.assistant {
  justify-content: flex-start;
}

.message-content {
  max-width: 90%;
  padding: 10px 14px;
  border-radius: 12px;
  font-size: 13px;
  line-height: 1.6;
  white-space: pre-wrap;
  word-break: break-word;
}

.message.user .message-content {
  background: var(--accent-primary);
  color: white;
  border-bottom-right-radius: 4px;
}

.message.assistant .message-content {
  background: var(--bg-tertiary);
  color: var(--text-primary);
  border-bottom-left-radius: 4px;
}

/* 思考过程样式 */
.thinking-section {
  margin-bottom: 8px;
  border-bottom: 1px dashed var(--border-color);
  padding-bottom: 8px;
}

.thinking-toggle {
  display: flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: 12px;
  color: var(--text-secondary);
  user-select: none;
  padding: 4px 0;
}

.thinking-toggle:hover {
  color: var(--text-primary);
}

.thinking-icon {
  font-size: 14px;
}

.thinking-label {
  flex: 1;
}

.thinking-arrow {
  font-size: 10px;
  opacity: 0.7;
}

.thinking-content {
  font-size: 12px;
  color: var(--text-secondary);
  background: var(--bg-secondary);
  padding: 8px 10px;
  border-radius: 6px;
  margin-top: 6px;
  line-height: 1.5;
  max-height: 200px;
  overflow-y: auto;
}

/* Markdown 渲染的回复内容样式 */
.reply-content {
  line-height: 1.5;
}

.reply-content :deep(p) {
  margin: 0 0 6px 0;
}

.reply-content :deep(p:last-child) {
  margin-bottom: 0;
}

/* 去掉 "💬 回复" 等标题的多余间距 */
.reply-content :deep(h1),
.reply-content :deep(h2),
.reply-content :deep(h3),
.reply-content :deep(h4) {
  margin: 0 0 6px 0;
  font-size: 13px;
  font-weight: 600;
}

.reply-content :deep(ul),
.reply-content :deep(ol) {
  margin: 4px 0;
  padding-left: 18px;
}

.reply-content :deep(li) {
  margin: 2px 0;
}

.reply-content :deep(li p) {
  margin: 0;
}

.reply-content :deep(code) {
  background: var(--bg-secondary);
  padding: 2px 6px;
  border-radius: 4px;
  font-size: 12px;
  font-family: 'Monaco', 'Menlo', monospace;
}

.reply-content :deep(hr) {
  border: none;
  border-top: 1px dashed var(--border-color);
  margin: 12px 0;
}

.reply-content :deep(strong) {
  font-weight: 600;
}

.cursor-blink {
  animation: blink 1s infinite;
  color: var(--accent-primary);
}

@keyframes blink {
  0%, 50% { opacity: 1; }
  51%, 100% { opacity: 0; }
}

.loading-hint {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px;
  color: var(--text-muted);
  font-size: 13px;
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.guide-input {
  display: flex;
  gap: 8px;
  padding: 12px;
  border-top: 1px solid var(--border-color);
  background: var(--bg-primary);
}

.guide-input textarea {
  flex: 1;
  padding: 10px 12px;
  font-size: 13px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--bg-tertiary);
  color: var(--text-primary);
  resize: none;
  font-family: inherit;
}

.guide-input textarea:focus {
  outline: none;
  border-color: var(--accent-primary);
}

.guide-input textarea:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.send-btn {
  width: 38px;
  height: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 8px;
  background: var(--accent-primary);
  color: white;
  cursor: pointer;
  transition: all 0.2s ease;
  flex-shrink: 0;
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.1);
}

.send-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
</style>

