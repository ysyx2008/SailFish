import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info'

export interface Toast {
  id: string
  message: string
  type: ToastType
  duration: number
  closable: boolean
}

// 全局状态
const toasts = ref<Toast[]>([])

let toastId = 0

/**
 * Toast 提示系统
 */
export function useToast() {
  /**
   * 显示 Toast
   */
  const show = (
    message: string,
    type: ToastType = 'info',
    duration: number = 3000,
    closable: boolean = true
  ): string => {
    const id = `toast-${++toastId}`
    const toast: Toast = {
      id,
      message,
      type,
      duration,
      closable
    }
    
    toasts.value.push(toast)
    
    // 自动关闭
    if (duration > 0) {
      setTimeout(() => {
        close(id)
      }, duration)
    }
    
    return id
  }

  /**
   * 关闭指定 Toast
   */
  const close = (id: string) => {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index > -1) {
      toasts.value.splice(index, 1)
    }
  }

  /**
   * 关闭所有 Toast
   */
  const closeAll = () => {
    toasts.value = []
  }

  // 便捷方法
  const success = (message: string, duration?: number) => show(message, 'success', duration)
  const error = (message: string, duration?: number) => show(message, 'error', duration ?? 5000)
  const warning = (message: string, duration?: number) => show(message, 'warning', duration)
  const info = (message: string, duration?: number) => show(message, 'info', duration)

  return {
    toasts,
    show,
    close,
    closeAll,
    success,
    error,
    warning,
    info
  }
}

// 导出便捷方法供全局使用
export const toast = {
  show: (message: string, type: ToastType = 'info', duration?: number) => {
    const { show } = useToast()
    return show(message, type, duration)
  },
  success: (message: string, duration?: number) => {
    const { success } = useToast()
    return success(message, duration)
  },
  error: (message: string, duration?: number) => {
    const { error } = useToast()
    return error(message, duration)
  },
  warning: (message: string, duration?: number) => {
    const { warning } = useToast()
    return warning(message, duration)
  },
  info: (message: string, duration?: number) => {
    const { info } = useToast()
    return info(message, duration)
  },
  close: (id: string) => {
    const { close } = useToast()
    close(id)
  },
  closeAll: () => {
    const { closeAll } = useToast()
    closeAll()
  }
}
