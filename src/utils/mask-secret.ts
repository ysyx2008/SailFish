/**
 * 密钥的遮盖显示：开头 3 位 + 圆点 + 末尾 4 位，输出的长度和密钥原来的长度一样。
 *
 * 太短的密钥露头尾就露掉了大半，一位都不露，全是圆点（长度同样和原来一样）。
 * 首尾的空白（复制时常多带的空格、换行）不算密钥的一部分，按去掉后的样子遮盖。
 */
export const MASK_CHAR = '•'
const HEAD = 3
const TAIL = 4
/** 达到这个长度才露头尾；再短露出的部分占比太大 */
const MIN_REVEAL_LENGTH = 16

export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (!value) return ''
  if (value.length < MIN_REVEAL_LENGTH) return MASK_CHAR.repeat(value.length)
  return `${value.slice(0, HEAD)}${MASK_CHAR.repeat(value.length - HEAD - TAIL)}${value.slice(-TAIL)}`
}
