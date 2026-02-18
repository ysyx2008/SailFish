---
name: node-project
description: Node.js 项目管理。npm/pnpm init、依赖管理、scripts、nvm、常见故障（node_modules、lock 文件）。涉及 Node 项目初始化或依赖问题时使用。
version: 1.0.0
---

# Node.js 项目管理

## 初始化

```bash
npm init -y
pnpm init
```

## 依赖管理

```bash
# 安装
npm install lodash
npm install -D eslint
pnpm add lodash
pnpm add -D eslint

# 更新
npm update
npm outdated
pnpm update
```

**建议**：提交 `package-lock.json` 或 `pnpm-lock.yaml`，保证环境一致。

## Scripts

```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "test": "vitest"
  }
}
```

运行：`npm run dev`、`pnpm dev`

## nvm（版本管理）

```bash
nvm install 20
nvm use 20
nvm alias default 20
```

项目指定版本：`.nvmrc` 写 `20` 或 `18.0.0`，配合 `nvm use`。

## 常见故障

| 问题 | 处理 |
|------|------|
| `node_modules` 异常 | 删 `node_modules` 和 lock 文件后重装：`rm -rf node_modules && npm install` |
| lock 文件冲突 | 团队统一用 npm 或 pnpm，不要混用；冲突时以 lock 为准或重生成 |
| 全局 vs 项目 | 依赖尽量装到项目，少用 `npm install -g` |
| 权限错误 | 避免 `sudo npm`；修复 npm 目录权限或用 nvm |
| 安装慢 | 换镜像：`npm config set registry https://registry.npmmirror.com` |
