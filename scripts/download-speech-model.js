#!/usr/bin/env node
/**
 * Vosk 语音识别模型下载脚本
 * 下载 vosk-model-small-cn 模型文件（约 42MB）
 */
const https = require('https')
const fs = require('fs')
const path = require('path')
const { URL } = require('url')

const MODEL_DIR = path.join(__dirname, '..', 'resources', 'models', 'speech', 'vosk')

// Vosk 模型下载地址
const MODEL_URL = 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip'
const MODEL_NAME = 'vosk-model-small-cn-0.22'

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
      timeout: 300000
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

async function main() {
  console.log('==================================================')
  console.log('Vosk Chinese Model Downloader')
  console.log('==================================================')
  console.log()

  // 创建目录
  if (!fs.existsSync(MODEL_DIR)) {
    fs.mkdirSync(MODEL_DIR, { recursive: true })
    console.log(`Created directory: ${MODEL_DIR}`)
  }

  const zipPath = path.join(MODEL_DIR, `${MODEL_NAME}.zip`)
  
  // 检查 zip 文件是否已存在
  if (fs.existsSync(zipPath)) {
    console.log('Model zip already exists, skipping download')
    console.log(`Model path: ${zipPath}`)
    return
  }

  console.log(`Downloading model from: ${MODEL_URL}`)
  console.log()

  try {
    await download(MODEL_URL, zipPath)
    console.log('  ✓ Download complete')
    
    console.log()
    console.log('==================================================')
    console.log('✓ Model downloaded successfully!')
    console.log(`  Path: ${zipPath}`)
    console.log('==================================================')
  } catch (err) {
    console.error(`Download failed: ${err.message}`)
    process.exit(1)
  }
}

main()
