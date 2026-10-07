/**
 * TTS 服务
 *
 * 管理 TTS provider 的注册（内置 + 插件）和语音合成路由。
 * 模块级状态，通过动态 import 懒加载（与 speech/index.ts 模式一致）。
 */

import type { TtsProvider, TtsSynthesizeOptions, TtsSynthesizeResult, TtsVoice, TtsSettings } from './types'
import { DEFAULT_TTS_SETTINGS } from './types'
import { OpenAICompatTtsProvider, setSettingsGetter } from './openai-provider'
import { VolcengineTtsProvider, setVolcengineSettingsGetter } from './volcengine-provider'
import { DashScopeTtsProvider, setDashScopeSettingsGetter } from './dashscope-provider'
import { createLogger } from '../../utils/logger'

const log = createLogger('TTS')

const providers = new Map<string, TtsProvider>()
let currentSettings: TtsSettings = { ...DEFAULT_TTS_SETTINGS }
let initialized = false

/** 跟踪所有进行中的合成请求，以便统一取消 */
const activeControllers = new Set<AbortController>()

/**
 * 确保内置 provider 已注册（幂等）
 */
export function ensureInitialized(): void {
  if (initialized) return
  try {
    registerBuiltinProviders()
    initialized = true
  } catch (err) {
    log.error('Failed to initialize builtin TTS providers:', err)
  }
}

/**
 * 注册内置 provider
 */
export function registerBuiltinProviders(): void {
  const getter = () => getSettings()
  setSettingsGetter(getter)
  setVolcengineSettingsGetter(getter)
  setDashScopeSettingsGetter(getter)

  for (const P of [OpenAICompatTtsProvider, VolcengineTtsProvider, DashScopeTtsProvider]) {
    const provider = new P()
    registerProvider(provider)
  }
  log.info(`Builtin TTS providers registered: ${providers.size}`)
}

/**
 * 内置 TTS provider id 集合。
 * 插件 provider 与内置 provider 共用同一个池，插件不得占用这些 id，
 * 撤销逻辑也凭此避免按裸 id 误删内置 provider。
 * 新增内置 provider 时必须同步维护此列表（与 registerBuiltinProviders 保持一致）。
 */
const BUILTIN_TTS_PROVIDER_IDS = ['openai-compat', 'volcengine-tts', 'dashscope-tts']

export function isBuiltinProvider(id: string): boolean {
  return BUILTIN_TTS_PROVIDER_IDS.includes(id)
}

/**
 * 注册 provider（插件或内置）
 */
export function registerProvider(provider: TtsProvider): void {
  if (providers.has(provider.id)) {
    log.warn(`TTS provider "${provider.id}" already registered, overwriting`)
    safeDispose(providers.get(provider.id))
  }
  providers.set(provider.id, provider)
  log.info(`TTS provider registered: ${provider.id} (${provider.name})`)
}

/**
 * 移除 provider
 */
export function removeProvider(id: string): void {
  const provider = providers.get(id)
  if (provider) {
    safeDispose(provider)
    providers.delete(id)
    log.info(`TTS provider removed: ${id}`)
  }
}

/** dispose 不影响注册/撤销流程本身（插件的 dispose 抛错只记录） */
function safeDispose(provider: TtsProvider | undefined): void {
  if (!provider?.dispose) return
  try {
    provider.dispose()
  } catch (err) {
    log.error(`TTS provider "${provider.id}" dispose failed:`, err)
  }
}

/**
 * 更新配置
 */
export function updateSettings(settings: TtsSettings): void {
  currentSettings = { ...settings }
}

/**
 * 获取当前配置
 */
export function getSettings(): TtsSettings {
  return { ...currentSettings }
}

/**
 * 获取所有已注册的 provider
 */
export function getProviders(): Array<{ id: string; name: string }> {
  return Array.from(providers.values()).map(p => ({ id: p.id, name: p.name }))
}

/**
 * 合成语音
 */
export async function synthesize(
  text: string,
  options?: Partial<TtsSynthesizeOptions>
): Promise<TtsSynthesizeResult> {
  const provider = providers.get(currentSettings.providerId)
  if (!provider) {
    throw new Error(`TTS provider "${currentSettings.providerId}" not found`)
  }

  const mergedOptions: TtsSynthesizeOptions = {
    voice: options?.voice ?? currentSettings.voice,
    model: options?.model ?? currentSettings.model,
    speed: options?.speed ?? currentSettings.speed,
    responseFormat: options?.responseFormat ?? 'mp3',
  }

  const controller = new AbortController()
  activeControllers.add(controller)

  try {
    const result = await provider.synthesize(text, mergedOptions, controller.signal)
    return result
  } finally {
    activeControllers.delete(controller)
  }
}

/**
 * 取消所有进行中的合成请求
 */
export function stopSynthesis(): void {
  for (const controller of activeControllers) {
    controller.abort()
  }
  activeControllers.clear()
}

/**
 * 获取当前 provider 的可用声色
 */
export async function getVoices(): Promise<TtsVoice[]> {
  const provider = providers.get(currentSettings.providerId)
  if (!provider?.getVoices) {
    return []
  }
  return provider.getVoices()
}

/**
 * 释放所有资源
 */
export function dispose(): void {
  stopSynthesis()
  for (const provider of providers.values()) {
    provider.dispose?.()
  }
  providers.clear()
  initialized = false
  log.info('TTS service disposed')
}
