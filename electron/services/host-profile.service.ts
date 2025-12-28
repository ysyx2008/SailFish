import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { app } from 'electron'
import { exec } from 'child_process'
import { promisify } from 'util'

const execAsync = promisify(exec)

// ==================== 类型定义 ====================

export interface HostProfile {
  hostId: string              // 唯一标识: local 或 user@host
  hostname: string            // 主机名
  username: string            // 用户名
  os: string                  // 操作系统
  osVersion: string           // 系统版本
  shell: string               // 默认 shell
  packageManager?: string     // 包管理器
  installedTools: string[]    // 已安装的常用工具
  homeDir?: string            // 用户主目录
  currentDir?: string         // 当前工作目录
  notes?: string[]            // 用户笔记（已迁移到知识库，保留兼容）
  lastProbed: number          // 上次探测时间
  lastUpdated: number         // 上次更新时间
}

export interface ProbeResult {
  hostname?: string
  username?: string
  os?: string
  osVersion?: string
  shell?: string
  packageManager?: string
  installedTools?: string[]
  homeDir?: string
  currentDir?: string
}

// ==================== 探测命令（公共） ====================

/**
 * 获取 Unix/Linux/macOS/BSD 系统的探测命令
 * 供本地探测和 SSH 探测共用
 */
export function getUnixProbeCommands(): string[] {
  return [
    'hostname 2>/dev/null || echo "unknown"',
    'whoami 2>/dev/null || echo "unknown"',
    'uname -s 2>/dev/null || echo "unknown"',
    // 系统版本（支持多种系统）
    // Linux: /etc/os-release, macOS: sw_vers, AIX: oslevel, BSD: freebsd-version/uname -r
    'cat /etc/os-release 2>/dev/null | grep -E "^(PRETTY_NAME|NAME|VERSION)=" | head -3 || sw_vers 2>/dev/null || freebsd-version 2>/dev/null || oslevel 2>/dev/null || uname -r 2>/dev/null || echo "unknown"',
    'echo $SHELL',
    'echo $HOME',
    'pwd',
    // 检测包管理器（Linux）
    'command -v apt >/dev/null 2>&1 && echo "[PKG_APT]"',
    'command -v yum >/dev/null 2>&1 && echo "[PKG_YUM]"',
    'command -v dnf >/dev/null 2>&1 && echo "[PKG_DNF]"',
    'command -v brew >/dev/null 2>&1 && echo "[PKG_BREW]"',
    'command -v pacman >/dev/null 2>&1 && echo "[PKG_PACMAN]"',
    // 检测包管理器（BSD）
    'command -v pkg >/dev/null 2>&1 && echo "[PKG_PKG]"',        // FreeBSD
    'command -v pkg_add >/dev/null 2>&1 && echo "[PKG_PKGADD]"', // OpenBSD
    'command -v pkgin >/dev/null 2>&1 && echo "[PKG_PKGIN]"',    // NetBSD
    // 检测常用工具
    'command -v git >/dev/null 2>&1 && echo "[HAS_GIT]"',
    'command -v docker >/dev/null 2>&1 && echo "[HAS_DOCKER]"',
    'command -v python3 >/dev/null 2>&1 && echo "[HAS_PYTHON3]"',
    'command -v python >/dev/null 2>&1 && echo "[HAS_PYTHON]"',
    'command -v node >/dev/null 2>&1 && echo "[HAS_NODE]"',
    'command -v nginx >/dev/null 2>&1 && echo "[HAS_NGINX]"',
    'command -v systemctl >/dev/null 2>&1 && echo "[HAS_SYSTEMD]"',
    'command -v vim >/dev/null 2>&1 && echo "[HAS_VIM]"',
    'command -v nano >/dev/null 2>&1 && echo "[HAS_NANO]"',
  ]
}

// ==================== 主机档案服务 ====================

export class HostProfileService {
  private profilesDir: string
  private profiles: Map<string, HostProfile> = new Map()

  constructor() {
    const userDataPath = app.getPath('userData')
    this.profilesDir = path.join(userDataPath, 'host-profiles')
    this.ensureDirectory()
    this.loadAllProfiles()
  }

