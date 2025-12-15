/**
 * AI 对话 composable
 * 处理普通对话模式的消息发送、命令解释、命令生成等
 * 每个 tab 有独立的 AiPanel 实例，tabId 通过参数传入
 */
import { ref, computed, nextTick, Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '../stores/terminal'
import type { AiMessage } from '../stores/terminal'

// 判断用户是否在底部附近的阈值（像素）
const SCROLL_THRESHOLD = 100
// 滚动节流间隔（毫秒）
const SCROLL_THROTTLE_MS = 1000

/**
 * 检测文本的语言
 * 返回 'zh' (中文), 'en' (英文/拉丁语系), 或 'other' (其他)
 */
function detectLanguage(text: string): 'zh' | 'en' | 'other' {
  // 统计中文字符数量
  const chineseChars = (text.match(/[\u4e00-\u9fff]/g) || []).length
  // 统计日文假名数量
  const japaneseChars = (text.match(/[\u3040-\u309f\u30a0-\u30ff]/g) || []).length
  // 统计韩文字符数量
  const koreanChars = (text.match(/[\uac00-\ud7af]/g) || []).length
  // 统计拉丁字母数量
  const latinChars = (text.match(/[a-zA-Z]/g) || []).length
  // 总字符数（去除空格和标点）
  const totalChars = text.replace(/[\s\p{P}]/gu, '').length || 1
  
  // 计算各语言占比
  const chineseRatio = chineseChars / totalChars
  const japaneseRatio = japaneseChars / totalChars
  const koreanRatio = koreanChars / totalChars
  const latinRatio = latinChars / totalChars
  
  // 判断语言
  if (chineseRatio > 0.3) return 'zh'
  if (japaneseRatio > 0.2) return 'other'  // 日语
  if (koreanRatio > 0.2) return 'other'    // 韩语
  if (latinRatio > 0.5) return 'en'        // 英语/拉丁语系
  return 'zh'  // 默认中文
}

/**
 * 根据检测到的语言生成语言提示
 */
function getLanguageHint(lang: 'zh' | 'en' | 'other'): string {
  if (lang === 'en') {
    return '[Respond in English]\n'
  } else if (lang === 'other') {
    return '[Respond in the same language as the user]\n'
  }
  return ''  // 中文不需要特别提示
}

// 语言规则（与 Agent 保持一致）
const LANGUAGE_RULE = '**CRITICAL RULE: You MUST respond in the SAME language the user uses. If user writes in English, reply in English. If user writes in Japanese, reply in Japanese. If user writes in Chinese, reply in Chinese.**\n\n'

export function useAiChat(
  getDocumentContext: () => Promise<string>,
  messagesRef: Ref<HTMLDivElement | null>,
  tabId: Ref<string>  // 每个 AiPanel 实例固定绑定的 tab ID
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()
  const inputText = ref('')
  
  // 是否有新消息（用户不在底部时显示提示）
  const hasNewMessage = ref(false)

  // 当前终端 ID（使用传入的 tabId，不再依赖 activeTabId）
  const currentTabId = tabId

  // 当前终端的 AI 消息（基于固定的 tabId）
  const messages = computed(() => {
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    return tab?.aiMessages || []
  })

  // 用户是否在底部附近（从 store 获取，每个终端独立）
  const isUserNearBottom = computed(() => {
    const id = currentTabId.value
    if (!id) return true
    return terminalStore.getAiScrollNearBottom(id)
  })

  // 设置当前 tab 的 isUserNearBottom 状态
  const setIsUserNearBottom = (value: boolean) => {
    const id = currentTabId.value
    if (id) {
      terminalStore.setAiScrollNearBottom(id, value)
    }
  }

  // 每个 tab 有独立的 AiPanel 实例，不需要切换 tab 时保存/恢复滚动位置
  // 滚动位置由 DOM 元素自然保持

  // 标志：是否跳过 scroll 事件的状态更新（用于避免强制滚动时被 scroll 事件覆盖）
  let skipScrollUpdate = false

  // 获取当前 tab（基于固定的 tabId）
  const currentTab = computed(() => {
    return terminalStore.tabs.find(t => t.id === currentTabId.value)
  })

  // 获取当前终端信息（用于历史记录）
  const getTerminalInfo = () => {
    const tab = currentTab.value
    if (!tab) return null
    return {
      terminalId: tab.id,
      terminalType: tab.type as 'local' | 'ssh',
      sshHost: tab.sshConfig?.host
    }
  }

  // 当前终端的 AI 加载状态（每个终端独立）
  const isLoading = computed(() => {
    return currentTab.value?.aiLoading || false
  })

  // 获取当前终端的系统信息
  const currentSystemInfo = computed(() => {
    const tab = currentTab.value
    if (tab?.systemInfo) {
      return tab.systemInfo
    }
    return null
  })

  // 获取当前终端选中的文本
  const terminalSelectedText = computed(() => {
    return currentTab.value?.selectedText || ''
  })

  // 获取最近的错误
  const lastError = computed(() => {
    return currentTab.value?.lastError
  })

  // 检查用户是否在底部附近
  const checkIsNearBottom = () => {
    if (!messagesRef.value) return true
    const { scrollTop, scrollHeight, clientHeight } = messagesRef.value
    return scrollHeight - scrollTop - clientHeight < SCROLL_THRESHOLD
  }

  // 更新用户滚动位置状态（由组件的 scroll 事件调用）
  const updateScrollPosition = () => {
    // 跳过强制滚动期间的状态更新，避免被 scroll 事件覆盖
    if (skipScrollUpdate) return
    const nearBottom = checkIsNearBottom()
    setIsUserNearBottom(nearBottom)
    // 如果用户滚动到底部，清除新消息提示
    if (nearBottom) {
      hasNewMessage.value = false
    }
  }

  // 强制滚动到底部（用户主动发送消息或点击时调用）
  const scrollToBottom = async () => {
    // 先设置状态，防止被 scroll 事件覆盖
    skipScrollUpdate = true
    setIsUserNearBottom(true)
    hasNewMessage.value = false
    
    await nextTick()
    if (messagesRef.value) {
      messagesRef.value.scrollTop = messagesRef.value.scrollHeight
    }
    
    // 延迟恢复 scroll 事件更新，确保滚动完成后才开始监听用户滚动
    requestAnimationFrame(() => {
      skipScrollUpdate = false
    })
  }

  // 智能滚动节流状态
  let scrollPending = false
  let lastScrollTime = 0

  // 智能滚动：只有用户在底部附近时才自动滚动（带节流）
  const scrollToBottomIfNeeded = async () => {
    const now = Date.now()
    
    // 节流：如果距离上次滚动时间过短，标记为待处理
    if (now - lastScrollTime < SCROLL_THROTTLE_MS) {
      if (!scrollPending) {
        scrollPending = true
        requestAnimationFrame(() => {
          scrollPending = false
          doScrollIfNeeded()
        })
      }
      return
    }
    
    await doScrollIfNeeded()
  }

  // 实际执行滚动
  const doScrollIfNeeded = async () => {
    lastScrollTime = Date.now()
    await nextTick()
    
    // 在执行滚动前再次检测是否在底部附近
    // 这样可以避免内容突然增加导致的误判
    const nearBottomNow = checkIsNearBottom()
    
    if (isUserNearBottom.value || nearBottomNow) {
      if (messagesRef.value) {
        // 滚动期间跳过状态更新，避免 scroll 事件错误地更新状态
        skipScrollUpdate = true
        setIsUserNearBottom(true)
        hasNewMessage.value = false
        
        messagesRef.value.scrollTop = messagesRef.value.scrollHeight
        
        // 延迟恢复 scroll 事件监听，等待滚动完成
        // 使用 50ms 延迟，确保滚动动画完成，同时不影响用户后续手动滚动
        setTimeout(() => {
          skipScrollUpdate = false
        }, 50)
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
        unknown: 'Unknown OS'
      }
      const shellNames: Record<string, string> = {
        powershell: 'PowerShell',
        cmd: 'CMD',
        bash: 'Bash',
        zsh: 'Zsh',
        sh: 'Shell',
        unknown: 'Unknown Shell'
      }
      
      systemContext = `

[System Environment]
- OS: ${osNames[info.os]}
- Shell: ${shellNames[info.shell]}
You must generate commands strictly for this environment. Do not use syntax from other systems.
Examples: Linux/macOS uses ls, cat, grep; Windows CMD uses dir, type, findstr; PowerShell uses Get-ChildItem, Get-Content, Select-String.
`
    } else {
      systemContext = `Current platform: ${navigator.platform}.`
    }
    
    return `${LANGUAGE_RULE}You are the AI assistant of SFTerm (旗鱼终端), helping operations engineers solve command-line problems.${systemContext}Be concise and practical.`
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
      // 对最后一条用户消息添加语言提示
      const historyMessages = currentMessages
        .filter(msg => !msg.content.includes('中...'))
        .map((msg, idx, arr) => {
          // 检测最后一条用户消息的语言并添加语言提示
          if (msg.role === 'user' && idx === arr.length - 1) {
            const lang = detectLanguage(msg.content)
            const hint = getLanguageHint(lang)
            return {
              role: msg.role as 'user' | 'assistant',
              content: hint + msg.content
            }
          }
          return {
            role: msg.role as 'user' | 'assistant',
            content: msg.content
          }
        })
      
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
      ? `[System Environment] OS: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}, Shell: ${info.shell}. Explain the command based on this environment.` 
      : ''
    
    // 检测用户消息语言（这里根据命令内容或上下文检测）
    const userContent = `请解释这个命令：\n\`\`\`\n${command}\n\`\`\``
    const lang = detectLanguage(userContent)
    const languageHint = getLanguageHint(lang)
    
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `${LANGUAGE_RULE}You are a professional system administrator assistant.${osContext} The user will give you a command. Concisely explain what the command does, the meaning of its parameters, and any important notes.`
        },
        { role: 'user', content: languageHint + userContent }
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
      const osNames: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: 'Unknown' }
      const shellNames: Record<string, string> = { powershell: 'PowerShell', cmd: 'CMD', bash: 'Bash', zsh: 'Zsh', sh: 'Shell', unknown: 'Unknown' }
      systemContext = `[System Environment] OS: ${osNames[info.os]}, Shell: ${shellNames[info.shell]}. You must generate commands for this environment only.`
    } else {
      systemContext = `Current platform: ${navigator.platform}.`
    }
    
    // 检测用户描述的语言
    const lang = detectLanguage(description)
    const languageHint = getLanguageHint(lang)
    
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `${LANGUAGE_RULE}You are a professional command-line assistant. ${systemContext} The user will describe what they want to do in natural language. Generate the corresponding command and briefly explain it.`
        },
        { role: 'user', content: languageHint + description }
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
      content: `${t('ai.analyzeErrorPrompt')}\n\`\`\`\n${error.content}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: t('ai.diagnosing'),
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `[System Environment] OS: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}, Shell: ${info.shell}. Analyze the error and provide solutions based on this environment.` 
      : ''

    // 检测用户消息语言
    const userContent = `请分析这个错误并提供解决方案：\n\`\`\`\n${error.content}\n\`\`\``
    const lang = detectLanguage(userContent)
    const languageHint = getLanguageHint(lang)

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `${LANGUAGE_RULE}You are a professional operations engineer assistant. ${osContext} The user will give you an error message. Analyze the error cause and provide possible solutions.`
        },
        { role: 'user', content: languageHint + userContent }
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
        terminalStore.updateAiMessage(tabId, messageIndex, `${t('ai.errorPrefix')} ${err}`)
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
      content: `${t('ai.analyzeOutputPrompt')}\n\`\`\`\n${selection}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: t('ai.analyzing'),
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `[System Environment] OS: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}, Shell: ${info.shell}. Analyze content based on this environment.` 
      : ''

    // 检测用户消息语言
    const userContent = `请分析这段终端输出：\n\`\`\`\n${selection}\n\`\`\``
    const lang = detectLanguage(userContent)
    const languageHint = getLanguageHint(lang)

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `${LANGUAGE_RULE}You are a professional operations engineer assistant. ${osContext} The user will give you terminal output. Analyze this content, explain its meaning, and provide solutions if there are errors.`
        },
        { role: 'user', content: languageHint + userContent }
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
        terminalStore.updateAiMessage(tabId, messageIndex, `${t('ai.errorPrefix')} ${err}`)
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
      content: `${t('ai.analyzeContentPrompt')}\n\`\`\`\n${text}\n\`\`\``,
      timestamp: new Date()
    }
    terminalStore.addAiMessage(tabId, userMessage)
    terminalStore.setAiLoading(tabId, true)
    await scrollToBottom()

    const assistantMessage: AiMessage = {
      id: (Date.now() + 1).toString(),
      role: 'assistant',
      content: t('ai.analyzing'),
      timestamp: new Date()
    }
    const messageIndex = terminalStore.addAiMessage(tabId, assistantMessage)
    await scrollToBottom()

    const info = currentSystemInfo.value
    const osContext = info 
      ? `[System Environment] OS: ${info.os === 'windows' ? 'Windows' : info.os === 'macos' ? 'macOS' : 'Linux'}, Shell: ${info.shell}. Analyze content based on this environment.` 
      : ''

    // 检测用户消息语言
    const userContent = `请分析这段终端内容：\n\`\`\`\n${text}\n\`\`\``
    const lang = detectLanguage(userContent)
    const languageHint = getLanguageHint(lang)

    let firstChunk = true
    window.electronAPI.ai.chatStream(
      [
        {
          role: 'system',
          content: `${LANGUAGE_RULE}You are a professional operations engineer assistant. ${osContext} The user will give you terminal content. Analyze this content, explain its meaning, and provide solutions if there are errors.`
        },
        { role: 'user', content: languageHint + userContent }
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
        terminalStore.updateAiMessage(tabId, messageIndex, `${t('ai.errorPrefix')} ${err}`)
        terminalStore.setAiLoading(tabId, false)
      },
      undefined,
      tabId
    )
  }

  // 快捷操作
  const quickActions = computed(() => [
    { label: t('ai.quickActions.explainCommand'), icon: '💡', action: () => explainCommand(terminalSelectedText.value || 'ls -la') },
    { label: t('ai.quickActions.findFiles'), icon: '🔍', action: () => generateCommand(t('ai.quickActionPrompts.findFiles')) },
    { label: t('ai.quickActions.viewProcesses'), icon: '📊', action: () => generateCommand(t('ai.quickActionPrompts.viewProcesses')) },
    { label: t('ai.quickActions.diskSpace'), icon: '💾', action: () => generateCommand(t('ai.quickActionPrompts.diskSpace')) }
  ])

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
