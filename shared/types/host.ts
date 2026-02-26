/**
 * 主机档案共享类型定义
 */

export interface HostProfile {
  hostId: string
  hostname: string
  username: string
  os: string
  osVersion: string
  shell: string
  packageManager?: string
  installedTools: string[]
  homeDir?: string
  currentDir?: string
  notes?: string[]
  lastProbed: number
  lastUpdated: number
}
