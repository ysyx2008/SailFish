/**
 * AI 相关共享类型（IPC 边界）
 *
 * 这些类型在前后端之间通过 IPC 序列化传递，是单一真相来源。
 * 后端 service、preload、前端 store 一律从 `@shared/types` 导入，
 * 禁止重复定义。
 */

/** AI 模型类型 */
export type AiModelType = 'general' | 'vision'

/** API 协议格式 */
export type ApiFormat = 'auto' | 'openai' | 'anthropic'

/** AI Profile（API endpoint + 模型配置） */
export interface AiProfile {
  id: string
  name: string
  apiUrl: string
  apiKey: string
  model: string
  proxy?: string
  /** 模型上下文长度（tokens），默认 128000 */
  contextLength?: number
  /** 单次回复最大输出 token 数；未填时按 32768 */
  maxOutputTokens?: number
  /** 采样温度，留空则自动选择（默认 0.7，部分模型如 Kimi K2.5 强制为 1） */
  temperature?: number
  /** 模型类型，默认 general */
  modelType?: AiModelType
  /** 关联的视觉模型 Profile ID（仅 general 类型有效） */
  visionProfileId?: string
  /** API 协议格式，默认 auto（自动检测） */
  apiFormat?: ApiFormat
  /**
   * 来自公司模型清单的稳定编号。有这个编号、又没填钥匙时，对话按清单约定带登录令牌或不带凭证。
   * 用户后来改过这条时仍留着，用来认出「这是公司给的那条」，避免升级时再塞一份。
   */
  oemCatalogId?: string
  /** 用户改过这条之后，清单再更新也不再改它的地址、名字和文本/视觉。 */
  oemDetached?: boolean
}

/** 从供应商模型列表解析出的条目（选模型时回填上下文 / 输出上限） */
export interface FetchedAiModel {
  id: string
  supportsVision: boolean
  contextLength?: number
  maxOutputTokens?: number
}

/** 等待模型首 token 文案的 i18n 键前缀（后端 flat key，camelCase） */
export const WAITING_FOR_MODEL_I18N_PREFIX = 'ai.waitingForModel' as const

export type WaitingForModelI18nVariant = 'default' | 'easter' | 'slow'

/** 构建 waiting-for-model 文案 i18n 键（后端 agent/i18n.ts 使用） */
export function waitingForModelI18nKey(
  id: string,
  variant: WaitingForModelI18nVariant = 'default',
): string {
  switch (variant) {
    case 'easter':
      return `${WAITING_FOR_MODEL_I18N_PREFIX}.easter.${id}`
    case 'slow':
      return `${WAITING_FOR_MODEL_I18N_PREFIX}.slow.${id}`
    default:
      return `${WAITING_FOR_MODEL_I18N_PREFIX}.${id}`
  }
}

/** 等待模型首 token 时随机展示的文案子键（前后端 i18n 共用） */
export const WAITING_FOR_MODEL_LABEL_IDS = [
  'diving',
  'scanning',
  'waitingWave',
  'booting',
  'neurons',
  'inspiration',
  'calling',
] as const

/** 5% 概率出现的彩蛋文案 */
export const WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS = [
  'coffee',
  'bribingGpu',
  'quantum',
  'yoda',
  'haggling',
] as const

/** TTFT 超过阈值后切换的调侃文案 */
export const WAITING_FOR_MODEL_SLOW_LABEL_IDS = [
  'slacking',
  'patience',
  'deepBreath',
  'novel',
  'almostThere',
] as const

export type WaitingForModelLabelId = (typeof WAITING_FOR_MODEL_LABEL_IDS)[number]
export type WaitingForModelEasterEggLabelId = (typeof WAITING_FOR_MODEL_EASTER_EGG_LABEL_IDS)[number]
export type WaitingForModelSlowLabelId = (typeof WAITING_FOR_MODEL_SLOW_LABEL_IDS)[number]

/** 彩蛋文案出现概率 */
export const WAITING_FOR_MODEL_EASTER_EGG_CHANCE = 0.05

/** 任务完成 footer 偶发趣味文案概率（其余走 default 池） */
export const TASK_COMPLETE_FUN_CHANCE = 0.08

/** 超过此 TTFT（ms）后切换为 slow 调侃文案 */
export const WAITING_FOR_MODEL_SLOW_TTFT_MS = 10_000
