#!/usr/bin/env node
/**
 * 检查 asarUnpack 传递依赖是否齐全。
 *
 * 背景：utilityProcess worker 从 app.asar.unpacked 加载原生/ESM 包时，
 * Node 解析不会跨进仍在 asar 内的同级依赖（经典 asarUnpack 缺口）。
 * 11.4.1 曾因此导致 Embedding/LanceDB worker 起不来，知识库整条静默不可用。
 *
 * 用法：
 *   node scripts/check-asar-unpack-deps.js
 *     → 静态模式：对照 electron-builder.yml + 开发态 node_modules
 *   node scripts/check-asar-unpack-deps.js --unpacked <path/to/app.asar.unpacked/node_modules>
 *     → 打包后：只在 unpacked 树内解析（afterPack 用）
 *
 * 退出码：0 通过 / 1 发现缺口
 */
'use strict'

const fs = require('fs')
const path = require('path')

const ROOT = path.resolve(__dirname, '..')
const DEFAULT_YML = path.join(ROOT, 'electron-builder.yml')
const DEFAULT_NM = path.join(ROOT, 'node_modules')

/** worker 直接 import 的包（及其传递 dependencies / 已安装 peer 必须可从 unpacked 解析） */
const WORKER_ENTRY_PACKAGES = [
  '@huggingface/transformers',
  '@lancedb/lancedb',
  'apache-arrow', // @lancedb/lancedb 的 peerDependency，lancedb-worker 热路径必载
  'onnxruntime-node',
  'onnxruntime-web',
  'sherpa-onnx-node',
  'pdfjs-dist',
  '@napi-rs/canvas',
  '@firecrawl/pdf-inspector',
]

/**
 * 已知不在 utilityProcess 热路径上的依赖（打包版实测可缺）。
 * 新增放行前必须确认对应 worker 初始化仍成功。
 */
const ALLOW_MISSING = new Set([
  // onnxruntime-web 已列入 asarUnpack：原生 ORT 加载失败时 worker 要能解析它
  'command-line-args', // apache-arrow CLI
  'command-line-usage',
  '@swc/helpers', // apache-arrow 编译辅助，Node 入口未强制加载
  'json-bignum', // apache-arrow 大整数可选路径
  '@types/node',
  '@types/command-line-args',
  '@types/command-line-usage',
  'adm-zip', // onnxruntime-node 下载辅助
  'global-agent',
  'prebuild-install', // native 构建期
  'node-addon-api',
  'nan',
  'buildcheck',
])

/** 跨平台 optional 原生包（当前机只装本平台，不必要求全平台解包） */
const PLATFORM_OPTIONAL_RE =
  /^(?:@img\/sharp(?:-libvips)?-|@lancedb\/lancedb-|@napi-rs\/canvas-|sherpa-onnx-(?!node$)|@firecrawl\/pdf-inspector-)/

function exists(p) {
  try {
    fs.accessSync(p)
    return true
  } catch {
    return false
  }
}

function readPkg(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
  } catch {
    return null
  }
}

