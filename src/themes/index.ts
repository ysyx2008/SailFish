import type { ITheme } from '@xterm/xterm'
import { uiThemes, type UiThemeName } from './ui-themes'

export type ThemeName =
  | 'one-dark'
  | 'dracula'
  | 'monokai'
  | 'solarized-dark'
  | 'solarized-light'
  | 'nord'
  | 'github-dark'
  | 'github-light'
  | 'catppuccin'
  | 'gruvbox'
  | 'forest'
  | 'ayu-mirage'
  | 'cyberpunk'
  | 'aurora'
  | 'sponsor-gold'

// One Dark 主题
const oneDark: ITheme = {
  background: '#282c34',
  foreground: '#abb2bf',
  cursor: '#528bff',
  cursorAccent: '#282c34',
  selectionBackground: '#3e4451',
  black: '#282c34',
  red: '#e06c75',
  green: '#98c379',
  yellow: '#e5c07b',
  blue: '#61afef',
  magenta: '#c678dd',
  cyan: '#56b6c2',
  white: '#abb2bf',
  brightBlack: '#5c6370',
  brightRed: '#e06c75',
  brightGreen: '#98c379',
  brightYellow: '#e5c07b',
  brightBlue: '#61afef',
  brightMagenta: '#c678dd',
  brightCyan: '#56b6c2',
  brightWhite: '#ffffff'
}

// Dracula 主题
const dracula: ITheme = {
  background: '#282a36',
  foreground: '#f8f8f2',
  cursor: '#f8f8f2',
  cursorAccent: '#282a36',
  selectionBackground: '#44475a',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff'
}

// Monokai 主题
const monokai: ITheme = {
  background: '#272822',
  foreground: '#f8f8f2',
  cursor: '#f8f8f0',
  cursorAccent: '#272822',
  selectionBackground: '#49483e',
  black: '#272822',
  red: '#f92672',
  green: '#a6e22e',
  yellow: '#f4bf75',
  blue: '#66d9ef',
  magenta: '#ae81ff',
  cyan: '#a1efe4',
  white: '#f8f8f2',
  brightBlack: '#75715e',
  brightRed: '#f92672',
  brightGreen: '#a6e22e',
  brightYellow: '#f4bf75',
  brightBlue: '#66d9ef',
  brightMagenta: '#ae81ff',
  brightCyan: '#a1efe4',
  brightWhite: '#f9f8f5'
}

