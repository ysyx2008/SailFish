/**
 * OEM 配置类型（开源主线提交）。
 * 可选覆盖文件 `oem.config.ts` 不进仓库；缺省见 `oem-defaults.ts` / `OEM_FEATURE_DEFAULTS`。
 */

export interface OemBrand {
  name: {
    zh: string
    en: string
  }
  logo: string
  version?: string
  copyright: {
    zh: string
    en: string
  }
}

/**
 * 能力开关：开源默认尽量全开；`sso` 默认关。
 * OEM 在可选的 oem.config.ts 中关闭即可裁剪，无需改业务代码。
 */
export interface OemFeatures {
  /** 觉醒（个性 / 心跳 / 觉醒面板等） */
  awaken: boolean
  /** 联络（companion 常驻关系线） */
  companion: boolean
  /** 关切 / Watch */
  watch: boolean
  /**
   * 羁绊气质 / 俏皮文案（placeholder 分池、任务完成趣味 footer、
   * 里程碑 toast、首 token 彩蛋与调侃、prompt 羁绊段等）
   */
  bond: boolean
  /** 本地终端工作台 */
  localTerminal: boolean
  /** SSH 终端工作台 */
  sshTerminal: boolean
  /** 独立助手工作台（含产出物等） */
  assistantWorkbench: boolean
  /** 赞助 / 社区入口 */
  showSponsor: boolean
  /** 应用 SSO（OAuth2/OIDC）；开源默认关闭 */
  sso: boolean
}

export type OemFeatureKey = keyof OemFeatures

/**
 * 更新地址。字段不写 = 旗鱼默认；写成空字符串 = 关掉这一路，不退回旗鱼。
 * 两路都关掉则不做应用内更新。
 */
export interface OemDistribution {
  /** 代码仓库，形如 owner/repo */
  repository?: string
  /** 国内或企业自己的更新根地址，目录内有 latest.yml */
  updateRoot?: string
}

/**
 * 关于页和帮助里的链接。字段不写 = 旗鱼默认；写成空字符串 = 不显示该项。
 */
export interface OemLinks {
  website?: string
  docs?: string
  issues?: string
  qqGroup?: string
  contactEmail?: string
  /** 协议页面地址。开源默认是 AGPL 说明页 */
  license?: string
  /** 旗鱼技能清单。写成空则只用软件内已有技能，不连旗鱼的站点 */
  skillRegistry?: string
}

/**
 * 安装身份。不写 = 旗鱼今天的值。不要写成空：空着会仍用旗鱼默认，避免装出没有名字的程序。
 * 选定数据目录名之后不要再改，否则用户数据会找不回。
 */
export interface OemIdentity {
  appId?: string
  /** 安装包和程序文件名。界面上的中文名仍用 brand.name */
  productName?: string
  /** 用户数据目录名，也是自定义数据位置的指针所在目录名 */
  dataDirName?: string
  /** 别的软件用来打开本应用的链接协议名，不含 :// */
  protocol?: string
  /** 终端里的命令名 */
  cliName?: string
}

/**
 * 图标路径相对仓库根目录。不写 = 旗鱼现有图标。不要改主线 resources 里的图标文件。
 */
export interface OemIcons {
  /** 一张彩色应用图标，窗口、关于页和安装包都从它来 */
  app?: string
  /** 菜单栏用的黑白轮廓。不写则仍用旗鱼的菜单栏图标 */
  tray?: string
}

export interface OemConfig {
  brand: OemBrand
  features: OemFeatures
  /**
   * 应用 SSO（OAuth2/OIDC）IdP 配置。
   * 仅当 features.sso === true 时生效；开源默认不配。
   */
  sso?: OemSsoConfig
  distribution?: OemDistribution
  links?: OemLinks
  identity?: OemIdentity
  icons?: OemIcons
  /**
   * 公开的社区技能市场。不写或 true = 开着；false = 关掉。
   * 不是地址。旗鱼自己的技能清单在 links.skillRegistry。
   */
  communitySkillMarket?: boolean
}

/** SSO 登录门控：hard 全屏挡；soft 可进主界面；none 无登录 UI */
export type OemSsoGateMode = 'hard' | 'soft' | 'none'

/** ID Token 校验强度：claims 只验 iss/aud/exp；jwks 再验 RS256 签名 */
export type OemSsoVerifyIdToken = 'claims' | 'jwks'

/** OEM 应用登录 IdP（与邮箱 OAuth 无关） */
export interface OemSsoConfig {
  /** OIDC Issuer，用于发现 /.well-known/openid-configuration */
  issuer: string
  clientId: string
  /** 公共客户端推荐省略，走 PKCE；机密客户端可选 */
  clientSecret?: string
  redirectUri: string
  scopes?: string[]
  /**
   * 未登录时的门控。缺省 soft。
   * - hard：全屏登录页，进不了主界面
   * - soft：可进主界面，设置/角标可登录
   * - none：无登录 UI（OEM 自接）
   */
  gateMode?: OemSsoGateMode
  /** ID Token 校验；缺省 claims */
  verifyIdToken?: OemSsoVerifyIdToken
  /**
   * 允许后端 HTTP（如 web_fetch）自动注入 Bearer 的精确 hostname 名单。
   * 默认 [] / 未配 → 永不自动注入。不做通配。
   */
  enterpriseApiHosts?: string[]
}

/** 缺字段时的回退（兼容旧/不完整 oem.config） */
export const OEM_FEATURE_DEFAULTS: OemFeatures = {
  awaken: true,
  companion: true,
  watch: true,
  bond: true,
  localTerminal: true,
  sshTerminal: true,
  assistantWorkbench: true,
  showSponsor: true,
  sso: false
}
