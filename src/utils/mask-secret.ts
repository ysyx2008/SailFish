/**
 * 密钥的遮盖显示：开头 3 位 + 固定 8 个圆点 + 末尾 4 位。
 *
 * 圆点个数固定，不随密钥长短变，旁人看不出密钥有多长。
 * 太短的密钥露头尾就露掉了大半，一位都不露，只给 8 个圆点。
 * 首尾的空白（复制时常多带的空格、换行）不算密钥的一部分，按去掉后的样子遮盖。
 */
export const MASK_CHAR = '•'
const HEAD = 3
const TAIL = 4
const MIDDLE = 8
/** 达到这个长度才露头尾；再短露出的部分占比太大 */
const MIN_REVEAL_LENGTH = 16

export function maskSecret(secret: string): string {
  const value = secret.trim()
  if (!value) return ''
  if (value.length < MIN_REVEAL_LENGTH) return MASK_CHAR.repeat(MIDDLE)
  return `${value.slice(0, HEAD)}${MASK_CHAR.repeat(MIDDLE)}${value.slice(-TAIL)}`
}
