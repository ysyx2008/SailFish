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
    logo: string  // emoji 或图片路径，如 '/assets/logo.png'
    version?: string  // 留空使用 package.json 版本，或填写自定义版本
    copyright: {
      zh: string
      en: string
    }
  }
  features: {
    showSponsor: boolean  // 是否显示赞助功能（二维码、徽章、专属主题）
  }
  /** Embedding 模型配置（仅作为构建提醒，不会被代码读取） */
  embedding: {
    bundledModel: 'lite' | 'standard'  // 打包的模型：lite(22MB) 或 standard(24MB)
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
  },
  embedding: {
    bundledModel: 'lite'  // 开源版打包轻量模型（22MB）
  }
}

/**
 * 版本配置示例：
 * 
 * === 开源版（默认） ===
 * edition: 'opensource'
 * - 打包 lite 模型（all-MiniLM-L6-v2，22MB，384维）
 * - 用户可选下载 standard/large 模型
 * - 显示赞助功能
 * 
 * === Steam 版 ===
 * export const oemConfig: OemConfig = {
 *   edition: 'steam',
 *   brand: {
 *     name: { zh: '旗鱼终端', en: 'SFTerm' },
 *     logo: '/assets/logo.png',
 *     version: '',
 *     copyright: { zh: '© 2024 旗鱼', en: '© 2024 SFTerm' }
 *   },
 *   features: {
 *     showSponsor: false,  // Steam 版隐藏赞助功能
 *     cloudSync: false     // 未来扩展：Steam 云存档同步
 *   },
 *   embedding: {
 *     bundledModel: 'standard'  // Steam 版打包标准模型（bge-small-zh-v1.5，95MB，512维）
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
 *   },
 *   embedding: {
 *     bundledModel: 'lite'
 *   }
 * }
 */
