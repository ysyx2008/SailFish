/**
 * 本地模型 HTTP 服务器
 * 为 vosk-browser 提供本地模型文件访问
 */
import * as http from 'http'
import * as fs from 'fs'
import * as path from 'path'
import { app } from 'electron'

let server: http.Server | null = null
let serverPort = 0

/**
 * 获取模型目录
 */
function getModelDirectory(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'models', 'speech', 'vosk')
  } else {
    return path.join(process.cwd(), 'resources', 'models', 'speech', 'vosk')
  }
}

/**
 * 获取 MIME 类型
 */
function getMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  const mimeTypes: Record<string, string> = {
    '.json': 'application/json',
    '.mdl': 'application/octet-stream',
    '.fst': 'application/octet-stream',
    '.int': 'application/octet-stream',
    '.conf': 'text/plain',
    '.stats': 'application/octet-stream',
    '.mat': 'application/octet-stream',
    '.dubm': 'application/octet-stream',
    '.ie': 'application/octet-stream',
    '.zip': 'application/zip',
    '.tar': 'application/x-tar',
    '.gz': 'application/gzip',
  }
  return mimeTypes[ext] || 'application/octet-stream'
}

/**
 * 启动模型服务器
 */
export async function startModelServer(): Promise<number> {
  if (server) {
    return serverPort
  }

  const modelDir = getModelDirectory()
  
  return new Promise((resolve, reject) => {
    server = http.createServer((req, res) => {
      // CORS 头
      res.setHeader('Access-Control-Allow-Origin', '*')
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range')
      res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range')

      if (req.method === 'OPTIONS') {
        res.writeHead(204)
        res.end()
        return
      }

      if (req.method !== 'GET') {
        res.writeHead(405)
        res.end('Method not allowed')
        return
      }

      // 解析请求路径
      const urlPath = decodeURIComponent(req.url || '/')
      const filePath = path.join(modelDir, urlPath)

      // 安全检查：确保路径在模型目录内
      if (!filePath.startsWith(modelDir)) {
        res.writeHead(403)
        res.end('Forbidden')
        return
      }

      // 检查文件是否存在
      fs.stat(filePath, (err, stats) => {
        if (err) {
          if (err.code === 'ENOENT') {
            res.writeHead(404)
            res.end('Not found')
          } else {
            res.writeHead(500)
            res.end('Internal server error')
          }
          return
        }

        if (stats.isDirectory()) {
          // 列出目录（简单实现）
          fs.readdir(filePath, (err, files) => {
            if (err) {
              res.writeHead(500)
              res.end('Internal server error')
              return
            }
            res.setHeader('Content-Type', 'application/json')
            res.writeHead(200)
            res.end(JSON.stringify(files))
          })
          return
        }

        // 处理 Range 请求（支持断点续传）
        const range = req.headers.range
        const mimeType = getMimeType(filePath)

        if (range) {
          const parts = range.replace(/bytes=/, '').split('-')
          const start = parseInt(parts[0], 10)
          const end = parts[1] ? parseInt(parts[1], 10) : stats.size - 1
          const chunkSize = end - start + 1

          res.setHeader('Content-Range', `bytes ${start}-${end}/${stats.size}`)
          res.setHeader('Accept-Ranges', 'bytes')
          res.setHeader('Content-Length', chunkSize)
          res.setHeader('Content-Type', mimeType)
          res.writeHead(206)

          const stream = fs.createReadStream(filePath, { start, end })
          stream.pipe(res)
        } else {
          res.setHeader('Content-Length', stats.size)
          res.setHeader('Content-Type', mimeType)
          res.setHeader('Accept-Ranges', 'bytes')
          res.writeHead(200)

          const stream = fs.createReadStream(filePath)
          stream.pipe(res)
        }
      })
    })

    // 监听随机端口
    server.listen(0, '127.0.0.1', () => {
      const address = server!.address()
      if (typeof address === 'object' && address) {
        serverPort = address.port
        console.log(`[ModelServer] Started on http://127.0.0.1:${serverPort}`)
        resolve(serverPort)
      } else {
        reject(new Error('Failed to get server port'))
      }
    })

    server.on('error', (err) => {
      console.error('[ModelServer] Error:', err)
      reject(err)
    })
  })
}

/**
 * 停止模型服务器
 */
export function stopModelServer(): void {
  if (server) {
    server.close()
    server = null
    serverPort = 0
    console.log('[ModelServer] Stopped')
  }
}

/**
 * 获取服务器端口
 */
export function getServerPort(): number {
  return serverPort
}

/**
 * 获取模型 URL（zip 文件）
 */
export function getModelUrl(modelName: string = 'vosk-model-small-cn-0.22'): string | null {
  if (!serverPort) {
    return null
  }
  return `http://127.0.0.1:${serverPort}/${modelName}.zip`
}
