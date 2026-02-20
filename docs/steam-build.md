# Steam 版本说明

本文档说明通过 Steam 分发的「旗鱼终端」构建与普通版本的区别，以及构建与上架注意事项。

## 定位

- **Steam 版**：以**终端、SSH、文件管理**为核心功能的产品；不提供任何「用户自行配置 AI / 填写 API Key / 选择外部大模型」的入口，以满足 Steam 审核对「不依赖玩家自建或第三方付费服务」的要求。
- **普通版**：功能完整，支持用户自行配置多种 AI 服务（含 API Key、Ollama、自定义端点等）。

两版通过**构建时**环境变量区分，仅 Steam 专用构建脚本会打开 Steam 模式，普通构建不受影响。

## 构建与开发

**开发时本地跑 Steam 版界面**（无 AI 配置、2 步向导等）：

```bash
npm run dev:steam
```

**打 Steam 用包**时使用以下脚本（会设置 `VITE_STEAM_BUILD=true`）：

```bash
# 当前平台
npm run build:steam:current

# 指定平台
npm run build:steam:win
npm run build:steam:mac
npm run build:steam:linux
```

产物在对应平台的 `dist/` 目录下，可用于 Steam 上传，**不要**与普通渠道的安装包混用。

## Steam 版与普通版的差异

| 项目           | 普通版                         | Steam 版                                       |
|----------------|--------------------------------|------------------------------------------------|
| 设置 · AI 模型 | 完整配置（添加/编辑、API Key、模板等） | 仅显示一句说明：不提供 AI 配置，可使用终端/SSH/文件管理 |
| 设置 · 左侧标签 | 含「AI 模型配置」               | 不显示「AI 模型配置」标签，默认打开「主题」等     |
| 首次引导步骤   | 3 步：欢迎 → 配置大模型 → 完成  | 2 步：欢迎 → 完成（无「配置大模型」）           |
| 完成页文案     | AI 功能已就绪等                | Steam 专用文案（准备就绪 / 终端·SSH·文件管理）   |

后端与其它设置（主题、终端、数据、语言、关于等）在两版中一致；仅「AI 配置相关入口」在 Steam 版中被隐藏或替换为说明文案。

## 实现方式（开发参考）

- 前端通过 `import.meta.env.VITE_STEAM_BUILD === 'true'` 判断是否为 Steam 构建。
- 涉及文件：
  - `src/components/Settings/AiSettings.vue`：Steam 时只渲染说明区块，不渲染配置表单与 API Key。
  - `src/components/Settings/SettingsModal.vue`：Steam 时从侧边栏去掉「AI 模型配置」、默认 tab 改为非 AI。
  - `src/components/SetupWizard.vue`：Steam 时总步数为 2，跳过「配置大模型」，完成页使用 Steam 文案。
- 文案 key：`aiSettings.steamNoAiConfig`、`setup.complete.steamReady` / `steamReadyDesc`（见 `src/i18n/locales/`）。

## 上架与审核

1. **提交前**：务必用 `npm run build:steam:*` 打出**新构建**再上传，避免重复提交同一 BuildID。
2. **商店与系统要求**：建议在商店页写清「以终端/SSH/文件管理为主」；SteamOS + Linux 需填写最低存储等系统要求。
3. **AI 问卷**：若商店或审核要求填写 AI 相关问卷，可说明：Steam 版不提供用户可配置的 AI 或第三方 API，无实时生成 AI 内容依赖，核心为本地终端与连接管理。
4. **审核沟通**：可说明「本产品在 Steam 上销售的是终端与连接管理功能；Steam 版本不包含任何需要用户自行配置或付费的第三方 AI/API 入口。」

## 常见问题

- **Steam 版能否用 AI？**  
  当前 Steam 版不提供任何 AI 配置界面或 API Key 输入；用户只能使用终端、SSH、文件管理等不依赖第三方 API 的功能。

- **普通版会受影响吗？**  
  不会。仅在 `VITE_STEAM_BUILD=true` 的构建中启用上述逻辑，普通 `npm run build` 行为不变。

- **CI 里如何打 Steam 包？**  
  使用 `.github/workflows/steam-build.yml` 中已有脚本，或在 CI 中设置环境变量 `VITE_STEAM_BUILD=true` 后执行对应 `build:steam:*` 命令。
