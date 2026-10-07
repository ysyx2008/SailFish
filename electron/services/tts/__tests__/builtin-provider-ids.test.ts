import { describe, expect, it } from 'vitest'
import { isBuiltinProvider, registerBuiltinProviders } from '../index'

/**
 * 内置 TTS provider 的 id 判定必须在模块加载时就确定，不能依赖
 * registerBuiltinProviders() 是否已执行——内置注册由 ensureInitialized() 懒触发，
 * 插件装配可能发生在其之前。判定此时失效会让插件占用内置 id，并在插件停用时
 * 按裸 id 误删内置 provider。内置 id 由 provider 类派生，故「注册前」也要成立。
 */
describe('内置 TTS provider id 判定', () => {
  it('未调用 registerBuiltinProviders 时已能识别内置 id', () => {
    expect(isBuiltinProvider('openai-compat')).toBe(true)
    expect(isBuiltinProvider('volcengine-tts')).toBe(true)
    expect(isBuiltinProvider('dashscope-tts')).toBe(true)
  })

  it('插件自定义 id 不被视为内置', () => {
    expect(isBuiltinProvider('my-plugin-tts')).toBe(false)
    expect(isBuiltinProvider('')).toBe(false)
  })

  it('注册内置 provider 前后判定一致', () => {
    registerBuiltinProviders()
    expect(isBuiltinProvider('openai-compat')).toBe(true)
    expect(isBuiltinProvider('volcengine-tts')).toBe(true)
    expect(isBuiltinProvider('dashscope-tts')).toBe(true)
    expect(isBuiltinProvider('my-plugin-tts')).toBe(false)
  })
})
