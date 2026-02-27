/**
 * 语音识别 Composable
 * 使用 sherpa-onnx + Paraformer 模型
 */
import { ref, computed, onUnmounted } from 'vue'

export interface SpeechRecognitionStatus {
  initialized: boolean
  modelLoaded: boolean
  modelId: string | null
  error?: string
}

export interface TranscriptionResult {
  text: string
  language?: string
  duration?: number
}

/**
 * 简单的线性插值重采样
 * @param input 输入音频数据
 * @param fromSampleRate 原始采样率
 * @param toSampleRate 目标采样率
 */
function resampleAudio(input: Float32Array, fromSampleRate: number, toSampleRate: number): Float32Array {
  if (fromSampleRate === toSampleRate) {
    return new Float32Array(input)
  }
  
  const ratio = fromSampleRate / toSampleRate
  const outputLength = Math.round(input.length / ratio)
  const output = new Float32Array(outputLength)
  
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio
    const srcIndexFloor = Math.floor(srcIndex)
    const srcIndexCeil = Math.min(srcIndexFloor + 1, input.length - 1)
    const fraction = srcIndex - srcIndexFloor
    
    // 线性插值
    output[i] = input[srcIndexFloor] * (1 - fraction) + input[srcIndexCeil] * fraction
  }
  
  return output
}

