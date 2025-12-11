// UI 主题类型
export type UiThemeName = 'dark' | 'light' | 'blue' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-forest'

// UI 主题 CSS 变量定义
export interface UiThemeVars {
  // 背景色
  bgPrimary: string
  bgSecondary: string
  bgTertiary: string
  bgSurface: string
  bgHover: string
  
  // 文字色
  textPrimary: string
  textSecondary: string
  textMuted: string
  
  // 强调色
  accentPrimary: string
  accentSecondary: string
  accentSuccess: string
  accentWarning: string
  accentError: string
  
  // 边框
  borderColor: string
}

// 深色主题（当前默认主题 - Catppuccin Mocha 风格）
const darkTheme: UiThemeVars = {
  bgPrimary: '#1e1e2e',
  bgSecondary: '#181825',
  bgTertiary: '#11111b',
  bgSurface: '#313244',
  bgHover: '#45475a',
  
  textPrimary: '#cdd6f4',
  textSecondary: '#a6adc8',
  textMuted: '#6c7086',
  
  accentPrimary: '#89b4fa',
  accentSecondary: '#74c7ec',
  accentSuccess: '#a6e3a1',
  accentWarning: '#f9e2af',
  accentError: '#f38ba8',
  
  borderColor: '#45475a'
}

// 浅色主题
const lightTheme: UiThemeVars = {
  bgPrimary: '#ffffff',
  bgSecondary: '#f5f5f5',
  bgTertiary: '#e8e8e8',
  bgSurface: '#ffffff',
  bgHover: '#e0e0e0',
  
  textPrimary: '#1a1a1a',
  textSecondary: '#4a4a4a',
  textMuted: '#8a8a8a',
  
  accentPrimary: '#0078d4',
  accentSecondary: '#106ebe',
  accentSuccess: '#107c10',
  accentWarning: '#ca5010',
  accentError: '#d13438',
  
  borderColor: '#d1d1d1'
}

// 蓝色主题（VS 经典风格）
const blueTheme: UiThemeVars = {
  bgPrimary: '#1e3a5f',
  bgSecondary: '#152d4a',
  bgTertiary: '#0d1f33',
  bgSurface: '#264b73',
  bgHover: '#2d5a8a',
  
  textPrimary: '#e8f0f8',
  textSecondary: '#b8d0e8',
  textMuted: '#7a9aba',
  
  accentPrimary: '#4db8ff',
  accentSecondary: '#66c2ff',
  accentSuccess: '#6dd400',
  accentWarning: '#ffb900',
  accentError: '#ff6b6b',
  
  borderColor: '#3a6a9a'
}

// 赞助者专属金色主题（尊贵风格）
const sponsorGoldTheme: UiThemeVars = {
  bgPrimary: '#1a1612',
  bgSecondary: '#231f1a',
  bgTertiary: '#141210',
  bgSurface: '#2d2720',
  bgHover: '#3d352a',
  
  textPrimary: '#f5e6d3',
  textSecondary: '#c9b89a',
  textMuted: '#8a7a65',
  
  accentPrimary: '#d4af37',
  accentSecondary: '#b8962e',
  accentSuccess: '#9acd32',
  accentWarning: '#ffa500',
  accentError: '#cd5c5c',
  
  borderColor: '#4a4035'
}

// 赞助者专属樱花粉主题（温柔优雅风格）
const sponsorSakuraTheme: UiThemeVars = {
  bgPrimary: '#1e1921',
  bgSecondary: '#252028',
  bgTertiary: '#16121a',
  bgSurface: '#2e2733',
  bgHover: '#3d3444',
  
  textPrimary: '#f0e4ec',
  textSecondary: '#c9b6c4',
  textMuted: '#8a7585',
  
  accentPrimary: '#d4a5b9',
  accentSecondary: '#c792ac',
  accentSuccess: '#a3d9a5',
  accentWarning: '#e8c87a',
  accentError: '#e07a7a',
  
  borderColor: '#423848'
}

// 赞助者专属森林绿主题（清新自然风格）
const sponsorForestTheme: UiThemeVars = {
  bgPrimary: '#181d1a',
  bgSecondary: '#1e2521',
  bgTertiary: '#121614',
  bgSurface: '#262e28',
  bgHover: '#313b34',
  
  textPrimary: '#e2ede6',
  textSecondary: '#b5c9bb',
  textMuted: '#7a9482',
  
  accentPrimary: '#7ec9a0',
  accentSecondary: '#6bb58d',
  accentSuccess: '#8fd4a8',
  accentWarning: '#d4b87a',
  accentError: '#d98b8b',
  
  borderColor: '#354038'
}

// 主题集合
export const uiThemes: Record<UiThemeName, UiThemeVars> = {
  dark: darkTheme,
  light: lightTheme,
  blue: blueTheme,
  'sponsor-gold': sponsorGoldTheme,
  'sponsor-sakura': sponsorSakuraTheme,
  'sponsor-forest': sponsorForestTheme
}

// 赞助者专属 UI 主题列表
export const sponsorUiThemes: UiThemeName[] = ['sponsor-gold', 'sponsor-sakura', 'sponsor-forest']

// 获取 UI 主题
export function getUiTheme(name: string): UiThemeVars {
  return uiThemes[name as UiThemeName] || uiThemes.dark
}

// 获取所有 UI 主题名称
export function getUiThemeNames(): UiThemeName[] {
  return Object.keys(uiThemes) as UiThemeName[]
}
