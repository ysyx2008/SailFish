/**
 * Embedding 模型管理服务
 * 负责模型的下载、校验和状态管理
 */
import * as fs from 'fs'
import * as path from 'path'
import * as https from 'https'
import * as http from 'http'
import * as os from 'os'
import * as crypto from 'crypto'
import { app } from 'electron'
import { EventEmitter } from 'events'
import type { ModelInfo, ModelTier, ModelStatus, DownloadProgressCallback } from './types'

// 模型定义
const MODELS: Record<ModelTier, ModelInfo> = {
  lite: {
    id: 'lite',
    name: '轻量模型',
    huggingfaceId: 'Xenova/bge-small-zh-v1.5',
    size: 24_000_000,  // ~24MB (量化版)
    dimensions: 512,
    maxTokens: 512,    // max_position_embeddings
    bundled: true,
    sha256: undefined  // 打包模型不需要校验
  },
  standard: {
    id: 'standard',
    name: '标准模型',
    huggingfaceId: 'Xenova/bge-base-zh-v1.5',
    size: 98_000_000,  // ~98MB (量化版)
    dimensions: 768,
    maxTokens: 512,    // max_position_embeddings
    bundled: false,
    downloadUrl: 'https://huggingface.co/Xenova/bge-base-zh-v1.5/resolve/main',
    sha256: undefined
  },
  large: {
    id: 'large',
    name: '高精模型',
    huggingfaceId: 'Xenova/bge-large-zh-v1.5',
    size: 650_000_000,  // ~650MB (量化版估算)
    dimensions: 1024,
    maxTokens: 512,    // max_position_embeddings
    bundled: false,
    downloadUrl: 'https://huggingface.co/Xenova/bge-large-zh-v1.5/resolve/main',
    sha256: undefined
  }
}

// 需要下载的模型文件列表
const MODEL_FILES = [
  'config.json',
  'tokenizer.json',
  'tokenizer_config.json',
  'onnx/model_quantized.onnx'
]

export class ModelManager extends EventEmitter {
  private bundledModelsPath: string
  private downloadedModelsPath: string
  private downloadingModels: Set<ModelTier> = new Set()

  constructor() {
    super()
    // 打包的模型路径（随软件安装）
    let resourcesPath: string
    if (app.isPackaged) {
      resourcesPath = path.join(process.resourcesPath, 'models', 'embedding')
    } else {
      // 开发环境：app.getAppPath() 可能不是项目根目录，需要特殊处理
      const appPath = app.getAppPath()
      // 检查是否在 asar 包内或 node_modules 下
      if (appPath.includes('.asar') || appPath.includes('node_modules')) {
        // 使用 process.cwd() 作为项目根目录
        resourcesPath = path.join(process.cwd(), 'resources', 'models', 'embedding')
      } else {
        resourcesPath = path.join(appPath, 'resources', 'models', 'embedding')
      }
    }
    this.bundledModelsPath = resourcesPath
    console.log('[ModelManager] bundledModelsPath:', this.bundledModelsPath)

    // 用户下载的模型路径
    this.downloadedModelsPath = path.join(app.getPath('userData'), 'models', 'embedding')
    
    // 确保目录存在
    this.ensureDirectories()
  }

  /**
   * 确保必要的目录存在
   */
  private ensureDirectories(): void {
    if (!fs.existsSync(this.downloadedModelsPath)) {
      fs.mkdirSync(this.downloadedModelsPath, { recursive: true })
    }
  }

  /**
   * 获取所有模型信息
   */
  getModels(): ModelInfo[] {
    return Object.values(MODELS)
  }

  /**
   * 获取指定模型信息
   */
  getModel(id: ModelTier): ModelInfo {
    return MODELS[id]
  }

  /**
   * 获取模型本地路径
   */
  getModelPath(id: ModelTier): string {
    const model = MODELS[id]
    if (model.bundled) {
      return path.join(this.bundledModelsPath, this.getModelDirName(id))
    }
    return path.join(this.downloadedModelsPath, this.getModelDirName(id))
  }

  /**
   * 获取模型目录名
   */
  private getModelDirName(id: ModelTier): string {
    const model = MODELS[id]
    // 使用 HuggingFace ID 的最后一部分作为目录名
    return model.huggingfaceId.split('/').pop() || id
  }

