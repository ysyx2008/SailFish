#!/usr/bin/env node
/**
 * 修复 sherpa-onnx-node 在 macOS 上的 dylib 路径问题
 * 将 @rpath 替换为 @loader_path，使其能在 Electron 中正常加载
 */

const { execSync } = require('child_process')
const path = require('path')
const fs = require('fs')

// 仅在 macOS 上运行
if (process.platform !== 'darwin') {
  console.log('[fix-sherpa-onnx] Skipping - not macOS')
  process.exit(0)
}

// 检测 CPU 架构
const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
const sherpaDir = path.join(__dirname, '..', 'node_modules', `sherpa-onnx-darwin-${arch}`)

if (!fs.existsSync(sherpaDir)) {
  console.log(`[fix-sherpa-onnx] Directory not found: ${sherpaDir}`)
  process.exit(0)
}

console.log(`[fix-sherpa-onnx] Fixing dylib paths in ${sherpaDir}`)

const filesToFix = [
  {
    file: 'sherpa-onnx.node',
    deps: [
      '@rpath/libsherpa-onnx-c-api.dylib',
      '@rpath/libonnxruntime.1.23.2.dylib'
    ]
  },
  {
    file: 'libsherpa-onnx-c-api.dylib',
    deps: [
      '@rpath/libonnxruntime.1.23.2.dylib'
    ]
  },
  {
    file: 'libsherpa-onnx-cxx-api.dylib',
    deps: [
      '@rpath/libsherpa-onnx-c-api.dylib',
      '@rpath/libonnxruntime.1.23.2.dylib'
    ]
  }
]

for (const { file, deps } of filesToFix) {
  const filePath = path.join(sherpaDir, file)
  if (!fs.existsSync(filePath)) {
    console.log(`[fix-sherpa-onnx] File not found: ${file}`)
    continue
  }

  for (const dep of deps) {
    const newDep = dep.replace('@rpath/', '@loader_path/')
    try {
      execSync(`install_name_tool -change ${dep} ${newDep} "${filePath}"`, { stdio: 'pipe' })
      console.log(`[fix-sherpa-onnx] Fixed ${file}: ${dep} -> ${newDep}`)
    } catch (e) {
      // 可能已经修复过了，忽略错误
    }
  }
}

console.log('[fix-sherpa-onnx] Done')
