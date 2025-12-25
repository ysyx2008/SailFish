/**
 * UI 主题定义（用于主题预览卡片）
 * 
 * ⚠️ 注意：修改主题颜色时，需要同步修改以下两个文件：
 * 1. 本文件 (ui-themes.ts) - 用于设置界面的主题预览卡片
 * 2. src/styles/main.css - 实际应用到 UI 的 CSS 变量
 */

// UI 主题类型
export type UiThemeName = 'dark' | 'light' | 'blue' | 'gruvbox' | 'forest' | 'ayu-mirage' | 'sponsor-gold' | 'sponsor-sakura' | 'sponsor-rose-pine'

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

// 暖橙主题（温暖的棕橙色调，中深色）
const gruvboxTheme: UiThemeVars = {
  bgPrimary: '#2d251f',
  bgSecondary: '#251f1a',
  bgTertiary: '#1f1a15',
  bgSurface: '#3a3028',
  bgHover: '#4a3d32',
  
  textPrimary: '#e8d5c4',
  textSecondary: '#c8b8a5',
  textMuted: '#8a7a6a',
  
  accentPrimary: '#e8a855',
  accentSecondary: '#d09545',
  accentSuccess: '#a8c070',
  accentWarning: '#e0a050',
  accentError: '#e07055',
  
  borderColor: '#4a3d32'
}

// Forest 主题（浅色清新的森林绿色调）
const forestTheme: UiThemeVars = {
  bgPrimary: '#f6fbf8',
  bgSecondary: '#eef6f0',
  bgTertiary: '#e5f0e8',
  bgSurface: '#ffffff',
  bgHover: '#e0ede4',
  
  textPrimary: '#2a403a',
  textSecondary: '#4a665a',
  textMuted: '#7a9a8a',
  
  accentPrimary: '#4a9a70',
  accentSecondary: '#3a8560',
  accentSuccess: '#5aaa75',
  accentWarning: '#aa8540',
  accentError: '#b85555',
  
  borderColor: '#c8dcd0'
}

// Ayu Mirage 主题（现代化的橙色调）
const ayuMirageTheme: UiThemeVars = {
  bgPrimary: '#1f2430',
  bgSecondary: '#1a1f29',
  bgTertiary: '#151920',
  bgSurface: '#232834',
  bgHover: '#34455a',
  
  textPrimary: '#cbccc6',
  textSecondary: '#b8b4a8',
  textMuted: '#707a8c',
  
  accentPrimary: '#ffcc66',
  accentSecondary: '#ffd580',
  accentSuccess: '#bae67e',
  accentWarning: '#ffa759',
  accentError: '#ff3333',
  
  borderColor: '#3d4455'
}

// 赞助者专属暗金色主题（尊贵内敛风格）
const sponsorGoldTheme: UiThemeVars = {
  bgPrimary: '#1a1612',
  bgSecondary: '#231f1a',
  bgTertiary: '#141210',
  bgSurface: '#2d2720',
  bgHover: '#3d352a',
  
  textPrimary: '#e8dcc8',
  textSecondary: '#b8a88a',
  textMuted: '#7a6b55',
  
  accentPrimary: '#b8860b',
  accentSecondary: '#996b08',
  accentSuccess: '#7a9a32',
  accentWarning: '#cc8800',
  accentError: '#b85050',
  
  borderColor: '#4a4035'
}

// 赞助者专属樱花粉主题（浅色温柔风格）
const sponsorSakuraTheme: UiThemeVars = {
  bgPrimary: '#fdf8fa',
  bgSecondary: '#f8f0f4',
  bgTertiary: '#f2e8ed',
  bgSurface: '#ffffff',
  bgHover: '#f5e5ec',
  
  textPrimary: '#4a3040',
  textSecondary: '#6b4a5a',
  textMuted: '#9a7a8a',
  
  accentPrimary: '#d4728a',
  accentSecondary: '#c25d78',
  accentSuccess: '#5a9a6a',
  accentWarning: '#c98a40',
  accentError: '#c95050',
  
  borderColor: '#e8d0dc'
}

// 赞助者专属玫瑰松主题（温暖的玫瑰色调）
const sponsorRosePineTheme: UiThemeVars = {
  bgPrimary: '#191724',
  bgSecondary: '#1f1d2e',
  bgTertiary: '#13111e',
  bgSurface: '#26233a',
  bgHover: '#403d52',
  
  textPrimary: '#e0def4',
  textSecondary: '#908caa',
  textMuted: '#6e6a86',
  
  accentPrimary: '#ebbcba',
  accentSecondary: '#c4a7e7',
  accentSuccess: '#31748f',
  accentWarning: '#f6c177',
  accentError: '#eb6f92',
  
  borderColor: '#403d52'
}

// 主题集合
export const uiThemes: Record<UiThemeName, UiThemeVars> = {
  dark: darkTheme,
  light: lightTheme,
  blue: blueTheme,
  'gruvbox': gruvboxTheme,
  'forest': forestTheme,
  'ayu-mirage': ayuMirageTheme,
  'sponsor-gold': sponsorGoldTheme,
  'sponsor-sakura': sponsorSakuraTheme,
  'sponsor-rose-pine': sponsorRosePineTheme
}

// 赞助者专属 UI 主题列表
export const sponsorUiThemes: UiThemeName[] = ['sponsor-gold', 'sponsor-sakura', 'sponsor-rose-pine']

// 获取 UI 主题
export function getUiTheme(name: string): UiThemeVars {
  return uiThemes[name as UiThemeName] || uiThemes.dark
}

// 获取所有 UI 主题名称
export function getUiThemeNames(): UiThemeName[] {
  return Object.keys(uiThemes) as UiThemeName[]
}
