# SFTerm Legacy 版本

本分支专为 **Windows 7 / Windows Server 2008 R2** 等旧系统提供支持。

## 系统要求

- Windows 7 SP1 (64-bit)
- Windows Server 2008 R2 SP1 (64-bit)
- Windows 8/8.1 (64-bit)
- Windows Server 2012/2012 R2 (64-bit)

## 技术说明

- 使用 **Electron 22.x**（最后一个支持 Windows 7 的版本）
- 基于 Chromium 108

## 限制

与主版本相比，Legacy 版本可能存在以下限制：

1. **安全更新**：Electron 22 已停止维护，不再接收安全更新
2. **新特性**：部分依赖新版 Electron API 的功能可能不可用
3. **性能**：较旧的 Chromium 版本可能性能略低

## 构建方法

```bash
# 安装依赖
npm install

# 构建 Windows 版本
npm run build:win
```

## 建议

如果您的系统支持，**强烈建议**使用主版本（支持 Windows 10+）以获得：
- 更好的安全性
- 更多新特性
- 更好的性能
- 持续的更新支持

## 版本同步

此分支会定期从 `main` 分支同步重要的 bug 修复，但不保证所有新功能都会移植。
