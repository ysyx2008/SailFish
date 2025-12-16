#!/usr/bin/env node
/**
 * 修复 macOS 多架构构建时 latest-mac.yml 缺少 arch 字段的问题
 */

const fs = require('fs')
const path = require('path')

const ymlPath = path.join(__dirname, '../release/latest-mac.yml')

if (!fs.existsSync(ymlPath)) {
  console.log('[fix-mac-yml] latest-mac.yml 不存在，跳过')
  process.exit(0)
}

let content = fs.readFileSync(ymlPath, 'utf8')

if (content.includes('    arch:')) {
  console.log('[fix-mac-yml] 已包含 arch 字段，无需修复')
  process.exit(0)
}

const fileEntryRegex = /(  - url: (.+\.dmg)\n    sha512: [^\n]+\n    size: \d+)(\n(?!    arch:))/g

const fixed = content.replace(fileEntryRegex, (match, entry, url, trailing) => {
  const arch = (url.includes('-arm64.') || url.includes('_arm64.')) ? 'arm64' : 'x64'
  console.log(`[fix-mac-yml] 为 ${url} 添加 arch: ${arch}`)
  return `${entry}\n    arch: ${arch}${trailing}`
})

if (fixed !== content) {
  fs.writeFileSync(ymlPath, fixed, 'utf8')
  console.log('[fix-mac-yml] latest-mac.yml 已修复 ✓')
} else {
  console.log('[fix-mac-yml] 无需修复')
}
