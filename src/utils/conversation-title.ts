/**
 * 会话侧栏展示标题：优先 record.title，否则回退 userTask。
 * 标题是会话自身字段，不再走 config overlay。
 */
import i18n from '../i18n'
import { markersToFileNames } from '../composables/message-attachment-inline'

/** 文字里的「[附件：名称]」标记显示成文件名本身（各界面语言的写法都认）；标题、排队条这类纯文字场合用 */
export function withFileNames(text: string): string {
  const { t, availableLocales } = i18n.global
  return markersToFileNames(
    text,
    availableLocales.map(locale => (name: string) => String(t('ai.attachmentMarker', { name }, { locale }))),
  )
}

export function resolveConversationDisplayTitle(record: {
  title?: string
  userTask: string
}): string {
  const titled = record.title?.trim()
  if (titled) return withFileNames(titled).replace(/\s+/g, ' ')

  const task = record.userTask.trim()
  if (task === '__onboarding__') {
    return String(i18n.global.t('ai.onboardingConversationTitle'))
  }
  return withFileNames(task).replace(/\s+/g, ' ')
}
