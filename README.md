# 旗鱼终端

[English](./README_EN.md) | 中文

> AI 驱动的跨平台终端，助力运维提效

🌐 **官方网站**：[www.sfterm.com](http://www.sfterm.com/)

## 产品介绍

旗鱼终端是一款面向运维工程师和开发者的现代化终端工具。它将传统终端的强大功能与AI智能助手深度融合，让命令行操作变得更加高效、智能。

遇到不熟悉的命令？让AI帮你解释。
看到报错信息一头雾水？AI帮你分析原因并给出解决方案。
想要执行某个操作但不知道命令？用自然语言描述，AI为你生成。

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-welcome.png" width="900" alt="旗鱼终端欢迎页面">
</p>

对于企业用户，旗鱼终端充分考虑了内网环境的需求：支持配置私有化部署的 AI 模型，可以一键导入 Xshell 会话配置，让团队快速上手、平滑迁移。

## 功能特性

### 终端功能
- 🖥️ **跨平台支持**：Windows、macOS、Linux 全平台覆盖
- 🔐 **SSH 管理**：支持密码和私钥认证
- 📂 **会话分组**：灵活的分组管理，支持分组级跳板机配置
  - 创建、编辑、删除分组
  - 每个分组可配置独立跳板机，组内会话自动通过跳板机连接
  - 会话拖拽排序
- 📥 **Xshell 导入**：一键导入 Xshell 会话配置，快速迁移
- 🎨 **丰富主题**：内置多款精美配色方案
- ⚡ **高性能**：基于 xterm.js，流畅的终端体验

### AI Agent 模式

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-agent-exec.png" width="900" alt="AI Agent 执行">
</p>

- 🤖 **自动化任务执行**：描述任务，Agent 自动规划并执行多步命令
- 🎭 **Agent 性格系统**：支持 16 种 MBTI 性格类型，自定义 Agent 回复风格
  - INTJ、INTP、ENTJ、ENTP（理性主义者）
  - INFJ、INFP、ENFJ、ENFP（理想主义者）
  - ISTJ、ISFJ、ESTJ、ESFJ（护卫者）
  - ISTP、ISFP、ESTP、ESFP（技艺者）
- 🔧 **丰富的工具集**：
  - `execute_command` - 执行 shell 命令，支持 top/htop/watch/tail -f 等实时命令
  - `get_terminal_context` - 获取终端输出，查看命令执行结果
  - `send_control_key` - 发送控制键（Ctrl+C/D/Z 等），处理卡住的命令
  - `read_file` / `write_file` - 文件读写操作
  - `remember_info` - 记住关键信息，跨会话记忆
  - `search_knowledge` - 搜索本地知识库文档
- 🔌 **MCP 扩展**：支持 Model Context Protocol，可接入外部工具和资源
- ⚠️ **严格模式**：危险命令执行前需要用户确认，默认开启
- ⏱️ **命令超时控制**：可配置命令执行超时时间，避免长时间等待
- 📜 **任务历史**：记录每次 Agent 任务的执行过程和结果

### MCP 扩展能力
- 🔗 **协议支持**：完整支持 Model Context Protocol (MCP) 标准
- 🚀 **多种传输**：支持 stdio 和 SSE 两种传输模式
- 🧩 **能力聚合**：自动聚合多个 MCP 服务器的工具、资源和提示模板
- 📦 **预设模板**：内置 Filesystem、GitHub、PostgreSQL 等常用 MCP 服务器配置模板
- 🎛️ **可视化管理**：图形化界面配置和管理 MCP 服务器连接

### AI 对话能力

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-analyse.png" width="900" alt="AI 对话">
</p>

- 💬 **智能对话**：命令解释、错误诊断、自然语言生成命令，流式响应实时输出
- 📊 **终端内容分析**：选中终端输出，右键一键分析，快速定位问题
- 📄 **文档上传**：上传 PDF、Word、文本等文档作为 AI 上下文，让 AI 结合文档内容回答问题
- 🧠 **主机记忆**：自动探测主机信息，跨会话记忆关键路径和配置，让 AI 更了解你的环境
- 📈 **上下文统计**：实时显示 Token 使用量和上下文占比，避免超出限制

### 企业特性
- 🏢 **内网友好**：支持配置内网 AI API 和 HTTP/SOCKS 代理
- 🔒 **数据安全**：所有数据本地存储，支持私有化部署的 AI 模型

### 本地知识库 (RAG)
- 📚 **文档导入**：支持 PDF、Word、TXT、Markdown 等格式文档
- 🧠 **本地 Embedding**：内置轻量级向量模型，完全离线运行，无需外部 API
- 🔍 **语义搜索**：基于向量相似度的智能检索，理解文档语义
- 📖 **智能分块**：支持多种分块策略（固定长度/段落/语义）
- 📊 **重排序优化**：可选 Rerank 模型优化搜索结果排序
- 💾 **向量存储**：基于 LanceDB 的高效本地向量数据库
- 🔗 **Agent 集成**：知识库与 Agent 深度集成，自动检索相关文档辅助回答

### 文件管理
- 📁 **双栏文件管理器**：独立窗口的双面板文件管理器
  - 左右双栏布局，支持本地与远程文件操作
  - 目录树导航，快速定位
  - 文件预览，文本文件在线查看
  - 文件书签，常用目录一键跳转
  - 完善的键盘快捷键和右键菜单
- 📂 **SFTP 侧边栏**：终端侧边栏集成文件浏览器，支持上传/下载/预览/编辑

## 技术栈

- **框架**：Electron 28 + Vue 3 + TypeScript
- **终端**：xterm.js 5.x
- **构建**：Vite 5 + electron-builder
- **状态管理**：Pinia
- **国际化**：vue-i18n
- **AI**：OpenAI 兼容 API（支持 Function Calling）+ MCP 协议
- **知识库**：LanceDB + Transformers.js（本地 Embedding）+ BM25

## 快速开始

### 环境要求

- Node.js 18+
- npm 或 pnpm

### 安装依赖

```bash
npm install
```

### 开发模式

```bash
npm run dev
```

### 构建应用

```bash
# Windows
npm run build:win

# macOS
npm run build:mac

# Linux
npm run build:linux
```

### 快速构建（跳过类型检查）

```bash
npm run build:win:fast
npm run build:mac:fast
npm run build:linux:fast
```

## AI 配置

旗鱼终端支持 OpenAI 兼容 API，可以连接：

- 公有云服务：OpenAI、通义千问、DeepSeek 等
- 私有化部署：vLLM、FastChat、Ollama 等

### 配置示例

在设置中添加 AI 配置：

```json
{
  "name": "公司内网模型",
  "apiUrl": "http://10.0.1.100:8080/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "qwen-72b",
  "proxy": null
}
```

### Agent 模式要求

Agent 模式需要 AI 模型支持 **Function Calling**（工具调用）能力。推荐使用：
- OpenAI GPT-4 / GPT-4o / GPT-4o-mini
- Claude 3.5 Sonnet / Claude 3 Opus
- 通义千问 qwen-plus / qwen-max
- DeepSeek V3
- Gemini 1.5 Pro

## MCP 配置

MCP (Model Context Protocol) 允许扩展 Agent 的能力，接入外部工具和资源。

### 添加 MCP 服务器

在设置中的「MCP 服务」页面添加配置：

**stdio 模式**（本地进程）：
```json
{
  "name": "文件系统",
  "transport": "stdio",
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/dir"],
  "env": {}
}
```

**SSE 模式**（远程服务）：
```json
{
  "name": "远程服务",
  "transport": "sse",
  "url": "http://localhost:8080/sse"
}
```

### 常用 MCP 服务器

- **Filesystem**：本地文件读写操作
- **GitHub**：GitHub 仓库操作（需要 Token）
- **PostgreSQL**：数据库查询操作
- **Brave Search**：网页搜索能力

更多 MCP 服务器请参考：[MCP Servers](https://github.com/modelcontextprotocol/servers)

## 知识库配置

本地知识库功能允许导入文档，让 AI Agent 在执行任务时自动检索相关信息。

### 启用知识库

1. 打开设置 → 知识库
2. 开启「启用知识库」选项
3. 等待本地 Embedding 模型加载完成

### 导入文档

支持的文档格式：
- **PDF**：自动提取文本内容
- **Word**：支持 .doc 和 .docx 格式
- **文本**：TXT、Markdown、代码文件等

### 分块策略

- **固定长度**：按字符数均匀分块
- **段落分块**：保持段落完整性
- **语义分块**：基于内容语义智能分割（推荐）

### 使用场景

- 导入项目文档，让 Agent 了解项目架构和规范
- 导入运维手册，Agent 自动参考处理故障
- 导入 API 文档，辅助开发和调试

## Xshell 会话导入

支持从 Xshell 导入已有的会话配置：

1. 点击主机管理面板的「导入」按钮
2. 选择「导入 Xshell 文件」或「导入 Xshell 目录」
3. 选择 `.xsh` 文件或 Xshell Sessions 目录

**说明**：
- 支持导入单个或多个 `.xsh` 文件
- 支持递归导入整个目录，子目录自动作为分组
- Xshell Sessions 目录通常位于：`C:\Users\<用户名>\Documents\NetSarang Computer\Xshell\Sessions`
- 由于 Xshell 密码是加密存储的，导入后需要手动设置密码

## 项目结构

```
├── electron/                  # Electron 主进程
│   ├── main.ts               # 入口
│   ├── preload.ts            # 预加载脚本
│   └── services/             # 服务层
│       ├── agent/            # AI Agent 模块
│       │   ├── index.ts      # Agent 服务入口
│       │   ├── planner.ts    # 动态任务规划器
│       │   ├── progress-detector.ts   # 进度检测器
│       │   ├── prompt-builder.ts  # 提示词构建
│       │   ├── risk-assessor.ts   # 命令风险评估
│       │   ├── tool-executor.ts   # 工具执行器
│       │   ├── tools.ts      # 工具定义
│       │   ├── i18n.ts       # Agent 国际化
│       │   └── types.ts      # 类型定义
│       ├── terminal-awareness/   # 终端感知模块
│       │   ├── index.ts      # 感知服务入口
│       │   └── process-monitor.ts # 进程状态监控
│       ├── knowledge/        # 知识库模块
│       │   ├── index.ts      # 知识库服务入口
│       │   ├── embedding.ts  # Embedding 服务
│       │   ├── storage.ts    # 向量存储（LanceDB）
│       │   ├── bm25.ts       # BM25 关键词搜索
│       │   ├── chunker.ts    # 文档分块
│       │   ├── reranker.ts   # 重排序
│       │   ├── crypto.ts     # 数据加密
│       │   ├── model-manager.ts   # 模型管理
│       │   ├── mcp-adapter.ts     # MCP 适配器
│       │   └── types.ts      # 类型定义
│       ├── ai.service.ts     # AI API 对话
│       ├── pty.service.ts    # 本地终端
│       ├── ssh.service.ts    # SSH 连接
│       ├── sftp.service.ts   # SFTP 文件传输
│       ├── unified-terminal.service.ts  # 统一终端服务
│       ├── terminal-state.service.ts    # 终端状态管理
│       ├── screen-content.service.ts    # 屏幕内容服务
│       ├── command-executor.service.ts  # 命令执行服务
│       ├── host-profile.service.ts      # 主机档案
│       ├── document-parser.service.ts   # 文档解析
│       ├── mcp.service.ts        # MCP 客户端服务
│       ├── history.service.ts    # 历史记录
│       ├── config.service.ts     # 配置管理
│       └── xshell-import.service.ts  # Xshell 导入
├── src/                       # Vue 渲染进程
│   ├── components/           # 组件
│   │   ├── AiPanel.vue       # AI 面板
│   │   ├── Terminal.vue      # 终端组件
│   │   ├── SessionManager.vue    # 会话管理
│   │   ├── AgentPlanView.vue     # Agent 计划视图
│   │   ├── FileExplorer/     # SFTP 文件浏览器
│   │   │   ├── FileExplorer.vue  # 主组件
│   │   │   ├── FileList.vue      # 文件列表
│   │   │   ├── PathBreadcrumb.vue # 路径导航
│   │   │   ├── FileContextMenu.vue # 右键菜单
│   │   │   └── TransferQueue.vue  # 传输队列
│   │   ├── KnowledgeManager.vue   # 知识库管理
│   │   └── Settings/         # 设置组件
│   │       └── KnowledgeSettings.vue # 知识库设置
│   ├── composables/          # 组合式函数
│   │   ├── useAgentMode.ts   # Agent 模式逻辑
│   │   ├── useAiChat.ts      # AI 对话逻辑
│   │   ├── useSftp.ts        # SFTP 操作逻辑
│   │   ├── useHostProfile.ts # 主机档案管理
│   │   ├── useDocumentUpload.ts  # 文档上传
│   │   ├── useContextStats.ts    # 上下文统计
│   │   └── useMarkdown.ts    # Markdown 渲染
│   ├── services/             # 前端服务
│   │   ├── terminal-screen.service.ts   # 终端屏幕分析
│   │   └── terminal-snapshot.service.ts # 终端快照
│   ├── stores/               # Pinia 状态
│   │   ├── terminal.ts       # 终端状态
│   │   └── config.ts         # 配置状态
│   ├── i18n/                 # 国际化
│   │   ├── index.ts          # i18n 配置
│   │   └── locales/          # 语言包
│   └── themes/               # 主题配色
├── resources/                # 应用图标与模型
│   └── models/               # 本地 AI 模型
│       └── embedding/        # Embedding 模型
└── electron-builder.yml      # 打包配置
```

## 版本历史

### v8.1.0 (当前版本)
- 🧠 **智能记忆管理**：增强记忆冲突处理，支持智能去重
- 🧹 **知识库优化**：添加孤儿数据清理功能，增强向量存储清理

### v8.0.0
- 📂 **双栏文件管理器**：全功能的双栏文件管理器
  - 左右双面板布局，支持本地与远程文件操作
  - 目录树导航，快速定位目录
  - 文件预览功能，支持文本文件在线查看
  - 路径编辑和面包屑导航
  - 完善的键盘快捷键支持（Ctrl/Cmd+A 全选、ESC 取消等）
  - 右键菜单操作
- 🔖 **文件书签**：快速收藏常用目录，一键跳转
- 📋 **计划管理增强**：支持计划归档和清除功能
- 🎨 **新增主题**：Solarized Light、GitHub Light 浅色主题
- 🖥️ **终端增强**：
  - 右键打开文件管理器
  - 增强终端提示符解析，智能识别当前目录
  - 终端关闭确认提示

### v7.7.0
- ⚡ **启动速度优化**：知识库异步加载，极大提升启动速度
- 🌍 **多语言增强**：根据界面语言设置 AI 回复语言
- 📖 **英文文档**：新增 README 英文版

### v7.6.0
- 🔀 **会话排序**：支持会话拖拽排序，可拖动到分组最后
- 💡 **Tips 增强**：欢迎页随机提示功能，点击切换更多技巧

### v7.5.0
- 🔧 **统一终端服务**：抽象 PTY 和 SSH 终端的公共接口
- 📊 **进度检测器**：智能识别命令执行进度
- 🛠️ **Agent 工具增强**：优化工具执行器和风险评估

### v7.0.0
- 🏗️ **架构重构**：Agent 服务模块化重构
  - 工具执行器增强
  - 风险评估优化
- 🔍 **BM25 搜索**：知识库新增关键词搜索支持
- 🔐 **数据加密**：敏感配置加密存储

### v6.0.0
- 🖥️ **屏幕内容服务**：终端屏幕内容智能分析
- 📝 **命令执行服务**：独立的命令执行管理
- 🌐 **国际化增强**：完善中英文支持

### v5.0.0
- 🤖 **Agent 增强**：
  - 任务规划器优化
  - 提示词构建改进
  - 工具集扩展
- 📊 **上下文统计**：实时 Token 使用量监控
- 🧠 **主机画像增强**：更智能的环境记忆

### v4.5.0
- 🔍 **终端感知系统**：增强终端状态感知能力
  - 综合状态检测：空闲、忙碌、等待输入、卡死
  - 智能输入识别：密码、确认、选择、分页器、编辑器
  - 输出模式分析：进度条、编译、测试、日志流
  - 卡死检测与自动建议
- 🛡️ **智能命令处理**：
  - 四级风险评估（safe/moderate/dangerous/blocked）
  - 自动修正问题命令（ping、apt install 等）
  - 交互式命令自动转换（top → top -bn1）
  - 持续命令定时执行（tail -f 等）
- 📋 **动态任务规划**：
  - 任务复杂度分析
  - 多种执行策略（default/conservative/aggressive/diagnostic）
  - 动态计划调整、步骤重试、备选方案

### v4.1.0
- 🧠 **本地知识库增强**：
  - 优化向量检索性能
  - 改进文档分块算法
  - Agent 工具集新增 `search_knowledge` 知识库搜索

### v4.0.0
- 📚 **本地知识库 (RAG)**：全新离线知识库功能
  - 内置本地 Embedding 模型（bge-small-zh-v1.5），完全离线运行
  - 基于 LanceDB 的高效向量存储和检索
  - 支持 PDF、Word、TXT、Markdown 等多种文档格式
  - 智能分块策略：固定长度、段落、语义分块
  - 可选 Rerank 模型优化搜索结果
  - 知识库与 Agent 深度集成，自动检索相关文档

### v3.0.0
- 🔌 **MCP 协议支持**：全新 Model Context Protocol 扩展能力
  - 支持连接外部 MCP 服务器，扩展 Agent 工具集
  - 支持 stdio 和 SSE 两种传输模式
  - 自动聚合多服务器的工具、资源和提示模板
  - 内置 Filesystem、GitHub、PostgreSQL 等预设模板
  - 可视化 MCP 服务器配置和管理界面

### v2.2.0
- 📁 **SFTP 文件管理**：全新可视化文件浏览器
  - 支持文件/目录的上传、下载、删除、重命名
  - 实时传输进度显示
  - 文本文件在线预览
  - 路径导航和历史记录
  - 右键菜单快捷操作

### v2.1.0
- 🔍 **终端状态检测**：智能判断命令是否执行完成
- 💡 **Tips 提示**：新增操作提示信息
- 🛡️ **严格模式优化**：修复自动修正命令的确认逻辑
- 🧹 **输出清理**：使用 strip-ansi 库统一处理 ANSI 转义序列
- ⏹️ **Agent 中止优化**：增强中止处理逻辑

### v2.0.0
- 🚀 全新 AI Agent 模式，支持自动化任务执行
- 🔧 丰富的工具集：命令执行、终端控制、文件操作、信息记忆
- ⚠️ 严格模式：危险命令确认机制
- ⏱️ 可配置的命令超时时间
- 📜 Agent 任务历史记录

### v1.0.0
- 🖥️ 跨平台终端基础功能
- 🔐 SSH 连接支持
- 💬 AI 对话助手
- 📥 Xshell 会话导入

## 许可证

本项目采用 **双许可模式（Dual Licensing）**：

### 开源许可：AGPL v3.0
以下场景可免费使用，需遵守 [AGPL v3.0](https://www.gnu.org/licenses/agpl-3.0.html) 全部条款：
- ✅ 个人学习、研究、日常使用
- ✅ 企业内部使用（**≤1000 套**，且修改需开源）
- ✅ 非盈利组织 / 教育机构
- ✅ 医疗及医疗研究机构

### 商业许可
以下场景需要商业授权：
- 企业内部使用超过 1000 套
- 作为产品/服务的一部分提供
- 不希望开源修改的代码
- 修改本软件的 Logo 或名称

详细及商用条款请查看 [LICENSE](./LICENSE) 文件，或访问[官网](http://www.sfterm.com/)联系获取商业授权。

## 相关链接

- 🌐 **官方网站**：[www.sfterm.com](http://www.sfterm.com/)
- 📦 **GitHub**：[https://github.com/ysyx2008/SFTerminal](https://github.com/ysyx2008/SFTerminal)
- 🐛 **问题反馈**：[GitHub Issues](https://github.com/ysyx2008/SFTerminal/issues)

## 致谢

- [Electron](https://www.electronjs.org/)
- [xterm.js](https://xtermjs.org/)
- [Vue.js](https://vuejs.org/)
- [node-pty](https://github.com/microsoft/node-pty)
- [ssh2](https://github.com/mscdex/ssh2)
- [LanceDB](https://lancedb.com/)
- [Transformers.js](https://huggingface.co/docs/transformers.js)
