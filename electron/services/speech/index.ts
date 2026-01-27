/**
 * 语音识别服务
 * 提供模型 HTTP 服务器和信息给渲染进程
 * 实际语音识别在渲染进程中使用 vosk-browser 运行
 */
import * as path from 'path'
import * as fs from 'fs'
import { app } from 'electron'
import { startModelServer, getModelUrl, getServerPort } from './model-server'

const MODEL_NAME = 'vosk-model-small-cn-0.22'

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
 * 检查模型是否可用（检查 zip 文件）
 */
export function isModelAvailable(): boolean {
  const zipPath = path.join(getModelDirectory(), `${MODEL_NAME}.zip`)
  return fs.existsSync(zipPath)
}

/**
 * 获取模型信息
 */
export async function getModelInfo() {
  const modelDir = getModelDirectory()
  const zipPath = path.join(modelDir, `${MODEL_NAME}.zip`)
  const available = fs.existsSync(zipPath)

  // 确保服务器已启动
  let modelUrl: string | null = null
  if (available) {
    try {
      await startModelServer()
      modelUrl = getModelUrl(MODEL_NAME)
    } catch (e) {
      console.error('[Speech] Failed to start model server:', e)
    }
  }

  return {
    id: 'vosk-small-cn',
    name: 'Vosk 中文小模型',
    description: '离线语音识别模型，支持普通话',
    languages: ['中文'],
    sampleRate: 16000,
    available,
    modelPath: available ? zipPath : null,
    modelUrl  // HTTP URL 供 vosk-browser 使用
  }
}

/**
 * 获取服务状态
 */
export function getStatus() {
  return {
    initialized: isModelAvailable() && getServerPort() > 0,
    modelLoaded: isModelAvailable(),
    modelId: isModelAvailable() ? 'vosk-small-cn' : null
  }
}

/**
 * 初始化服务
 */
export async function initialize() {
  if (!isModelAvailable()) {
    return { success: false, error: '模型文件不存在' }
  }
  
  try {
    await startModelServer()
    return { success: true }
  } catch (e) {
    return { success: false, error: e instanceof Error ? e.message : '启动服务器失败' }
  }
}

/**
 * 检查是否就绪
 */
export function isReady(): boolean {
  return isModelAvailable() && getServerPort() > 0
}