  /**
   * 检查模型是否可用
   */
  isModelAvailable(id: ModelTier): boolean {
    const modelPath = this.getModelPath(id)
    
    // 检查模型目录是否存在
    if (!fs.existsSync(modelPath)) {
      console.warn(`[ModelManager] Model ${id} not available: directory not found at ${modelPath}`)
      return false
    }

    // 检查必要文件是否存在
    const requiredFiles = ['config.json', 'tokenizer.json']
    for (const file of requiredFiles) {
      if (!fs.existsSync(path.join(modelPath, file))) {
        console.warn(`[ModelManager] Model ${id} not available: missing ${file}`)
        return false
      }
    }

    // 检查 ONNX 模型文件
    const onnxPath = path.join(modelPath, 'onnx', 'model_quantized.onnx')
    const onnxAltPath = path.join(modelPath, 'onnx', 'model.onnx')
    if (!fs.existsSync(onnxPath) && !fs.existsSync(onnxAltPath)) {
      console.warn(`[ModelManager] Model ${id} not available: missing ONNX model`)
      return false
    }

    return true
  }

  /**
   * 获取所有模型状态
   */
  getModelStatuses(): ModelStatus[] {
    return Object.keys(MODELS).map(id => {
      const tier = id as ModelTier
      return {
        id: tier,
        available: this.isModelAvailable(tier),
        downloading: this.downloadingModels.has(tier)
      }
    })
  }

  /**
   * 获取已下载的模型列表
   */
  getDownloadedModels(): ModelTier[] {
    return (Object.keys(MODELS) as ModelTier[]).filter(id => this.isModelAvailable(id))
  }

  /**
   * 根据系统配置推荐模型
   */
  getRecommendedModel(): ModelInfo {
    const totalMemory = os.totalmem() / (1024 ** 3)  // GB
    const cpuCores = os.cpus().length

    if (totalMemory >= 16 && cpuCores >= 8) {
      return MODELS.large
    } else if (totalMemory >= 8 && cpuCores >= 4) {
      return MODELS.standard
    } else {
      return MODELS.lite
    }
  }

  /**
   * 获取当前可用的最佳模型
   */
  getBestAvailableModel(): ModelInfo {
    // 按优先级检查：large > standard > lite
    const priority: ModelTier[] = ['large', 'standard', 'lite']
    
    for (const tier of priority) {
      if (this.isModelAvailable(tier)) {
        return MODELS[tier]
      }
    }

    // 如果都不可用，返回 lite（应该总是打包的）
    return MODELS.lite
  }

  /**
   * 下载模型
   */
  async downloadModel(
    id: ModelTier, 
    onProgress?: DownloadProgressCallback
  ): Promise<void> {
    const model = MODELS[id]
    
    if (model.bundled) {
      throw new Error('打包的模型无需下载')
    }

    if (this.downloadingModels.has(id)) {
      throw new Error('模型正在下载中')
    }

    if (this.isModelAvailable(id)) {
      console.log(`[ModelManager] Model ${id} already available`)
      return
    }

    this.downloadingModels.add(id)
    this.emit('downloadStart', id)

    const modelDir = this.getModelPath(id)
    const onnxDir = path.join(modelDir, 'onnx')

    try {
      // 创建模型目录
      if (!fs.existsSync(modelDir)) {
        fs.mkdirSync(modelDir, { recursive: true })
      }
      if (!fs.existsSync(onnxDir)) {
        fs.mkdirSync(onnxDir, { recursive: true })
      }

      // 下载所有必要文件
      let totalDownloaded = 0
      const totalSize = model.size

      for (const file of MODEL_FILES) {
        const fileUrl = `${model.downloadUrl}/${file}`
        const filePath = path.join(modelDir, file)
        
        // 确保文件目录存在
        const fileDir = path.dirname(filePath)
        if (!fs.existsSync(fileDir)) {
          fs.mkdirSync(fileDir, { recursive: true })
        }

        console.log(`[ModelManager] Downloading ${file}...`)
        
        await this.downloadFile(fileUrl, filePath, (downloaded, total) => {
          // 估算总体进度
          const fileProgress = downloaded / Math.max(total, 1)
          const overallProgress = (totalDownloaded + downloaded) / totalSize * 100
          
          if (onProgress) {
            onProgress(Math.min(overallProgress, 99), totalDownloaded + downloaded, totalSize)
          }
          
          this.emit('downloadProgress', {
            modelId: id,
            percent: Math.min(overallProgress, 99),
            downloaded: totalDownloaded + downloaded,
            total: totalSize
          })
        })

        // 获取下载文件大小
        const stats = fs.statSync(filePath)
        totalDownloaded += stats.size
      }

      // 下载完成
      if (onProgress) {
        onProgress(100, totalSize, totalSize)
      }
      
      this.emit('downloadComplete', id)
      console.log(`[ModelManager] Model ${id} downloaded successfully`)

    } catch (error) {
      // 下载失败，清理部分下载的文件
      if (fs.existsSync(modelDir)) {
        fs.rmSync(modelDir, { recursive: true, force: true })
      }
      
      this.emit('downloadError', { modelId: id, error })
      throw error
    } finally {
      this.downloadingModels.delete(id)
    }
  }

