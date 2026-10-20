/**
 * 密钥的遮盖显示：开头 3 位 + 固定 8 个圆点 + 末尾 4 位。
 *
 * 圆点个数固定，不随密钥长短变，旁人看不出密钥有多长。
 * 太短的密钥露头尾就露掉了大半，一位都不露，只给 8 个圆点。
 */
export const MASK_CHAR = '•'
const HEAD = 3
const TAIL = 4
const MIDDLE = 8
/** 达到这个长度才露头尾；再短露出的部分占比太大 */
const MIN_REVEAL_LENGTH = 16

export function maskSecret(secret: string): string {
  if (!secret) return ''
  if (secret.length < MIN_REVEAL_LENGTH) return MASK_CHAR.repeat(MIDDLE)
  return `${secret.slice(0, HEAD)}${MASK_CHAR.repeat(MIDDLE)}${secret.slice(-TAIL)}`
}