function parseAsarUnpack(ymlPath) {
  const text = fs.readFileSync(ymlPath, 'utf8')
  const patterns = []
  let inSection = false
  for (const line of text.split(/\r?\n/)) {
    if (/^asarUnpack:\s*$/.test(line)) {
      inSection = true
      continue
    }
    if (!inSection) continue
    if (/^[a-zA-Z#]/.test(line) && !/^\s/.test(line)) break
    if (/^\s*#/.test(line) || !line.trim()) continue
    const m = line.match(/^\s+-\s+(?:"([^"]+)"|'([^']+)'|(\S+))/)
    if (m) patterns.push(m[1] || m[2] || m[3])
  }
  return patterns
}

function globToRegExp(pattern) {
  const norm = pattern.replace(/\\/g, '/')
  const re =
    '^' +
    norm
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, ':::GS:::')
      .replace(/\*/g, '[^/]*')
      .replace(/:::GS:::/g, '.*') +
    '$'
  return new RegExp(re)
}

function isCoveredByAsarUnpack(relPosix, patterns) {
  const rel = relPosix.replace(/\\/g, '/')
  const candidates = [
    rel,
    rel.replace(/\/?$/, '/'),
    `${rel.replace(/\/?$/, '')}/**`,
    `${rel.replace(/\/?$/, '')}/**/*`,
    `${rel.replace(/\/?$/, '')}/package.json`,
  ]
  for (const pat of patterns) {
    const rx = globToRegExp(pat)
    for (const c of candidates) {
      if (rx.test(c)) return true
    }
    // pattern node_modules/foo/**/* should cover node_modules/foo/bar
    if (pat.endsWith('/**/*') || pat.endsWith('/**')) {
      const prefix = pat.replace(/\*\*\/\*?$/, '').replace(/\/?$/, '')
      if (rel === prefix || rel.startsWith(prefix + '/')) return true
    }
  }
  return false
}

function pkgDir(nmRoot, name) {
  const segs = name.startsWith('@') ? name.split('/') : [name]
  const direct = path.join(nmRoot, ...segs)
  if (exists(path.join(direct, 'package.json'))) return direct
  return null
}

function isInside(dir, boundary) {
  const r = path.resolve(dir)
  const b = path.resolve(boundary)
  return r === b || r.startsWith(b + path.sep)
}

/**
 * 从 fromDir 起按 Node NODE_MODULES_PATHS 规则解析。
 * boundary：不得走到此目录之外（static=项目根；unpacked=app.asar.unpacked）
 */
function resolveFrom(fromDir, name, boundary) {
  const segs = name.startsWith('@') ? name.split('/') : [name]
  let dir = fromDir
  while (true) {
    if (!isInside(dir, boundary) && path.resolve(dir) !== path.resolve(boundary)) {
      break
    }
    // Node：当前段名为 node_modules 时跳过，避免 …/node_modules/node_modules/…
    if (path.basename(dir) !== 'node_modules') {
      const candidate = path.join(dir, 'node_modules', ...segs)
      if (exists(path.join(candidate, 'package.json'))) return candidate
    }
    const parent = path.dirname(dir)
    if (parent === dir) break
    if (!isInside(parent, boundary) && path.resolve(parent) !== path.resolve(boundary)) {
      break
    }
    dir = parent
  }
  return null
}

function collectClosure(nmRoot, entries, boundary) {
  /** @type {Map<string, { name: string, dir: string }>} */
  const byDir = new Map()
  /** @type {string[]} */
  const dirQueue = []

  function addDir(name, dir) {
    if (!dir || byDir.has(dir)) return
    byDir.set(dir, { name, dir })
    dirQueue.push(dir)
  }

  for (const name of entries) {
    const dir = pkgDir(nmRoot, name)
    if (dir) addDir(name, dir)
  }

  while (dirQueue.length) {
    const dir = dirQueue.shift()
    const { name } = byDir.get(dir)
    const pkg = readPkg(dir)
    if (!pkg) continue

    for (const dep of Object.keys(pkg.dependencies || {})) {
      if (ALLOW_MISSING.has(dep) || PLATFORM_OPTIONAL_RE.test(dep) || dep.startsWith('@types/')) {
        continue
      }
      const resolved = resolveFrom(dir, dep, boundary) || pkgDir(nmRoot, dep)
      if (resolved) addDir(dep, resolved)
    }

    // peerDependency 若已安装也要纳入（如 lancedb → apache-arrow）
    for (const dep of Object.keys(pkg.peerDependencies || {})) {
      if (ALLOW_MISSING.has(dep) || PLATFORM_OPTIONAL_RE.test(dep) || dep.startsWith('@types/')) {
        continue
      }
      const resolved = resolveFrom(dir, dep, boundary) || pkgDir(nmRoot, dep)
      if (resolved) addDir(dep, resolved)
    }

    // 物理嵌套的直接依赖必须单独纳入（例如 transformers/node_modules/sharp）。
    // 父包没声明的嵌套包是别的依赖自己的子树：onnxruntime 的 global-agent 只在安装脚本里用，
    // 它的 matcher / serialize-error 不在 worker 热路径上，不能因为嵌在旁边就被要求解包。
    const declared = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.optionalDependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ])
    const nestedNm = path.join(dir, 'node_modules')
    if (exists(nestedNm)) {
      for (const nested of listImmediatePackages(nestedNm)) {
        if (!declared.has(nested.name)) continue
        if (ALLOW_MISSING.has(nested.name) || PLATFORM_OPTIONAL_RE.test(nested.name) || nested.name.startsWith('@types/')) {
          continue
        }
        addDir(nested.name, nested.dir)
      }
    }
  }

  const pkgs = []
  for (const { name, dir } of byDir.values()) {
    const pkg = readPkg(dir)
    if (!pkg) continue
    pkgs.push({ name, dir, pkg })
  }
  return pkgs
}

function listImmediatePackages(nmRoot) {
  const out = []
  if (!exists(nmRoot)) return out
  for (const ent of fs.readdirSync(nmRoot, { withFileTypes: true })) {
    if (!ent.isDirectory() && !ent.isSymbolicLink()) continue
    if (ent.name.startsWith('.')) continue
    if (ent.name.startsWith('@')) {
      const scopeDir = path.join(nmRoot, ent.name)
      for (const sub of fs.readdirSync(scopeDir, { withFileTypes: true })) {
        if (!sub.isDirectory() && !sub.isSymbolicLink()) continue
        const dir = path.join(scopeDir, sub.name)
        if (exists(path.join(dir, 'package.json'))) {
          out.push({ name: `${ent.name}/${sub.name}`, dir })
        }
      }
    } else {
      const dir = path.join(nmRoot, ent.name)
      if (exists(path.join(dir, 'package.json'))) {
        out.push({ name: ent.name, dir })
      }
    }
  }
  return out
}

/**
 * @param {{ mode: 'static'|'unpacked', nmRoot: string, patterns?: string[], ymlPath?: string }} opts
 * @returns {{ ok: boolean, gaps: Array<{ from: string, dep: string, detail: string }> }}
 */