// Solarized Dark 主题
const solarizedDark: ITheme = {
  background: '#002b36',
  foreground: '#839496',
  cursor: '#839496',
  cursorAccent: '#002b36',
  selectionBackground: '#073642',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

// Solarized Light 主题（浅色）
const solarizedLight: ITheme = {
  background: '#fdf6e3',
  foreground: '#657b83',
  cursor: '#657b83',
  cursorAccent: '#fdf6e3',
  selectionBackground: '#eee8d5',
  black: '#073642',
  red: '#dc322f',
  green: '#859900',
  yellow: '#b58900',
  blue: '#268bd2',
  magenta: '#d33682',
  cyan: '#2aa198',
  white: '#eee8d5',
  brightBlack: '#002b36',
  brightRed: '#cb4b16',
  brightGreen: '#586e75',
  brightYellow: '#657b83',
  brightBlue: '#839496',
  brightMagenta: '#6c71c4',
  brightCyan: '#93a1a1',
  brightWhite: '#fdf6e3'
}

// Nord 主题
const nord: ITheme = {
  background: '#2e3440',
  foreground: '#d8dee9',
  cursor: '#d8dee9',
  cursorAccent: '#2e3440',
  selectionBackground: '#434c5e',
  black: '#3b4252',
  red: '#bf616a',
  green: '#a3be8c',
  yellow: '#ebcb8b',
  blue: '#81a1c1',
  magenta: '#b48ead',
  cyan: '#88c0d0',
  white: '#e5e9f0',
  brightBlack: '#4c566a',
  brightRed: '#bf616a',
  brightGreen: '#a3be8c',
  brightYellow: '#ebcb8b',
  brightBlue: '#81a1c1',
  brightMagenta: '#b48ead',
  brightCyan: '#8fbcbb',
  brightWhite: '#eceff4'
}

// GitHub Dark 主题
const githubDark: ITheme = {
  background: '#0d1117',
  foreground: '#c9d1d9',
  cursor: '#c9d1d9',
  cursorAccent: '#0d1117',
  selectionBackground: '#3b5070',
  black: '#484f58',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#bc8cff',
  cyan: '#39c5cf',
  white: '#b1bac4',
  brightBlack: '#6e7681',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#d2a8ff',
  brightCyan: '#56d4dd',
  brightWhite: '#f0f6fc'
}

// GitHub Light 主题（浅色）
const githubLight: ITheme = {
  background: '#ffffff',
  foreground: '#24292f',
  cursor: '#24292f',
  cursorAccent: '#ffffff',
  selectionBackground: '#bde0fc',
  black: '#24292f',
  red: '#cf222e',
  green: '#116329',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#1a7f37',
  brightYellow: '#633c01',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f'
}

// Catppuccin Mocha 主题
const catppuccin: ITheme = {
  background: '#1e1e2e',
  foreground: '#cdd6f4',
  cursor: '#f5e0dc',
  cursorAccent: '#1e1e2e',
  selectionBackground: '#45475a',
  black: '#45475a',
  red: '#f38ba8',
  green: '#a6e3a1',
  yellow: '#f9e2af',
  blue: '#89b4fa',
  magenta: '#cba6f7',
  cyan: '#94e2d5',
  white: '#bac2de',
  brightBlack: '#585b70',
  brightRed: '#f38ba8',
  brightGreen: '#a6e3a1',
  brightYellow: '#f9e2af',
  brightBlue: '#89b4fa',
  brightMagenta: '#cba6f7',
  brightCyan: '#94e2d5',
  brightWhite: '#a6adc8'
}

// 暖橙主题 - 温暖的棕橙色调（中深色）
const gruvbox: ITheme = {
  background: '#2d251f',
  foreground: '#e8d5c4',
  cursor: '#e8a855',
  cursorAccent: '#2d251f',
  selectionBackground: '#4a3d32',
  black: '#2d251f',
  red: '#e07055',
  green: '#a8c070',
  yellow: '#e8a855',
  blue: '#70a8c0',
  magenta: '#c08090',
  cyan: '#70c0a8',
  white: '#e8d5c4',
  brightBlack: '#6a5a4a',
  brightRed: '#f08060',
  brightGreen: '#b8d080',
  brightYellow: '#f0b860',
  brightBlue: '#80b8d0',
  brightMagenta: '#d090a0',
  brightCyan: '#80d0b8',
  brightWhite: '#f5ebe0'
}

// Forest 主题 - 浅色清新的森林绿色调
const forest: ITheme = {
  background: '#f6fbf8',
  foreground: '#2a403a',
  cursor: '#4a9a70',
  cursorAccent: '#f6fbf8',
  selectionBackground: '#c8dcd0',
  black: '#2a403a',
  red: '#b85555',
  green: '#4a9a70',
  yellow: '#aa8540',
  blue: '#4a7a9a',
  magenta: '#8a5a8a',
  cyan: '#3a8a7a',
  white: '#e5f0e8',
  brightBlack: '#4a665a',
  brightRed: '#c86060',
  brightGreen: '#5aaa75',
  brightYellow: '#bb9550',
  brightBlue: '#5a8aaa',
  brightMagenta: '#9a6a9a',
  brightCyan: '#4a9a8a',
  brightWhite: '#f6fbf8'
}

// Ayu Mirage 主题 - 现代化的橙色调
const ayuMirage: ITheme = {
  background: '#1f2430',
  foreground: '#cbccc6',
  cursor: '#ffcc66',
  cursorAccent: '#1f2430',
  selectionBackground: '#34455a',
  black: '#1f2430',
  red: '#ff3333',
  green: '#bae67e',
  yellow: '#ffd580',
  blue: '#73d0ff',
  magenta: '#d4bfff',
  cyan: '#95e6cb',
  white: '#cbccc6',
  brightBlack: '#707a8c',
  brightRed: '#ff6666',
  brightGreen: '#bae67e',
  brightYellow: '#ffd580',
  brightBlue: '#73d0ff',
  brightMagenta: '#d4bfff',
  brightCyan: '#95e6cb',
  brightWhite: '#f3f4f5'
}

// 赞助者专属主题 - 金色暖色调
const sponsorGold: ITheme = {
  background: '#1a1a1a',
  foreground: '#e8d4b0',
  cursor: '#ffd700',
  cursorAccent: '#1a1a1a',
  selectionBackground: '#3d3522',
  black: '#2a2a2a',
  red: '#ff6b6b',
  green: '#c9a961',
  yellow: '#ffd700',
  blue: '#d4af37',
  magenta: '#daa520',
  cyan: '#f4a460',
  white: '#e8d4b0',
  brightBlack: '#4a4a4a',
  brightRed: '#ff8787',
  brightGreen: '#d4c085',
  brightYellow: '#ffed4e',
  brightBlue: '#e5c158',
  brightMagenta: '#e5b858',
  brightCyan: '#f5b87a',
  brightWhite: '#f5e6d3'
}

// 🆕 赛博朋克主题 - 霓虹科技感
const cyberpunk: ITheme = {
  background: '#0a0a0f',
  foreground: '#e0e0ff',
  cursor: '#00ffff',
  cursorAccent: '#0a0a0f',
  selectionBackground: '#1a1a2e',
  black: '#0a0a0f',
  red: '#ff0055',
  green: '#00ff88',
  yellow: '#ffff00',
  blue: '#00ffff',
  magenta: '#ff00ff',
  cyan: '#00ccff',
  white: '#e0e0ff',
  brightBlack: '#2a2a44',
  brightRed: '#ff3377',
  brightGreen: '#33ff99',
  brightYellow: '#ffff55',
  brightBlue: '#33ffff',
  brightMagenta: '#ff55ff',
  brightCyan: '#55ddff',
  brightWhite: '#ffffff'
}

// 🆕 极光主题 - 神秘渐变色调
const aurora: ITheme = {
  background: '#0f1419',
  foreground: '#e6f1ff',
  cursor: '#7dd3fc',
  cursorAccent: '#0f1419',
  selectionBackground: '#232f3e',
  black: '#0f1419',
  red: '#fb7185',
  green: '#4ade80',
  yellow: '#fbbf24',
  blue: '#7dd3fc',
  magenta: '#c084fc',
  cyan: '#22d3ee',
  white: '#e6f1ff',
  brightBlack: '#2a3f54',
  brightRed: '#fda4af',
  brightGreen: '#86efac',
  brightYellow: '#fcd34d',
  brightBlue: '#a5f3fc',
  brightMagenta: '#d8b4fe',
  brightCyan: '#67e8f9',
  brightWhite: '#f0f9ff'
}

// 主题集合
export const themes: Record<ThemeName, ITheme> = {
  'one-dark': oneDark,
  dracula,
  monokai,
  'solarized-dark': solarizedDark,
  'solarized-light': solarizedLight,
  nord,
  'github-dark': githubDark,
  'github-light': githubLight,
  catppuccin,
  'gruvbox': gruvbox,
  'forest': forest,
  'ayu-mirage': ayuMirage,
  'cyberpunk': cyberpunk,
  'aurora': aurora,
  'sponsor-gold': sponsorGold
}

// 赞助者专属主题列表
export const sponsorThemes: ThemeName[] = ['sponsor-gold']

/**
 * 获取主题配置
 */
export function getTheme(name: string): ITheme {
  return themes[name as ThemeName] || themes['one-dark']
}

/**
 * 获取所有主题名称
 */
export function getThemeNames(): ThemeName[] {
  return Object.keys(themes) as ThemeName[]
}

/**
 * 🆕 UI 主题与终端主题的集成映射
 * 为每个 UI 主题创建完美匹配的终端配色，让终端完全融入界面
 */
const integratedTerminalThemes: Record<UiThemeName, ITheme> = {
  // Dark (Catppuccin Mocha 风格) - 使用 UI 主题的背景色
  'dark': {
    background: '#1e1e2e',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#cdd6f4',
    cursor: '#89b4fa',
    cursorAccent: '#1e1e2e',
    selectionBackground: '#45475a',
    black: '#45475a',
    red: '#f38ba8',
    green: '#a6e3a1',
    yellow: '#f9e2af',
    blue: '#89b4fa',
    magenta: '#cba6f7',
    cyan: '#94e2d5',
    white: '#bac2de',
    brightBlack: '#585b70',
    brightRed: '#f38ba8',
    brightGreen: '#a6e3a1',
    brightYellow: '#f9e2af',
    brightBlue: '#89b4fa',
    brightMagenta: '#cba6f7',
    brightCyan: '#94e2d5',
    brightWhite: '#a6adc8'
  },

  // Light - 浅色主题
  'light': {
    background: '#ffffff',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#1a1a1a',
    cursor: '#0078d4',
    cursorAccent: '#ffffff',
    selectionBackground: '#bde0fc',
    black: '#1a1a1a',
    red: '#d13438',
    green: '#107c10',
    yellow: '#9a6700',
    blue: '#0078d4',
    magenta: '#8250df',
    cyan: '#1b7c83',
    white: '#6e7781',
    brightBlack: '#57606a',
    brightRed: '#cf222e',
    brightGreen: '#1a7f37',
    brightYellow: '#ca5010',
    brightBlue: '#218bff',
    brightMagenta: '#a475f9',
    brightCyan: '#3192aa',
    brightWhite: '#8c959f'
  },

  // Blue (VS 经典风格)
  'blue': {
    background: '#1e3a5f',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e8f0f8',
    cursor: '#4db8ff',
    cursorAccent: '#1e3a5f',
    selectionBackground: '#2d5a8a',
    black: '#152d4a',
    red: '#ff6b6b',
    green: '#6dd400',
    yellow: '#ffb900',
    blue: '#4db8ff',
    magenta: '#bc8cff',
    cyan: '#66c2ff',
    white: '#b8d0e8',
    brightBlack: '#3a6a9a',
    brightRed: '#ff8787',
    brightGreen: '#8ae000',
    brightYellow: '#ffc933',
    brightBlue: '#66c2ff',
    brightMagenta: '#d2a8ff',
    brightCyan: '#80ccff',
    brightWhite: '#e8f0f8'
  },

  // Gruvbox (暖橙主题)
  'gruvbox': {
    background: '#2d251f',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e8d5c4',
    cursor: '#e8a855',
    cursorAccent: '#2d251f',
    selectionBackground: '#4a3d32',
    black: '#2d251f',
    red: '#e07055',
    green: '#a8c070',
    yellow: '#e8a855',
    blue: '#70a8c0',
    magenta: '#c08090',
    cyan: '#70c0a8',
    white: '#e8d5c4',
    brightBlack: '#6a5a4a',
    brightRed: '#f08060',
    brightGreen: '#b8d080',
    brightYellow: '#f0b860',
    brightBlue: '#80b8d0',
    brightMagenta: '#d090a0',
    brightCyan: '#80d0b8',
    brightWhite: '#f5ebe0'
  },

  // Forest (浅色森林绿)
  'forest': {
    background: '#f6fbf8',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#2a403a',
    cursor: '#4a9a70',
    cursorAccent: '#f6fbf8',
    selectionBackground: '#c8dcd0',
    black: '#2a403a',
    red: '#b85555',
    green: '#4a9a70',
    yellow: '#aa8540',
    blue: '#4a7a9a',
    magenta: '#8a5a8a',
    cyan: '#3a8a7a',
    white: '#e5f0e8',
    brightBlack: '#4a665a',
    brightRed: '#c86060',
    brightGreen: '#5aaa75',
    brightYellow: '#bb9550',
    brightBlue: '#5a8aaa',
    brightMagenta: '#9a6a9a',
    brightCyan: '#4a9a8a',
    brightWhite: '#f6fbf8'
  },

  // Ayu Mirage
  'ayu-mirage': {
    background: '#1f2430',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#cbccc6',
    cursor: '#ffcc66',
    cursorAccent: '#1f2430',
    selectionBackground: '#34455a',
    black: '#1f2430',
    red: '#ff3333',
    green: '#bae67e',
    yellow: '#ffd580',
    blue: '#73d0ff',
    magenta: '#d4bfff',
    cyan: '#95e6cb',
    white: '#cbccc6',
    brightBlack: '#707a8c',
    brightRed: '#ff6666',
    brightGreen: '#bae67e',
    brightYellow: '#ffd580',
    brightBlue: '#73d0ff',
    brightMagenta: '#d4bfff',
    brightCyan: '#95e6cb',
    brightWhite: '#f3f4f5'
  },

  // Cyberpunk (霓虹科技感)
  'cyberpunk': {
    background: '#0a0a0f',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e0e0ff',
    cursor: '#00ffff',
    cursorAccent: '#0a0a0f',
    selectionBackground: '#1a1a2e',
    black: '#0a0a0f',
    red: '#ff0055',
    green: '#00ff88',
    yellow: '#ffff00',
    blue: '#00ffff',
    magenta: '#ff00ff',
    cyan: '#00ccff',
    white: '#e0e0ff',
    brightBlack: '#2a2a44',
    brightRed: '#ff3377',
    brightGreen: '#33ff99',
    brightYellow: '#ffff55',
    brightBlue: '#33ffff',
    brightMagenta: '#ff55ff',
    brightCyan: '#55ddff',
    brightWhite: '#ffffff'
  },

  // Lavender (薰衣草浅色主题)
  'lavender': {
    background: '#f8f6fc',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#3d3550',
    cursor: '#8b5cf6',
    cursorAccent: '#f8f6fc',
    selectionBackground: '#ebe5f5',
    black: '#3d3550',
    red: '#ef4444',
    green: '#22c55e',
    yellow: '#f59e0b',
    blue: '#8b5cf6',
    magenta: '#a78bfa',
    cyan: '#06b6d4',
    white: '#e8e2f4',
    brightBlack: '#5a5070',
    brightRed: '#f87171',
    brightGreen: '#4ade80',
    brightYellow: '#fbbf24',
    brightBlue: '#a78bfa',
    brightMagenta: '#c4b5fd',
    brightCyan: '#22d3ee',
    brightWhite: '#f8f6fc'
  },

  // Aurora (极光主题)
  'aurora': {
    background: '#0f1419',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e6f1ff',
    cursor: '#7dd3fc',
    cursorAccent: '#0f1419',
    selectionBackground: '#232f3e',
    black: '#0f1419',
    red: '#fb7185',
    green: '#4ade80',
    yellow: '#fbbf24',
    blue: '#7dd3fc',
    magenta: '#c084fc',
    cyan: '#22d3ee',
    white: '#e6f1ff',
    brightBlack: '#2a3f54',
    brightRed: '#fda4af',
    brightGreen: '#86efac',
    brightYellow: '#fcd34d',
    brightBlue: '#a5f3fc',
    brightMagenta: '#d8b4fe',
    brightCyan: '#67e8f9',
    brightWhite: '#f0f9ff'
  },

  // Sponsor Gold (赞助者暗金主题)
  'sponsor-gold': {
    background: '#1a1612',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e8dcc8',
    cursor: '#b8860b',
    cursorAccent: '#1a1612',
    selectionBackground: '#3d352a',
    black: '#1a1612',
    red: '#b85050',
    green: '#7a9a32',
    yellow: '#b8860b',
    blue: '#996b08',
    magenta: '#8a6a4a',
    cyan: '#7a8a5a',
    white: '#e8dcc8',
    brightBlack: '#4a4035',
    brightRed: '#c86060',
    brightGreen: '#8aaa42',
    brightYellow: '#cc8800',
    brightBlue: '#aa7b18',
    brightMagenta: '#9a7a5a',
    brightCyan: '#8a9a6a',
    brightWhite: '#f5ebe0'
  },

  // Sponsor Sakura (赞助者樱花粉主题)
  'sponsor-sakura': {
    background: '#fdf8fa',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#4a3040',
    cursor: '#d4728a',
    cursorAccent: '#fdf8fa',
    selectionBackground: '#f5e5ec',
    black: '#4a3040',
    red: '#c95050',
    green: '#5a9a6a',
    yellow: '#c98a40',
    blue: '#7a6a9a',
    magenta: '#d4728a',
    cyan: '#5a8a8a',
    white: '#e8d0dc',
    brightBlack: '#6b4a5a',
    brightRed: '#d96060',
    brightGreen: '#6aaa7a',
    brightYellow: '#d99a50',
    brightBlue: '#8a7aaa',
    brightMagenta: '#e4829a',
    brightCyan: '#6a9a9a',
    brightWhite: '#fdf8fa'
  },

  // Sponsor Rose Pine (赞助者玫瑰松主题)
  'sponsor-rose-pine': {
    background: '#191724',  // 与 UI 的 bgPrimary 完全一致
    foreground: '#e0def4',
    cursor: '#ebbcba',
    cursorAccent: '#191724',
    selectionBackground: '#403d52',
    black: '#191724',
    red: '#eb6f92',
    green: '#31748f',
    yellow: '#f6c177',
    blue: '#9ccfd8',
    magenta: '#c4a7e7',
    cyan: '#ebbcba',
    white: '#e0def4',
    brightBlack: '#6e6a86',
    brightRed: '#eb6f92',
    brightGreen: '#31748f',
    brightYellow: '#f6c177',
    brightBlue: '#9ccfd8',
    brightMagenta: '#c4a7e7',
    brightCyan: '#ebbcba',
    brightWhite: '#e0def4'
  }
}

/**
 * 🆕 获取与 UI 主题完全融合的终端主题
 * 终端背景色与 UI 背景色完全一致，实现无缝融合
 * 
 * @param uiThemeName - UI 主题名称
 * @returns 匹配的终端主题配置
 */
export function getIntegratedTheme(uiThemeName: string): ITheme {
  const theme = integratedTerminalThemes[uiThemeName as UiThemeName]
  if (theme) {
    return theme
  }
  
  // 如果没有预定义的集成主题，尝试从 UI 主题动态生成
  const uiTheme = uiThemes[uiThemeName as UiThemeName]
  if (uiTheme) {
    return generateTerminalThemeFromUi(uiTheme)
  }
  
  // 默认返回 dark 主题
  return integratedTerminalThemes['dark']
}

/**
 * 从 UI 主题动态生成终端主题
 * 用于处理未预定义的 UI 主题
 */
function generateTerminalThemeFromUi(uiTheme: typeof uiThemes[UiThemeName]): ITheme {
  const isDark = uiTheme.colorScheme === 'dark'
  
  return {
    background: uiTheme.bgPrimary,
    foreground: uiTheme.textPrimary,
    cursor: uiTheme.accentPrimary,
    cursorAccent: uiTheme.bgPrimary,
    selectionBackground: uiTheme.bgHover,
    black: isDark ? uiTheme.bgSurface : uiTheme.textPrimary,
    red: uiTheme.accentError,
    green: uiTheme.accentSuccess,
    yellow: uiTheme.accentWarning,
    blue: uiTheme.accentPrimary,
    magenta: uiTheme.accentSecondary,
    cyan: uiTheme.accentSecondary,
    white: uiTheme.textSecondary,
    brightBlack: uiTheme.textMuted,
    brightRed: uiTheme.accentError,
    brightGreen: uiTheme.accentSuccess,
    brightYellow: uiTheme.accentWarning,
    brightBlue: uiTheme.accentPrimary,
    brightMagenta: uiTheme.accentSecondary,
    brightCyan: uiTheme.accentSecondary,
    brightWhite: uiTheme.textPrimary
  }
}

