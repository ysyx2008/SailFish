/**
 * OEM 配置文件
 * 
 * 用于 OEM 版本定制品牌信息和功能开关
 * OEM 版本只需修改此文件即可完成品牌定制
 */

export interface OemConfig {
  brand: {
    name: {
      zh: string
      en: string
    }
    logo: string  // 图片路径，如 '/assets/logo.png'
    version?: string  // 留空使用 package.json 版本，或填写自定义版本
    copyright: {
      zh: string
      en: string
    }
  }
  features: {
    showSponsor: boolean  // 是否显示赞助功能（二维码、徽章、专属主题）
  }
}

export const oemConfig: OemConfig = {
  brand: {
    name: { zh: '旗鱼终端', en: 'SFTerm' },
    logo: '/assets/logo.png',
    version: '',  // 留空使用 package.json 版本
    copyright: { zh: '© 2024 旗鱼', en: '© 2024 SFTerm' }
  },
  features: {
    showSponsor: true  // 赞助功能开关
  }
}

/**
 * 版本配置示例：
 * 
 * === 开源版（默认） ===
 * - 打包 lite 模型（bge-small-zh-v1.5，24MB，512维，中文优化）
 * - 用户可选下载 standard/large 模型
 * - 显示赞助功能
 * 
 * === Steam 版 ===
 * export const oemConfig: OemConfig = {
 *   brand: {
 *     name: { zh: '旗鱼终端', en: 'SFTerm' },
 *     logo: '/assets/logo.png',
 *     version: '',
 *     copyright: { zh: '© 2024 旗鱼', en: '© 2024 SFTerm' }
 *   },
 *   features: {
 *     showSponsor: false  // Steam 版隐藏赞助功能
 *   }
 * }
 * 
 * === OEM 定制版 ===
 * export const oemConfig: OemConfig = {
 *   brand: {
 *     name: { zh: '某某云终端', en: 'XX Cloud Terminal' },
 *     logo: '/assets/oem-logo.png',
 *     version: '1.0.0',
 *     copyright: { zh: '© 2024 某某公司', en: '© 2024 XX Corp' }
 *   },
 *   features: {
 *     showSponsor: false  // OEM 版本隐藏赞助功能
 *   }
 * }
 */
