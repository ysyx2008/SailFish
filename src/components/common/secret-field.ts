import { maskSecret } from '@/utils/mask-secret'

/**
 * 密钥框「此刻该怎么显示」的判断，不碰界面，方便把每种状态逐个测到。
 *
 * 输入框只能显示它自己的内容：想平时露头尾、点进去又能改真实内容，
 * 只能在不编辑的时候换一种显示——平时只读、里面放遮盖后的文本，
 * 聚焦时换成真实内容。
 */
export interface SecretFieldState {
  /** 用户自己填的 */
  value: string
  /** 框留空时实际在用的那一把（比如搜索沿用模型密钥）；不是 value */
  reusedValue?: string
  /** 光标在框里 */
  focused: boolean
  /** 点了眼睛，要看全文 */
  revealed: boolean
  /** 什么都没有时的占位文字 */
  placeholder?: string
}

export interface SecretFieldView {
  inputType: 'text' | 'password'
  /** 输入框里的文字 */
  shown: string
  readonly: boolean
  placeholder: string
  /** 框是空的，占位显示的是沿用着的那一把 */
  showsReused: boolean
}

export function describeSecretField(state: SecretFieldState): SecretFieldView {
  const { value, reusedValue = '', focused, revealed, placeholder = '' } = state

  if (value) {
    if (revealed) return { inputType: 'text', shown: value, readonly: false, placeholder, showsReused: false }
    if (focused) return { inputType: 'password', shown: value, readonly: false, placeholder, showsReused: false }
    return { inputType: 'text', shown: maskSecret(value), readonly: true, placeholder, showsReused: false }
  }

  // 空框：用户可以直接填。沿用着别处的密钥时，占位里显示那一把，样子和自己填的一样
  const inputType = revealed ? 'text' : 'password'
  if (reusedValue) {
    return {
      inputType,
      shown: '',
      readonly: false,
      placeholder: revealed ? reusedValue : maskSecret(reusedValue),
      showsReused: true,
    }
  }
  return { inputType, shown: '', readonly: false, placeholder, showsReused: false }
}
