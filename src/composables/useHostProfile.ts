/**
 * 主机档案 composable
 * 管理主机信息的加载、刷新和 Agent 发现总结
 */
import { ref, watch, ComputedRef } from 'vue'
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
  notes: string[]
  lastProbed: number
  lastUpdated: number
}

// Agent 状态类型（用于总结功能）
interface AgentState {
  isRunning: boolean
  agentId?: string
  steps: Array<{
    type: string
    content: string
    toolResult?: string
  }>
  history: Array<{ userTask: string; finalResult: string }>
}

export function useHostProfile(agentState: ComputedRef<AgentState | undefined>) {
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

  // 总结 Agent 任务中的关键发现
  const summarizeAgentFindings = async (hostId: string) => {
    const history = agentState.value?.history || []
    const currentSteps = agentState.value?.steps || []
    
    // 收集最近的 Agent 交互内容
    const recentInteractions: string[] = []
    
    // 添加历史任务
    for (const item of history.slice(-3)) {  // 最近 3 个历史任务
      recentInteractions.push(`任务: ${item.userTask}\n结果: ${item.finalResult}`)
    }
    
    // 添加当前任务步骤
    const currentTaskSteps = currentSteps.filter(s => 
      s.type === 'tool_result' || s.type === 'message'
    ).slice(-10)  // 最近 10 个步骤
    
    for (const step of currentTaskSteps) {
      if (step.toolResult) {
        recentInteractions.push(`命令输出: ${step.toolResult.substring(0, 500)}`)
      } else if (step.content && step.type === 'message') {
        recentInteractions.push(`AI 分析: ${step.content.substring(0, 300)}`)
      }
    }
    
    if (recentInteractions.length === 0) return
    
    // 获取当前已有的记忆
    const existingProfile = await window.electronAPI.hostProfile.get(hostId)
    const existingNotes = existingProfile?.notes || []
    
    // 让 AI 更新记忆（新增、更新、删除）
    try {
      const prompt = `你是主机信息管理助手。请精简更新主机的记忆信息。

## 当前已有记忆
${existingNotes.length > 0 ? existingNotes.map((n: string) => `- ${n}`).join('\n') : '（空）'}

## 最新交互记录
${recentInteractions.join('\n\n')}

## 任务
输出更新后的记忆列表。**最多保留 5 条**最重要的信息。

### 不要记录：
- 系统默认路径（如 /etc/nginx/、/var/log/ 等常见路径）
- 动态信息（端口、进程、状态、使用率）
- 临时目录或缓存

### 输出格式
最多 10 条，每条一行：
- 项目配置在 /home/user/myapp/config/
- 应用日志在 /data/logs/myapp/

如果没有值得记住的信息，只输出：无`

      const response = await window.electronAPI.ai.chat([
        { role: 'user', content: prompt }
      ])
      
      if (response && response.trim()) {
        if (response.trim() === '无' || response.includes('没有') && response.includes('信息')) {
          // 清空所有记忆
          if (existingNotes.length > 0) {
            await window.electronAPI.hostProfile.update(hostId, { notes: [] })
            console.log('[HostProfile] 清空了所有记忆')
          }
        } else {
          // 解析新的记忆列表
          // 过滤动态信息和系统默认路径
          const dynamicPatterns = [
            /端口/i, /port/i, /监听/i, /listen/i,
            /进程/i, /process/i, /pid/i,
            /运行中/i, /running/i, /stopped/i, /状态/i,
            /使用率/i, /占用/i, /usage/i,
            /\d+%/, /\d+mb/i, /\d+gb/i,
            /连接/i, /connection/i,
            /登录/i, /login/i
          ]
          // 系统默认路径不需要记录
          const commonPaths = [
            /^\/etc\/nginx\/?$/i,
            /^\/var\/log\/?$/i,
            /^\/usr\/local\/?$/i,
            /^\/home\/?$/i,
            /^\/root\/?$/i
          ]
          
          const newNotes = response.split('\n')
            .map(l => l.replace(/^[-•✅❌]\s*/, '').trim())
            .filter(l => {
              if (!l || l.length < 10 || l.length > 80) return false
              if (l.includes('输出') || l.includes('格式') || l.includes('最多')) return false
              if (dynamicPatterns.some(p => p.test(l))) return false
              if (!l.includes('/') && !l.includes('\\')) return false
              // 提取路径部分检查是否是常见默认路径
              const pathMatch = l.match(/[\/\\][\w\/\\\-\.]+/)
              if (pathMatch && commonPaths.some(p => p.test(pathMatch[0]))) return false
              return true
            })
            .slice(0, 5)  // 最多保留 5 条
          
          // 替换整个记忆列表
          await window.electronAPI.hostProfile.update(hostId, { notes: newNotes })
          console.log('[HostProfile] 更新记忆:', newNotes)
        }
      }
    } catch (e) {
      console.warn('[HostProfile] AI 总结失败:', e)
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
    summarizeAgentFindings,
    autoProbeHostProfile
  }
}
