#!/usr/bin/env node
/**
 * Paraformer 语音识别模型下载脚本
 * 下载 sherpa-onnx-paraformer-zh-2024-03-09 模型（约 217MB）
 */
const https = require('https')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')
const { execSync } = require('child_process')

const MODEL_DIR = path.join(__dirname, '..', 'resources', 'models', 'speech', 'paraformer')
const MODEL_NAME = 'sherpa-onnx-paraformer-zh-2024-03-09'
const MODEL_URL = `https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models/${MODEL_NAME}.tar.bz2`

function download(url, destPath, maxRedirects = 10) {
  return new Promise((resolve, reject) => {
    if (maxRedirects <= 0) {
      reject(new Error('Too many redirects'))
      return
    }

    const urlObj = new URL(url)
    
    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port || 443,
      path: urlObj.pathname + urlObj.search,
      method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Accept': '*/*'
      },
      timeout: 600000  // 10分钟超时
    }

    const req = https.request(options, (res) => {
      // 处理重定向
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        let redirectUrl = res.headers.location
        if (redirectUrl) {
          if (!redirectUrl.startsWith('http')) {
            redirectUrl = new URL(redirectUrl, url).href
          }
          console.log(`  Redirecting to: ${redirectUrl}`)
          download(redirectUrl, destPath, maxRedirects - 1)
            .then(resolve)
            .catch(reject)
          return
        }
      }

      if (res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}: ${res.statusMessage}`))
        return
      }

      const totalSize = parseInt(res.headers['content-length'], 10)
      let downloadedSize = 0
      let lastProgress = 0

      const file = fs.createWriteStream(destPath)
      
      res.on('data', (chunk) => {
        downloadedSize += chunk.length
        if (totalSize) {
          const progress = Math.round((downloadedSize / totalSize) * 100)
          if (progress >= lastProgress + 10) {
            const mb = (downloadedSize / 1024 / 1024).toFixed(1)
            const totalMb = (totalSize / 1024 / 1024).toFixed(1)
            console.log(`  Progress: ${progress}% (${mb}MB / ${totalMb}MB)`)
            lastProgress = progress
          }
        }
      })

      res.pipe(file)

      file.on('finish', () => {
        file.close()
        resolve()
      })

      file.on('error', (err) => {
        fs.unlink(destPath, () => {})
        reject(err)
      })
    })

    req.on('error', reject)
    req.on('timeout', () => {
      req.destroy()
      reject(new Error('Request timeout'))
    })

    req.end()
  })
}

function extractTarBz2(archivePath, destDir) {
  console.log('Extracting model...')
  try {
    // 使用 tar 命令解压 .tar.bz2
    execSync(`tar -xjf "${archivePath}" -C "${destDir}"`, { stdio: 'inherit' })
    console.log('  ✓ Extraction complete')
  } catch (err) {
    throw new Error(`Failed to extract: ${err.message}`)
  }
}

/**
 * 清理不需要的文件，只保留运行时必需的文件
 */
function cleanupModelFiles(modelPath) {
  console.log('Cleaning up unnecessary files...')
  
  // 需要删除的文件和目录
  const toDelete = [
    'model.onnx',           // fp32 模型（785MB），只需要 int8 版本
    'test_wavs',            // 测试音频目录
    'add-model-metadata.py',
    'generate-tokens.py',
    'quantize-model.py',
    'README.md',
    'config.yaml'
  ]
  
  let deletedSize = 0
  
  for (const item of toDelete) {
    const itemPath = path.join(modelPath, item)
    if (fs.existsSync(itemPath)) {
      const stat = fs.statSync(itemPath)
      if (stat.isDirectory()) {
        // 递归删除目录
        fs.rmSync(itemPath, { recursive: true })
        console.log(`  Deleted directory: ${item}`)
      } else {
        deletedSize += stat.size
        fs.unlinkSync(itemPath)
        console.log(`  Deleted: ${item} (${(stat.size / 1024 / 1024).toFixed(1)}MB)`)
      }
    }
  }
  
  console.log(`  ✓ Cleanup complete (saved ${(deletedSize / 1024 / 1024).toFixed(1)}MB)`)
}

async function main() {
  console.log('==================================================')
  console.log('Paraformer Speech Recognition Model Downloader')
  console.log('==================================================')
  console.log()

  // 创建目录
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true })
    console.log(`Created directory: ${MODEL_DIR}`)
  }

  const modelPath = path.join(MODEL_DIR, MODEL_NAME)
  const archivePath = path.join(MODEL_DIR, `${MODEL_NAME}.tar.bz2`)
  
  // 检查模型是否已存在
  if (fs.existsSync(path.join(modelPath, 'model.int8.onnx'))) {
    console.log('Model already exists, skipping download')
    console.log(`Model path: ${modelPath}`)
    return
  }

  console.log(`Downloading model from: ${MODEL_URL}`)
  console.log()

  try {
    // 下载
    await download(MODEL_URL, archivePath)
    console.log('  ✓ Download complete')
    
    // 解压
    extractTarBz2(archivePath, MODEL_DIR)
    
    // 删除压缩包
    fs.unlinkSync(archivePath)
    console.log('  ✓ Cleaned up archive')
    
    // 清理不需要的文件（如 fp32 模型、测试文件等）
    cleanupModelFiles(modelPath)
    
    console.log()
    console.log('==================================================')
    console.log('✓ Model downloaded successfully!')
    console.log(`  Path: ${modelPath}`)
    console.log('==================================================')
  } catch (err) {
    console.error(`Download failed: ${err.message}`)
    // 清理失败的文件
    if (fs.existsSync(archivePath)) {
      fs.unlinkSync(archivePath)
    }
    process.exit(1)
  }
}

main()