  /**
   * 确保目录存在
   */
  private ensureDirectory(): void {
    if (!fs.existsSync(this.profilesDir)) {
      fs.mkdirSync(this.profilesDir, { recursive: true })
    }
  }

  /**
   * 生成主机 ID
   */
  generateHostId(type: 'local' | 'ssh', sshHost?: string, sshUser?: string): string {
    if (type === 'local') {
      return 'local'
    }
    return `${sshUser || 'unknown'}@${sshHost || 'unknown'}`
  }

  /**
   * 获取档案文件路径
   */
  private getProfilePath(hostId: string): string {
    // 将特殊字符替换为安全字符
    const safeId = hostId.replace(/[@:]/g, '_')
    return path.join(this.profilesDir, `${safeId}.json`)
  }

  /**
   * 加载所有档案
   */
  private loadAllProfiles(): void {
    try {
      const files = fs.readdirSync(this.profilesDir).filter(f => f.endsWith('.json'))
      for (const file of files) {
        const filePath = path.join(this.profilesDir, file)
        const content = fs.readFileSync(filePath, 'utf-8')
        const profile = JSON.parse(content) as HostProfile
        this.profiles.set(profile.hostId, profile)
      }
    } catch (e) {
      console.error('加载主机档案失败:', e)
    }
  }

  /**
   * 保存档案
   */
  private saveProfile(profile: HostProfile): void {
    try {
      const filePath = this.getProfilePath(profile.hostId)
      fs.writeFileSync(filePath, JSON.stringify(profile, null, 2), 'utf-8')
      this.profiles.set(profile.hostId, profile)
    } catch (e) {
      console.error('保存主机档案失败:', e)
    }
  }

  /**
   * 获取档案
   */
  getProfile(hostId: string): HostProfile | null {
    return this.profiles.get(hostId) || null
  }

  /**
   * 获取所有档案
   */
  getAllProfiles(): HostProfile[] {
    return Array.from(this.profiles.values())
  }

  /**
   * 创建或更新档案
   */
  updateProfile(hostId: string, updates: Partial<HostProfile>): HostProfile {
    if (!hostId) {
      console.warn('[HostProfile] updateProfile called with undefined hostId, using "local"')
      hostId = 'local'
    }
    const existing = this.profiles.get(hostId)
    const now = Date.now()

    const profile: HostProfile = {
      hostId,
      hostname: updates.hostname || existing?.hostname || '',
      username: updates.username || existing?.username || '',
      os: updates.os || existing?.os || 'unknown',
      osVersion: updates.osVersion || existing?.osVersion || '',
      shell: updates.shell || existing?.shell || 'unknown',
      packageManager: updates.packageManager || existing?.packageManager,
      installedTools: updates.installedTools || existing?.installedTools || [],
      homeDir: updates.homeDir || existing?.homeDir,
      currentDir: updates.currentDir || existing?.currentDir,
      notes: updates.notes !== undefined ? updates.notes : existing?.notes,
      lastProbed: updates.lastProbed || existing?.lastProbed || now,
      lastUpdated: now
    }

    this.saveProfile(profile)
    return profile
  }

  /**
   * 添加笔记
   */
  addNote(hostId: string, note: string): void {
    const profile = this.profiles.get(hostId)
    if (!profile) {
      // 如果档案不存在，创建一个新档案并添加笔记
      this.updateProfile(hostId, { notes: [note] })
      return
    }

    const notes = profile.notes || []
    notes.push(note)
    profile.notes = notes
    profile.lastUpdated = Date.now()
    this.saveProfile(profile)
  }

  /**
   * 更新已安装工具
   */
  updateInstalledTools(hostId: string, tools: string[]): void {
    const profile = this.profiles.get(hostId)
    if (!profile) return

    // 合并工具列表
    const allTools = new Set([...profile.installedTools, ...tools])
    profile.installedTools = Array.from(allTools)
    profile.lastUpdated = Date.now()
    this.saveProfile(profile)
  }

