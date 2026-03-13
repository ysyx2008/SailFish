---
title: '下载与安装'
description: '在 macOS、Windows 或 Linux 上下载并安装旗鱼'
---

# 下载与安装

旗鱼支持 macOS、Windows 和 Linux 三大平台。安装过程非常简单，和安装其他桌面应用没有区别。

## 系统要求

| 平台 | 最低要求 |
|------|---------|
| macOS | 10.15 (Catalina) 及以上，支持 Intel 和 Apple Silicon |
| Windows | Windows 10 / 11，Server 2016 及以上 |
| Linux | 主流 64 位发行版（Ubuntu 20.04+、Debian 11+、Fedora 36+ 等） |

## 下载

你可以从以下两个渠道下载最新版本：

- **阿里云（国内推荐）**：速度快，无需翻墙
- **GitHub Releases**：海外用户推荐

> 访问旗鱼官网首页 [sfterm.com](https://www.sfterm.com) 底部的下载区域，或直接前往 [GitHub Releases](https://github.com/ysyx2008/SailFish/releases) 页面。

### macOS

- **Apple Silicon（M1/M2/M3/M4）**：下载 `SailFish-x.x.x-arm64.dmg`
- **Intel**：下载 `SailFish-x.x.x-x64.dmg`

> 不确定自己的 Mac 是哪种芯片？点击左上角苹果菜单 →「关于本机」，查看「芯片」一栏。如果显示 Apple M1/M2/M3/M4 就选 Apple Silicon，显示 Intel 就选 Intel。

### Windows

- 下载 `SailFish-x.x.x-x64-setup.exe`（64 位安装包）

### Linux

- **AppImage**（通用）：下载 `SailFish-x.x.x-x86_64.AppImage`
- **deb 包**（Debian/Ubuntu）：下载 `SailFish-x.x.x-amd64.deb`

## 安装步骤

### macOS 安装

1. 双击下载的 `.dmg` 文件
2. 在弹出的窗口中，将旗鱼图标拖拽到 Applications 文件夹
3. 打开启动台（Launchpad）或在 Applications 文件夹中找到旗鱼，双击启动

**首次启动提示**：macOS 可能会提示「无法验证开发者」。这是正常的，解决方法：

1. 打开「系统设置」→「隐私与安全性」
2. 在底部找到关于旗鱼的提示，点击「仍要打开」
3. 或者在终端中执行：`xattr -cr /Applications/SailFish.app`

### Windows 安装

1. 双击下载的 `.exe` 安装包
2. 如果弹出 SmartScreen 警告，点击「更多信息」→「仍要运行」
3. 按照安装向导完成安装（建议使用默认路径）
4. 安装完成后，在开始菜单或桌面找到旗鱼图标，双击启动

### Linux 安装

**AppImage 方式（推荐）：**

```bash
# 赋予执行权限
chmod +x SailFish-*.AppImage

# 直接运行
./SailFish-*.AppImage
```

**deb 包方式：**

```bash
sudo dpkg -i SailFish-*-amd64.deb
```

## 启动与首次见面

安装完成并启动旗鱼后，你会看到主界面。此时 AI 还无法工作，因为还没有配置 AI 服务的 API。

不用着急，下一篇我们会手把手教你完成配置。

## 自动更新

旗鱼内置了自动更新功能。当有新版本时，应用会提示你下载更新。你也可以在「设置」中手动检查更新。

## 遇到问题？

- **macOS 提示「已损坏」**：在终端执行 `xattr -cr /Applications/SailFish.app`
- **Windows 杀毒软件拦截**：将旗鱼加入白名单，这是误报
- **Linux 无法启动**：确保系统已安装 `libgtk-3-0`、`libnotify4`、`libnss3` 等依赖

如果仍有问题，可以到 [GitHub Issues](https://github.com/ysyx2008/SailFish/issues) 反馈，或加入 QQ 交流群寻求帮助。

## 下一步

安装完成后，接下来要 [配置 AI 服务](/zh/docs/getting-started/first-setup)，让旗鱼能够"思考"。
