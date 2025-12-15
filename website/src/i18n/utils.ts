import { translations, type Lang, supportedLanguages, defaultLanguage } from './translations';

/**
 * 从 URL 路径检测语言
 * 支持格式: /en/... 或其他语言前缀
 */
export function getLangFromUrl(url: URL): Lang {
  const path = url.pathname;
  
  // 检查所有支持的语言前缀（除了默认语言）
  for (const lang of supportedLanguages) {
    if (lang !== defaultLanguage && path.startsWith(`/${lang}`)) {
      return lang;
    }
  }
  
  return defaultLanguage;
}

/**
 * 获取指定语言的翻译对象
 */
export function useTranslations(lang: Lang) {
  // 如果语言不存在，回退到默认语言
  if (!(lang in translations)) {
    return translations[defaultLanguage];
  }
  return translations[lang];
}

/**
 * 获取备用语言（用于语言切换）
 * 目前返回另一个主要语言，未来可以扩展为语言列表
 */
export function getAlternateLang(lang: Lang): Lang {
  // 返回第一个不同的支持语言
  const otherLang = supportedLanguages.find(l => l !== lang);
  return otherLang || defaultLanguage;
}

/**
 * 获取切换语言后的 URL
 */
export function getAlternateUrl(currentUrl: URL, targetLang: Lang): string {
  const path = currentUrl.pathname;
  
  // 如果目标语言是默认语言，移除所有语言前缀
  if (targetLang === defaultLanguage) {
    // 移除所有支持的语言前缀
    let newPath = path;
    for (const lang of supportedLanguages) {
      if (lang !== defaultLanguage) {
        newPath = newPath.replace(new RegExp(`^/${lang}`), '');
      }
    }
    return newPath || '/';
  }
  
  // 如果目标语言不是默认语言，添加或替换语言前缀
  // 先移除现有语言前缀
  let newPath = path;
  for (const lang of supportedLanguages) {
    if (lang !== defaultLanguage) {
      newPath = newPath.replace(new RegExp(`^/${lang}`), '');
    }
  }
  
  // 添加目标语言前缀
  return `/${targetLang}${newPath}`;
}

/**
 * 验证语言是否支持
 */
export function isValidLang(lang: string): lang is Lang {
  return supportedLanguages.includes(lang as Lang);
}