  /**
   * 删除档案
   */
  deleteProfile(hostId: string): void {
    const filePath = this.getProfilePath(hostId)
    try {
      if (fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      this.profiles.delete(hostId)
    } catch (e) {
      console.error('删除主机档案失败:', e)
    }
  }

  /**
   * 导入档案（用于数据恢复）
   */
  importProfiles(profiles: HostProfile[]): void {
    for (const profile of profiles) {
      // 合并而不是覆盖：保留较新的数据
      const existing = this.profiles.get(profile.hostId)
      if (!existing || (profile.lastUpdated || 0) > (existing.lastUpdated || 0)) {
        this.saveProfile(profile)
      }
    }
  }

  /**
   * 生成探测命令
   */
  getProbeCommands(os: string = 'linux'): string[] {
    const isWindows = os.toLowerCase().includes('windows')
    
    if (isWindows) {
      return [
        'hostname',
        'whoami',
        'echo %OS%',
        'echo %USERPROFILE%',
        'cd',
        // 检测常用工具
        'where git 2>nul && echo [HAS_GIT]',
        'where docker 2>nul && echo [HAS_DOCKER]',
        'where python 2>nul && echo [HAS_PYTHON]',
        'where node 2>nul && echo [HAS_NODE]',
      ]
    }

    // Unix/Linux/macOS/BSD - 使用公共函数
    return getUnixProbeCommands()
  }

  /**
   * 解析探测结果
   */
  parseProbeOutput(output: string, existingProfile?: HostProfile | null): ProbeResult {
    const result: ProbeResult = {}
    const lines = output.split('\n').map(l => l.trim()).filter(l => l)

    // 解析主机名
    const hostnameLine = lines.find(l => !l.includes('=') && !l.startsWith('[') && !l.includes('/'))
    if (hostnameLine && hostnameLine.length < 100) {
      result.hostname = hostnameLine
    }

    // 解析用户名（通常是第二个非标记行）
    const userLine = lines.find((l, i) => i > 0 && !l.includes('=') && !l.startsWith('[') && !l.includes('/') && l !== result.hostname)
    if (userLine && userLine.length < 50) {
      result.username = userLine
    }

    // 解析操作系统
    // 优先检测 Windows 特征（Windows_NT 是 %OS% 的典型输出）
    if (output.includes('Windows_NT') || output.includes('Windows') || output.includes('WINDOWS')) {
      result.os = 'windows'
      // Windows 系统的 shell 检测
      if (output.includes('powershell') || output.includes('PowerShell')) {
        result.shell = 'powershell'
      } else if (output.includes('cmd')) {
        result.shell = 'cmd'
      }
    } else if (output.includes('Darwin')) {
      result.os = 'macos'
    } else if (output.includes('FreeBSD')) {
      result.os = 'freebsd'
    } else if (output.includes('OpenBSD')) {
      result.os = 'openbsd'
    } else if (output.includes('NetBSD')) {
      result.os = 'netbsd'
    } else if (output.includes('DragonFly')) {
      result.os = 'dragonfly'
    } else if (output.includes('AIX')) {
      result.os = 'aix'
    } else if (output.includes('HP-UX')) {
      result.os = 'hpux'
    } else if (output.includes('SunOS')) {
      result.os = 'solaris'
    } else if (output.includes('Linux')) {
      result.os = 'linux'
    }

    // 解析系统版本
    // 优先使用 PRETTY_NAME（如 "Ubuntu 20.04.6 LTS"）
    const prettyNameMatch = output.match(/PRETTY_NAME="([^"]+)"/)
    if (prettyNameMatch) {
      result.osVersion = prettyNameMatch[1]
    } else {
      // 回退到 NAME + VERSION
      const nameMatch = output.match(/NAME="([^"]+)"/)
      const versionMatch = output.match(/VERSION="([^"]+)"/)
      if (nameMatch) {
        result.osVersion = versionMatch 
          ? `${nameMatch[1]} ${versionMatch[1]}`
          : nameMatch[1]
      } else if (output.includes('ProductName')) {
        // macOS
        const productMatch = output.match(/ProductName:\s*(.+)/)
        const versionMatch2 = output.match(/ProductVersion:\s*(.+)/)
        if (productMatch) {
          result.osVersion = `${productMatch[1]} ${versionMatch2?.[1] || ''}`.trim()
        }
      } else if (result.os === 'aix') {
        // AIX: 解析 oslevel 输出（如 "7.2.0.0"）
        const oslevelMatch = output.match(/(\d+\.\d+\.\d+\.\d+)/)
        if (oslevelMatch) {
          result.osVersion = `AIX ${oslevelMatch[1]}`
        }
      } else if (result.os === 'freebsd') {
        // FreeBSD: 解析 freebsd-version 或 uname -r 输出
        const freebsdMatch = output.match(/(\d+\.\d+[-\w]*)/)
        if (freebsdMatch) {
          result.osVersion = `FreeBSD ${freebsdMatch[1]}`
        }
      } else if (result.os === 'openbsd') {
        // OpenBSD: 解析 uname -r 输出
        const openbsdMatch = output.match(/OpenBSD[\s\S]*?(\d+\.\d+)/)
        if (openbsdMatch) {
          result.osVersion = `OpenBSD ${openbsdMatch[1]}`
        }
      } else if (result.os === 'netbsd') {
        // NetBSD: 解析 uname -r 输出
        const netbsdMatch = output.match(/NetBSD[\s\S]*?(\d+\.\d+)/)
        if (netbsdMatch) {
          result.osVersion = `NetBSD ${netbsdMatch[1]}`
        }
      } else if (result.os === 'dragonfly') {
        // DragonFly BSD: 解析 uname -r 输出
        const dragonflyMatch = output.match(/(\d+\.\d+\.\d+)/)
        if (dragonflyMatch) {
          result.osVersion = `DragonFly BSD ${dragonflyMatch[1]}`
        }
      } else if (result.os === 'hpux') {
        // HP-UX: 解析 uname -r 输出
        const hpuxMatch = output.match(/B\.(\d+\.\d+)/)
        if (hpuxMatch) {
          result.osVersion = `HP-UX ${hpuxMatch[1]}`
        }
      } else if (result.os === 'solaris') {
        // Solaris/SunOS: 解析版本
        const solarisMatch = output.match(/(\d+\.\d+)/)
        if (solarisMatch) {
          result.osVersion = `Solaris ${solarisMatch[1]}`
        }
      }
    }

    // 解析 Shell
    const shellLine = lines.find(l => l.includes('/bin/') || l.includes('/usr/'))
    if (shellLine) {
      if (shellLine.includes('zsh')) result.shell = 'zsh'
      else if (shellLine.includes('bash')) result.shell = 'bash'
      else if (shellLine.includes('fish')) result.shell = 'fish'
      else if (shellLine.includes('tcsh')) result.shell = 'tcsh'  // BSD 常用
      else if (shellLine.includes('csh')) result.shell = 'csh'    // BSD 常用
      else if (shellLine.includes('ksh')) result.shell = 'ksh'    // AIX/Solaris 常用
      else if (shellLine.includes('sh')) result.shell = 'sh'
    }

    // 解析主目录
    const homeLine = lines.find(l => l.startsWith('/home/') || l.startsWith('/Users/') || l.startsWith('/root'))
    if (homeLine) {
      result.homeDir = homeLine
    }

    // 解析当前目录
    const pwdLine = lines.find(l => l.startsWith('/') && l !== result.homeDir && !l.includes('bin'))
    if (pwdLine) {
      result.currentDir = pwdLine
    }

    // 解析包管理器
    if (output.includes('[PKG_APT]')) result.packageManager = 'apt'
    else if (output.includes('[PKG_DNF]')) result.packageManager = 'dnf'
    else if (output.includes('[PKG_YUM]')) result.packageManager = 'yum'
    else if (output.includes('[PKG_BREW]')) result.packageManager = 'brew'
    else if (output.includes('[PKG_PACMAN]')) result.packageManager = 'pacman'
    else if (output.includes('[PKG_PKG]')) result.packageManager = 'pkg'        // FreeBSD
    else if (output.includes('[PKG_PKGADD]')) result.packageManager = 'pkg_add' // OpenBSD
    else if (output.includes('[PKG_PKGIN]')) result.packageManager = 'pkgin'    // NetBSD

    // 解析已安装工具
    const tools: string[] = []
    if (output.includes('[HAS_GIT]')) tools.push('git')
    if (output.includes('[HAS_DOCKER]')) tools.push('docker')
    if (output.includes('[HAS_PYTHON3]')) tools.push('python3')
    else if (output.includes('[HAS_PYTHON]')) tools.push('python')
    if (output.includes('[HAS_NODE]')) tools.push('node')
    if (output.includes('[HAS_NGINX]')) tools.push('nginx')
    if (output.includes('[HAS_SYSTEMD]')) tools.push('systemd')
    if (output.includes('[HAS_VIM]')) tools.push('vim')
    if (output.includes('[HAS_NANO]')) tools.push('nano')
    
    if (tools.length > 0) {
      result.installedTools = tools
    }

    return result
  }

  /**
   * 生成用于 System Prompt 的主机信息
   */
  generateHostContext(hostId: string): string {
    const profile = this.profiles.get(hostId)
    if (!profile) {
      return '主机信息: 未知（首次连接，正在探测...）'
    }

    const lines: string[] = ['## 主机信息']
    
    if (profile.hostname) {
      lines.push(`- 主机名: ${profile.hostname}`)
    }
    if (profile.username) {
      lines.push(`- 用户: ${profile.username}`)
    }
    if (profile.osVersion) {
      lines.push(`- 系统: ${profile.osVersion}`)
    } else if (profile.os) {
      lines.push(`- 系统: ${profile.os}`)
    }
    if (profile.shell) {
      lines.push(`- Shell: ${profile.shell}`)
    }
    if (profile.packageManager) {
      lines.push(`- 包管理器: ${profile.packageManager}`)
    }
    if (profile.installedTools.length > 0) {
      lines.push(`- 已安装工具: ${profile.installedTools.join(', ')}`)
    }
    if (profile.currentDir) {
      lines.push(`- 当前目录: ${profile.currentDir}`)
    }

    return lines.join('\n')
  }

  /**
   * 检查是否需要探测
   */
  needsProbe(hostId: string): boolean {
    const profile = this.profiles.get(hostId)
    if (!profile) return true

    // 如果超过 24 小时没有探测，建议重新探测
    const hoursSinceProbe = (Date.now() - profile.lastProbed) / (1000 * 60 * 60)
    return hoursSinceProbe > 24
  }

  /**
   * 后台探测本地主机信息（不在终端显示）
   */
  async probeLocal(): Promise<ProbeResult> {
    const result: ProbeResult = {}
    // 使用多种方式检测 Windows
    const isWindows = process.platform === 'win32' || os.platform() === 'win32' || os.type() === 'Windows_NT'
    
    console.log('[HostProfile] 探测本地主机, platform:', process.platform, 'os.platform:', os.platform(), 'os.type:', os.type(), 'isWindows:', isWindows)
    
    try {
      // 探测主机名（Windows 和 Unix 都支持 hostname 命令）
      const { stdout: hostname } = await execAsync('hostname')
      result.hostname = hostname.trim()
    } catch (e) { 
      console.log('[HostProfile] hostname 探测失败:', e)
    }

    try {
      // 探测用户名（Windows 和 Unix 都支持 whoami 命令）
      const { stdout: username } = await execAsync('whoami')
      result.username = username.trim()
    } catch (e) { 
      console.log('[HostProfile] whoami 探测失败:', e)
    }

    if (isWindows) {
      // Windows 系统探测
      result.os = 'windows'
      
      try {
        // 探测 Windows 版本（使用 PowerShell 避免编码问题）
        const { stdout: ver } = await execAsync('powershell -Command "[System.Environment]::OSVersion.VersionString"')
        result.osVersion = ver.trim()
      } catch {
        // 如果 PowerShell 失败，尝试使用 wmic
        try {
          const { stdout: wmic } = await execAsync('wmic os get Caption,Version /value')
          const captionMatch = wmic.match(/Caption=(.+)/)
          const versionMatch = wmic.match(/Version=(.+)/)
          if (captionMatch) {
            result.osVersion = `${captionMatch[1].trim()} ${versionMatch?.[1]?.trim() || ''}`.trim()
          }
        } catch (e) {
          console.log('[HostProfile] Windows 版本探测失败:', e)
        }
      }

      // 探测 Shell（通过环境变量判断）- 不需要 try-catch，这里不会抛异常
      const comspec = process.env.COMSPEC || ''
      if (comspec.toLowerCase().includes('cmd.exe')) {
        result.shell = 'cmd'
      }
      // 检查是否有 PowerShell 环境变量
      if (process.env.PSModulePath) {
        result.shell = 'powershell'
      }
      // 如果还没设置，默认 cmd
      if (!result.shell) {
        result.shell = 'cmd'
      }

      try {
        // 探测已安装工具 (Windows)
        const tools: string[] = []
        const toolChecks = ['git', 'docker', 'python', 'node', 'npm', 'code']
        for (const tool of toolChecks) {
          try {
            await execAsync(`where ${tool}`)
            tools.push(tool)
          } catch { /* not found */ }
        }
        if (tools.length > 0) {
          result.installedTools = tools
        }
      } catch { /* ignore */ }

      // Windows 主目录
      result.homeDir = process.env.USERPROFILE || os.homedir() || undefined
      
      console.log('[HostProfile] Windows 探测结果:', result)

    } else {
      // Unix/Linux/macOS 系统探测
      try {
        // 探测系统类型
        const { stdout: uname } = await execAsync('uname -s')
        const osName = uname.trim().toLowerCase()
        if (osName.includes('darwin')) result.os = 'macos'
        else if (osName.includes('linux')) result.os = 'linux'
        else result.os = osName
      } catch { /* ignore */ }

      try {
        // 探测 Shell
        const shell = process.env.SHELL || ''
        if (shell.includes('zsh')) result.shell = 'zsh'
        else if (shell.includes('bash')) result.shell = 'bash'
        else if (shell.includes('fish')) result.shell = 'fish'
        else if (shell) result.shell = path.basename(shell)
      } catch { /* ignore */ }

      try {
        // 探测系统版本 (macOS)
        const { stdout: swVers } = await execAsync('sw_vers 2>/dev/null || echo ""')
        if (swVers.includes('ProductName')) {
          const nameMatch = swVers.match(/ProductName:\s*(.+)/)
          const verMatch = swVers.match(/ProductVersion:\s*(.+)/)
          if (nameMatch) {
            result.osVersion = `${nameMatch[1].trim()} ${verMatch?.[1]?.trim() || ''}`.trim()
          }
        }
      } catch { /* ignore */ }

      if (!result.osVersion) {
        try {
          // 探测系统版本 (Linux)
          const { stdout: osRelease } = await execAsync('cat /etc/os-release 2>/dev/null | head -3 || echo ""')
          const nameMatch = osRelease.match(/NAME="?([^"\n]+)"?/)
          const verMatch = osRelease.match(/VERSION="?([^"\n]+)"?/)
          if (nameMatch) {
            result.osVersion = `${nameMatch[1]} ${verMatch?.[1] || ''}`.trim()
          }
        } catch { /* ignore */ }
      }

      try {
        // 探测包管理器
        const pmChecks = [
          { cmd: 'command -v brew', name: 'brew' },
          { cmd: 'command -v apt', name: 'apt' },
          { cmd: 'command -v yum', name: 'yum' },
          { cmd: 'command -v dnf', name: 'dnf' },
          { cmd: 'command -v pacman', name: 'pacman' }
        ]
        for (const pm of pmChecks) {
          try {
            await execAsync(pm.cmd)
            result.packageManager = pm.name
            break
          } catch { /* not found */ }
        }
      } catch { /* ignore */ }

      try {
        // 探测已安装工具
        const tools: string[] = []
        const toolChecks = ['git', 'docker', 'python3', 'node', 'nginx', 'vim', 'nano']
        for (const tool of toolChecks) {
          try {
            await execAsync(`command -v ${tool}`)
            tools.push(tool)
          } catch { /* not found */ }
        }
        if (tools.length > 0) {
          result.installedTools = tools
        }
      } catch { /* ignore */ }

      try {
        // 主目录
        result.homeDir = process.env.HOME || os.homedir() || undefined
      } catch { /* ignore */ }
      
      console.log('[HostProfile] Unix 探测结果:', result)
    }

    console.log('[HostProfile] 最终探测结果:', result)
    return result
  }

  /**
   * 执行本地探测并更新档案
   */
  async probeAndUpdateLocal(): Promise<HostProfile> {
    const probeResult = await this.probeLocal()
    console.log('[HostProfile] probeAndUpdateLocal 探测结果:', probeResult)
    const profile = this.updateProfile('local', {
      ...probeResult,
      lastProbed: Date.now()
    })
    console.log('[HostProfile] probeAndUpdateLocal 更新后档案:', profile)
    return profile
  }
}

