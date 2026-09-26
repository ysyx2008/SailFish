#!/usr/bin/env node
/**
 * 下载 ripgrep（编程技能的内容搜索 / 按模式找文件）到 resources/ripgrep/<os>-<arch>/
 * 目录名与 electron-builder 的 ${os}-${arch} 宏一致，打包时按目标架构取对应那份。
 *
 * 用法：
 *   node scripts/download-ripgrep.js            # 按本机平台取打包要用的几份（mac 同时取 x64 + arm64）
 *   node scripts/download-ripgrep.js --all      # 全部支持的平台
 *   node scripts/download-ripgrep.js mac-arm64  # 指定
 */

const https = require('https')
const fs = require('fs')
const os = require('os')
const path = require('path')
const crypto = require('crypto')
const { execFileSync } = require('child_process')

const VERSION = '15.2.0'
const OUT_ROOT = path.join(__dirname, '..', 'resources', 'ripgrep')

const TARGETS = {
  'mac-x64': 'x86_64-apple-darwin',
  'mac-arm64': 'aarch64-apple-darwin',
  'win-x64': 'x86_64-pc-windows-msvc',
  'win-arm64': 'aarch64-pc-windows-msvc',
  'linux-x64': 'x86_64-unknown-linux-musl',
  'linux-arm64': 'aarch64-unknown-linux-musl',
}

function defaultTargets() {
  if (process.platform === 'darwin') return ['mac-x64', 'mac-arm64']
  if (process.platform === 'win32') return ['win-x64']
  return [`linux-${process.arch}`]
}

function pickTargets(argv) {
  if (argv.includes('--all')) return Object.keys(TARGETS)
  const named = argv.filter(a => !a.startsWith('--'))
  const targets = named.length > 0 ? named : defaultTargets()
  for (const t of targets) {
    if (!TARGETS[t]) {
      console.error(`[download-ripgrep] 不支持的目标 ${t}，可选：${Object.keys(TARGETS).join(', ')}`)
      process.exit(1)
    }
  }
  return targets
}

function fetchBuffer(url, maxRedirects = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SailFish-Build' } }, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume()
        if (maxRedirects <= 0) return reject(new Error('Too many redirects'))
        return resolve(fetchBuffer(res.headers.location, maxRedirects - 1))
      }
      if (res.statusCode !== 200) {
        res.resume()
        return reject(new Error(`HTTP ${res.statusCode} ${url}`))
      }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    }).on('error', reject)
  })
}

function extract(archive, destDir) {
  if (archive.endsWith('.zip') && process.platform === 'linux') {
    execFileSync('unzip', ['-q', archive, '-d', destDir], { stdio: 'inherit' })
  } else {
    execFileSync('tar', ['-xf', archive, '-C', destDir], { stdio: 'inherit' })
  }
}

async function downloadTarget(target) {
  const triple = TARGETS[target]
  const isWin = target.startsWith('win-')
  const binName = isWin ? 'rg.exe' : 'rg'
  const outDir = path.join(OUT_ROOT, target)
  const versionFile = path.join(outDir, 'VERSION')

  if (fs.existsSync(path.join(outDir, binName)) && fs.existsSync(versionFile)
    && fs.readFileSync(versionFile, 'utf8').trim() === VERSION) {
    console.log(`[download-ripgrep] ${target} 已是 ${VERSION}，跳过`)
    return
  }

  const base = `ripgrep-${VERSION}-${triple}`
  const file = `${base}${isWin ? '.zip' : '.tar.gz'}`
  const url = `https://github.com/BurntSushi/ripgrep/releases/download/${VERSION}/${file}`
  console.log(`[download-ripgrep] ${target} ← ${url}`)

  const [archive, shaText] = await Promise.all([fetchBuffer(url), fetchBuffer(`${url}.sha256`)])
  const expected = shaText.toString('utf8').trim().split(/\s+/)[0].toLowerCase()
  const actual = crypto.createHash('sha256').update(archive).digest('hex')
  if (expected !== actual) {
    throw new Error(`${target} 校验失败：期望 ${expected}，实际 ${actual}`)
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sailfish-rg-'))
  try {
    const archivePath = path.join(tmp, file)
    fs.writeFileSync(archivePath, archive)
    extract(archivePath, tmp)
    fs.rmSync(outDir, { recursive: true, force: true })
    fs.mkdirSync(outDir, { recursive: true })
    fs.copyFileSync(path.join(tmp, base, binName), path.join(outDir, binName))
    fs.copyFileSync(path.join(tmp, base, 'LICENSE-MIT'), path.join(outDir, 'LICENSE-MIT'))
    if (!isWin) fs.chmodSync(path.join(outDir, binName), 0o755)
    fs.writeFileSync(versionFile, `${VERSION}\n`)
    console.log(`[download-ripgrep] ${target} 完成（${(archive.length / 1024 / 1024).toFixed(1)} MB 压缩包）`)
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

async function main() {
  const targets = pickTargets(process.argv.slice(2))
  for (const target of targets) {
    await downloadTarget(target)
  }
}

main().catch(err => {
  console.error(`[download-ripgrep] 失败：${err.message}`)
  process.exit(1)
})
