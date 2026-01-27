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

  // 计算属性
  const canRecord = computed(() => isModelReady.value && !isRecording.value && !isTranscribing.value)
  const isProcessing = computed(() => isRecording.value || isTranscribing.value || isInitializing.value)

  /**
   * 检查并初始化语音识别服务
   */
  async function checkAndInitialize(): Promise<boolean> {
    console.log('[useSpeechRecognition] checkAndInitialize called')
    try {
      // 检查模型是否可用
      const modelInfo = await window.electronAPI.speech.getModelInfo()
      console.log('[useSpeechRecognition] modelInfo:', modelInfo)
      if (!modelInfo.available) {
        error.value = '语音模型未安装'
        console.log('[useSpeechRecognition] Model not available')
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

      // 确保模型已初始化
      if (!isModelReady.value) {
        console.log('[useSpeechRecognition] Model not ready, initializing...')
        const initialized = await checkAndInitialize()
        console.log('[useSpeechRecognition] Initialize result:', initialized, 'error:', error.value)
        if (!initialized) return false
      }

      // 请求麦克风权限并获取音频流
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })

      // 创建 AudioContext 用于处理音频数据
      audioContext = new AudioContext({ sampleRate: 16000 })
      const source = audioContext.createMediaStreamSource(mediaStream)

      // 使用 ScriptProcessorNode 捕获音频数据
      const processor = audioContext.createScriptProcessor(4096, 1, 1)

      processor.onaudioprocess = (e) => {
        if (isRecording.value) {
          const inputData = e.inputBuffer.getChannelData(0)
          // 复制数据，因为 buffer 会被重用
          audioChunks.push(new Float32Array(inputData))
        }
      }

      source.connect(processor)
      processor.connect(audioContext.destination)

      isRecording.value = true
      return true
    } catch (err) {
      error.value = err instanceof Error ? err.message : '无法访问麦克风'
      return false
    }
  }

  /**
   * 停止录音并转录
   */
  async function stopRecording(): Promise<TranscriptionResult | null> {
    if (!isRecording.value) return null

    isRecording.value = false

    try {
      // 停止媒体流
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop())
        mediaStream = null
      }

      // 关闭 AudioContext
      if (audioContext) {
        await audioContext.close()
        audioContext = null
      }

      // 合并音频数据
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
   * 取消录音
   */
  function cancelRecording(): void {
    if (!isRecording.value) return

    isRecording.value = false
    audioChunks = []

    // 停止媒体流
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }

    // 关闭 AudioContext
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }
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