export function useSpeechRecognition() {
  // 状态
  const isRecording = ref(false)
  const isTranscribing = ref(false)
  const isInitializing = ref(false)
  const isModelReady = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<TranscriptionResult | null>(null)

  // 录音相关
  let audioContext: AudioContext | null = null
  let audioChunks: Float32Array[] = []
  let mediaStream: MediaStream | null = null
  let startAborted = false

  // 计算属性
  const canRecord = computed(() => isModelReady.value && !isRecording.value && !isTranscribing.value)
  const isProcessing = computed(() => isRecording.value || isTranscribing.value || isInitializing.value)

  /**
   * 检查并初始化语音识别服务
   */
  async function checkAndInitialize(): Promise<boolean> {
    console.debug('[useSpeechRecognition] checkAndInitialize called')
    try {
      // 检查模型是否可用
      const modelInfo = await window.electronAPI.speech.getModelInfo()
      console.debug('[useSpeechRecognition] modelInfo:', modelInfo)
      if (!modelInfo.available) {
        error.value = '语音模型未安装'
        console.debug('[useSpeechRecognition] Model not available')
        return false
      }

      // 检查是否已就绪
      const ready = await window.electronAPI.speech.isReady()
      if (ready) {
        isModelReady.value = true
        return true
      }

      // 初始化服务
      isInitializing.value = true
      error.value = null

      const result = await window.electronAPI.speech.initialize()
      if (!result.success) {
        error.value = result.error || '初始化失败'
        return false
      }

      isModelReady.value = true
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '初始化失败'
      return false
    } finally {
      isInitializing.value = false
    }
  }

  function releaseMediaResources(): void {
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }
    if (audioContext) {
      audioContext.close().catch(() => {})
      audioContext = null
    }
  }

  /**
   * 开始录音
   */
  async function startRecording(): Promise<boolean> {
    console.log('[useSpeechRecognition] startRecording called')
    if (isRecording.value) {
      console.log('[useSpeechRecognition] Already recording, skipping')
      return false
    }

    try {
      error.value = null
      audioChunks = []
      startAborted = false

      // 确保模型已初始化
      if (!isModelReady.value) {
        console.log('[useSpeechRecognition] Model not ready, initializing...')
        const initialized = await checkAndInitialize()
        console.log('[useSpeechRecognition] Initialize result:', initialized, 'error:', error.value)
        if (!initialized) return false
        if (startAborted) {
          releaseMediaResources()
          return false
        }
      }

      // 请求麦克风权限并获取音频流
      // 注意：Windows 上某些设备可能不支持指定的采样率约束
      // 使用 ideal 而不是硬性约束，让浏览器选择最接近的设置
      try {
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: {
            sampleRate: { ideal: 16000 },
            channelCount: { ideal: 1 },
            echoCancellation: true,
            noiseSuppression: true
          }
        })
      } catch (mediaErr) {
        // 如果 ideal 约束也失败，尝试使用最基本的约束
        console.warn('[useSpeechRecognition] 使用 ideal 约束失败，尝试基本约束:', mediaErr)
        mediaStream = await navigator.mediaDevices.getUserMedia({
          audio: true
        })
      }

      if (startAborted) {
        releaseMediaResources()
        return false
      }

      // 创建 AudioContext 用于处理音频数据
      // 注意：Windows 上可能无法强制指定采样率，需要后续重采样
      const targetSampleRate = 16000
      try {
        audioContext = new AudioContext({ sampleRate: targetSampleRate })
      } catch {
        // 如果指定采样率失败，使用默认采样率
        audioContext = new AudioContext()
        console.warn(`[useSpeechRecognition] 无法创建 ${targetSampleRate}Hz AudioContext，使用默认: ${audioContext.sampleRate}Hz`)
      }
      const source = audioContext.createMediaStreamSource(mediaStream)

      // 使用 ScriptProcessorNode 捕获音频数据
      const processor = audioContext.createScriptProcessor(4096, 1, 1)
      const actualSampleRate = audioContext.sampleRate

      processor.onaudioprocess = (e) => {
        if (isRecording.value) {
          const inputData = e.inputBuffer.getChannelData(0)
          
          // 如果采样率不是目标采样率，需要重采样
          if (actualSampleRate !== targetSampleRate) {
            const resampledData = resampleAudio(inputData, actualSampleRate, targetSampleRate)
            audioChunks.push(resampledData)
          } else {
            // 复制数据，因为 buffer 会被重用
            audioChunks.push(new Float32Array(inputData))
          }
        }
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      isRecording.value = true
      return true
    } catch (err) {
      releaseMediaResources()
      error.value = err instanceof Error ? err.message : '无法访问麦克风'
      return false
    }
  }

  /**
   * 停止录音并转录
   */
  async function stopRecording(): Promise<TranscriptionResult | null> {
    startAborted = true

    if (!isRecording.value) {
      releaseMediaResources()
      audioChunks = []
      return null
    }

    isRecording.value = false

    try {
      releaseMediaResources()

      if (audioChunks.length === 0) {
        error.value = '未录制到音频'
        return null
      }

      const totalLength = audioChunks.reduce((acc, chunk) => acc + chunk.length, 0)
      const mergedData = new Float32Array(totalLength)
      let offset = 0
      for (const chunk of audioChunks) {
        mergedData.set(chunk, offset)
        offset += chunk.length
      }

      // 转录
      isTranscribing.value = true
      
      // 将 Float32Array 转为普通数组传递给 IPC
      const audioArray = Array.from(mergedData)
      
      const result = await window.electronAPI.speech.transcribe(audioArray, 16000)

      if (!result.success) {
        error.value = result.error || '转录失败'
        return null
      }

      lastResult.value = result.result || null
      return result.result || null
    } catch (err) {
      error.value = err instanceof Error ? err.message : '转录失败'
      return null
    } finally {
      isTranscribing.value = false
      audioChunks = []
    }
  }

  /**
   * 取消录音（也能中止尚未完成的 startRecording）
   */
  function cancelRecording(): void {
    startAborted = true
    isRecording.value = false
    audioChunks = []
    releaseMediaResources()
  }

  /**
   * 获取服务状态
   */
  async function getStatus(): Promise<SpeechRecognitionStatus> {
    return await window.electronAPI.speech.getStatus()
  }

  // 清理
  onUnmounted(() => {
    cancelRecording()
  })

  return {
    // 状态
    isRecording,
    isTranscribing,
    isInitializing,
    isModelReady,
    isProcessing,
    canRecord,
    error,
    lastResult,

    // 方法
    checkAndInitialize,
    startRecording,
    stopRecording,
    cancelRecording,
    getStatus
  }
}
