import { ref } from 'vue'

export type ToastType = 'success' | 'error' | 'warning' | 'info' | 'proactive'

export interface Toast {
  id: string
  message: string
  type: ToastType
  duration: number
  closable: boolean
  onClick?: () => void
  action?: string
  /** 一条一直在走的进度，表示这件事还在进行、总时长未知 */
  progress?: boolean
  /** 主文案下面的补充，例如正在想的最新几句 */
  detail?: string
}

const toasts = ref<Toast[]>([])

let toastId = 0

export function useToast() {
  const show = (
    message: string,
    type: ToastType = 'info',
    duration: number = 3000,
    closable: boolean = true,
    options?: { onClick?: () => void; action?: string; progress?: boolean }
  ): string => {
    const id = `toast-${++toastId}`
    const toast: Toast = {
      id,
      message,
      type,
      duration,
      closable,
      onClick: options?.onClick,
      action: options?.action,
      progress: options?.progress
    }
    
    toasts.value.push(toast)
    
    if (duration > 0) {
      setTimeout(() => {
        close(id)
      }, duration)
    }
    
    return id
  }

  const update = (id: string, message: string) => {
    const toast = toasts.value.find(t => t.id === id)
    if (toast) toast.message = message
  }

  const updateDetail = (id: string, detail: string) => {
    const toast = toasts.value.find(t => t.id === id)
    if (toast) toast.detail = detail
  }

  const close = (id: string) => {
    const index = toasts.value.findIndex(t => t.id === id)
    if (index > -1) {
      toasts.value.splice(index, 1)
    }
  }

  const closeAll = () => {
    toasts.value = []
  }

  const success = (message: string, duration?: number) => show(message, 'success', duration)
  const error = (message: string, duration?: number) => show(message, 'error', duration ?? 5000)
  const warning = (message: string, duration?: number) => show(message, 'warning', duration)
  const info = (message: string, duration?: number) => show(message, 'info', duration)

  const proactive = (message: string, onClick?: () => void, duration: number = 15000): string => {
    return show(message, 'proactive', duration, true, {
      onClick,
      action: onClick ? '查看' : undefined
    })
  }

  return {
    toasts,
    show,
    update,
    updateDetail,
    close,
    closeAll,
    success,
    error,
    warning,
    info,
    proactive
  }
}

export const toast = {
  show: (message: string, type: ToastType = 'info', duration?: number, closable?: boolean, options?: { onClick?: () => void; action?: string; progress?: boolean }) => {
    const { show } = useToast()
    return show(message, type, duration, closable, options)
  },
  update: (id: string, message: string) => {
    const { update } = useToast()
    update(id, message)
  },
  updateDetail: (id: string, detail: string) => {
    const { updateDetail } = useToast()
    updateDetail(id, detail)
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
  proactive: (message: string, onClick?: () => void, duration?: number) => {
    const { proactive } = useToast()
    return proactive(message, onClick, duration)
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
