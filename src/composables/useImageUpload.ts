/**
 * 图片上传 composable
 * 处理图片粘贴、拖拽、选择和管理
 * 将图片转为 base64 data URL 发送给 AI 用于视觉理解
 */
import { ref, type Ref } from 'vue'

// 支持的图片 MIME 类型（可直接作为视觉输入传给 AI）
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']

// 限制配置
const IMAGE_LIMITS = {
  MAX_COUNT: 5,           // 最多同时上传 5 张图片
  MAX_SIZE_MB: 5,         // 单张图片最大 5MB（兼容 Anthropic 等 API 的请求体限制）
}

export interface PendingImage {
  id: string
  dataUrl: string      // base64 data URL
  name: string         // 文件名
  size: number         // 原始文件大小（字节）
  width?: number       // 图片宽度
  height?: number      // 图片高度
}

/**
 * 将 File 对象转为 base64 data URL（不做缩放，保留原始质量）
 * AI API 会自行处理图片尺寸，客户端预压缩只会损失质量
 */
async function fileToDataUrl(file: File): Promise<{ dataUrl: string; width: number; height: number }> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const dataUrl = reader.result as string
      const img = new Image()
      img.onload = () => resolve({ dataUrl, width: img.width, height: img.height })
      img.onerror = () => resolve({ dataUrl, width: 0, height: 0 })
      img.src = dataUrl
    }
    reader.onerror = () => reject(new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

/**
 * 检查文件是否为支持的图片类型
 */
function isSupportedImage(file: File): boolean {
  return SUPPORTED_IMAGE_TYPES.includes(file.type)
}

export function useImageUpload() {
  // 待发送的图片列表
  const pendingImages: Ref<PendingImage[]> = ref([])
  
  // 是否正在处理图片
  const isProcessingImage = ref(false)
  
  /**
   * 添加图片文件
   */
  const addImageFile = async (file: File): Promise<boolean> => {
    // 检查是否为支持的图片类型
    if (!isSupportedImage(file)) {
      console.warn(`不支持的图片类型: ${file.type}`)
      return false
    }
    
    // 检查数量限制
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      console.warn(`图片数量已达上限 (${IMAGE_LIMITS.MAX_COUNT})`)
      return false
    }
    
    // 检查文件大小
    if (file.size > IMAGE_LIMITS.MAX_SIZE_MB * 1024 * 1024) {
      console.warn(`图片文件过大: ${(file.size / 1024 / 1024).toFixed(1)}MB，上限 ${IMAGE_LIMITS.MAX_SIZE_MB}MB`)
      return false
    }
    
    try {
      isProcessingImage.value = true
      const { dataUrl, width, height } = await fileToDataUrl(file)
      
      pendingImages.value.push({
        id: `img_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`,
        dataUrl,
        name: file.name || 'pasted-image',
        size: file.size,
        width,
        height
      })
      
      return true
    } catch (error) {
      console.error('处理图片失败:', error)
      return false
    } finally {
      isProcessingImage.value = false
    }
  }
  
  /**
   * 处理粘贴事件中的图片
   * 返回 true 如果处理了图片（阻止默认粘贴行为）
   */
  const handlePasteImages = async (event: ClipboardEvent): Promise<boolean> => {
    const items = event.clipboardData?.items
    if (!items) return false
    
    let hasImage = false
    const imageFiles: File[] = []
    
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile()
        if (file) {
          imageFiles.push(file)
          hasImage = true
        }
      }
    }
    
    if (!hasImage) return false
    
    // 处理所有图片
    for (const file of imageFiles) {
      await addImageFile(file)
    }
    
    return true
  }
  
  /**
   * 处理拖拽的文件中的图片
   * 返回处理的图片数量
   */
  const handleDroppedImages = async (files: FileList | File[]): Promise<number> => {
    let count = 0
    for (const file of files) {
      if (isSupportedImage(file)) {
        const added = await addImageFile(file)
        if (added) count++
      }
    }
    return count
  }
  
  /**
   * 移除指定图片
   */
  const removeImage = (id: string) => {
    const index = pendingImages.value.findIndex(img => img.id === id)
    if (index >= 0) {
      pendingImages.value.splice(index, 1)
    }
  }
  
  /**
   * 清空所有待发送图片
   */
  const clearImages = () => {
    pendingImages.value = []
  }
  
  /**
   * 获取所有待发送图片的 data URL 列表
   */
  const getImageDataUrls = (): string[] => {
    return pendingImages.value.map(img => img.dataUrl)
  }
  
  /**
   * 是否有待发送的图片
   */
  const hasImages = (): boolean => {
    return pendingImages.value.length > 0
  }
  
  /**
   * 检查是否还能添加更多图片
   */
  const canAddMore = (): boolean => {
    return pendingImages.value.length < IMAGE_LIMITS.MAX_COUNT
  }
  
  /**
   * 通过文件选择器选择图片
   */
  const selectImages = () => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = SUPPORTED_IMAGE_TYPES.join(',')
    input.multiple = true
    input.onchange = async () => {
      if (input.files) {
        for (const file of input.files) {
          await addImageFile(file)
        }
      }
    }
    input.click()
  }
  
  return {
    pendingImages,
    isProcessingImage,
    addImageFile,
    handlePasteImages,
    handleDroppedImages,
    removeImage,
    clearImages,
    getImageDataUrls,
    hasImages,
    canAddMore,
    selectImages,
    IMAGE_LIMITS
  }
}
