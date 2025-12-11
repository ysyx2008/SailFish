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

// 赞助者专属樱花粉主题（温馨浪漫风格）
const sponsorSakuraTheme: UiThemeVars = {
  bgPrimary: '#1f1a1d',
  bgSecondary: '#2a2226',
  bgTertiary: '#171315',
  bgSurface: '#352a30',
  bgHover: '#453a40',
  
  textPrimary: '#f5e6ee',
  textSecondary: '#d4b8c8',
  textMuted: '#9a7a8a',
  
  accentPrimary: '#ff8fab',
  accentSecondary: '#f472b6',
  accentSuccess: '#86efac',
  accentWarning: '#fcd34d',
  accentError: '#fb7185',
  
  borderColor: '#4a3a42'
}

// 赞助者专属森林绿主题（清新自然风格）
const sponsorForestTheme: UiThemeVars = {
  bgPrimary: '#151a16',
  bgSecondary: '#1c231e',
  bgTertiary: '#101410',
  bgSurface: '#243027',
  bgHover: '#2f4033',
  
  textPrimary: '#e6f5ea',
  textSecondary: '#b8d4be',
  textMuted: '#7a9a80',
  
  accentPrimary: '#4ade80',
  accentSecondary: '#22c55e',
  accentSuccess: '#86efac',
  accentWarning: '#fbbf24',
  accentError: '#f87171',
  
  borderColor: '#3a4a3c'
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
