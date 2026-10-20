const MASK_CHAR = '•'
const HEAD = 3
const TAIL = 4
const MIDDLE = 8
/** 露出的头尾要不到总长的一半，太短的一个字也不露 */
const MIN_REVEAL_LENGTH = 16

/**
 * 把密钥遮住只露开头和结尾几位，用来让用户认出是哪一把，又不把整把摆在界面上。
 * 空串返回空串。
 */
export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (!value) return ''
  if (value.length < MIN_REVEAL_LENGTH) return MASK_CHAR.repeat(MIDDLE)
  return `${value.slice(0, HEAD)}${MASK_CHAR.repeat(MIDDLE)}${value.slice(-TAIL)}`
}
