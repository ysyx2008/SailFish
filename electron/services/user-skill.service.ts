/**
 * 用户技能服务
 * 管理用户自定义的 SKILL.md 文件，支持 Claude Skill 标准
 */
import { app, shell } from 'electron'
import * as fs from 'fs'
import * as path from 'path'

/**
 * 用户技能定义
 */
export interface UserSkill {
  /** 技能 ID（目录名或文件名，不含扩展名） */
  id: string
  /** 技能名称 */
  name: string
  /** 技能描述 */
  description: string
  /** 版本号 */
  version?: string
  /** 是否启用 */
  enabled: boolean
  /** 技能内容（Markdown 正文，不含 frontmatter） */
  content: string
  /** 文件路径 */
  filePath: string
  /** 最后修改时间 */
  lastModified: number
}

/**
 * YAML Frontmatter 解析结果
 */
interface SkillFrontmatter {
  name?: string
  description?: string
  version?: string
  enabled?: boolean
}

/**
 * 用户技能服务类
 */
export class UserSkillService {
  private skillsDir: string
  private cachedSkills: UserSkill[] | null = null

  constructor() {
    // 使用 app.getPath('userData') 获取用户数据目录
    this.skillsDir = path.join(app.getPath('userData'), 'skills')
    this.ensureSkillsDir()
  }

  /**
   * 确保 skills 目录存在
   */
  private ensureSkillsDir(): void {
    if (!fs.existsSync(this.skillsDir)) {
      fs.mkdirSync(this.skillsDir, { recursive: true })
      console.log(`[UserSkill] Created skills directory: ${this.skillsDir}`)
    }
  }

  /**
   * 获取 skills 目录路径
   */
  getSkillsDir(): string {
    return this.skillsDir
  }

  /**
   * 在系统文件管理器中打开 skills 目录
   */
  async openSkillsFolder(): Promise<void> {
    this.ensureSkillsDir()
    await shell.openPath(this.skillsDir)
  }

  /**
   * 解析 YAML frontmatter
   * 格式: ---\nkey: value\n---
   */
  private parseFrontmatter(content: string): { frontmatter: SkillFrontmatter; body: string } {
    // 支持有内容或无内容的情况
    const frontmatterRegex = /^---\s*\n([\s\S]*?)\n---\s*(?:\n([\s\S]*))?$/
    const match = content.match(frontmatterRegex)

    if (!match) {
      // 没有 frontmatter，整个内容作为 body
      return { frontmatter: {}, body: content }
    }

    const yamlStr = match[1]
    const body = match[2] || '' // 可能没有 body

    // 简单的 YAML 解析（只支持 key: value 格式）
    const frontmatter: SkillFrontmatter = {}
    const lines = yamlStr.split('\n')

    for (const line of lines) {
      const colonIndex = line.indexOf(':')
      if (colonIndex > 0) {
        const key = line.substring(0, colonIndex).trim().toLowerCase()
        let value = line.substring(colonIndex + 1).trim()
        
        // 移除引号
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
          value = value.slice(1, -1)
        }

        switch (key) {
          case 'name':
            frontmatter.name = value
            break
          case 'description':
            frontmatter.description = value
            break
          case 'version':
            frontmatter.version = value
            break
          case 'enabled':
            frontmatter.enabled = value.toLowerCase() !== 'false'
            break
        }
      }
    }

