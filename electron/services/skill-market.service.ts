/**
 * 技能市场服务
 * 从远程 registry 获取、安装、更新社区共享的 SKILL.md 技能
 */
import * as fs from 'fs'
import * as path from 'path'
import type { ConfigService } from './config.service'
import type { UserSkillService } from './user-skill.service'

const DEFAULT_REGISTRY_URL = 'https://www.sfterm.com/skill-registry.json'

const SAFE_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/

/** 分类元数据 */
export interface SkillCategory {
  id: string
  name: string
  nameEn: string
  icon: string
}

/** 远程 registry 中的技能元数据 */
export interface MarketSkill {
  id: string
  name: string
  description: string
  version: string
  author: string
  category?: string
  tags?: string[]
  featured?: boolean
  url: string
  size?: number
  createdAt?: string
  updatedAt?: string
}

/** Registry 索引文件格式 */
export interface SkillRegistry {
  version: number
  updated: string
  categories?: SkillCategory[]
  skills: MarketSkill[]
}

/** 市场技能列表项（合并本地安装状态） */
export interface MarketSkillItem extends MarketSkill {
  installed: boolean
  installedVersion?: string
  hasUpdate: boolean
}

/** 操作结果 */
export interface SkillOperationResult {
  success: boolean
  error?: string
}

function validateSkillId(id: string): boolean {
  return SAFE_ID_RE.test(id) && !id.includes('..') && id.length <= 128
}

function assertInsideDir(parent: string, child: string): void {
  const resolvedParent = path.resolve(parent) + path.sep
  const resolvedChild = path.resolve(child)
  if (!resolvedChild.startsWith(resolvedParent)) {
    throw new Error('Path traversal detected')
  }
}

/**
 * 内置 fallback registry，保证离线或网络失败时用户不会看到空白市场。
 * 仅包含元数据，URL 指向 GitHub；若安装时网络不通则安装会失败，但浏览不受影响。
 */
