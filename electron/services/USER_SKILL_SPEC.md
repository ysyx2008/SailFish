# User Skill Service SPEC

> Last verified: 2026-05-07

## 职责

用户自定义技能（Skill）管理。扫描 `skills/` 目录下的 Markdown 文件，解析 frontmatter 元数据，提供启用/禁用、内容注入 Prompt、导入导出等功能。技能是 Agent 能力扩展的轻量级机制。

## 文件 / 规模

单文件：`electron/services/user-skill.service.ts`（~633 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `getSkillsDir(): string` | 返回技能目录路径 | `skill-market.service.ts` |
| `async openSkillsFolder(): Promise<void>` | 在文件管理器中打开技能目录 | 前端"打开文件夹"按钮 |
| `scanSkills(): UserSkill[]` | 扫描所有技能文件（目录扫描） | 初始加载 |
| `getAllSkills(): UserSkill[]` | 获取所有技能（缓存优先） | `agent/index.ts` |
| `getEnabledSkills(): UserSkill[]` | 获取已启用的技能 | Prompt 构建 |
| `getSkill(skillId: string): UserSkill \| undefined` | 按 ID 获取单个技能 | `skill-market.service.ts` |
| `getSkillContent(skillId: string): string \| null` | 读取技能 Markdown 正文 | 技能预览 |
| `toggleSkill(skillId, enabled): boolean` | 启用/禁用技能 | 前端技能开关 |
| `buildSkillsSummary(): string` | 生成技能摘要（用于 Agent 系统提示） | `agent/index.ts` |
| `buildPromptInjection(): string` | 生成完整技能内容注入（拼接所有已启用技能） | Agent Prompt 构建 |
| `refresh(): UserSkill[]` | 强制刷新缓存（重扫目录） | 技能安装/卸载后 |
| `copySkillsTo(destPath): {success, count, error?}` | 导出技能到目标目录 | 备份 |
| `importSkillsFrom(srcPath): {success, imported, skipped, error?}` | 从源目录导入技能 | 迁移/分享 |

## 核心类型 / 接口

### UserSkill
```ts
interface UserSkill {
  id: string, name: string, description: string
  version?: string, enabled: boolean
  content: string, filePath: string, baseDir: string
  lastModified: number
  source?: "sailfish" | "clawhub" | "skillhub", author?: string
  permissions?: string[], commands?: string[]
  requires?: { bins?: string[], env?: string[] }
  files?: string[]
}
```

### SkillFrontmatter
Markdown frontmatter 解析结果：`{ name?, description?, version?, enabled?, author?, source?, permissions?, commands?, metadata? }`

## 依赖（跨 service）

无跨 service 依赖。纯文件扫描 + frontmatter 解析。

## 关键行为 / 数据流

**技能加载流程**：
1. `scanSkills()` → 遍历 `skills/` 目录 → 每个 `.md` 文件一个技能
2. 解析 YAML frontmatter → `SkillFrontmatter`
3. 包装为 `UserSkill` → 缓存到 `cachedSkills`
4. `buildPromptInjection()` → 拼接所有已启用技能的 body 内容 → 注入 Agent 系统提示

**技能格式**：
```markdown
---
name: 技能名称
description: 简短描述
version: "1.0"
permissions: [exec, file_read]
---
技能正文内容...
```

## 关键约束

- **技能文件必须是以 `---` frontmatter 分隔的 Markdown**
- **`buildPromptInjection` 只注入已启用（`enabled: true`）的技能**，禁用技能不出现在 Prompt 中
- **技能正文不得包含 Markdown 代码块嵌套**（防止 Prompt 注入混乱）
- **`refresh()` 被调用后必须失效所有缓存**
- **技能文件编码必须为 UTF-8**