    return { frontmatter, body }
  }

  /**
   * 扫描 skills 目录，解析所有 SKILL.md 文件
   */
  scanSkills(): UserSkill[] {
    this.ensureSkillsDir()
    const skills: UserSkill[] = []

    try {
      const entries = fs.readdirSync(this.skillsDir, { withFileTypes: true })

      for (const entry of entries) {
        const entryPath = path.join(this.skillsDir, entry.name)

        if (entry.isDirectory()) {
          // 目录形式：查找 SKILL.md
          const skillMdPath = path.join(entryPath, 'SKILL.md')
          if (fs.existsSync(skillMdPath)) {
            const skill = this.parseSkillFile(entry.name, skillMdPath)
            if (skill) {
              skills.push(skill)
            }
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          // 文件形式：直接解析 .md 文件
          const skill = this.parseSkillFile(
            entry.name.replace(/\.md$/, ''),
            entryPath
          )
          if (skill) {
            skills.push(skill)
          }
        }
      }
    } catch (error) {
      console.error('[UserSkill] Error scanning skills directory:', error)
    }

    // 按名称排序
    skills.sort((a, b) => a.name.localeCompare(b.name))
    
    // 缓存结果
    this.cachedSkills = skills
    
    console.log(`[UserSkill] Scanned ${skills.length} skills`)
    return skills
  }

  /**
   * 解析单个技能文件
   */
  private parseSkillFile(id: string, filePath: string): UserSkill | null {
    try {
      const content = fs.readFileSync(filePath, 'utf-8')
      const stats = fs.statSync(filePath)
      const { frontmatter, body } = this.parseFrontmatter(content)

      return {
        id,
        name: frontmatter.name || id,
        description: frontmatter.description || '',
        version: frontmatter.version,
        enabled: frontmatter.enabled !== false, // 默认启用
        content: body.trim(),
        filePath,
        lastModified: stats.mtimeMs
      }
    } catch (error) {
      console.error(`[UserSkill] Error parsing skill file ${filePath}:`, error)
      return null
    }
  }

  /**
   * 获取所有技能（使用缓存）
   */
  getAllSkills(): UserSkill[] {
    if (this.cachedSkills === null) {
      return this.scanSkills()
    }
    return this.cachedSkills
  }

  /**
   * 获取已启用的技能
   */
  getEnabledSkills(): UserSkill[] {
    return this.getAllSkills().filter(s => s.enabled)
  }

  /**
   * 获取单个技能
   */
  getSkill(skillId: string): UserSkill | undefined {
    return this.getAllSkills().find(s => s.id === skillId)
  }

  /**
   * 获取技能完整内容
   */
  getSkillContent(skillId: string): string | null {
    const skill = this.getSkill(skillId)
    if (!skill) {
      return null
    }

    // 重新读取文件以确保内容是最新的
    try {
      const content = fs.readFileSync(skill.filePath, 'utf-8')
      const { body } = this.parseFrontmatter(content)
      return body.trim()
    } catch (error) {
      console.error(`[UserSkill] Error reading skill content:`, error)
      return skill.content
    }
  }

  /**
   * 启用/禁用技能
   */
  toggleSkill(skillId: string, enabled: boolean): boolean {
    const skill = this.getSkill(skillId)
    if (!skill) {
      console.warn(`[UserSkill] Skill not found: ${skillId}`)
      return false
    }

    try {
      // 读取原始文件内容
      const originalContent = fs.readFileSync(skill.filePath, 'utf-8')
      
      // 检查是否有 frontmatter
      const frontmatterRegex = /^(---\s*\n)([\s\S]*?)(\n---)/
      const match = originalContent.match(frontmatterRegex)
      
      let newContent: string
      
      if (match) {
        // 有 frontmatter，更新或添加 enabled 字段
        const yamlContent = match[2]
        const enabledRegex = /^enabled\s*:\s*.*/m
        
        if (enabledRegex.test(yamlContent)) {
          // 更新已有的 enabled 字段
          const newYaml = yamlContent.replace(enabledRegex, `enabled: ${enabled}`)
          newContent = originalContent.replace(frontmatterRegex, `$1${newYaml}$3`)
        } else {
          // 添加 enabled 字段
          const newYaml = yamlContent.trimEnd() + `\nenabled: ${enabled}`
          newContent = originalContent.replace(frontmatterRegex, `$1${newYaml}$3`)
        }
      } else {
        // 没有 frontmatter，添加一个
        newContent = `---\nenabled: ${enabled}\n---\n\n${originalContent}`
      }

      // 写回文件
      fs.writeFileSync(skill.filePath, newContent, 'utf-8')

      // 清除缓存以强制重新扫描
      this.cachedSkills = null

      console.log(`[UserSkill] Toggled skill ${skillId} to ${enabled ? 'enabled' : 'disabled'}`)
      return true
    } catch (error) {
      console.error(`[UserSkill] Error toggling skill ${skillId}:`, error)
      return false
    }
  }

  /**
   * 构建技能摘要列表（用于渐进式加载）
   * 只返回技能的 ID、名称和描述，不包含完整内容
   */
  buildSkillsSummary(): string {
    const enabledSkills = this.getEnabledSkills()
    
    if (enabledSkills.length === 0) {
      return ''
    }

    const sections: string[] = []
    sections.push('## 用户技能')
    sections.push('')
    sections.push('以下是用户定义的技能。当任务涉及相关领域时，使用 `load_user_skill` 工具加载完整内容：')
    sections.push('')

    for (const skill of enabledSkills) {
      const desc = skill.description ? ` - ${skill.description}` : ''
      sections.push(`- \`${skill.id}\`: **${skill.name}**${desc}`)
    }
    
    sections.push('')
    sections.push('**使用方式**：`load_user_skill("技能ID")` 获取完整技能内容后，按照其中的指导执行任务。')

    return sections.join('\n')
  }

  /**
   * 构建 prompt 注入内容（完整版，保留用于向后兼容）
   * 将已启用的技能格式化为 system prompt 片段
   * @deprecated 请使用 buildSkillsSummary() 实现渐进式加载
   */
  buildPromptInjection(): string {
    const enabledSkills = this.getEnabledSkills()
    
    if (enabledSkills.length === 0) {
      return ''
    }

    const sections: string[] = []
    sections.push('## 用户技能')
    sections.push('')
    sections.push('以下是用户定义的技能，请在相关场景下参考使用：')
    sections.push('')

    for (const skill of enabledSkills) {
      sections.push(`### ${skill.name}`)
      if (skill.description) {
        sections.push(`> ${skill.description}`)
        sections.push('')
      }
      sections.push(skill.content)
      sections.push('')
    }

    return sections.join('\n')
  }

  /**
   * 刷新技能列表（清除缓存并重新扫描）
   */
  refresh(): UserSkill[] {
    this.cachedSkills = null
    return this.scanSkills()
  }

  /**
   * 复制 skills 目录到指定路径（用于备份）
   */
  copySkillsTo(destPath: string): { success: boolean; count: number; error?: string } {
    try {
      this.ensureSkillsDir()
      
      // 检查源目录是否为空
      const entries = fs.readdirSync(this.skillsDir)
      if (entries.length === 0) {
        return { success: true, count: 0 }
      }

      // 创建目标目录
      if (!fs.existsSync(destPath)) {
        fs.mkdirSync(destPath, { recursive: true })
      }

      let count = 0
      
      // 递归复制
      const copyRecursive = (src: string, dest: string) => {
        const stats = fs.statSync(src)
        
        if (stats.isDirectory()) {
          if (!fs.existsSync(dest)) {
            fs.mkdirSync(dest, { recursive: true })
          }
          const items = fs.readdirSync(src)
          for (const item of items) {
            copyRecursive(path.join(src, item), path.join(dest, item))
          }
        } else {
          fs.copyFileSync(src, dest)
          count++
        }
      }

      for (const entry of entries) {
        copyRecursive(
          path.join(this.skillsDir, entry),
          path.join(destPath, entry)
        )
      }

      console.log(`[UserSkill] Copied ${count} files to ${destPath}`)
      return { success: true, count }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Copy failed'
      console.error('[UserSkill] Error copying skills:', error)
      return { success: false, count: 0, error: errorMsg }
    }
  }

  /**
   * 从指定路径导入 skills（用于恢复备份）
   * 同名 skill 保留现有，不覆盖
   */
  importSkillsFrom(srcPath: string): { success: boolean; imported: number; skipped: number; error?: string } {
    try {
      if (!fs.existsSync(srcPath)) {
        return { success: true, imported: 0, skipped: 0 }
      }

      this.ensureSkillsDir()

      const entries = fs.readdirSync(srcPath, { withFileTypes: true })
      let imported = 0
      let skipped = 0

      for (const entry of entries) {
        const srcEntryPath = path.join(srcPath, entry.name)
        const destEntryPath = path.join(this.skillsDir, entry.name)

        // 如果目标已存在，跳过
        if (fs.existsSync(destEntryPath)) {
          console.log(`[UserSkill] Skipped existing: ${entry.name}`)
          skipped++
          continue
        }

        // 复制
        if (entry.isDirectory()) {
          this.copyDirRecursive(srcEntryPath, destEntryPath)
        } else {
          fs.copyFileSync(srcEntryPath, destEntryPath)
        }
        imported++
      }

      // 清除缓存
      this.cachedSkills = null

      console.log(`[UserSkill] Imported ${imported}, skipped ${skipped}`)
      return { success: true, imported, skipped }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Import failed'
      console.error('[UserSkill] Error importing skills:', error)
      return { success: false, imported: 0, skipped: 0, error: errorMsg }
    }
  }

  /**
   * 递归复制目录
   */
  private copyDirRecursive(src: string, dest: string): void {
    fs.mkdirSync(dest, { recursive: true })
    const items = fs.readdirSync(src, { withFileTypes: true })
    
    for (const item of items) {
      const srcPath = path.join(src, item.name)
      const destPath = path.join(dest, item.name)
      
      if (item.isDirectory()) {
        this.copyDirRecursive(srcPath, destPath)
      } else {
        fs.copyFileSync(srcPath, destPath)
      }
    }
  }
}

// 单例实例
let userSkillServiceInstance: UserSkillService | null = null

/**
 * 获取 UserSkillService 实例
 */
export function getUserSkillService(): UserSkillService {
  if (!userSkillServiceInstance) {
    userSkillServiceInstance = new UserSkillService()
  }
  return userSkillServiceInstance
}
