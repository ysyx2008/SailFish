/**
 * @ 命令（提及）composable
 * 处理输入框中的 @ 命令，支持文件引用和文档引用
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useI18n } from 'vue-i18n'
import { useTerminalStore } from '../stores/terminal'
import type { ParsedDocument } from '../stores/terminal'

// @ 命令类型
export type MentionType = 'file' | 'docs'

// @ 命令定义
export interface MentionCommand {
  type: MentionType
  name: string           // 显示名称
  aliases: string[]      // 可识别的别名（包含 @）
  icon: string           // 图标
  description: string    // 描述
}

// 补全建议项
export interface MentionSuggestion {
  type: MentionType
  id: string             // 唯一标识
  label: string          // 显示标签
  value: string          // 插入值（完整的 @file:xxx）
  icon: string           // 图标
  description?: string   // 描述（如文件大小、路径等）
  data?: unknown         // 附加数据
}

// 已选择的 @ 引用
export interface SelectedMention {
  type: MentionType
  id: string
  label: string
  value: string          // 原始 @ 引用（如 @file:path/to/file）
  content?: string       // 展开后的内容（延迟加载）
  icon: string
}

// 文件信息（用于文件补全）
export interface FileInfo {
  name: string
  path: string
  isDirectory: boolean
  size?: number
}

export function useMentions(
  inputText: Ref<string>,
  currentTabId: Ref<string> | ComputedRef<string>,
  uploadedDocs: ComputedRef<ParsedDocument[]>
) {
  const { t } = useI18n()
  const terminalStore = useTerminalStore()

  // ==================== 状态 ====================
  
  // 是否显示补全菜单
  const showMenu = ref(false)
  // 当前菜单类型（null 表示显示命令列表，否则显示具体类型的补全）
  const menuType = ref<MentionType | null>(null)
  // 补全建议列表
  const suggestions = ref<MentionSuggestion[]>([])
  // 当前选中的建议索引
  const selectedIndex = ref(0)
  // 加载中
  const isLoading = ref(false)
  // 是否有更多结果（超出显示限制）
  const hasMore = ref(false)
  const totalCount = ref(0)
  // 当前 @ 触发位置（用于替换）
  const triggerPosition = ref(-1)
  // 当前搜索关键词
  const searchQuery = ref('')
  // 已选择的 @ 引用列表
  const selectedMentions = ref<SelectedMention[]>([])
  // 文件补全的当前目录
  const currentDir = ref('')
  // 知识库文档缓存
  const knowledgeDocs = ref<Array<{ id: string; filename: string; hostId?: string; tags?: string[] }>>([])

  // ==================== 命令定义 ====================

  const commands = computed<MentionCommand[]>(() => [
    {
      type: 'file',
      name: t('mentions.file'),
      aliases: ['@file', '@文件', '@f'],
      icon: '📄',
      description: t('mentions.fileDesc')
    },
    {
      type: 'docs',
      name: t('mentions.docs'),
      aliases: ['@docs', '@文档', '@doc', '@d'],
      icon: '📚',
      description: t('mentions.docsDesc')
    }
  ])

  // ==================== 工具函数 ====================

  /**
   * 获取当前终端的类型
   */
  const getTerminalType = (): 'local' | 'ssh' | null => {
    if (!currentTabId.value) return null
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    return tab?.type || null
  }

  /**
   * 获取当前终端的 ptyId
   */
  const getPtyId = (): string | null => {
    if (!currentTabId.value) return null
    const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
    return tab?.ptyId || null
  }

  /**
   * 获取文件图标
   */
  const getFileIcon = (name: string, isDirectory: boolean): string => {
    if (isDirectory) return '📁'
    const ext = name.split('.').pop()?.toLowerCase()
    const iconMap: Record<string, string> = {
      // 文档
      pdf: '📕', doc: '📘', docx: '📘', txt: '📄', md: '📝',
      // 代码
      js: '📜', ts: '📜', py: '🐍', java: '☕', go: '🐹', rs: '🦀',
      vue: '💚', jsx: '⚛️', tsx: '⚛️', html: '🌐', css: '🎨',
      json: '📋', xml: '📋', yaml: '📋', yml: '📋',
      sh: '🐚', bash: '🐚', zsh: '🐚',
      // 配置
      conf: '⚙️', config: '⚙️', ini: '⚙️', env: '⚙️',
      // 压缩
      zip: '📦', tar: '📦', gz: '📦', rar: '📦',
      // 图片
      png: '🖼️', jpg: '🖼️', jpeg: '🖼️', gif: '🖼️', svg: '🖼️',
      // 日志
      log: '📋'
    }
    return iconMap[ext || ''] || '📄'
  }

  /**
   * 格式化文件大小
   */
  const formatFileSize = (bytes?: number): string => {
    if (!bytes) return ''
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // ==================== 文件补全 ====================

  /**
   * 获取本地文件列表
   */
  const getLocalFiles = async (dir: string): Promise<FileInfo[]> => {
    try {
      // 如果是空字符串，使用终端当前工作目录
      let targetDir = dir
      if (!targetDir) {
        const ptyId = getPtyId()
        if (ptyId) {
          // 使用 refreshCwd 强制刷新获取最新 CWD（避免缓存问题）
          targetDir = await window.electronAPI.terminalState.refreshCwd(ptyId) || ''
        }
        if (!targetDir || targetDir === '~') {
          targetDir = await window.electronAPI.localFs.getHomeDir()
        }
      }
      
      currentDir.value = targetDir
      const result = await window.electronAPI.localFs.list(targetDir)
      if (result.success && result.data) {
        return result.data.map(f => ({
          name: f.name,
          path: f.path,
          isDirectory: f.isDirectory,
          size: f.size
        }))
      }
      return []
    } catch (err) {
      console.error('获取本地文件列表失败:', err)
      return []
    }
  }

  /**
   * 获取远程文件列表（SSH）
   */
  const getRemoteFiles = async (dir: string): Promise<FileInfo[]> => {
    try {
      const ptyId = getPtyId()
      if (!ptyId) return []
      
      const tab = terminalStore.tabs.find(t => t.id === currentTabId.value)
      if (!tab?.sshConfig) {
        console.warn('[useMentions] SSH 终端没有 sshConfig，无法获取文件列表')
        return []
      }
      
      // 如果是空字符串，使用终端当前工作目录
      let targetDir = dir
      if (!targetDir) {
        // SSH 终端：使用 refreshCwd 从屏幕提示符解析获取真实 CWD
        targetDir = await window.electronAPI.terminalState.refreshCwd(ptyId) || '~'
      }
      
      currentDir.value = targetDir
      
      // 检查 SFTP 会话是否存在，如果不存在则建立连接（与 Agent 行为一致，使用 ptyId 作为会话 ID）
      const hasSession = await window.electronAPI.sftp.hasSession(ptyId)
      if (!hasSession) {
        // 从 configStore 获取完整的 SSH 会话配置（包含密码等敏感信息）
        let sftpConfig: { host: string; port: number; username: string; password?: string; privateKeyPath?: string; passphrase?: string }
        
        if (tab.sshSessionId) {
          // 通过 sshSessionId 从 configStore 获取完整配置
          const sessions = await window.electronAPI.config.get('sshSessions') as Array<{
            id: string; host: string; port: number; username: string; password?: string; privateKeyPath?: string; passphrase?: string
          }> | undefined
          const session = sessions?.find(s => s.id === tab.sshSessionId)
          if (session) {
            sftpConfig = {
              host: session.host,
              port: session.port,
              username: session.username,
              password: session.password,
              privateKeyPath: session.privateKeyPath,
              passphrase: session.passphrase
            }
          } else {
            // 会话不存在，使用基本配置
            sftpConfig = { ...tab.sshConfig }
          }
        } else {
          // 没有 sshSessionId，使用基本配置（可能需要用户重新认证）
          sftpConfig = { ...tab.sshConfig }
        }
        
        const connectResult = await window.electronAPI.sftp.connect(ptyId, sftpConfig)
        if (!connectResult.success) {
          console.error('[useMentions] SFTP 连接失败:', connectResult.error)
          return []
        }
      }
      
      // 使用 SFTP 获取文件列表（使用 ptyId 作为会话 ID，与 Agent 一致）
      const result = await window.electronAPI.sftp.list(ptyId, targetDir)
      if (result.success && result.data) {
        return result.data.map(f => ({
          name: f.name,
          path: f.path,
          isDirectory: f.isDirectory,
          size: f.size
        }))
      }
      return []
    } catch (err) {
      console.error('获取远程文件列表失败:', err)
      return []
    }
  }

  /**
   * 加载文件补全建议
   */
  const loadFileSuggestions = async (query: string) => {
    isLoading.value = true
    hasMore.value = false
    totalCount.value = 0
    try {
      const terminalType = getTerminalType()
      if (!terminalType) {
        suggestions.value = []
        return
      }

      // 解析查询，分离目录和文件名
      let dir = ''
      let filename = query
      
      if (query.includes('/')) {
        const lastSlash = query.lastIndexOf('/')
        // 如果是目录路径（以 / 结尾），则整个作为目录
        if (lastSlash === query.length - 1) {
          dir = query
          filename = ''
        } else {
          dir = query.substring(0, lastSlash + 1)
          filename = query.substring(lastSlash + 1)
        }
      } else if (query.includes('\\')) {
        const lastSlash = query.lastIndexOf('\\')
        if (lastSlash === query.length - 1) {
          dir = query
          filename = ''
        } else {
          dir = query.substring(0, lastSlash + 1)
          filename = query.substring(lastSlash + 1)
        }
      }

      // 获取文件列表
      const files = terminalType === 'local' 
        ? await getLocalFiles(dir)
        : await getRemoteFiles(dir)

      // 过滤并排序
      const lowerFilename = filename.toLowerCase()
      const MAX_DISPLAY = 50
      const sortedFiles = files
        .filter(f => {
          if (!filename) return true
          return f.name.toLowerCase().includes(lowerFilename)
        })
        .sort((a, b) => {
          const aLower = a.name.toLowerCase()
          const bLower = b.name.toLowerCase()
          
          // 首字母匹配的优先
          const aStartsWith = aLower.startsWith(lowerFilename)
          const bStartsWith = bLower.startsWith(lowerFilename)
          if (aStartsWith !== bStartsWith) {
            return aStartsWith ? -1 : 1
          }
          
          // 目录优先
          if (a.isDirectory !== b.isDirectory) {
            return a.isDirectory ? -1 : 1
          }
          
          return a.name.localeCompare(b.name)
        })

      // 记录是否有更多文件
      totalCount.value = sortedFiles.length
      hasMore.value = sortedFiles.length > MAX_DISPLAY
      
      const filtered = sortedFiles.slice(0, MAX_DISPLAY)

      suggestions.value = filtered.map(f => ({
        type: 'file' as MentionType,
        id: f.path,
        label: f.name,
        // 使用完整路径，确保目录导航正确
        value: `@file:${f.path}${f.isDirectory ? '/' : ''}`,
        icon: getFileIcon(f.name, f.isDirectory),
        description: f.isDirectory ? t('mentions.directory') : formatFileSize(f.size),
        data: f
      }))
    } catch (err) {
      console.error('加载文件建议失败:', err)
      suggestions.value = []
    } finally {
      isLoading.value = false
    }
  }

  // ==================== 文档补全 ====================

  /**
   * 加载知识库文档列表
   */
  const loadKnowledgeDocs = async () => {
    try {
      const docs = await window.electronAPI.knowledge.getDocuments()
      knowledgeDocs.value = docs || []
    } catch (err) {
      console.error('加载知识库文档失败:', err)
      knowledgeDocs.value = []
    }
  }

  /**
   * 加载文档补全建议
   */
  const loadDocsSuggestions = async (query: string) => {
    isLoading.value = true
    try {
      const allDocs: MentionSuggestion[] = []

      // 1. 已上传的文档（当前会话）
      const uploaded = uploadedDocs.value
        .filter(d => !d.error && d.content)
        .filter(d => !query || d.filename.toLowerCase().includes(query.toLowerCase()))
        .map(d => ({
          type: 'docs' as MentionType,
          id: `uploaded:${d.filename}`,
          label: d.filename,
          value: `@docs:${d.filename}`,
          icon: d.fileType === 'pdf' ? '📕' : d.fileType === 'docx' || d.fileType === 'doc' ? '📘' : '📄',
          description: `${t('mentions.uploaded')} · ${formatFileSize(d.fileSize)}`,
          data: d
        }))
      allDocs.push(...uploaded)

      // 2. 知识库文档（过滤掉主机记忆文档）
      if (knowledgeDocs.value.length === 0) {
        await loadKnowledgeDocs()
      }
      const knowledge = knowledgeDocs.value
        // 过滤掉主机记忆文档（tags 包含 'host-memory'）
        .filter(d => !d.tags?.includes('host-memory'))
        .filter(d => !query || d.filename.toLowerCase().includes(query.toLowerCase()))
        .map(d => ({
          type: 'docs' as MentionType,
          id: `knowledge:${d.id}`,
          label: d.filename,
          value: `@docs:${d.filename}#${d.id}`,  // 文件名#ID，显示友好且可精确定位
          icon: '📚',
          description: t('mentions.knowledge'),
          data: d
        }))
      allDocs.push(...knowledge)

      suggestions.value = allDocs.slice(0, 20)
    } catch (err) {
      console.error('加载文档建议失败:', err)
      suggestions.value = []
    } finally {
      isLoading.value = false
    }
  }

  // ==================== 菜单控制 ====================

  /**
   * 检测输入中的 @ 触发
   */
  const detectTrigger = (text: string, cursorPos: number) => {
    // 从光标位置向前搜索 @
    let atPos = -1
    for (let i = cursorPos - 1; i >= 0; i--) {
      const char = text[i]
      if (char === '@') {
        atPos = i
        break
      }
      // 遇到空格或换行则停止
      if (char === ' ' || char === '\n' || char === '\r') {
        break
      }
    }

    if (atPos === -1) {
      showMenu.value = false
      return
    }

    // 获取 @ 后的内容
    const afterAt = text.substring(atPos, cursorPos)
    
    // 检查是否匹配命令
    const matchedCommand = commands.value.find(cmd => 
      cmd.aliases.some(alias => afterAt.toLowerCase().startsWith(alias.toLowerCase()))
    )

    if (matchedCommand) {
      // 找到匹配的命令，进入具体补全模式
      const matchedAlias = matchedCommand.aliases.find(alias => 
        afterAt.toLowerCase().startsWith(alias.toLowerCase())
      )!
      
      menuType.value = matchedCommand.type
      triggerPosition.value = atPos
      
      // 提取搜索关键词（命令后的内容）
      const query = afterAt.substring(matchedAlias.length).replace(/^[:\s]+/, '')
      searchQuery.value = query
      
      // 加载补全建议
      if (matchedCommand.type === 'file') {
        loadFileSuggestions(query)
      } else if (matchedCommand.type === 'docs') {
        loadDocsSuggestions(query)
      }
      
      showMenu.value = true
      selectedIndex.value = 0
    } else if (afterAt === '@' || commands.value.some(cmd => 
      cmd.aliases.some(alias => alias.toLowerCase().startsWith(afterAt.toLowerCase()))
    )) {
      // 刚输入 @ 或正在输入命令名，显示命令列表
      menuType.value = null
      triggerPosition.value = atPos
      searchQuery.value = afterAt.substring(1)  // 去掉 @
      
      // 过滤命令列表
      const query = searchQuery.value.toLowerCase()
      suggestions.value = commands.value
        .filter(cmd => 
          !query || 
          cmd.name.toLowerCase().includes(query) ||
          cmd.aliases.some(a => a.toLowerCase().includes('@' + query))
        )
        .map(cmd => ({
          type: cmd.type,
          id: cmd.type,
          label: cmd.name,
          value: cmd.aliases[0],
          icon: cmd.icon,
          description: cmd.description
        }))
      
      showMenu.value = suggestions.value.length > 0
      selectedIndex.value = 0
    } else {
      showMenu.value = false
    }
  }

  /**
   * 选择建议
   */
  const selectSuggestion = (suggestion: MentionSuggestion) => {
    if (!showMenu.value) return

    const text = inputText.value
    const beforeTrigger = text.substring(0, triggerPosition.value)
    
    // 找到当前 @ 引用的结束位置
    let endPos = triggerPosition.value
    while (endPos < text.length && text[endPos] !== ' ' && text[endPos] !== '\n') {
      endPos++
    }
    const afterTrigger = text.substring(endPos)

    if (menuType.value === null) {
      // 选择的是命令，切换到具体补全模式
      menuType.value = suggestion.type
      inputText.value = beforeTrigger + suggestion.value + ':' + afterTrigger
      searchQuery.value = ''
      
      // 加载对应类型的补全
      if (suggestion.type === 'file') {
        loadFileSuggestions('')
      } else if (suggestion.type === 'docs') {
        loadDocsSuggestions('')
      }
    } else {
      // 选择的是具体项
      if (suggestion.type === 'file' && (suggestion.data as FileInfo)?.isDirectory) {
        // 如果是目录，继续补全
        inputText.value = beforeTrigger + suggestion.value + afterTrigger
        const query = suggestion.value.replace(/^@file:/, '')
        loadFileSuggestions(query)
      } else {
        // 选择完成，替换文本
        inputText.value = beforeTrigger + suggestion.value + ' ' + afterTrigger.trimStart()
        showMenu.value = false
        menuType.value = null
      }
    }
  }

  /**
   * 移除已选择的 @ 引用
   */
  const removeMention = (id: string) => {
    const index = selectedMentions.value.findIndex(m => m.id === id)
    if (index !== -1) {
      const mention = selectedMentions.value[index]
      selectedMentions.value.splice(index, 1)
      
      // 从输入文本中移除对应的引用
      inputText.value = inputText.value.replace(mention.value, '').replace(/\s+/g, ' ').trim()
    }
  }

  /**
   * 清空所有 @ 引用
   */
  const clearMentions = () => {
    selectedMentions.value = []
  }

  /**
   * 关闭菜单
   */
  const closeMenu = () => {
    showMenu.value = false
    menuType.value = null
    suggestions.value = []
    selectedIndex.value = 0
  }

  /**
   * 键盘导航
   */
  const handleKeyDown = (event: KeyboardEvent): boolean => {
    if (!showMenu.value) return false

    switch (event.key) {
      case 'ArrowUp':
        event.preventDefault()
        selectedIndex.value = Math.max(0, selectedIndex.value - 1)
        return true
      case 'ArrowDown':
        event.preventDefault()
        selectedIndex.value = Math.min(suggestions.value.length - 1, selectedIndex.value + 1)
        return true
      case 'Tab':
      case 'Enter':
        if (suggestions.value[selectedIndex.value]) {
          event.preventDefault()
          selectSuggestion(suggestions.value[selectedIndex.value])
          return true
        }
        break
      case 'Escape':
        event.preventDefault()
        closeMenu()
        return true
    }
    return false
  }

  // ==================== 内容展开 ====================

  /**
   * 展开消息中的所有 @ 引用
   * 返回格式化的上下文字符串，用于发送给 AI
   */
  const expandMentions = async (text: string): Promise<{ 
    cleanText: string      // 清理后的用户消息（保留 @ 引用作为提示）
    contextParts: string[] // 不再使用，保留接口兼容
  }> => {
    let cleanText = text

    // 匹配所有 @ 引用
    const filePattern = /@file:([^\s]+)/g
    const docsPattern = /@docs:([^\s]+)/g

    // 处理文件引用 - 只转换格式，不读取内容
    // @file 是一个引用/指针，让 AI 知道用户在说哪个文件
    // Agent 模式下 AI 可以使用 read_file 工具来读取内容
    let match
    while ((match = filePattern.exec(text)) !== null) {
      const filePath = match[1]
      
      // 跳过目录（以 / 结尾），只处理文件
      if (!filePath.endsWith('/')) {
        const fileName = filePath.split('/').pop() || filePath
        // 保留文件引用在消息中，转换为更友好的格式
        cleanText = cleanText.replace(match[0], `[文件: ${fileName}](${filePath})`)
      }
    }

    // 处理文档引用 - 只转换格式，不展开内容
    // @docs 是一个引用/指针，让 AI 知道用户在说哪个文档
    // 格式: @docs:filename 或 @docs:filename#id（知识库文档带 ID 用于精确定位）
    // Agent 可以使用 get_knowledge_doc 工具按 ID 获取精确内容
    while ((match = docsPattern.exec(text)) !== null) {
      const ref = match[1]
      // 解析 filename#id 格式
      const hashIndex = ref.indexOf('#')
      const filename = hashIndex > 0 ? ref.substring(0, hashIndex) : ref
      const docId = hashIndex > 0 ? ref.substring(hashIndex + 1) : null
      // 保留文档引用在消息中，转换为更友好的格式（包含 ID 便于精确获取）
      const displayText = docId ? `[文档: ${filename}](doc_id:${docId})` : `[文档: ${filename}]`
      cleanText = cleanText.replace(match[0], displayText)
    }

    // 清理多余的空格
    cleanText = cleanText.replace(/\s+/g, ' ').trim()

    return { cleanText, contextParts: [] }
  }

  /**
   * 解析输入文本中的 @ 引用（同步，用于显示）
   */
  const parseMentions = (text: string): SelectedMention[] => {
    const mentions: SelectedMention[] = []
    
    // 匹配文件引用
    const filePattern = /@file:([^\s]+)/g
    let match
    while ((match = filePattern.exec(text)) !== null) {
      const filePath = match[1]
      if (!filePath.endsWith('/')) {
        const fileName = filePath.split('/').pop() || filePath
        mentions.push({
          type: 'file',
          id: `file:${filePath}`,
          label: fileName,
          value: match[0],
          icon: getFileIcon(fileName, false)
        })
      }
    }

    // 匹配文档引用
    const docsPattern = /@docs:([^\s]+)/g
    while ((match = docsPattern.exec(text)) !== null) {
      const filename = match[1]
      mentions.push({
        type: 'docs',
        id: `docs:${filename}`,
        label: filename,
        value: match[0],
        icon: '📚'
      })
    }

    return mentions
  }

  // ==================== 监听输入变化 ====================

  // 注意：这个 watcher 需要配合输入框的光标位置使用
  // 实际使用时应该在 @input 事件中调用 detectTrigger

  return {
    // 状态
    showMenu,
    menuType,
    suggestions,
    selectedIndex,
    isLoading,
    hasMore,
    totalCount,
    selectedMentions,
    currentDir,
    
    // 方法
    detectTrigger,
    selectSuggestion,
    removeMention,
    clearMentions,
    closeMenu,
    handleKeyDown,
    expandMentions,
    parseMentions,
    
    // 工具函数
    getFileIcon,
    formatFileSize
  }
}

