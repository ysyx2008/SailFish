/**
 * 用户附带图片时写给模型的系统附注。
 * 有磁盘路径时一并告知，避免它满盘找图。
 */
import type { AttachmentInfo } from '@shared/types'
import { t } from './i18n'

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp'])

export function collectImageAttachmentPaths(attachments?: AttachmentInfo[]): string[] {
  if (!attachments?.length) return []
  const paths: string[] = []
  for (const a of attachments) {
    if (!a.filePath) continue
    const ext = (a.fileType || a.filename.split('.').pop() || '')
      .toLowerCase()
      .replace(/^\./, '')
    const looksLikeImage = IMAGE_EXTS.has(ext)
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filename)
      || /\.(png|jpe?g|gif|webp|bmp)$/i.test(a.filePath)
    if (a.imagePathOnly) continue
    if (looksLikeImage) paths.push(a.filePath)
  }
  return paths
}

/** 只留了路径、没有把图像内容送去看的那些图 */
export function collectPathOnlyImagePaths(attachments?: AttachmentInfo[]): string[] {
  if (!attachments?.length) return []
  const paths: string[] = []
  for (const a of attachments) {
    if (!a.imagePathOnly || !a.filePath) continue
    paths.push(a.filePath)
  }
  return paths
}

function formatPathsBlock(paths: string[]): string {
  if (paths.length === 0) return ''
  const listed = paths.length === 1
    ? paths[0]
    : paths.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return t('agent.images_attached_paths', { paths: listed })
}

/** 用户留下了原图路径，图像内容没有直接送进来。只陈述这件事。 */
export function buildPathOnlyImageNote(paths: string[]): string {
  if (paths.length === 0) return ''
  const listed = paths.length === 1
    ? paths[0]
    : paths.map((p, i) => `${i + 1}. ${p}`).join('\n')
  return t('agent.images_path_only', { count: paths.length, paths: listed })
}

export function buildUserImageNote(opts: {
  count: number
  paths: string[]
  visionAvailable: boolean
}): string {
  const paths = formatPathsBlock(opts.paths)
  if (opts.visionAvailable) {
    return t('agent.images_attached', { count: opts.count, paths })
  }
  return t('agent.user_image_no_vision', { count: opts.count, paths })
}
