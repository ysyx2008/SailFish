/**
 * ECharts 服务端 SVG 渲染封装
 *
 * 通过 echarts v6+ 内置的 SSR 模式，在 Node.js 主进程中无 DOM、无 canvas
 * 直接渲染出 SVG 字符串，再由调用方编码成 data URL 或落盘。
 *
 * echarts 是技能首次使用时由 init() 动态 import 的，避免拖慢 Electron 冷启动。
 */

import type { EChartsOption } from './render'
import type { ChartMapId } from '../../../../../shared/chart-maps'
import { ensureMapsRegistered } from './maps'

export interface RenderSize {
  width: number
  height: number
}

export interface RenderOptions {
  /** 渲染前需 echarts.registerMap 的内置地图 id */
  mapIds?: ChartMapId[]
}

/**
 * echarts 命名空间的最小子集类型，避免在本文件强依赖 echarts 类型。
 * echarts 实例真正持有 setOption / renderToSVGString / dispose。
 */
interface EChartsLike {
  init(
    dom: null,
    theme: null,
    opts: { renderer: 'svg'; ssr: true; width: number; height: number }
  ): {
    setOption(option: EChartsOption): void
    renderToSVGString(): string
    dispose(): void
  }
  registerMap(mapName: string, geoJson: object, specialAreas?: Record<string, unknown>): void
  getMap?(mapName: string): unknown
}

let echartsModule: EChartsLike | null = null

/**
 * 懒加载 echarts。在 skill init() 中预热一次，避免首次调用工具时延时。
 *
 * echarts 在不同打包模式下导出形态不一：
 *   - CJS：require('echarts') 直接拿到 namespace（含 init 等顶层方法）
 *   - ESM 动态 import：可能是 namespace，可能在 .default 里包一层
 * 通过运行时探测「是否存在 init 函数」来决定取哪一层，避免硬绑定 .default。
 */
export async function loadEcharts(): Promise<EChartsLike> {
  if (echartsModule) return echartsModule
  const mod = await import('echarts')
  const candidate = mod as unknown as Record<string, unknown> & { default?: unknown }
  const ns = (typeof candidate.init === 'function' ? candidate : candidate.default) as EChartsLike | undefined
  if (!ns || typeof ns.init !== 'function') {
    throw new Error('Failed to resolve echarts module: init() not found')
  }
  echartsModule = ns
  return ns
}

/**
 * 把一份 ECharts option 渲染成 SVG 字符串。
 * 调用方负责把 option 构造正确，本函数只做渲染 + 资源回收。
 */
export async function renderToSvg(
  option: EChartsOption,
  size: RenderSize,
  opts: RenderOptions = {}
): Promise<string> {
  const echarts = await loadEcharts()
  if (opts.mapIds?.length) {
    await ensureMapsRegistered(echarts, opts.mapIds)
  }
  const chart = echarts.init(null, null, {
    renderer: 'svg',
    ssr: true,
    width: size.width,
    height: size.height
  })
  try {
    chart.setOption(option)
    return chart.renderToSVGString()
  } finally {
    chart.dispose()
  }
}

export interface PngRenderOptions {
  /**
   * 像素密度倍率（Retina 缩放）。
   *
   * 设计目的：把"布局尺寸"和"输出像素"解耦。SVG 仍按 size.width × size.height 渲染，
   * 字号/网格/留白等所有视觉元素的相对比例不变；但栅格化时按 pixelRatio 倍放大像素，
   * 让 PNG 在被缩放（如 Word 把 1000px 图压到 580px 显示）后仍然清晰。
   *
   * 类比：CSS 中的 devicePixelRatio——@2x 资源在标清屏显示尺寸不变、视网膜屏更锐。
   *
   * 实现：通过 sharp 的 density 参数（默认 72 dpi 对应 1:1）放大 librsvg 的栅格化分辨率，
   * 字体走高 DPI 抗锯齿，比"先 1:1 出 PNG 再 .resize 放大"清晰得多。
   *
   * 默认 1（1:1 像素，向后兼容）—— **指 ssr 这一层**：直接 import renderToPng 的代码
   * 不会被意外放大。executor 入口（chart skill 工具调用）针对 PNG 默认值是 2，详见
   * executor.ts 的 clampPixelRatio。两层默认刻意不同：
   *   - ssr 层是基础设施，对所有内部调用方保持中性
   *   - executor 层面向 AI 工具调用，已知"默认要 Retina 锐"是更好的体验
   */
  pixelRatio?: number
}

/**
 * 把一份 ECharts option 渲染成 PNG buffer。
 *
 * 实现方式：先调 echarts SVG 渲染，再用 sharp 的 librsvg 后端栅格化为 PNG。
 * 选择 librsvg 而非 ImageMagick 的原因：
 *   - librsvg 走 fontconfig，能正确匹配 echarts 默认字体栈中的系统字体
 *     （macOS 的 PingFang SC、Windows 的 Microsoft YaHei、Linux 的 Noto Sans CJK）
 *   - ImageMagick 内置 SVG 渲染对中文/复杂 SVG 文本支持极差，常出方框/丢字
 *
 * 用 sharp 而非直接调 librsvg-loader 的原因：
 *   - sharp 自带跨平台 prebuild（含 Apple Silicon / x64 / Linux），不必让用户自己装系统包
 *   - SailFish 桌面 Electron 包早已被其它 native dep（@xenova/transformers 等）拉入 sharp，
 *     这次只是把它从间接依赖升级为直接登记的 dep，包体积无增量
 *
 * Electron 打包注意：sharp 是 native 模块，依赖 N-API；如果未来升级 Electron 主版本，
 * electron-builder 会自动 rebuild。生产构建后建议手测一次 format:'png'，因为 vitest
 * 跑的是系统 Node ABI 而非 Electron Node ABI。
 *
 * 字体注意事项：
 *   - 中文字体由系统提供。macOS 桌面环境永远有 PingFang SC，无需额外配置
 *   - Linux 服务器需安装中文字体包（如 fonts-noto-cjk）才能正确渲染中文
 *   - 字体匹配失败会回退到 sans-serif 默认字形（通常是英文字体），中文显示为 □
 *
 * sharp 用懒加载，避免 chart skill 没用 PNG 时也付出 sharp 启动开销。
 */
export async function renderToPng(
  option: EChartsOption,
  size: RenderSize,
  opts: PngRenderOptions & RenderOptions = {}
): Promise<Buffer> {
  const svg = await renderToSvg(option, size, { mapIds: opts.mapIds })
  const sharpMod = await import('sharp')
  // sharp 的 default export 行为在 CJS/ESM 下不一致，做一次容错探测
  const sharp = (typeof sharpMod === 'function' ? sharpMod : sharpMod.default) as
    typeof import('sharp').default
  if (typeof sharp !== 'function') {
    throw new Error('Failed to resolve sharp module: callable not found')
  }
  // pixelRatio < 1 当作 1 处理（缩小图没意义，且会和 sharp 默认 72 DPI 冲突）。
  // 上限不在这层兜，由 executor 层结合 size 算出"不会爆 sharp"的安全上限再传进来。
  const ratio = opts.pixelRatio && opts.pixelRatio > 0 ? Math.max(1, opts.pixelRatio) : 1
  return sharp(Buffer.from(svg, 'utf8'), { density: 72 * ratio })
    .png()
    .toBuffer()
}
