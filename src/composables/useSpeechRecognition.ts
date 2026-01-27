/**
 * 语音识别 Composable
 * 使用 vosk-browser 实现离线语音识别
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

// Vosk 相关类型
interface VoskModel {
  // Vosk model interface
}

interface VoskRecognizer {
  on(event: 'result', callback: (message: { result: { text: string } }) => void): void
  on(event: 'partialresult', callback: (message: { result: { partial: string } }) => void): void
  acceptWaveform(data: AudioBuffer): void
  remove(): void
}

// Vosk 单例
let voskModel: VoskModel | null = null
let voskRecognizer: VoskRecognizer | null = null
let isVoskReady = false

export function useSpeechRecognition() {
  // 状态
  const isRecording = ref(false)
  const isTranscribing = ref(false)
  const isInitializing = ref(false)
  const isModelReady = ref(false)
  const error = ref<string | null>(null)
  const lastResult = ref<TranscriptionResult | null>(null)
  const partialResult = ref<string>('')

  // 录音相关
  let audioContext: AudioContext | null = null
  let mediaStream: MediaStream | null = null
  let scriptProcessor: ScriptProcessorNode | null = null
  let audioChunks: Float32Array[] = []

  // 计算属性
  const canRecord = computed(() => isModelReady.value && !isRecording.value && !isTranscribing.value)
  const isProcessing = computed(() => isRecording.value || isTranscribing.value || isInitializing.value)

  /**
   * 初始化 Vosk
   */
  async function checkAndInitialize(): Promise<boolean> {
    console.log('[useSpeechRecognition] checkAndInitialize called')
    
    if (isVoskReady && voskModel) {
      isModelReady.value = true
      return true
    }

    try {
      isInitializing.value = true
      error.value = null

      // 动态导入 vosk-browser
      const { createModel } = await import('vosk-browser')

      console.log('[useSpeechRecognition] Loading Vosk model...')
      
      // 获取模型路径
      // 在 Electron 中，可以使用 file:// 协议加载本地文件
      // 或者从远程加载预打包的模型
      const modelUrl = await getModelUrl()
      
      if (!modelUrl) {
        error.value = '无法获取模型路径'
        return false
      }

      console.log('[useSpeechRecognition] Model URL:', modelUrl)
      
      // 创建模型
      voskModel = await createModel(modelUrl)
      
      isVoskReady = true
      isModelReady.value = true
      
      console.log('[useSpeechRecognition] Vosk model loaded successfully')
      return true
    } catch (err) {
      console.error('[useSpeechRecognition] Initialize error:', err)
      error.value = err instanceof Error ? err.message : '初始化失败'
      return false
    } finally {
      isInitializing.value = false
    }
  }

  /**
   * 获取模型 URL
   * 从主进程的本地 HTTP 服务器获取模型
   */
  async function getModelUrl(): Promise<string | null> {
    try {
      const modelInfo = await window.electronAPI.speech.getModelInfo()
      if (modelInfo.modelUrl) {
        return modelInfo.modelUrl
      }
    } catch (e) {
      console.error('[useSpeechRecognition] Failed to get model URL:', e)
    }
    return null
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
      partialResult.value = ''
      audioChunks = []

      // 确保模型已初始化
      if (!isModelReady.value) {
        console.log('[useSpeechRecognition] Model not ready, initializing...')
        const initialized = await checkAndInitialize()
        console.log('[useSpeechRecognition] Initialize result:', initialized, 'error:', error.value)
        if (!initialized) return false
      }

      // 创建识别器
      if (!voskModel) {
        error.value = '模型未加载'
        return false
      }
      
      // 从模型创建识别器，采样率 16000
      // @ts-ignore - vosk-browser 类型定义问题
      voskRecognizer = new voskModel.KaldiRecognizer(16000)
      
      // 监听识别结果
      voskRecognizer.on('result', (message) => {
        const text = message.result.text
        if (text) {
          console.log('[useSpeechRecognition] Final result:', text)
          lastResult.value = { text }
        }
      })

      voskRecognizer.on('partialresult', (message) => {
        const partial = message.result.partial
        if (partial) {
          console.log('[useSpeechRecognition] Partial result:', partial)
          partialResult.value = partial
        }
      })

      // 请求麦克风权限并获取音频流
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true
        }
      })

      // 创建 AudioContext
      audioContext = new AudioContext({ sampleRate: 16000 })
      const source = audioContext.createMediaStreamSource(mediaStream)

      // 使用 ScriptProcessorNode 捕获音频数据
      scriptProcessor = audioContext.createScriptProcessor(4096, 1, 1)

      scriptProcessor.onaudioprocess = (e) => {
        if (isRecording.value && voskRecognizer) {
          const inputData = e.inputBuffer.getChannelData(0)
          // 保存原始数据用于最终转录
          audioChunks.push(new Float32Array(inputData))
          
          // 发送给 Vosk 进行流式识别
          voskRecognizer.acceptWaveform(e.inputBuffer)
        }
      }

      source.connect(scriptProcessor)
      scriptProcessor.connect(audioContext.destination)

      isRecording.value = true
      return true
    } catch (err) {
      console.error('[useSpeechRecognition] Start recording error:', err)
      error.value = err instanceof Error ? err.message : '无法访问麦克风'
      return false
    }
  }

  /**
   * 停止录音并获取最终结果
   */
  async function stopRecording(): Promise<TranscriptionResult | null> {
    if (!isRecording.value) return null

    isRecording.value = false
    isTranscribing.value = true

    try {
      // 停止媒体流
      if (mediaStream) {
        mediaStream.getTracks().forEach(track => track.stop())
        mediaStream = null
      }

      // 断开连接
      if (scriptProcessor) {
        scriptProcessor.disconnect()
        scriptProcessor = null
      }

      // 关闭 AudioContext
      if (audioContext) {
        await audioContext.close()
        audioContext = null
      }

      // 获取最终结果
      // Vosk 的结果已经通过 'result' 事件返回
      // 这里返回最后一个结果或部分结果
      const finalText = lastResult.value?.text || partialResult.value || ''
      
      // 清理识别器
      if (voskRecognizer) {
        voskRecognizer.remove()
        voskRecognizer = null
      }

      if (finalText) {
        const result: TranscriptionResult = { text: finalText }
        lastResult.value = result
        return result
      }

      return null
    } catch (err) {
      console.error('[useSpeechRecognition] Stop recording error:', err)
      error.value = err instanceof Error ? err.message : '转录失败'
      return null
    } finally {
      isTranscribing.value = false
      audioChunks = []
      partialResult.value = ''
    }
  }

  /**
   * 取消录音
   */
  function cancelRecording(): void {
    if (!isRecording.value) return

    isRecording.value = false
    audioChunks = []
    partialResult.value = ''

    // 停止媒体流
    if (mediaStream) {
      mediaStream.getTracks().forEach(track => track.stop())
      mediaStream = null
    }

    // 断开连接
    if (scriptProcessor) {
      scriptProcessor.disconnect()
      scriptProcessor = null
    }

    // 关闭 AudioContext
    if (audioContext) {
      audioContext.close()
      audioContext = null
    }

    // 清理识别器
    if (voskRecognizer) {
      voskRecognizer.remove()
      voskRecognizer = null
    }
  }

  /**
   * 获取服务状态
   */
  async function getStatus(): Promise<SpeechRecognitionStatus> {
    return {
      initialized: isVoskReady,
      modelLoaded: isVoskReady && voskModel !== null,
      modelId: isVoskReady ? 'vosk-small-cn' : null
    }
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
    partialResult,  // 新增：部分识别结果（流式）

    // 方法
    checkAndInitialize,
    startRecording,
    stopRecording,
    cancelRecording,
    getStatus
  }
}
