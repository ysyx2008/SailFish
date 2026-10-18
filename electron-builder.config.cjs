/* eslint-env node */
/**
 * 打包配置：以 electron-builder.yml 为底，安装身份和更新地址改读 OEM 配置。
 * Steam 构建不走这份文件。开源默认与 yml 里的旗鱼身份一致。
 */
'use strict'

const { execFileSync } = require('child_process')
const fs = require('fs')
const path = require('path')
const yaml = require('js-yaml')

require('tsx/cjs')
const { oemResolved } = require('./shared/oem-resolve.ts')
const { oemConfig } = require('./shared/oem-runtime.ts')

const base = yaml.load(fs.readFileSync(path.join(__dirname, 'electron-builder.yml'), 'utf8'))
const identity = oemResolved.identity

base.appId = identity.appId
base.productName = identity.productName
base.extraMetadata = {
  ...(base.extraMetadata || {}),
  productName: identity.productName,
}

if (Array.isArray(base.protocols) && base.protocols[0]) {
  base.protocols[0].name = `${identity.productName} Protocol`
  base.protocols[0].schemes = [identity.protocol]
}

if (base.nsis) {
  base.nsis.shortcutName = oemConfig.brand?.name?.zh || base.nsis.shortcutName
}

const github = oemResolved.distribution.github
const updateRoot = oemResolved.distribution.updateRoot
if (github) {
  base.publish = { provider: 'github', owner: github.owner, repo: github.repo }
} else if (updateRoot) {
  base.publish = { provider: 'generic', url: updateRoot }
} else {
  delete base.publish
}

if (base.mac && base.mac.extendInfo) {
  for (const key of ['NSLocalNetworkUsageDescription', 'NSMicrophoneUsageDescription']) {
    const text = base.mac.extendInfo[key]
    if (typeof text === 'string') {
      base.mac.extendInfo[key] = text.replaceAll('SailFish', identity.productName)
    }
  }
}

function existingIcon(rel) {
  if (!rel) return null
  const abs = path.isAbsolute(rel) ? rel : path.join(__dirname, rel)
  return fs.existsSync(abs) ? abs : null
}

const appIcon = existingIcon(oemResolved.icons.app)
if (appIcon) {
  base.mac = base.mac || {}
  base.win = base.win || {}
  base.mac.icon = appIcon
  base.win.icon = appIcon
  for (const item of base.extraResources || []) {
    if (item && item.to === 'icon.png') item.from = appIcon
  }
}

const trayIcon = existingIcon(oemResolved.icons.tray)
if (trayIcon) {
  for (const item of base.extraResources || []) {
    if (item && (item.to === 'icon_trayTemplate.png' || item.to === 'icon_trayTemplate@2x.png')) {
      item.from = trayIcon
    }
  }
}

function plistQuoted(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const brandingDir = path.join(__dirname, 'build', 'oem-branding')
const zhLproj = path.join(brandingDir, 'zh-Hans.lproj')
const enLproj = path.join(brandingDir, 'en.lproj')
const dmgDir = path.join(brandingDir, 'dmg')
fs.mkdirSync(zhLproj, { recursive: true })
fs.mkdirSync(enLproj, { recursive: true })
fs.mkdirSync(dmgDir, { recursive: true })

const brandZh = oemConfig.brand?.name?.zh || identity.productName
const brandEn = oemConfig.brand?.name?.en || identity.productName
fs.writeFileSync(
  path.join(zhLproj, 'InfoPlist.strings'),
  `CFBundleDisplayName = ${plistQuoted(brandZh)};\nCFBundleName = ${plistQuoted(brandZh)};\n`,
)
fs.writeFileSync(
  path.join(enLproj, 'InfoPlist.strings'),
  `CFBundleDisplayName = ${plistQuoted(brandEn)};\nCFBundleName = ${plistQuoted(brandEn)};\n`,
)

function brandedGuide(fileName) {
  const source = fs.readFileSync(path.join(__dirname, 'resources', 'dmg', fileName), 'utf8')
  const dest = path.join(dmgDir, fileName)
  fs.writeFileSync(dest, source.replaceAll('SailFish', identity.productName))
  return dest
}
const zhGuide = brandedGuide('安装说明.txt')
const enGuide = brandedGuide('Installation Guide.txt')

for (const item of base.mac?.extraFiles || []) {
  if (item?.to === 'Resources/zh-Hans.lproj') item.from = zhLproj
  if (item?.to === 'Resources/en.lproj') item.from = enLproj
}
for (const item of base.dmg?.contents || []) {
  if (item?.path === 'resources/dmg/安装说明.txt') item.path = zhGuide
  if (item?.path === 'resources/dmg/Installation Guide.txt') item.path = enGuide
}

// ssh2 的可选依赖要在自己的安装脚本里生成本机探测结果。打包重编原生模块时不跑那个脚本，文件缺失会让整次打包失败。
function prepareCpuFeaturesGypi() {
  const dir = path.join(__dirname, 'node_modules', 'cpu-features')
  const script = path.join(dir, 'buildcheck.js')
  if (!fs.existsSync(script)) return
  const gypi = execFileSync(process.execPath, [script], { cwd: dir, encoding: 'utf8' })
  fs.writeFileSync(path.join(dir, 'buildcheck.gypi'), gypi)
}

base.beforeBuild = async () => {
  prepareCpuFeaturesGypi()
  return true
}

module.exports = base
