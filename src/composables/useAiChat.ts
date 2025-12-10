/**
 * AI 对话 composable
 * 处理普通对话模式的消息发送、命令解释、命令生成等
 */
import { ref, computed, nextTick, watch, Ref } from 'vue'
import { useTerminalStore } from '../stores/terminal'
import type { AiMessage } from '../stores/terminal'

// 判断用户是否在底部附近的阈值（像素）
const SCROLL_THRESHOLD = 100

export function useAiChat(
  getDocumentContext: () => Promise<string>,
  messagesRef: Ref<HTMLDivElement | null>
) {
  const terminalStore = useTerminalStore()
  const inputText = ref('')
  
  // 是否有新消息（用户不在底部时显示提示）
  const hasNewMessage = ref(false)

  // 当前终端的 AI 消息（每个终端独立）
  const messages = computed(() => {
    const activeTab = terminalStore.activeTab
    return activeTab?.aiMessages || []
  })

  // 当前终端 ID
  const currentTabId = computed(() => terminalStore.activeTabId)

  // 用户是否在底部附近（从 store 获取，每个终端独立）
  const isUserNearBottom = computed(() => {
    const tabId = currentTabId.value
    if (!tabId) return true
    return terminalStore.getAiScrollNearBottom(tabId)
  })

  // 设置当前 tab 的 isUserNearBottom 状态
  const setIsUserNearBottom = (value: boolean) => {
    const tabId = currentTabId.value
    if (tabId) {
      terminalStore.setAiScrollNearBottom(tabId, value)
    }
  }

  // 当切换 tab 时，重置新消息提示（因为每个 tab 的滚动位置是独立的）
  watch(currentTabId, () => {
    hasNewMessage.value = false
  })

  // 获取当前终端信息（用于历史记录）
  const getTerminalInfo = () => {
    const activeTab = terminalStore.activeTab
    if (!activeTab) return null
    return {
      terminalId: activeTab.id,
      terminalType: activeTab.type as 'local' | 'ssh',
      sshHost: activeTab.sshConfig?.host
    }
  }

  // 当前终端的 AI 加载状态（每个终端独立）
  const isLoading = computed(() => {
    const activeTab = terminalStore.activeTab
    return activeTab?.aiLoading || false
  })

  // 获取当前终端的系统信息
  const currentSystemInfo = computed(() => {
    const activeTab = terminalStore.activeTab
    if (activeTab?.systemInfo) {
      return activeTab.systemInfo
    }
    return null
  })

  // 获取当前终端选中的文本
  const terminalSelectedText = computed(() => {
    return terminalStore.activeTab?.selectedText || ''
  })

  // 获取最近的错误
  const lastError = computed(() => {
    return terminalStore.activeTab?.lastError
  })

  // 检查用户是否在底部附近
  const checkIsNearBottom = () => {
    if (!messagesRef.value) return true
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.value
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    const nearBottom = checkIsNearBottom()
    setIsUserNearBottom(nearBottom)
    // 如果用户滚动到底部，清除新消息提示
    if (nearBottom) {
      hasNewMessage.value = false
    }
  }

  // 强制滚动到底部（用户主动点击时调用）
  const scrollToBottom = async () => {
    await nextTick()
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
    hasNewMessage.value = false
    setIsUserNearBottom(true)
  }

  // 智能滚动：只有用户在底部附近时才自动滚动
  const scrollToBottomIfNeeded = async () => {
    await nextTick()
    if (isUserNearBottom.value) {
      if (messagesRef.value) {
        messagesRef.value.scrollTop = messagesRef.value.scrollHeight
      }
    } else {
      // 用户在上方查看历史，显示新消息提示
      hasNewMessage.value = true
    }
  }

  // 生成系统信息的提示词
  const getSystemPrompt = () => {
    const info = currentSystemInfo.value
    let systemContext = ''
    
    if (info) {
      const osNames: Record<string, string> = {
        windows: 'Windows',
        linux: 'Linux',
        macos: 'macOS',
        unknown: '未知操作系统'
      }
      const shellNames: Record<string, string> = {
        powershell: 'PowerShell',
        cmd: 'CMD (命令提示符)',
        bash: 'Bash',
        zsh: 'Zsh',
        sh: 'Shell',
        unknown: '未知 Shell'
      }
      
      systemContext = `

【重要：系统环境约束】
- 操作系统：${osNames[info.os]}
- Shell 类型：${shellNames[info.shell]}
你必须严格按照上述环境生成命令。禁止使用其他系统的命令语法。
例如：Linux/macOS 使用 ls、cat、grep；Windows CMD 使用 dir、type、findstr；PowerShell 使用 Get-ChildItem、Get-Content、Select-String。
`
    } else {
      systemContext = `当前操作系统平台: ${navigator.platform}。`
    }
    
    return `你是旗鱼终端的 AI 助手，专门帮助运维人员解决命令行相关问题。${systemContext}请用中文回答，回答要简洁实用。`
  }

  // 发送消息
  const sendMessage = async () => {
    if (!inputText.value.trim() || isLoading.value || !currentTabId.value) return

    const tabId = currentTabId.value
    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: inputText.value,
      timestamp: new Date()
    }

    terminalStore.addAiMessage(tabId, userMessage)
    inputText.value = ''
    terminalStore.setAiLoading(tabId, true)
    // 发送消息时强制滚动到底部
    await scrollToBottom()

    // 创建 AI 响应占位
    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '思考中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    try {
      let firstChunk = true
      
      // 构建包含历史对话的消息列表
      const currentMessages = terminalStore.getAiMessages(tabId)
      // 过滤掉占位消息（内容包含"中..."的），并转换格式
      const historyMessages = currentMessages
        .filter(msg => !msg.content.includes('中...'))
        .map(msg => ({
          role: msg.role as 'user' | 'assistant',
          content: msg.content
        }))
      
      // 获取文档上下文
      const documentContext = await getDocumentContext()
      
      // 构建系统提示词（包含文档上下文）
      let systemPrompt = getSystemPrompt()
      if (documentContext) {
        systemPrompt += `\n\n${documentContext}`
      }
      
      // 使用流式响应，传入 tabId 作为 requestId 支持多终端同时请求
      window.electronAPI.ai.chatStream(
        [
          {
            role: 'system',
            content: systemPrompt
          },
          ...historyMessages
        ],
        chunk => {
          const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
          if (firstChunk) {
            terminalStore.updateAiMessage(tabId, messageIndex, chunk)
            firstChunk = false
          } else {
            terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
          }
          // 流式响应时使用智能滚动，不打断用户查看历史
          scrollToBottomIfNeeded()
        },
        () => {
          terminalStore.setAiLoading(tabId, false)
          scrollToBottomIfNeeded()
          
          // 保存聊天记录
          const terminalInfo = getTerminalInfo()
          if (terminalInfo) {
            const finalContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
            window.electronAPI.history.saveChatRecords([
              {
                id: userMessage.id,
                timestamp: userMessage.timestamp.getTime(),
                ...terminalInfo,
                role: 'user',
                content: userMessage.content
              },
              {
                id: assistantMessage.id,
                timestamp: Date.now(),
                ...terminalInfo,
                role: 'assistant',
                content: finalContent
              }
            ])
          }
        },
        error => {
          terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
          terminalStore.setAiLoading(tabId, false)
        },
        undefined,  // profileId
        tabId       // requestId - 使用 tabId 区分不同终端的请求
      )
    } catch (error) {
      terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
      terminalStore.setAiLoading(tabId, false)
    }
  }

  // 解释命令
  const explainCommand = async (command: string) => {
    if (isLoading.value || !currentTabId.value) return

    const tabId = currentTabId.value
    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: `请解释这个命令：\`${command}\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '分析中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    let firstChunk = true
    const info = currentSystemInfo.value
    const osContext = info 
      ? `【系统环境】操作系统: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}，Shell: ${info.shell}。请基于此环境解释命令。` 
      : ''
    
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `你是一个专业的系统管理员助手。${osContext}用户会给你一个命令，请用中文简洁地解释这个命令的作用、参数含义，以及可能的注意事项。`
        },
        { role: 'user', content: `请解释这个命令：\n\`\`\`\n${command}\n\`\`\`` }
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottomIfNeeded()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottomIfNeeded()
      },
      error => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 生成命令
  const generateCommand = async (description: string) => {
    if (isLoading.value || !currentTabId.value) return

    const tabId = currentTabId.value
    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: description,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '生成中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    let firstChunk = true
    const info = currentSystemInfo.value
    let systemContext = ''
    if (info) {
      const osNames: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: '未知' }
      const shellNames: Record<string, string> = { powershell: 'PowerShell', cmd: 'CMD', bash: 'Bash', zsh: 'Zsh', sh: 'Shell', unknown: '未知' }
      systemContext = `【重要：系统环境约束】操作系统: ${osNames[info.os]}，Shell: ${shellNames[info.shell]}。你必须生成适合该环境的命令，禁止使用其他系统的命令。`
    } else {
      systemContext = `当前操作系统平台: ${navigator.platform}。`
    }
    
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `你是一个专业的命令行助手。${systemContext} 用户会用自然语言描述他想做的事情，请生成对应的命令并简要解释。`
        },
        { role: 'user', content: description }
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottomIfNeeded()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottomIfNeeded()
      },
      error => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${error}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 停止生成
  const stopGeneration = async () => {
    if (currentTabId.value) {
      // 传入 tabId 只中止当前终端的请求，不影响其他终端
      await window.electronAPI.ai.abort(currentTabId.value)
      terminalStore.setAiLoading(currentTabId.value, false)
    }
  }

  // 诊断错误
  const diagnoseError = async (agentModeRef: Ref<boolean>) => {
    const error = lastError.value
    if (!error || isLoading.value || !currentTabId.value) return

    const tabId = currentTabId.value
    
    // 切换到对话模式
    agentModeRef.value = false
    
    // 清除错误提示
    if (terminalStore.activeTab) {
      terminalStore.clearError(terminalStore.activeTab.id)
    }

    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: `请帮我分析这个错误：\n\`\`\`\n${error.content}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '诊断中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `【系统环境】操作系统: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}，Shell: ${info.shell}。请基于此环境分析错误和提供解决方案。` 
      : ''

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `你是一个专业的运维工程师助手。${osContext}用户会给你一个错误信息，请用中文分析错误原因，并提供可能的解决方案。`
        },
        { role: 'user', content: `请分析这个错误并提供解决方案：\n\`\`\`\n${error.content}\n\`\`\`` }
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottomIfNeeded()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottomIfNeeded()
      },
      err => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 分析选中的终端内容
  const analyzeSelection = async (agentModeRef: Ref<boolean>) => {
    const selection = terminalSelectedText.value
    if (!selection || isLoading.value || !currentTabId.value) return

    // 切换到对话模式
    agentModeRef.value = false

    const tabId = currentTabId.value
    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: `请帮我分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '分析中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `【系统环境】操作系统: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}，Shell: ${info.shell}。请基于此环境分析内容。` 
      : ''

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `你是一个专业的运维工程师助手。${osContext}用户会给你一段终端输出，请用中文分析这段内容，解释其含义，如果有错误请提供解决方案。`
        },
        { role: 'user', content: `请分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\`` }
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottomIfNeeded()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottomIfNeeded()
      },
      err => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 分析从右键菜单发来的终端内容
  const analyzeTerminalContent = async (text: string) => {
    if (!text || isLoading.value || !currentTabId.value) return

    const tabId = currentTabId.value
    const userMessage: AiMessage = {
      id: Date.now().toString(),
      role: 'user',
      content: `请帮我分析这段终端内容：\n\`\`\`\n${text}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: '分析中...',
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `【系统环境】操作系统: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}，Shell: ${info.shell}。请基于此环境分析内容。` 
      : ''

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `你是一个专业的运维工程师助手。${osContext}用户会给你一段终端内容，请用中文分析这段内容，解释其含义，如果有错误请提供解决方案。`
        },
        { role: 'user', content: `请分析这段终端内容：\n\`\`\`\n${text}\n\`\`\`` }
      ],
      chunk => {
        const currentContent = terminalStore.getAiMessages(tabId)[messageIndex]?.content || ''
        if (firstChunk) {
          terminalStore.updateAiMessage(tabId, messageIndex, chunk)
          firstChunk = false
        } else {
          terminalStore.updateAiMessage(tabId, messageIndex, currentContent + chunk)
        }
        scrollToBottomIfNeeded()
      },
      () => {
        terminalStore.setAiLoading(tabId, false)
        scrollToBottomIfNeeded()
      },
      err => {
        terminalStore.updateAiMessage(tabId, messageIndex, `错误: ${err}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 快捷操作
  const quickActions = [
    { label: '解释命令', icon: '💡', action: () => explainCommand(terminalSelectedText.value || 'ls -la') },
    { label: '查找文件', icon: '🔍', action: () => generateCommand('查找当前目录下所有的日志文件') },
    { label: '查看进程', icon: '📊', action: () => generateCommand('查看占用内存最多的前10个进程') },
    { label: '磁盘空间', icon: '💾', action: () => generateCommand('查看磁盘空间使用情况') }
  ]

  return {
    inputText,
    messages,
    currentTabId,
    isLoading,
    currentSystemInfo,
    terminalSelectedText,
    lastError,
    // 滚动相关
    hasNewMessage,
    isUserNearBottom,
    updateScrollPosition,
    scrollToBottom,
    scrollToBottomIfNeeded,
    // 其他方法
    getTerminalInfo,
    sendMessage,
    explainCommand,
    generateCommand,
    stopGeneration,
    diagnoseError,
    analyzeSelection,
    analyzeTerminalContent,
    quickActions
  }
}
