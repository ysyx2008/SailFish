/**
 * 图片上传 composable
 * 处理图片拖拽、选择和管理（粘贴分类见 useComposerPaste）
 * 将图片转为 base64 data URL 发送给 AI 用于视觉理解；
 * 没有磁盘路径的图落到历史目录，带上路径发给 Agent。
 */
import { ref, type Ref } from 'vue'
import { useI18n } from 'vue-i18n'
import type { AttachmentInfo } from '@shared/types'
import { toast } from './useToast'
import { showConfirm } from './useConfirm'

// 支持的图片 MIME 类型（可直接作为视觉输入传给 AI）
export const SUPPORTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/bmp']

// 单张发给视觉接口的原始字节上限。超过的先缩小，不直接丢掉。
const IMAGE_LIMITS = {
  MAX_COUNT: 5,
  MAX_SIZE_MB: 5,
}

const IMAGE_MAX_BYTES = IMAGE_LIMITS.MAX_SIZE_MB * 1024 * 1024
/** 超过这个体积不解码、也不把剪贴板原图整份读进内存 */
const IMAGE_DECODE_MAX_BYTES = 50 * 1024 * 1024
const IMAGE_KEEP_MAX_BYTES = IMAGE_DECODE_MAX_BYTES
const IMAGE_DECODE_MAX_PIXELS = 40_000_000
const SHRINK_QUALITIES = [0.85, 0.7, 0.55]

export interface ShrinkPass {
  maxEdge: number
  quality: number
}

/**
 * 超过上限时的缩小顺序：长边先收到 2560（视觉看图够用），
 * 同一边长先降画质，仍放不下再缩小，不低于 800。
 */
export function buildShrinkPasses(width: number, height: number): ShrinkPass[] {
  const long = Math.max(1, Math.round(width), Math.round(height))
  const edges: number[] = []
  let edge = Math.min(long, 2560)
  for (let i = 0; i < 4; i++) {
    const next = Math.round(edge)
    if (edges.length > 0 && next === edges[edges.length - 1]) break
    edges.push(next)
    if (next <= 800) break
    edge = Math.max(800, Math.round(next * 0.75))
  }
  return edges.flatMap((maxEdge) => SHRINK_QUALITIES.map((quality) => ({ maxEdge, quality })))
}

