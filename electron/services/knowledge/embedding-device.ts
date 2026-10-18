/**
 * 嵌入推理设备选择（Transformers.js v4 device API）
 *
 * @see https://huggingface.co/docs/transformers.js/guides/device-acceleration
 */

import fs from 'fs'
import type { EmbeddingDevice } from './types'

export type { EmbeddingDevice } from './types'

const VALID_DEVICES: ReadonlySet<string> = new Set([
  'auto', 'cpu', 'gpu', 'coreml', 'cuda', 'dml', 'webgpu',
])

/** 将配置值规范为合法设备，未知值回退 auto */
export function normalizeEmbeddingDevice(device?: string | null): EmbeddingDevice {
  if (device && VALID_DEVICES.has(device)) {
    return device as EmbeddingDevice
  }
  return 'auto'
}

/**
 * Linux 上有没有能给进程用的显卡设备。
 * 不靠报错文案判断：看设备节点在不在。容器里没挂显卡设备时也算没有。
 */
export function linuxHasGpu(
  exists: (path: string) => boolean,
  listDir: (path: string) => string[],
): boolean {
  if (exists('/dev/nvidia0') || exists('/dev/nvidiactl')) return true
  try {
    return listDir('/dev/dri').some(name => name.startsWith('renderD'))
  } catch {
    return false
  }
}

/** 图形栈明确在用硬件加速 */
const HARDWARE_GPU_STATUSES = new Set([
  'enabled',
  'enabled_on',
  'enabled_force',
  'enabled_force_on',
  'enabled_readback',
])

/** 图形栈明确只剩软件渲染，没有能用来做嵌入的显卡 */
const SOFTWARE_ONLY_GPU_STATUSES = new Set([
  'disabled_software',
  'unavailable_software',
])

/**
 * 从图形栈状态判断有没有硬件显卡。
 * 问不到、或只是被人关掉，返回 null，调用方不要据此停掉加速。
 */
export function hardwareGpuFromFeatureStatus(
  status: Record<string, string> | null | undefined,
): boolean | null {
  if (!status) return null
  const values = [status.gpu_compositing, status.webgl].filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  )
  if (values.length === 0) return null
  if (values.some(value => HARDWARE_GPU_STATUSES.has(value))) return true
  if (values.every(value => SOFTWARE_ONLY_GPU_STATUSES.has(value))) return false
  return null
}

function readElectronGpuStatus(): Record<string, string> | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as {
      app?: { getGPUFeatureStatus?: () => Record<string, string> }
    }
    const status = electron.app?.getGPUFeatureStatus?.()
    if (!status || typeof status !== 'object') return null
    return status
  } catch {
    return null
  }
}

function detectGpuAvailable(): boolean {
  if (process.platform === 'linux') {
    return linuxHasGpu(
      path => fs.existsSync(path),
      dir => fs.readdirSync(dir),
    )
  }
  const fromElectron = hardwareGpuFromFeatureStatus(readElectronGpuStatus())
  if (fromElectron !== null) return fromElectron
  return true
}

/** 将用户配置解析为 pipeline 实际使用的 device（处理 auto 与平台差异） */
export function resolvePipelineDevice(
  device: EmbeddingDevice,
  gpuAvailable: boolean = detectGpuAvailable(),
): EmbeddingDevice {
  if (device === 'auto') {
    // macOS：transformers auto 会优先 CoreML，但 ORT 1.24 对外部 onnx_data 路径解析有误；
    // gpu 会走 webgpu 等可用后端，实测稳定且更快。
    switch (process.platform) {
      case 'darwin':
        // 没有可用显卡时不要走 WebGPU，和 Windows / Linux 一样直接 CPU。
        return gpuAvailable ? 'gpu' : 'cpu'
      case 'linux':
        // 无设备节点就直接 CPU。gpu 的执行器列表不含 CPU，
        // 无卡机器上先去碰 WebGPU/CUDA 会卡住或把进程打退出去。
        return process.arch === 'x64' && gpuAvailable ? 'gpu' : 'cpu'
      case 'win32':
        // 没有可用显卡时不要走 DirectML。有显卡也不能用 gpu 别名：
        // transformers.js 会同时注册 webgpu + dml。
        return gpuAvailable ? 'dml' : 'cpu'
      default:
        return 'cpu'
    }
  }

  // 用户显式选 gpu 时，Windows 同样会触发 webgpu+dml 冲突，落到 dml。
  if (device === 'gpu' && process.platform === 'win32') {
    return 'dml'
  }

  return device
}

/**
 * 模型加载时按顺序尝试的 pipeline 设备。
 * 加速 EP（DML/WebGPU/CUDA 等）在无可用 GPU 或驱动不兼容时会直接失败，ORT 不会自动回退 CPU。
 */
export function getEmbeddingInitDeviceCandidates(
  device: EmbeddingDevice,
  gpuAvailable: boolean = detectGpuAvailable(),
): EmbeddingDevice[] {
  const primary = resolvePipelineDevice(device, gpuAvailable)
  if (primary === 'cpu') return ['cpu']
  return [primary, 'cpu']
}

/** pipeline() 公共选项：本地量化 ONNX + 指定设备 */
export function buildEmbeddingPipelineOptions(device: EmbeddingDevice): {
  local_files_only: boolean
  device: EmbeddingDevice
  dtype: 'q8'
} {
  const resolved = resolvePipelineDevice(device)
  return {
    local_files_only: true,
    device: resolved,
    dtype: 'q8',
  }
}

/** GPU 类设备可用更大 batch（仍在独立 worker 内，降低 SIGTRAP 风险） */
export function usesAcceleratedEmbedding(device: EmbeddingDevice): boolean {
  return resolvePipelineDevice(device) !== 'cpu'
}

/** 设置页可选设备列表（按平台过滤无效项） */
export function getSelectableEmbeddingDevices(): EmbeddingDevice[] {
  const common: EmbeddingDevice[] = ['auto', 'cpu']
  if (process.platform === 'darwin') {
    return [...common, 'coreml', 'webgpu', 'gpu']
  }
  if (process.platform === 'win32') {
    return [...common, 'dml', 'webgpu', 'gpu']
  }
  if (process.platform === 'linux' && process.arch === 'x64') {
    return [...common, 'cuda', 'webgpu', 'gpu']
  }
  return common
}
