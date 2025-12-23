/**
 * Steam 版 OEM 配置文件
 * 
 * 发布 Steam 版时，将此文件内容复制到 oem.config.ts
 */

import type { OemConfig } from './oem.config'

export const steamConfig: OemConfig = {
  brand: {
    name: { zh: '旗鱼终端', en: 'SFTerm' },
    logo: '/assets/logo.png',
    version: '',  // 使用 package.json 版本
    copyright: { zh: '© 2024 旗鱼', en: '© 2024 SFTerm' }
  },
  features: {
    showSponsor: false,  // Steam 版隐藏赞助功能
  },
  embedding: {
    bundledModel: 'standard'  // Steam 版打包标准模型（bge-small-zh-v1.5，24MB，512维，中文优化）
  }
}

/**
 * Steam 版特性：
 * 
 * 1. Embedding 模型
 *    - 打包 bge-small-zh-v1.5（95MB）作为默认模型
 *    - 相比开源版的 all-MiniLM-L6-v2（22MB）有更好的中文支持
 *    - 512 维向量 vs 384 维，语义理解更精准
 * 
 * 2. 功能差异
 *    - 隐藏赞助功能（Steam 已付费）
 * 
 * 3. 使用方法
 *    构建 Steam 版时执行：
 *    cp src/config/oem.config.steam.ts src/config/oem.config.ts
 *    然后正常构建
 */