function formatImageSize(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))}KB`
  const mb = bytes / (1024 * 1024)
  return `${mb >= 10 ? mb.toFixed(0) : mb.toFixed(1)}MB`
}

interface FittedImage {
  dataUrl: string
  width: number
  height: number
  size: number
}

function drawToEdge(bitmap: ImageBitmap, maxEdge: number): HTMLCanvasElement {
  const scale = Math.min(1, maxEdge / Math.max(bitmap.width, bitmap.height, 1))
  const width = Math.max(1, Math.round(bitmap.width * scale))
  const height = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = width
  canvas.height = height
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('canvas unavailable')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, width, height)
  ctx.drawImage(bitmap, 0, 0, width, height)
  return canvas
}

function jpegDisplayName(name: string): string {
  const slash = Math.max(name.lastIndexOf('/'), name.lastIndexOf('\\'))
  const base = slash >= 0 ? name.slice(slash + 1) : name
  const dot = base.lastIndexOf('.')
  const stem = (dot > 0 ? base.slice(0, dot) : base).trim()
  return `${stem || 'pasted-image'}.jpg`
}

function canvasToJpegBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (!blob) reject(new Error('jpeg encode failed'))
      else resolve(blob)
    }, 'image/jpeg', quality)
  })
}

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('read blob failed'))
    reader.readAsDataURL(blob)
  })
}

type ShrinkOutcome =
  | { ok: true; image: FittedImage }
  | { ok: false; reason: 'too-large' | 'unreadable' }

/** 把位图压到上限以内。超大、读不出、压完仍超限，原因分开返回。 */
async function shrinkToByteLimit(source: Blob, maxBytes: number): Promise<ShrinkOutcome> {
  if (source.size > IMAGE_DECODE_MAX_BYTES) return { ok: false, reason: 'too-large' }
  if (typeof createImageBitmap !== 'function') return { ok: false, reason: 'unreadable' }
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(source, { imageOrientation: 'from-image' })
  } catch {
    return { ok: false, reason: 'unreadable' }
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) return { ok: false, reason: 'unreadable' }
    if (bitmap.width * bitmap.height > IMAGE_DECODE_MAX_PIXELS) return { ok: false, reason: 'too-large' }
    for (const pass of buildShrinkPasses(bitmap.width, bitmap.height)) {
      const canvas = drawToEdge(bitmap, pass.maxEdge)
      const blob = await canvasToJpegBlob(canvas, pass.quality)
      if (blob.size <= maxBytes && blob.size > 0) {
        return {
          ok: true,
          image: {
            dataUrl: await blobToDataUrl(blob),
            width: canvas.width,
            height: canvas.height,
            size: blob.size,
          },
        }
      }
    }
    return { ok: false, reason: 'too-large' }
  } catch {
    return { ok: false, reason: 'unreadable' }
  } finally {
    bitmap.close()
  }
}

export interface PendingImage {
  id: string
  dataUrl: string      // base64 data URL
  name: string         // 文件名
  size: number         // 原始文件大小（字节）
  width?: number       // 图片宽度
  height?: number      // 图片高度
  /** 磁盘路径：本机文件用原路径，粘贴图落到历史目录 */
  filePath?: string
  /** 路径是这次粘贴落盘的，点掉未发送的预览时应删掉 */
  savedByApp?: boolean
  /** 只留原文件路径，图像内容不送去看 */
  pathOnly?: boolean
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

function tryGetLocalPath(file: File): string | undefined {
  try {
    const p = window.electronAPI?.fileUtils?.getPathForFile?.(file)
    if (typeof p === 'string' && p.trim()) return p
  } catch {
    // 剪贴板 File 没有真实路径
  }
  const legacy = (file as File & { path?: string }).path
  return legacy && legacy.trim() ? legacy : undefined
}

function readFileAsDataUrl(file: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(reader.result as string)
    reader.onerror = () => reject(reader.error ?? new Error('Failed to read file'))
    reader.readAsDataURL(file)
  })
}

async function persistIfNeeded(
  dataUrl: string,
  name: string,
  existingPath?: string,
  maxBytes?: number,
): Promise<{ filePath?: string; savedByApp: boolean }> {
  if (existingPath) return { filePath: existingPath, savedByApp: false }
  const api = window.electronAPI?.workspace?.savePastedImage
  if (!api) return { savedByApp: false }
  try {
    const res = await api(dataUrl, name, maxBytes)
    if (res.success && res.filePath) return { filePath: res.filePath, savedByApp: true }
    console.warn('persist pasted image failed', res.error)
    return { savedByApp: false }
  } catch (error) {
    console.warn('persist pasted image failed', error)
    return { savedByApp: false }
  }
}

function extFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() || p
  const dot = base.lastIndexOf('.')
  if (dot <= 0 || dot === base.length - 1) return ''
  return base.slice(dot + 1).toLowerCase()
}

function discardSavedPastedImage(img?: PendingImage) {
  if (!img?.savedByApp || !img.filePath) return
  void window.electronAPI?.workspace?.deletePastedImage?.(img.filePath)
}

export function pendingImageToAttachment(img: PendingImage): AttachmentInfo | null {
  if (!img.filePath) return null
  const ext = extFromPath(img.filePath) || extFromPath(img.name) || 'png'
  const filename = extFromPath(img.name)
    ? img.name
    : (img.filePath.split(/[\\/]/).pop() || `image.${ext}`)
  return {
    filename,
    filePath: img.filePath,
    fileSize: img.size,
    fileType: ext,
    ...(img.pathOnly ? { imagePathOnly: true } : {}),
  }
}

export function useImageUpload() {
  const { t } = useI18n()
  // 待发送的图片列表
  const pendingImages: Ref<PendingImage[]> = ref([])
  
  // 是否正在处理图片
  const isProcessingImage = ref(false)
  let processingDepth = 0

  const beginProcessing = () => {
    processingDepth += 1
    isProcessingImage.value = true
  }

  const endProcessing = () => {
    processingDepth = Math.max(0, processingDepth - 1)
    isProcessingImage.value = processingDepth > 0
  }

  interface ImagePutResult {
    ok: boolean
    pathOnly?: boolean
    /** 缩小前的字节数；没缩则为空 */
    shrunkFrom?: number
    reason?: 'count' | 'too-large' | 'unreadable' | 'unsupported' | 'shrink-fallback'
  }

  const nextImageId = () => `img_${Date.now()}_${Math.random().toString(36).substr(2, 6)}`

  /** 一次粘贴/拖入/选择只提示一轮 */
  const announce = (results: ImagePutResult[]) => {
    const shrunkCount = results.filter((result) => result.ok && result.shrunkFrom).length
    if (shrunkCount === 1) toast.info(t('ai.composerImageShrunk'))
    else if (shrunkCount > 1) toast.info(t('ai.composerImageShrunkMany', { count: shrunkCount }))
    if (results.some((result) => result.ok && result.pathOnly && result.reason !== 'shrink-fallback')) {
      toast.info(t('ai.composerImagePathKept'))
    }
    if (results.some((result) => result.reason === 'shrink-fallback')) {
      toast.warning(t('ai.composerImageShrinkFallback'), 4000)
    }
    if (results.some((result) => result.reason === 'count')) {
      toast.warning(t('ai.composerImageCountLimit', { count: IMAGE_LIMITS.MAX_COUNT }), 4000)
    }
    if (results.some((result) => result.reason === 'too-large')) {
      toast.warning(t('ai.composerImageTooLarge'), 4000)
    }
    if (results.some((result) => result.reason === 'unreadable')) {
      toast.warning(t('ai.composerImageUnreadable'), 4000)
    }
  }

  const askShrink = async (files: File[]): Promise<boolean> => {
    if (files.length === 0) return false
    const one = files.length === 1
    return showConfirm({
      title: t('ai.composerImageShrinkAskTitle'),
      message: one
        ? t('ai.composerImageShrinkAsk', {
            name: files[0].name || t('ai.composerImageUnnamed'),
            size: formatImageSize(files[0].size),
          })
        : t('ai.composerImageShrinkAskMany', { count: files.length }),
      confirmText: t('ai.composerImageShrinkConfirm'),
      cancelText: t('ai.composerImageShrinkDecline'),
    })
  }

  /** 不缩小：本机图用原路径；剪贴板没有原文件的，原样另存后再给路径。 */
  const putPathOnly = async (file: File): Promise<ImagePutResult> => {
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      return { ok: false, reason: 'count' }
    }
    const localPath = tryGetLocalPath(file)
    if (localPath) {
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl: '',
        name: file.name || 'pasted-image',
        size: file.size,
        filePath: localPath,
        savedByApp: false,
        pathOnly: true,
      })
      return { ok: true, pathOnly: true }
    }
    if (file.size > IMAGE_KEEP_MAX_BYTES) return { ok: false, reason: 'too-large' }
    beginProcessing()
    try {
      const dataUrl = await readFileAsDataUrl(file)
      const saved = await persistIfNeeded(dataUrl, file.name || 'pasted-image', undefined, IMAGE_KEEP_MAX_BYTES)
      if (!saved.filePath) return { ok: false, reason: 'unreadable' }
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl: '',
        name: file.name || 'pasted-image',
        size: file.size,
        filePath: saved.filePath,
        savedByApp: true,
        pathOnly: true,
      })
      return { ok: true, pathOnly: true }
    } catch (error) {
      console.error('留下原图失败:', error)
      return { ok: false, reason: 'unreadable' }
    } finally {
      endProcessing()
    }
  }

  /**
   * 另存一份缩小的新文件。不写回原路径。
   * 缩小不了时由调用方改留原文件。
   */
  const putShrunkCopy = async (file: File): Promise<ImagePutResult> => {
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      return { ok: false, reason: 'count' }
    }
    if (file.size > IMAGE_DECODE_MAX_BYTES) return { ok: false, reason: 'shrink-fallback' }
    beginProcessing()
    try {
      const fitted = await shrinkToByteLimit(file, IMAGE_MAX_BYTES)
      if (!fitted.ok) return { ok: false, reason: fitted.reason === 'unreadable' ? 'unreadable' : 'shrink-fallback' }
      const name = jpegDisplayName(file.name || 'pasted-image')
      const saved = await persistIfNeeded(fitted.image.dataUrl, name)
      if (!saved.filePath) return { ok: false, reason: 'unreadable' }
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl: fitted.image.dataUrl,
        name,
        size: fitted.image.size,
        width: fitted.image.width,
        height: fitted.image.height,
        filePath: saved.filePath,
        savedByApp: saved.savedByApp,
      })
      return { ok: true, shrunkFrom: file.size }
    } catch (error) {
      console.error('缩小图片失败:', error)
      return { ok: false, reason: 'unreadable' }
    } finally {
      endProcessing()
    }
  }

  const putUnderLimit = async (file: File): Promise<ImagePutResult> => {
    if (!isSupportedImage(file)) {
      console.warn(`不支持的图片类型: ${file.type}`)
      return { ok: false, reason: 'unsupported' }
    }
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      return { ok: false, reason: 'count' }
    }
    beginProcessing()
    try {
      const read = await fileToDataUrl(file)
      const localPath = tryGetLocalPath(file)
      const name = file.name || 'pasted-image'
      const saved = await persistIfNeeded(read.dataUrl, name, localPath)
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl: read.dataUrl,
        name,
        size: file.size,
        width: read.width,
        height: read.height,
        filePath: saved.filePath,
        savedByApp: saved.savedByApp,
      })
      return { ok: true }
    } catch (error) {
      console.error('处理图片失败:', error)
      return { ok: false, reason: 'unreadable' }
    } finally {
      endProcessing()
    }
  }

  const ingestImageFiles = async (files: File[]): Promise<number> => {
    const supported = files.filter(isSupportedImage)
    const results: ImagePutResult[] = []
    const large = supported.filter((file) => file.size > IMAGE_MAX_BYTES)
    const small = supported.filter((file) => file.size <= IMAGE_MAX_BYTES)
    for (const file of small) results.push(await putUnderLimit(file))
    if (large.length > 0 && pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      results.push({ ok: false, reason: 'count' })
    } else if (large.length > 0) {
      const shrink = await askShrink(large)
      for (const file of large) {
        if (!shrink) {
          results.push(await putPathOnly(file))
          continue
        }
        const shrunk = await putShrunkCopy(file)
        if (shrunk.ok || shrunk.reason === 'count') {
          results.push(shrunk)
          continue
        }
        const kept = await putPathOnly(file)
        results.push(kept.ok ? { ...kept, reason: 'shrink-fallback' } : kept)
      }
    }
    announce(results)
    return results.filter((result) => result.ok).length
  }

  const addImageFile = async (file: File): Promise<boolean> => {
    const added = await ingestImageFiles([file])
    return added > 0
  }
  
  /**
   * 直接添加 data URL 图片（产出物截图反馈等场景，无 File 对象）
   */
  const addImageDataUrl = async (
    dataUrl: string,
    name: string,
    width = 0,
    height = 0,
    filePath?: string,
  ): Promise<boolean> => {
    if (pendingImages.value.length >= IMAGE_LIMITS.MAX_COUNT) {
      announce([{ ok: false, reason: 'count' }])
      return false
    }
    const approx = Math.floor(dataUrl.length * 0.75)
    if (approx <= IMAGE_MAX_BYTES) {
      const saved = await persistIfNeeded(dataUrl, name, filePath)
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl,
        name,
        size: approx,
        width,
        height,
        filePath: saved.filePath,
        savedByApp: saved.savedByApp,
      })
      return true
    }

    let blob: Blob
    try {
      blob = await fetch(dataUrl).then((res) => res.blob())
    } catch (error) {
      console.error('处理图片失败:', error)
      announce([{ ok: false, reason: 'unreadable' }])
      return false
    }
    if (blob.size <= IMAGE_MAX_BYTES) {
      const saved = await persistIfNeeded(dataUrl, name, filePath)
      pendingImages.value.push({
        id: nextImageId(),
        dataUrl,
        name,
        size: blob.size,
        width,
        height,
        filePath: saved.filePath,
        savedByApp: saved.savedByApp,
      })
      return true
    }

    const file = new File([blob], name || 'pasted-image', { type: blob.type || 'image/png' })
    const shrink = await askShrink([file])
    if (!shrink) {
      if (filePath) {
        pendingImages.value.push({
          id: nextImageId(),
          dataUrl: '',
          name,
          size: blob.size,
          filePath,
          savedByApp: false,
          pathOnly: true,
        })
        announce([{ ok: true, pathOnly: true }])
        return true
      }
      const kept = await putPathOnly(file)
      announce([kept])
      return kept.ok
    }

    const shrunk = await putShrunkCopy(file)
    if (shrunk.ok) {
      announce([shrunk])
      return true
    }
    if (shrunk.reason === 'shrink-fallback') {
      if (filePath) {
        pendingImages.value.push({
          id: nextImageId(),
          dataUrl: '',
          name,
          size: blob.size,
          filePath,
          savedByApp: false,
          pathOnly: true,
        })
        announce([{ ok: true, pathOnly: true, reason: 'shrink-fallback' }])
        return true
      }
      const kept = await putPathOnly(file)
      announce([kept.ok ? { ...kept, reason: 'shrink-fallback' } : kept])
      return kept.ok
    }
    announce([shrunk])
    return false
  }

  const handleDroppedImages = async (files: FileList | File[]): Promise<number> => {
    return ingestImageFiles(Array.from(files))
  }
  
  /**
   * 移除指定图片
   */
  const removeImage = (id: string) => {
    const index = pendingImages.value.findIndex(img => img.id === id)
    if (index < 0) return
    const [removed] = pendingImages.value.splice(index, 1)
    discardSavedPastedImage(removed)
  }
  
  /**
   * 清空所有待发送图片（发送后用：文件已交给对话，不要删）
   */
  const clearImages = () => {
    pendingImages.value = []
  }

  /** 丢掉未发送的预览：只删我们落下的文件，不动用户本机图 */
  const discardImages = () => {
    for (const img of pendingImages.value) {
      discardSavedPastedImage(img)
    }
    pendingImages.value = []
  }

  /** 从欢迎页等外部暂存恢复待发送图片（进入助手 tab 前 handoff） */
  const loadPendingImages = (images: PendingImage[]) => {
    pendingImages.value = images.map(img => ({ ...img }))
  }

  /** 发送前补落盘：编辑填回等场景可能只有 dataUrl */
  const ensurePendingImagePaths = async () => {
    for (const img of pendingImages.value) {
      if (img.filePath) continue
      const saved = await persistIfNeeded(img.dataUrl, img.name)
      if (saved.filePath) {
        img.filePath = saved.filePath
        if (saved.savedByApp) img.savedByApp = true
      }
    }
  }

  const getImageAttachments = (): AttachmentInfo[] => {
    return pendingImages.value
      .map(pendingImageToAttachment)
      .filter((a): a is AttachmentInfo => a !== null)
  }
  
  /**
   * 获取所有待发送图片的 data URL 列表
   */
  const getImageDataUrls = (): string[] => {
    return pendingImages.value
      .filter((img) => !img.pathOnly && !!img.dataUrl)
      .map((img) => img.dataUrl)
  }

  const hasVisionImages = (): boolean => {
    return pendingImages.value.some((img) => !img.pathOnly && !!img.dataUrl)
  }

  /** 模型不能看图时丢掉要送去看的那些，只留路径的原文件还在 */
  const dropVisionImages = () => {
    const kept: PendingImage[] = []
    for (const img of pendingImages.value) {
      if (img.pathOnly) kept.push(img)
      else discardSavedPastedImage(img)
    }
    pendingImages.value = kept
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
      if (!input.files) return
      await ingestImageFiles(Array.from(input.files))
    }
    input.click()
  }
  
  return {
    pendingImages,
    isProcessingImage,
    addImageFile,
    addImageDataUrl,
    handleDroppedImages,
    removeImage,
    clearImages,
    discardImages,
    loadPendingImages,
    ensurePendingImagePaths,
    getImageAttachments,
    getImageDataUrls,
    hasImages,
    hasVisionImages,
    dropVisionImages,
    canAddMore,
    selectImages,
    IMAGE_LIMITS
  }
}
