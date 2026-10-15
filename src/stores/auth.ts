/**
 * 应用 SSO 前端状态（脱敏会话；accessToken 按需经 IPC 领取）
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import { isOemFeatureEnabled } from '@shared/oem-features'
import type { AuthPublicSession, AuthUser } from '@shared/types'
import { signedInFace } from '../utils/signed-in-face'

export type SsoGateMode = 'hard' | 'soft' | 'none'

export const useAuthStore = defineStore('auth', () => {
  const enabled = computed(() => isOemFeatureEnabled('sso'))
  const gateMode = ref<SsoGateMode>('none')
  const session = ref<AuthPublicSession | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const initialized = ref(false)

  const user = computed<AuthUser | null>(() => session.value?.user ?? null)
  const isAuthenticated = computed(() => !!session.value?.user?.sub)
  /** 开了登录且已经登进来：左下角用这张脸。没开或还没登则是 null，角落仍是旗鱼或秘书。 */
  const face = computed(() => (enabled.value && isAuthenticated.value) ? signedInFace(user.value) : null)
  /** hard 门控且未登录 → 挡主界面 */
  const blockApp = computed(
    () => enabled.value && gateMode.value === 'hard' && !isAuthenticated.value
  )
  /** soft 时在顶栏显示登录入口 */
  const showSoftEntry = computed(
    () => enabled.value && gateMode.value === 'soft'
  )

  async function init(): Promise<void> {
    if (!enabled.value) {
      gateMode.value = 'none'
      session.value = null
      initialized.value = true
      return
    }
    loading.value = true
    error.value = null
    try {
      const api = window.electronAPI?.auth
      if (!api) {
        initialized.value = true
        return
      }
      gateMode.value = (await api.getGateMode()) || 'soft'
      session.value = await api.getSession()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      session.value = null
    } finally {
      loading.value = false
      initialized.value = true
    }
  }

  async function login(): Promise<void> {
    if (!enabled.value) return
    loading.value = true
    error.value = null
    try {
      const api = window.electronAPI?.auth
      if (!api) throw new Error('auth API unavailable')
      session.value = await api.startLogin()
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e)
      throw e
    } finally {
      loading.value = false
    }
  }

  async function logout(): Promise<void> {
    if (!enabled.value) return
    try {
      await window.electronAPI?.auth?.logout()
    } finally {
      session.value = null
    }
  }

  async function getAccessToken(): Promise<string | null> {
    if (!enabled.value || !isAuthenticated.value) return null
    return (await window.electronAPI?.auth?.getAccessToken()) ?? null
  }

  return {
    enabled,
    gateMode,
    session,
    user,
    isAuthenticated,
    face,
    blockApp,
    showSoftEntry,
    loading,
    error,
    initialized,
    init,
    login,
    logout,
    getAccessToken,
  }
})
