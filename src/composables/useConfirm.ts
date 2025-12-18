import { ref, reactive } from 'vue'
import type { ConfirmDialogOptions } from '../components/common/ConfirmDialog.vue'

// 全局状态
const show = ref(false)
const options = reactive<ConfirmDialogOptions>({
  title: '',
  message: '',
  type: 'default'
})

let resolvePromise: ((value: boolean) => void) | null = null

/**
 * 显示确认对话框
 */
export function useConfirm() {
  const confirm = (opts: ConfirmDialogOptions): Promise<boolean> => {
    return new Promise((resolve) => {
      Object.assign(options, {
        title: opts.title,
        message: opts.message,
        detail: opts.detail,
        confirmText: opts.confirmText,
        cancelText: opts.cancelText,
        type: opts.type || 'default',
        showCancel: opts.showCancel,
        fileInfo: opts.fileInfo
      })
      show.value = true
      resolvePromise = resolve
    })
  }

  const handleConfirm = () => {
    show.value = false
    resolvePromise?.(true)
    resolvePromise = null
  }

  const handleCancel = () => {
    show.value = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  const handleClose = () => {
    show.value = false
    resolvePromise?.(false)
    resolvePromise = null
  }

  return {
    show,
    options,
    confirm,
    handleConfirm,
    handleCancel,
    handleClose
  }
}

// 便捷方法
export async function showConfirm(opts: ConfirmDialogOptions): Promise<boolean> {
  const { confirm } = useConfirm()
  return confirm(opts)
}

// 删除确认快捷方法
export async function confirmDelete(
  name: string, 
  type: string = '文件',
  size?: string
): Promise<boolean> {
  return showConfirm({
    title: `删除${type}`,
    message: `确定要删除此${type}吗？此操作无法撤销。`,
    type: 'danger',
    confirmText: '删除',
    cancelText: '取消',
    fileInfo: {
      name,
      type,
      size
    }
  })
}

// 警告提示快捷方法
export async function showAlert(title: string, message: string): Promise<void> {
  await showConfirm({
    title,
    message,
    type: 'warning',
    showCancel: false,
    confirmText: '确定'
  })
}
