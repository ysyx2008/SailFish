/**
 * 文档上传 composable
 * 处理文档选择、解析和管理
 * 每个终端独立管理自己的文档
 */
import { ref, computed, type Ref, type ComputedRef } from 'vue'
import { useTerminalStore, type ParsedDocument } from '../stores/terminal'
import { SUPPORTED_IMAGE_TYPES } from './useImageUpload'

// 重新导出类型供外部使用
export type { ParsedDocument }

export function useDocumentUpload(currentTabId: Ref<string | null> | ComputedRef<string | null>) {
  const terminalStore = useTerminalStore()

  // 上传中状态（全局状态，因为同一时间只能上传一次）
  const isUploadingDocs = ref(false)
  // 拖放悬停状态
  const isDraggingOver = ref(false)
  // 保存到知识库中
  const isSavingToKnowledge = ref(false)
  // 等待知识库初始化中
  const isWaitingKnowledge = ref(false)

  // 当前终端的已上传文档列表（computed，自动响应终端切换）
  const uploadedDocs = computed(() => {
    if (!currentTabId.value) return []
    return terminalStore.getUploadedDocs(currentTabId.value)
  })

  // 选择并上传文档（替换模式：新文档替换旧文档）
  const selectAndUploadDocs = async (hostId?: string) => {
    if (isUploadingDocs.value || !currentTabId.value) return
    
    const tabId = currentTabId.value
    
    try {
      isUploadingDocs.value = true
      
      // 选择文件
      const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
      const { canceled, files } = await documentAPI.selectFiles()
      if (canceled || files.length === 0) {
        isUploadingDocs.value = false
        return
      }
      
      const parsedDocs = await documentAPI.parseMultiple(files)
      
      // 追加模式：新上传的文档追加到现有列表
      terminalStore.addUploadedDocs(tabId, parsedDocs)
      
      // 显示解析结果摘要
      const successCount = parsedDocs.filter((d: ParsedDocument) => !d.error).length
      const errorCount = parsedDocs.filter((d: ParsedDocument) => d.error).length
      
      if (errorCount > 0) {
        console.warn(`文档解析: ${successCount} 成功, ${errorCount} 失败`)
      }
      
      // 自动保存到知识库（如果启用）
      if (successCount > 0) {
        autoSaveToKnowledgeIfEnabled(parsedDocs, hostId)
      }
    } catch (error) {
      console.error('上传文档失败:', error)
    } finally {
      isUploadingDocs.value = false
    }
  }

  // 处理拖放的文件
  const handleDroppedFiles = async (files: FileList | File[], hostId?: string) => {
    if (isUploadingDocs.value || !currentTabId.value) return
    
    const tabId = currentTabId.value
    
    const fileInfos: Array<{ name: string; path: string; size: number; mimeType?: string }> = []
    for (const file of files) {
      if (SUPPORTED_IMAGE_TYPES.includes(file.type)) continue
      
      let filePath: string | undefined
      try {
        filePath = window.electronAPI?.fileUtils?.getPathForFile(file)
      } catch (e) {
        filePath = (file as File & { path?: string }).path
      }
      
      if (!filePath) continue
      
      fileInfos.push({
        name: file.name,
        path: filePath,
        size: file.size,
        mimeType: file.type || undefined
      })
    }
    
    if (fileInfos.length === 0) return
    
    try {
      isUploadingDocs.value = true
      
      const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
      const parsedDocs = await documentAPI.parseMultiple(fileInfos)
      
      terminalStore.addUploadedDocs(tabId, parsedDocs)
      
      const successCount = parsedDocs.filter((d: ParsedDocument) => !d.error).length
      const errorCount = parsedDocs.filter((d: ParsedDocument) => d.error).length
      
      if (errorCount > 0) {
        console.warn(`文档解析: ${successCount} 成功, ${errorCount} 失败`)
      }
      
      if (successCount > 0) {
        autoSaveToKnowledgeIfEnabled(parsedDocs, hostId)
      }
    } catch (error) {
      console.error('处理拖放文档失败:', error)
    } finally {
      isUploadingDocs.value = false
    }
  }

  // 移除已上传的文档
  const removeUploadedDoc = (index: number) => {
    if (!currentTabId.value) return
    terminalStore.removeUploadedDoc(currentTabId.value, index)
  }

  // 清空所有上传的文档
  const clearUploadedDocs = () => {
    if (!currentTabId.value) return
    terminalStore.clearUploadedDocs(currentTabId.value)
  }

  // 格式化文件大小
  const formatFileSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  }

  // 获取文档上下文（用于发送给 AI）
  // 有内容的文档注入全文，仅元数据的文档注入路径等信息让 Agent 自行处理
  const getDocumentContext = async (): Promise<string> => {
    const validDocs = uploadedDocs.value.filter(d => !d.error)
    if (validDocs.length === 0) return ''
    
    // 将 Vue Proxy 对象转换为普通对象，避免 IPC 序列化错误
    const plainDocs = JSON.parse(JSON.stringify(validDocs))
    
    const documentAPI = (window.electronAPI as { document: typeof window.electronAPI.document }).document
    return await documentAPI.formatAsContext(plainDocs)
  }

  /**
   * 获取用于 UI 展示的文档预览图片（仅 PDF 页面渲染）
   * Word 嵌入图片不在用户消息中展示，只通过 getAllDocImages 传给 AI
   */
  const getDocPreviewImages = (): string[] => {
    const images: string[] = []
    for (const doc of uploadedDocs.value) {
      if (doc.fileType === 'pdf' && doc.images && doc.images.length > 0) {
        images.push(...doc.images)
      }
    }
    return images
  }

  /** 获取所有文档的嵌入图片（PDF 页面 + Word 正文图片等，传给 AI 视觉模型） */
  const getAllDocImages = (): string[] => {
    const images: string[] = []
    for (const doc of uploadedDocs.value) {
      if (doc.images && doc.images.length > 0) {
        images.push(...doc.images)
      }
    }
    return images
  }

  // 获取含图片文档的文本描述（注入到上下文提示 AI）
  const getDocImagesContext = (): string => {
    const docsWithImages = uploadedDocs.value.filter(d => d.images && d.images.length > 0)
    if (docsWithImages.length === 0) return ''
    
    const parts = docsWithImages.map(d => {
      const imageCount = d.images!.length
      const pathHint = d.filePath ? `，路径: ${d.filePath}` : ''

      if (d.fileType === 'pdf') {
        const totalPages = d.totalPages || d.pageCount || 0
        const pageDesc = imageCount >= totalPages
          ? `全部 ${totalPages} 页已作为图片附上`
          : `前 ${imageCount} 页已作为图片附上（共 ${totalPages} 页）。如需查看更多页面，使用 pdf_view_page 工具`
        return `[扫描版 PDF: ${d.filename}${pathHint}，${pageDesc}]`
      }

      // Word 等其他含图片的文档
      const tableInfo = d.metadata?.tableCount ? `，含 ${d.metadata.tableCount} 个表格` : ''
      return `[${d.filename}${pathHint}，文档正文中包含 ${imageCount} 张图片已附上${tableInfo}]`
    })
    return parts.join('\n')
  }

  // 保存单个文档到知识库
  const saveToKnowledge = async (doc: ParsedDocument, options?: { hostId?: string; tags?: string[] }): Promise<{ success: boolean; duplicate?: boolean; existingFilename?: string }> => {
    if (doc.error || !doc.content) return { success: false }
    
    try {
      isSavingToKnowledge.value = true
      const knowledgeAPI = window.electronAPI.knowledge
      
      // 等待知识库初始化完成
      const isInitialized = await knowledgeAPI.isInitialized()
      if (!isInitialized) {
        isWaitingKnowledge.value = true
        console.log('[Knowledge] 等待知识库初始化...')
        await knowledgeAPI.waitInitialized()
        isWaitingKnowledge.value = false
      }
      
      // 将 Vue Proxy 对象转换为普通对象
      const plainDoc = JSON.parse(JSON.stringify(doc))
      
      const result = await knowledgeAPI.addDocument(plainDoc, options)
      return { 
        success: result.success, 
        duplicate: result.duplicate,
        existingFilename: result.existingFilename
      }
    } catch (error) {
      console.error('保存到知识库失败:', error)
      return { success: false }
    } finally {
      isSavingToKnowledge.value = false
      isWaitingKnowledge.value = false
    }
  }

  // 批量保存文档到知识库
  const saveAllToKnowledge = async (options?: { hostId?: string; tags?: string[] }): Promise<{ success: number; failed: number; skipped: number }> => {
    const validDocs = uploadedDocs.value.filter(d => !d.error && d.content)
    if (validDocs.length === 0) return { success: 0, failed: 0, skipped: 0 }
    
    let success = 0
    let failed = 0
    let skipped = 0
    
    isSavingToKnowledge.value = true
    
    try {
      for (const doc of validDocs) {
        const result = await saveToKnowledge(doc, options)
        if (result.success) {
          if (result.duplicate) {
            skipped++
            console.log(`文档已存在，跳过: ${doc.filename} (与 ${result.existingFilename} 相同)`)
          } else {
            success++
          }
        } else {
          failed++
        }
      }
    } finally {
      isSavingToKnowledge.value = false
    }
    
    return { success, failed, skipped }
  }

  // 检查知识库是否启用
  const checkKnowledgeEnabled = async (): Promise<boolean> => {
    try {
      return await window.electronAPI.knowledge.isEnabled()
    } catch {
      return false
    }
  }

  // 自动保存到知识库（根据设置）
  const autoSaveToKnowledgeIfEnabled = async (docs: ParsedDocument[], hostId?: string) => {
    try {
      const settings = await window.electronAPI.knowledge.getSettings()
      if (!settings.enabled || !settings.autoSaveUploads) return
      
      for (const doc of docs) {
        if (!doc.error && doc.content) {
          await saveToKnowledge(doc, { hostId })
        }
      }
    } catch (error) {
      console.error('自动保存到知识库失败:', error)
    }
  }

  return {
    uploadedDocs,
    isUploadingDocs,
    isDraggingOver,
    isSavingToKnowledge,
    isWaitingKnowledge,
    selectAndUploadDocs,
    handleDroppedFiles,
    removeUploadedDoc,
    clearUploadedDocs,
    formatFileSize,
    getDocumentContext,
    getDocPreviewImages,
    getAllDocImages,
    getDocImagesContext,
    saveToKnowledge,
    saveAllToKnowledge,
    checkKnowledgeEnabled,
    autoSaveToKnowledgeIfEnabled
  }
}
