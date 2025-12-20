/**
 * 主机档案 composable
 * 管理主机信息的加载和刷新
 */
import { ref, watch } from 'vue'
import { useTerminalStore } from '../stores/terminal'

// 主机档案类型
export interface HostProfile {
  hostId: string
  hostname: string
  username: string
  os: string
  osVersion: string
  shell: string
  packageManager?: string
  installedTools: string[]
  lastProbed: number
  lastUpdated: number
}

export function useHostProfile() {
  const terminalStore = useTerminalStore()

  // 当前主机档案
  const currentHostProfile = ref<HostProfile | null>(null)
  const isLoadingProfile = ref(false)
  const isProbing = ref(false)

  // 获取当前终端的主机 ID
  const getHostId = async (): Promise<string> => {
    try {
    const activeTab = terminalStore.activeTab
    if (!activeTab) return 'local'
    
    if (activeTab.type === 'ssh' && activeTab.sshConfig) {
        const hostId = await window.electronAPI.hostProfile.generateHostId(
        'ssh',
        activeTab.sshConfig.host,
        activeTab.sshConfig.username
      )
        // 确保返回有效值
        return hostId || 'local'
    }
    return 'local'
    } catch (e) {
      console.warn('[HostProfile] getHostId failed, using "local":', e)
      return 'local'
    }
  }
  
  // 根据 tabId 获取主机 ID（不依赖 activeTab，适用于 Agent 等异步场景）
  const getHostIdByTabId = async (tabId: string): Promise<string> => {
    try {
      const tab = terminalStore.tabs.find(t => t.id === tabId)
      if (!tab) return 'local'
      
      if (tab.type === 'ssh' && tab.sshConfig) {
        const hostId = await window.electronAPI.hostProfile.generateHostId(
          'ssh',
          tab.sshConfig.host,
          tab.sshConfig.username
        )
        return hostId || 'local'
      }
      return 'local'
    } catch (e) {
      console.warn('[HostProfile] getHostIdByTabId failed, using "local":', e)
      return 'local'
    }
  }

  // 加载当前主机档案
  const loadHostProfile = async () => {
    isLoadingProfile.value = true
    try {
      const hostId = await getHostId()
      currentHostProfile.value = await window.electronAPI.hostProfile.get(hostId)
    } catch (e) {
      console.error('[HostProfile] 加载失败:', e)
    } finally {
      isLoadingProfile.value = false
    }
  }

  // 手动刷新主机档案
  const refreshHostProfile = async () => {
    if (isProbing.value) return
    
    isProbing.value = true
    try {
      const activeTab = terminalStore.activeTab
      const hostId = await getHostId()
      
      if (hostId === 'local') {
        // 本地主机：使用后台静默探测
        currentHostProfile.value = await window.electronAPI.hostProfile.probeLocal()
      } else if (activeTab?.type === 'ssh' && activeTab.ptyId) {
        // SSH 主机：执行后台探测
        const profile = await window.electronAPI.hostProfile.probeSsh(activeTab.ptyId, hostId)
        if (profile) {
          currentHostProfile.value = profile
        } else {
          // 探测失败，从缓存加载
          currentHostProfile.value = await window.electronAPI.hostProfile.get(hostId)
        }
      } else {
        // 回退：从缓存加载
        currentHostProfile.value = await window.electronAPI.hostProfile.get(hostId)
      }
      
      console.log('[HostProfile] 刷新完成:', currentHostProfile.value)
    } catch (e) {
      console.error('[HostProfile] 刷新失败:', e)
    } finally {
      isProbing.value = false
    }
  }

  // 自动探测主机信息（首次加载时）
  const autoProbeHostProfile = async (): Promise<void> => {
    try {
      const hostId = await getHostId()
      
      // 检查是否需要探测
      const needsProbe = await window.electronAPI.hostProfile.needsProbe(hostId)
      if (!needsProbe) return
      
      if (hostId === 'local') {
        // 本地主机：后台静默探测
        const profile = await window.electronAPI.hostProfile.probeLocal()
        currentHostProfile.value = profile
        console.log('[HostProfile] 自动探测完成:', profile)
      } else {
        // SSH 主机：通过 SSH 连接探测
        const activeTab = terminalStore.activeTab
        if (activeTab?.type === 'ssh' && activeTab.ptyId) {
          const profile = await window.electronAPI.hostProfile.probeSsh(activeTab.ptyId, hostId)
          if (profile) {
            currentHostProfile.value = profile
            console.log('[HostProfile] SSH 自动探测完成:', profile)
          }
        }
      }
    } catch (e) {
      console.error('[HostProfile] 自动探测失败:', e)
    }
  }

  // 监听终端切换，重新加载主机档案
  watch(() => terminalStore.activeTabId, () => {
    loadHostProfile()
  })

  return {
    currentHostProfile,
    isLoadingProfile,
    isProbing,
    getHostId,
    getHostIdByTabId,
    loadHostProfile,
    refreshHostProfile,
    autoProbeHostProfile
  }
}
