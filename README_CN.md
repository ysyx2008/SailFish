<div align="center">

<pre>
███████╗███████╗████████╗███████╗██████╗ ███╗   ███╗
██╔════╝██╔════╝╚══██╔══╝██╔════╝██╔══██╗████╗ ████║
███████╗█████╗     ██║   █████╗  ██████╔╝██╔████╔██║
╚════██║██╔══╝     ██║   ██╔══╝  ██╔══██╗██║╚██╔╝██║
███████║██║        ██║   ███████╗██║  ██║██║ ╚═╝ ██║
╚══════╝╚═╝        ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝
</pre>

**旗鱼终端**

**AI 驱动的新世代终端**

*说出你的需求，AI 自主规划执行*

[![Build](https://github.com/ysyx2008/SFTerminal/actions/workflows/build-release.yml/badge.svg)](https://github.com/ysyx2008/SFTerminal/actions)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](./LICENSE)
[![en](https://img.shields.io/badge/lang-English-blue.svg)](./README.md)
[![cn](https://img.shields.io/badge/lang-中文-red.svg)](./README_CN.md)

[官方网站](http://www.sfterm.com/) · [下载](https://github.com/ysyx2008/SFTerminal/releases) · [文档](./docs/)

</div>

---

## 为什么选择旗鱼终端？

| 痛点 | 旗鱼终端方案 |
|------|-------------|
| 🤯 不会写命令？ | 用自然语言描述，AI 帮你执行 |
| 😵 看不懂报错？ | AI 分析原因并给出解决方案 |
| 🔁 重复性操作？ | Agent 自动化执行多步任务 |
| 🏢 内网环境？ | 支持私有化 AI 模型和代理 |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-welcome.png" width="800" alt="旗鱼终端">
</p>

## ✨ 核心功能

| 功能 | 说明 |
|------|------|
| 🤖 **AI Agent** | 描述任务，Agent 自动规划执行 |
| 🖥️ **SSH/SFTP** | 完整的远程连接和文件管理 |
| 📁 **文件管理器** | 双栏文件管理器，支持本地与远程 |
| 📚 **知识库** | 本地 RAG，完全离线运行 |
| 🔌 **MCP 扩展** | 通过 MCP 协议接入外部工具 |
| 🗄️ **数据库** | 自然语言执行 SQL 和分析 |
| 📊 **Excel/Word** | 文档处理技能 |
| 🌐 **浏览器自动化** | 基于 Playwright 的网页操作 |

<p align="center">
  <img src="https://raw.githubusercontent.com/ysyx2008/SFTerminal/main/website/public/screenshot-agent-exec.png" width="800" alt="AI Agent">
</p>

## 🚀 快速开始

### 下载安装

从 [GitHub Releases](https://github.com/ysyx2008/SFTerminal/releases) 或 [官方网站](http://www.sfterm.com/) 下载最新版本。

### 开发调试

```bash
# 安装依赖
npm install

# 启动开发模式
npm run dev

# 构建应用
npm run build:mac    # macOS
npm run build:win    # Windows
npm run build:linux  # Linux
```

### AI 配置

旗鱼终端支持 OpenAI 兼容 API。在设置中配置：

```json
{
  "name": "你的 AI",
  "apiUrl": "https://api.openai.com/v1/chat/completions",
  "apiKey": "sk-xxx",
  "model": "gpt-4o"
}
```

**Agent 模式推荐模型**（需支持 Function Calling）：
- DeepSeek V3
- 通义千问 qwen-plus / qwen-max
- OpenAI GPT-4o / GPT-4o-mini
- Claude 4.5 Sonnet

## 📖 文档

- [Agent 架构](./docs/agent-architecture.md)
- [开发路线图](./docs/ROADMAP.md)
- [更新日志](./CHANGELOG.md)
- [贡献指南](./CONTRIBUTING.md)

## 📄 许可证

**双许可模式**：开源使用遵循 AGPL v3.0，商业使用需授权。

- ✅ 个人使用、学习研究、教育机构
- ✅ 企业内部使用（≤1000 套，修改需开源）
- 💼 需商业授权：>1000 套、SaaS/产品集成、闭源修改

详见 [LICENSE](./LICENSE) 文件。

## 🔗 相关链接

- 🌐 [官方网站](http://www.sfterm.com/)
- 📦 [GitHub](https://github.com/ysyx2008/SFTerminal)
- 🐛 [问题反馈](https://github.com/ysyx2008/SFTerminal/issues)

## 🙏 致谢

基于 [Electron](https://www.electronjs.org/)、[Vue.js](https://vuejs.org/)、[xterm.js](https://xtermjs.org/)、[LanceDB](https://lancedb.com/) 等优秀开源项目构建。
