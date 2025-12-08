import { createI18n } from 'vue-i18n'
import zhCN from './locales/zh-CN'
import enUS from './locales/en-US'

export type LocaleType = 'zh-CN' | 'en-US'

export const SUPPORTED_LOCALES: { value: LocaleType; label: string }[] = [
  { value: 'zh-CN', label: '简体中文' },
  { value: 'en-US', label: 'English' }
]

// 获取默认语言
const getDefaultLocale = (): LocaleType => {
  // 优先使用浏览器语言
  const browserLang = navigator.language
  if (browserLang.startsWith('zh')) {
    return 'zh-CN'
  }
  return 'en-US'
}

const i18n = createI18n({
  legacy: false, // 使用 Composition API 模式
  locale: getDefaultLocale(),
  fallbackLocale: 'en-US',
  messages: {
    'zh-CN': zhCN,
    'en-US': enUS
  }
})

// 导出切换语言的函数
export const setLocale = (locale: LocaleType) => {
  i18n.global.locale.value = locale
}

// 导出获取当前语言的函数
export const getLocale = (): LocaleType => {
  return i18n.global.locale.value as LocaleType
}

export default i18n