const BUNDLED_REGISTRY: SkillRegistry = {
  version: 2,
  updated: '2026-02-19',
  categories: [
    { id: 'recommended', name: '推荐', nameEn: 'Recommended', icon: '⭐' },
    { id: 'safety', name: '安全', nameEn: 'Safety', icon: '🛡️' },
    { id: 'devops', name: 'DevOps', nameEn: 'DevOps', icon: '🔧' },
    { id: 'ops', name: '运维', nameEn: 'Ops', icon: '🖥️' },
    { id: 'development', name: '开发', nameEn: 'Development', icon: '💻' },
    { id: 'database', name: '数据库', nameEn: 'Database', icon: '🗄️' },
    { id: 'cloud', name: '云服务', nameEn: 'Cloud', icon: '☁️' },
    { id: 'performance', name: '性能调优', nameEn: 'Performance', icon: '⚡' }
  ],
  skills: [
    { id: 'safe-delete-reminder', name: '安全删除提醒', description: '执行 rm、delete 等删除操作前进行二次确认和备份提醒', version: '1.0.0', author: 'sailfish', category: 'safety', tags: ['safety', 'delete', 'rm'], featured: true, url: 'https://www.sfterm.com/skills/safe-delete-reminder/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'git-commit-convention', name: 'Git 提交规范', description: '规范化 Git 提交信息，遵循 Conventional Commits 标准', version: '1.0.0', author: 'sailfish', category: 'devops', tags: ['git', 'commit'], featured: true, url: 'https://www.sfterm.com/skills/git-commit-convention/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'docker-operations', name: 'Docker 操作指南', description: 'Docker 容器管理、镜像操作、compose 编排的最佳实践', version: '1.0.0', author: 'sailfish', category: 'devops', tags: ['docker', 'container', 'compose'], featured: true, url: 'https://www.sfterm.com/skills/docker-operations/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'mysql-operations', name: 'MySQL 运维手册', description: 'MySQL 备份恢复、性能排查、用户权限管理的操作指南', version: '1.0.0', author: 'sailfish', category: 'database', tags: ['mysql', 'database', 'sql'], featured: true, url: 'https://www.sfterm.com/skills/mysql-operations/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'nginx-config', name: 'Nginx 配置助手', description: 'Nginx 反向代理、SSL、性能优化的常用模板', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['nginx', 'proxy', 'ssl'], url: 'https://www.sfterm.com/skills/nginx-config/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'systemd-service', name: 'Systemd 服务管理', description: '创建和管理 systemd 服务单元文件', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['systemd', 'linux', 'service'], url: 'https://www.sfterm.com/skills/systemd-service/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'ssh-security', name: 'SSH 安全加固', description: 'SSH 密钥管理、安全配置、防暴力破解', version: '1.0.0', author: 'sailfish', category: 'safety', tags: ['ssh', 'security', 'firewall'], url: 'https://www.sfterm.com/skills/ssh-security/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'log-analysis', name: '日志分析助手', description: 'Linux 系统和应用日志的查看、过滤、分析技巧', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['log', 'journalctl', 'troubleshoot'], url: 'https://www.sfterm.com/skills/log-analysis/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'python-venv', name: 'Python 环境管理', description: 'Python 虚拟环境、依赖管理、版本切换', version: '1.0.0', author: 'sailfish', category: 'development', tags: ['python', 'venv', 'pip'], url: 'https://www.sfterm.com/skills/python-venv/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'node-project', name: 'Node.js 项目管理', description: 'npm/pnpm 依赖管理、脚本编排、项目初始化', version: '1.0.0', author: 'sailfish', category: 'development', tags: ['nodejs', 'npm', 'pnpm'], url: 'https://www.sfterm.com/skills/node-project/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'backup-strategy', name: '备份策略指南', description: '文件、数据库、配置的自动化备份方案', version: '1.0.0', author: 'sailfish', category: 'safety', tags: ['backup', 'rsync', 'cron'], url: 'https://www.sfterm.com/skills/backup-strategy/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'ssl-certificate', name: 'SSL 证书管理', description: "Let's Encrypt 证书申请、自动续期、多域名配置", version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['ssl', 'letsencrypt', 'certbot'], url: 'https://www.sfterm.com/skills/ssl-certificate/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'firewall-rules', name: '防火墙规则管理', description: 'iptables/ufw/firewalld 规则配置', version: '1.0.0', author: 'sailfish', category: 'safety', tags: ['firewall', 'iptables', 'ufw'], url: 'https://www.sfterm.com/skills/firewall-rules/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'cron-tasks', name: 'Cron 定时任务', description: 'crontab 表达式编写、任务调试、日志监控', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['cron', 'crontab', 'schedule'], url: 'https://www.sfterm.com/skills/cron-tasks/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'git-workflow', name: 'Git 工作流', description: '分支管理策略、merge/rebase 选择、冲突解决', version: '1.0.0', author: 'sailfish', category: 'devops', tags: ['git', 'branch', 'merge'], url: 'https://www.sfterm.com/skills/git-workflow/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'china-mirror-config', name: '国内镜像源配置', description: '一键切换 npm/pip/Docker/apt/yum/Go/Maven/Homebrew/Rust 等工具的国内镜像源，解决下载慢的问题', version: '1.0.0', author: 'sailfish', category: 'recommended', tags: ['mirror', 'npm', 'pip', 'docker', 'china'], featured: true, url: 'https://www.sfterm.com/skills/china-mirror-config/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'redis-operations', name: 'Redis 运维手册', description: 'Redis 数据操作、持久化配置、主从复制、内存分析、慢日志排查、集群管理', version: '1.0.0', author: 'sailfish', category: 'database', tags: ['redis', 'cache', 'database'], featured: true, url: 'https://www.sfterm.com/skills/redis-operations/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'server-init', name: '新服务器初始化', description: 'Linux 云服务器购买后的标准化初始化流程：用户创建、SSH 加固、时区、常用工具、防火墙、swap 配置', version: '1.0.0', author: 'sailfish', category: 'recommended', tags: ['server', 'init', 'linux', 'cloud'], featured: true, url: 'https://www.sfterm.com/skills/server-init/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'k8s-operations', name: 'Kubernetes 运维指南', description: 'Kubernetes 常用操作、Pod 调试、资源排查、HPA 自动扩缩容、ConfigMap/Secret 管理', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['kubernetes', 'k8s', 'container', 'pod'], featured: true, url: 'https://www.sfterm.com/skills/k8s-operations/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'java-deploy', name: 'Java/Spring Boot 部署', description: 'Java 应用构建打包、JVM 调优、systemd 部署、Docker 化部署、常见启动故障排查', version: '1.0.0', author: 'sailfish', category: 'development', tags: ['java', 'spring', 'jvm', 'maven'], url: 'https://www.sfterm.com/skills/java-deploy/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'postgresql-operations', name: 'PostgreSQL 运维手册', description: 'PostgreSQL 备份恢复、用户权限、慢查询分析、连接池配置、性能调优', version: '1.0.0', author: 'sailfish', category: 'database', tags: ['postgresql', 'postgres', 'database', 'sql'], url: 'https://www.sfterm.com/skills/postgresql-operations/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'performance-diagnosis', name: 'Linux 性能诊断工具箱', description: 'CPU、内存、磁盘、网络性能排查的系统化流程，覆盖 top/vmstat/iostat/ss/strace 等工具', version: '1.0.0', author: 'sailfish', category: 'performance', tags: ['performance', 'cpu', 'memory', 'disk', 'diagnose'], featured: true, url: 'https://www.sfterm.com/skills/performance-diagnosis/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'aliyun-cli', name: '阿里云 CLI 操作', description: '阿里云 CLI 安装配置、ECS 管理、OSS 操作、安全组、DNS、SLB 常用命令', version: '1.0.0', author: 'sailfish', category: 'cloud', tags: ['aliyun', 'ecs', 'oss', 'cloud'], url: 'https://www.sfterm.com/skills/aliyun-cli/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'ansible-playbook', name: 'Ansible 批量运维', description: 'Ansible 安装配置、Inventory 管理、常用模块、Playbook 编写、批量操作最佳实践', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['ansible', 'automation', 'playbook'], url: 'https://www.sfterm.com/skills/ansible-playbook/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'ci-cd-pipeline', name: 'CI/CD 流水线配置', description: 'GitHub Actions 与 GitLab CI 流水线配置、自动测试、构建部署、缓存优化', version: '1.0.0', author: 'sailfish', category: 'devops', tags: ['ci', 'cd', 'github-actions', 'gitlab-ci'], url: 'https://www.sfterm.com/skills/ci-cd-pipeline/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'vim-quickstart', name: 'Vim 快速上手', description: 'Vim 模式切换、移动、编辑、搜索替换、多文件操作、常用配置的速查手册', version: '1.0.0', author: 'sailfish', category: 'development', tags: ['vim', 'editor', 'terminal'], url: 'https://www.sfterm.com/skills/vim-quickstart/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' },
    { id: 'network-troubleshoot', name: '网络故障排查', description: 'DNS 解析、TCP 连接、路由追踪、抓包分析、防火墙排查等网络问题诊断流程', version: '1.0.0', author: 'sailfish', category: 'ops', tags: ['network', 'dns', 'tcpdump', 'troubleshoot'], url: 'https://www.sfterm.com/skills/network-troubleshoot/SKILL.md', createdAt: '2026-02-19', updatedAt: '2026-02-19' }
  ]
}

export class SkillMarketService {
  private registryCache: SkillRegistry | null = null
  private cacheTime = 0
  private readonly CACHE_TTL = 5 * 60 * 1000

  constructor(
    private configService: ConfigService,
    private userSkillService: UserSkillService
  ) {}

  getRegistryUrl(): string {
    return this.configService.get('skillMarketRegistryUrl') || DEFAULT_REGISTRY_URL
  }

  setRegistryUrl(url: string): void {
    this.configService.set('skillMarketRegistryUrl', url)
    this.registryCache = null
  }

  private async fetchText(url: string, timeoutMs = 15000): Promise<string> {
    if (url.startsWith('file://')) {
      const filePath = decodeURIComponent(url.slice(7))
      const resolved = path.resolve(filePath)
      if (!fs.existsSync(resolved)) {
        throw new Error(`File not found: ${resolved}`)
      }
      return fs.readFileSync(resolved, 'utf-8')
    }

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    try {
      const response = await fetch(url, {
        signal: controller.signal,
        headers: { 'Accept': 'application/json, text/plain' }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      return await response.text()
    } finally {
      clearTimeout(timer)
    }
  }

  async fetchRegistry(force = false): Promise<SkillRegistry> {
    if (!force && this.registryCache && Date.now() - this.cacheTime < this.CACHE_TTL) {
      return this.registryCache
    }

    const url = this.getRegistryUrl()
    if (!url) {
      throw new Error('Registry URL is not configured')
    }

    try {
      const raw = await this.fetchText(url)
      let registry: SkillRegistry
      try {
        registry = JSON.parse(raw) as SkillRegistry
      } catch {
        throw new Error('Registry is not valid JSON')
      }

      if (!registry.skills || !Array.isArray(registry.skills)) {
        throw new Error('Invalid registry format: missing skills array')
      }

      this.registryCache = registry
      this.cacheTime = Date.now()
      return registry
    } catch (error) {
      // 网络失败时使用内置 fallback，保证用户不会看到空白市场
      if (!this.registryCache) {
        console.warn('[SkillMarket] Remote registry unavailable, using bundled fallback')
        this.registryCache = BUNDLED_REGISTRY
        this.cacheTime = Date.now()
      }
      return this.registryCache
    }
  }

  async listSkills(force = false): Promise<MarketSkillItem[]> {
    const registry = await this.fetchRegistry(force)
    const installed = this.userSkillService.getAllSkills()

    return registry.skills.map(skill => {
      const local = installed.find(s => s.id === skill.id)
      return {
        ...skill,
        installed: !!local,
        installedVersion: local?.version,
        hasUpdate: !!local && !!local.version && local.version !== skill.version
      }
    })
  }

  async searchSkills(query: string): Promise<MarketSkillItem[]> {
    const all = await this.listSkills()
    if (!query.trim()) return all

    const q = query.toLowerCase()
    return all.filter(s =>
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.id.toLowerCase().includes(q) ||
      s.tags?.some(t => t.toLowerCase().includes(q)) ||
      s.category?.toLowerCase().includes(q)
    )
  }

  async getCategories(): Promise<SkillCategory[]> {
    const registry = await this.fetchRegistry()
    return registry.categories || []
  }

  async installSkill(skillId: string): Promise<SkillOperationResult> {
    if (!validateSkillId(skillId)) {
      return { success: false, error: `Invalid skill ID: "${skillId}"` }
    }

    const registry = await this.fetchRegistry()
    const skill = registry.skills.find(s => s.id === skillId)
    if (!skill) {
      return { success: false, error: `Skill "${skillId}" not found in registry` }
    }

    try {
      const content = await this.fetchText(skill.url, 30000)

      if (!content.trim()) {
        return { success: false, error: 'Downloaded file is empty' }
      }

      const skillsDir = this.userSkillService.getSkillsDir()
      const skillDir = path.join(skillsDir, skillId)
      assertInsideDir(skillsDir, skillDir)

      if (!fs.existsSync(skillDir)) {
        fs.mkdirSync(skillDir, { recursive: true })
      }

      const targetPath = path.join(skillDir, 'SKILL.md')
      if (fs.existsSync(targetPath) && fs.lstatSync(targetPath).isSymbolicLink()) {
        fs.unlinkSync(targetPath)
      }
      const tmpPath = targetPath + '.tmp'
      fs.writeFileSync(tmpPath, content, 'utf-8')
      fs.renameSync(tmpPath, targetPath)

      this.userSkillService.refresh()
      console.log(`[SkillMarket] Installed skill: ${skillId} v${skill.version}`)
      return { success: true }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[SkillMarket] Failed to install ${skillId}:`, error)
      return { success: false, error: msg }
    }
  }

  uninstallSkill(skillId: string): SkillOperationResult {
    if (!validateSkillId(skillId)) {
      return { success: false, error: `Invalid skill ID: "${skillId}"` }
    }

    try {
      const skillsDir = this.userSkillService.getSkillsDir()
      const skillDir = path.join(skillsDir, skillId)
      assertInsideDir(skillsDir, skillDir)

      if (fs.existsSync(skillDir) && fs.statSync(skillDir).isDirectory()) {
        fs.rmSync(skillDir, { recursive: true })
        this.userSkillService.refresh()
        console.log(`[SkillMarket] Uninstalled skill: ${skillId}`)
        return { success: true }
      }

      const skillFile = path.join(skillsDir, `${skillId}.md`)
      assertInsideDir(skillsDir, skillFile)
      if (fs.existsSync(skillFile)) {
        fs.unlinkSync(skillFile)
        this.userSkillService.refresh()
        console.log(`[SkillMarket] Uninstalled skill: ${skillId}`)
        return { success: true }
      }

      return { success: false, error: `Skill "${skillId}" not found locally` }
    } catch (error) {
      const msg = error instanceof Error ? error.message : 'Unknown error'
      console.error(`[SkillMarket] Failed to uninstall ${skillId}:`, error)
      return { success: false, error: msg }
    }
  }

  async updateSkill(skillId: string): Promise<SkillOperationResult> {
    return this.installSkill(skillId)
  }
}

let instance: SkillMarketService | null = null

export function getSkillMarketService(
  configService: ConfigService,
  userSkillService: UserSkillService
): SkillMarketService {
  if (!instance) {
    instance = new SkillMarketService(configService, userSkillService)
  }
  return instance
}
