# Skill Market Service SPEC

> Last verified: 2026-08-13

## 职责

技能市场客户端。从 SailFish 官方注册表、ClawHub 社区和国内 SkillHub 获取技能，提供搜索、预览、安装、更新、卸载流程，并扫描技能内容安全性。支持本地 `.md` 文件的技能导入。

## 设计目标

### 技能搜索增加国内的 SkillHub（2026-10-17）

助手搜技能时，除了官方技能市场和国外的 ClawHub，也搜国内的 SkillHub（skillhub.cn）。默认三处一起搜，也可以只搜其中一处。某一处暂时搜不到，不影响另外两处的结果。

搜到的技能可以预览、安装。同名技能按作者区分，不会装成另一份，也不会盖掉已经装好的别的技能。装上之后能看出是从 SkillHub 来的。社区技能市场关闭时，SkillHub 与 ClawHub 一样不可用。某一处暂时连不上时，会说明是哪一处不可用，另外两处的结果照常返回。

### 本地预览认技能名，也认独立文件（2026-08-13）

已安装的技能有两种形态：文件夹，或单独一个 markdown 文件。助手预览时常常只带技能名，有时还会写成 `/技能名`。这两种写法都应该打开这份已安装技能，不能当成系统根目录下的路径然后报找不到。

从磁盘导入时，独立 markdown、zip、技能文件夹都要能预览。已经是独立文件的旧技能不要自动改成文件夹。

成功标准：用技能 ID（带或不带前导斜杠）能预览已安装的独立文件技能；把独立 markdown 路径交给预览也能读出内容。

明确不做：不强制把已有独立文件升级成文件夹。

## 文件 / 规模

单文件：`electron/services/skill-market.service.ts`（~912 行）

## 公开 API

| 方法签名 | 用途 | 主要调用方 |
|---------|------|-----------|
| `getRegistryUrl(): string` | 获取当前注册表 URL | UI |
| `setRegistryUrl(url): void` | 切换注册表地址 | 设置页 |
| `async fetchRegistry(force?): Promise<SkillRegistry>` | 拉取注册表元数据 | 初始化/ls 前 |
| `async listSkills(force?): Promise<MarketSkillItem[]>` | 列出所有技能（含安装状态） | 市场页 |
| `async searchSkills(query): Promise<MarketSkillItem[]>` | 按关键词搜索技能 | 市场搜索 |
| `async getCategories(): Promise<SkillCategory[]>` | 获取技能分类列表 | 市场分类 |
| `async installSkill(skillId): Promise<SkillOperationResult>` | 安装技能（从注册表） | 市场/CLI |
| `uninstallSkill(skillId): SkillOperationResult` | 卸载技能 | 市场/CLI |
| `async updateSkill(skillId): Promise<SkillOperationResult>` | 更新已安装技能 | 更新检查 |
| `async searchClawHub(query): Promise<MarketSkill[]>` | 搜索 ClawHub 社区技能 | 社区市场 |
| `async previewSkill(skillId, source?): Promise<SkillPreviewResult>` | 预览技能内容（含安全扫描） | 安装前预览 |
| `async installClawHubSkill(skillId): Promise<SkillOperationResult>` | 安装 ClawHub 技能 | 社区市场 |
| `previewLocalSkill(localPath): SkillPreviewResult` | 预览本地技能文件 | 本地导入 |
| `installLocalSkillFiles(skillId, filesMap): SkillOperationResult` | 安装本地技能文件 | 本地导入 |
| `installSkillFromContent(skillId, content, meta?): SkillOperationResult` | 从内容字符串直接安装 | 编程接口 |

## 核心类型 / 接口

```ts
type SkillSource = "sailfish" | "clawhub" | "skillhub"
interface SkillCategory { id, name, nameEn, icon }
interface MarketSkill {
  id, name, description, version, author, source
  category?, tags?, featured?, url, size?, permissions?
  createdAt?, updatedAt?
}
interface MarketSkillItem extends MarketSkill { installed, installedVersion?, hasUpdate }
interface SkillOperationResult { success: boolean; error?: string }
interface SkillPreviewResult {
  success: boolean; skill?: MarketSkill; content?: string
  scan?: SecurityScanResult; files?: string[]; error?: string
}
interface SecurityScanResult { safe: boolean; warnings: SecurityWarning[] }
interface SecurityWarning {
  type: "hidden_content" | "encoding_obfuscation"
  description: string; evidence: string
}
```

## 依赖（跨 service）

| 服务 | 关系 | 说明 |
|------|:----:|------|
| `ConfigService` | **必需** | 获取注册表 URL |
| `UserSkillService` | **必需** | 安装/卸载/管理本地技能文件 |

## 关键行为 / 数据流

**远程安装流程**：
1. `fetchRegistry` 拉取注册表 JSON → 缓存 `CACHE_TTL` 时间
2. `previewSkill` → 获取 `SKILL.md` 内容 → `SecurityScan` 扫描 → 返回预览
3. `installSkill` → 下载 skill 文件 → 写入 `~/.sailfish/skills/{id}/` → 调用 `UserSkillService`

**安全扫描**：`scanSkillContent` 只检测展示层结构隐蔽信号（零宽字符、RTL 覆盖、大块 HTML 注释），结果是**线索不是判决**。语义风险（外泄、注入、恶意脚本）由 Agent 审阅 `skill_preview` 返回的正文后判断；安装路径不做关键词硬拦。有附属文件或结构线索时，`skill_market_install` / `skill_install_local` 会请求用户确认。所有公开 `install*` 方法安装前会 `logStructuralHints`（仅记日志，不拒绝）。

**本地导入**：`previewLocalSkill` 读目录内所有文件 → `installLocalSkillFiles` 写入 skills 目录

## 关键约束

- **安装前须有预览扫描结果供 Agent 审阅**——`skill_market_install` / `skill_install_local` 内部会先 `preview*`；语义放行权在 Agent +（有执行面/隐蔽线索时）用户确认
- **不做关键词语义硬拦**——禁止用 env/网络/prompt 等正则猜测意图并拒绝安装
- **注册表缓存不得跨实例共享**——`CACHE_TTL` 按实例计算，不得静态化
- **技能文件大小限制**：`MAX_SKILL_SIZE` + `MAX_SINGLE_FILE_SIZE`，超限拒绝安装
- **安装路径必须在 `UserSkillService.getSkillsDir()` 内**——`assertInsideDir` 检查，防路径遍历攻击