  /**
   * 下载单个文件
   */
  private downloadFile(
    url: string, 
    destPath: string,
    onProgress?: (downloaded: number, total: number) => void
  ): Promise<void> {
    return new Promise((resolve, reject) => {
      const protocol = url.startsWith('https') ? https : http
      
      const request = protocol.get(url, { 
        headers: { 'User-Agent': 'SFTerminal' }
      }, (response) => {
        // 处理重定向
        if (response.statusCode === 301 || response.statusCode === 302) {
          const redirectUrl = response.headers.location
          if (redirectUrl) {
            this.downloadFile(redirectUrl, destPath, onProgress)
              .then(resolve)
              .catch(reject)
            return
          }
        }

        if (response.statusCode !== 200) {
          reject(new Error(`下载失败: HTTP ${response.statusCode}`))
          return
        }

        const totalSize = parseInt(response.headers['content-length'] || '0', 10)
        let downloadedSize = 0

        const fileStream = fs.createWriteStream(destPath)
        
        response.on('data', (chunk: Buffer) => {
          downloadedSize += chunk.length
          if (onProgress) {
            onProgress(downloadedSize, totalSize)
          }
        })

        response.pipe(fileStream)

        fileStream.on('finish', () => {
          fileStream.close()
          resolve()
        })

        fileStream.on('error', (err) => {
          fs.unlink(destPath, () => {})
          reject(err)
        })
      })

      request.on('error', (err) => {
        reject(err)
      })

      request.setTimeout(60000, () => {
        request.destroy()
        reject(new Error('下载超时'))
      })
    })
  }

  /**
   * 删除已下载的模型
   */
  async deleteModel(id: ModelTier): Promise<void> {
    const model = MODELS[id]
    
    if (model.bundled) {
      throw new Error('打包的模型不能删除')
    }

    const modelPath = this.getModelPath(id)
    
    if (fs.existsSync(modelPath)) {
      fs.rmSync(modelPath, { recursive: true, force: true })
      this.emit('modelDeleted', id)
    }
  }

  /**
   * 校验模型文件完整性
   */
  async verifyModel(id: ModelTier): Promise<boolean> {
    if (!this.isModelAvailable(id)) {
      return false
    }

    const model = MODELS[id]
    
    // 如果没有 sha256，跳过校验
    if (!model.sha256) {
      return true
    }

    const modelPath = this.getModelPath(id)
    const onnxPath = path.join(modelPath, 'onnx', 'model_quantized.onnx')
    
    if (!fs.existsSync(onnxPath)) {
      return false
    }

    // 计算文件 SHA256
    const hash = crypto.createHash('sha256')
    const fileBuffer = fs.readFileSync(onnxPath)
    hash.update(fileBuffer)
    const fileHash = hash.digest('hex')

    return fileHash === model.sha256
  }

  /**
   * 获取模型存储路径信息
   */
  getStoragePaths(): { bundled: string; downloaded: string } {
    return {
      bundled: this.bundledModelsPath,
      downloaded: this.downloadedModelsPath
    }
  }
}

// 导出单例
let modelManager: ModelManager | null = null

export function getModelManager(): ModelManager {
  if (!modelManager) {
    modelManager = new ModelManager()
  }
  return modelManager
}

