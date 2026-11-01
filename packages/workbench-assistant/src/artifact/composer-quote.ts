import type { InjectionKey } from 'vue'

/** 产出物引用到 Composer 的摘录（与桌面 ComposerQuoteSnippet 字段对齐，不含 id） */
export interface ArtifactComposerQuote {
  label: string
  sourcePath: string | null
  sourceLinesAccurate: boolean
  startLine: number | null
  endLine: number | null
  excerpt: string
  quoteOrigin?: 'canvas' | 'terminal'
}

export type AddComposerQuoteFn = (snippet: ArtifactComposerQuote) => void

/** ArtifactPanel provide → MarkdownRenderer inject */
export const ADD_COMPOSER_QUOTE_KEY: InjectionKey<AddComposerQuoteFn> = Symbol('addComposerQuote')

export type SetComposerDraftFn = (text: string) => void

/** 选区快捷指令：面板 provide → MarkdownRenderer inject（设置 Composer 草稿文本） */
export const SET_COMPOSER_DRAFT_KEY: InjectionKey<SetComposerDraftFn> = Symbol('setComposerDraft')

export type SubmitComposerMessageFn = (text: string) => void

/** 选区右键快捷指令：当场发出，不预填输入框 */
export const SUBMIT_COMPOSER_MESSAGE_KEY: InjectionKey<SubmitComposerMessageFn> = Symbol('submitComposerMessage')

/** 产出物面板与当前对话输入、步骤定位的接线，所有入口共用。 */
export interface ArtifactPanelBindings {
  scrollToAgentStep?: (stepId: string) => void | Promise<void>
  addComposerQuote?: AddComposerQuoteFn
  addComposerImage?: (image: { dataUrl: string; name: string; width?: number; height?: number; filePath?: string }) => void
  setComposerDraft?: SetComposerDraftFn
  submitComposerMessage?: SubmitComposerMessageFn
}
