import type { AuthUser } from '@shared/types'

/** 登录之后左下角那张脸：名字、下面的邮箱、可用的头像地址。 */
export function signedInFace(user: AuthUser | null | undefined): { name: string; email: string; picture: string } | null {
  const sub = user?.sub?.trim()
  if (!sub) return null
  const name = user?.name?.trim() || user?.email?.trim() || sub
  const emailRaw = user?.email?.trim() || ''
  const email = emailRaw && emailRaw !== name ? emailRaw : ''
  const pictureRaw = user?.picture?.trim() || ''
  const picture = /^https?:\/\//i.test(pictureRaw) ? pictureRaw : ''
  return { name, email, picture }
}