function checkAsarUnpackDeps(opts) {
  const { mode, nmRoot } = opts
  const patterns =
    opts.patterns ||
    (opts.ymlPath || DEFAULT_YML ? parseAsarUnpack(opts.ymlPath || DEFAULT_YML) : [])

  // static：项目根；unpacked：app.asar.unpacked（nmRoot 的父目录）
  const boundary = mode === 'unpacked' ? path.dirname(nmRoot) : ROOT

  const pkgs = collectClosure(nmRoot, WORKER_ENTRY_PACKAGES, boundary)
  const gaps = []
  const seen = new Set()

  for (const { name, dir, pkg } of pkgs) {
    const depNames = new Set([
      ...Object.keys(pkg.dependencies || {}),
      ...Object.keys(pkg.peerDependencies || {}),
    ])
    for (const dep of depNames) {
      if (ALLOW_MISSING.has(dep) || PLATFORM_OPTIONAL_RE.test(dep) || dep.startsWith('@types/')) {
        continue
      }
      // 未安装的 peer 跳过（不在本产品依赖树里）
      if (!(pkg.dependencies || {})[dep] && !pkgDir(nmRoot, dep) && !resolveFrom(dir, dep, boundary)) {
        continue
      }
      const key = `${dir} → ${dep}`
      if (seen.has(key)) continue
      seen.add(key)

      const resolved = resolveFrom(dir, dep, boundary)
      if (!resolved) {
        gaps.push({
          from: name,
          dep,
          detail:
            mode === 'unpacked'
              ? `在 unpacked 树内无法解析（from ${path.relative(nmRoot, dir) || '.'}）`
              : `node_modules 中不存在，无法检查 asarUnpack 覆盖`,
        })
        continue
      }

      if (mode === 'static') {
        const rootRel = path.relative(ROOT, resolved).replace(/\\/g, '/')
        if (!rootRel.startsWith('node_modules/')) {
          gaps.push({ from: name, dep, detail: `解析到意外路径：${rootRel}` })
          continue
        }
        if (!isCoveredByAsarUnpack(rootRel, patterns)) {
          gaps.push({
            from: name,
            dep,
            detail: `仅在 asar 可达（${rootRel}），未列入 asarUnpack——utilityProcess 会 Cannot find module`,
          })
        }
      }
    }
  }

  return { ok: gaps.length === 0, gaps, packageCount: pkgs.length }
}

function printReport(result, mode) {
  console.log(`[check-asar-unpack-deps] mode=${mode}, packages=${result.packageCount}`)
  if (result.ok) {
    console.log('[check-asar-unpack-deps] ✓ worker 传递依赖 asarUnpack 覆盖完整')
    return
  }
  console.error('[check-asar-unpack-deps] ✗ 发现 asarUnpack 缺口：')
  for (const g of result.gaps) {
    console.error(`  - ${g.from} → ${g.dep}`)
    console.error(`    ${g.detail}`)
  }
  console.error(
    '\n请在 electron-builder.yml 的 asarUnpack 中补上对应 node_modules/<pkg>/**/*，然后重新打包。',
  )
}

function parseArgs(argv) {
  const out = { unpacked: null, yml: DEFAULT_YML }
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--unpacked' && argv[i + 1]) {
      out.unpacked = path.resolve(argv[++i])
    } else if (argv[i] === '--yml' && argv[i + 1]) {
      out.yml = path.resolve(argv[++i])
    } else if (argv[i] === '--help' || argv[i] === '-h') {
      out.help = true
    }
  }
  return out
}

function main() {
  const args = parseArgs(process.argv)
  if (args.help) {
    console.log(`Usage:
  node scripts/check-asar-unpack-deps.js
  node scripts/check-asar-unpack-deps.js --unpacked <app.asar.unpacked/node_modules>
  node scripts/check-asar-unpack-deps.js --yml electron-builder.yml`)
    process.exit(0)
  }

  let result
  if (args.unpacked) {
    if (!exists(args.unpacked)) {
      console.error(`[check-asar-unpack-deps] unpacked 目录不存在：${args.unpacked}`)
      process.exit(1)
    }
    result = checkAsarUnpackDeps({ mode: 'unpacked', nmRoot: args.unpacked })
    printReport(result, 'unpacked')
  } else {
    if (!exists(DEFAULT_NM)) {
      console.error('[check-asar-unpack-deps] 找不到 node_modules，请先 npm install')
      process.exit(1)
    }
    const patterns = parseAsarUnpack(args.yml)
    if (patterns.length === 0) {
      console.error(`[check-asar-unpack-deps] 未解析到 asarUnpack：${args.yml}`)
      process.exit(1)
    }
    result = checkAsarUnpackDeps({
      mode: 'static',
      nmRoot: DEFAULT_NM,
      patterns,
      ymlPath: args.yml,
    })
    printReport(result, 'static')
  }

  process.exit(result.ok ? 0 : 1)
}

module.exports = {
  checkAsarUnpackDeps,
  parseAsarUnpack,
  WORKER_ENTRY_PACKAGES,
  ALLOW_MISSING,
}

if (require.main === module) {
  main()
}
