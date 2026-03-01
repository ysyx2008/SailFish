# 旗鱼网站部署指南

本文档介绍如何将网站部署到阿里云 ECS Windows 服务器。

## 📋 前置要求

在 Windows 服务器上安装：

1. **Git for Windows**: https://git-scm.com/download/win
2. **Node.js 20+**: https://nodejs.org/

## 🚀 部署方式

### 方式一：PowerShell 一键脚本（推荐）

#### 首次部署

```powershell
# 1. 下载部署脚本
Invoke-WebRequest -Uri "https://raw.githubusercontent.com/你的用户名/SailFish/feature/Website/website/deploy.ps1" -OutFile "deploy.ps1"

# 2. 修改脚本中的 Git 仓库地址
notepad deploy.ps1

# 3. 运行首次安装
.\deploy.ps1 -Setup
```

#### 日常更新

```powershell
.\deploy.ps1
```

#### 自定义参数

```powershell
# 指定网站目录
.\deploy.ps1 -WebRoot "D:\wwwroot\qiyu-terminal"

# 指定分支
.\deploy.ps1 -Branch "main"

# 强制全新部署
.\deploy.ps1 -Force
```

---

### 方式二：GitHub Actions 自动部署

推送代码后自动构建并通过 FTP 部署到服务器。

#### 1. 在服务器上开启 FTP 服务

**使用 IIS FTP：**
1. 打开 "服务器管理器" → "添加角色和功能"
2. 勾选 "Web 服务器(IIS)" → "FTP 服务器"
3. 在 IIS 管理器中添加 FTP 站点，指向网站目录

#### 2. 配置 GitHub Secrets

在 GitHub 仓库中设置以下 Secrets（Settings → Secrets → Actions）：

| Secret 名称 | 说明 | 示例 |
|------------|------|------|
| `FTP_SERVER` | FTP 服务器地址 | `ftp.example.com` 或 IP |
| `FTP_PORT` | FTPS 端口（可自定义） | `990` 或 `21` |
| `FTP_USERNAME` | FTP 用户名 | `ftpuser` |
| `FTP_PASSWORD` | FTP 密码 | `yourpassword` |
| `FTP_SERVER_DIR` | 服务器目录 | `/` 或 `/wwwroot/` |

> ⚠️ **安全提示**：已启用 FTPS（FTP over TLS），所有传输数据都会加密。请确保服务器 FTP 服务已启用 SSL/TLS。

#### 3. 触发部署

- **自动触发**：推送 `website/` 目录下的更改到 main/master/feature/Website 分支
- **手动触发**：GitHub → Actions → Deploy Website → Run workflow

---

### 方式三：手动构建上传

在本地构建后手动上传到服务器。

```bash
# 在本地构建
cd website
npm install
npm run build

# 构建产物在 website/dist/ 目录
# 将 dist 目录下的所有文件上传到服务器网站目录
```

---

## 🌐 Web 服务器配置

### 使用 IIS

1. 打开 IIS 管理器
2. 右键 "网站" → "添加网站"
3. 配置：
   - 网站名称：`QiyuTerminal`
   - 物理路径：`C:\inetpub\wwwroot\qiyu-terminal`（或你的部署目录）
   - 绑定：设置 IP、端口、域名

### 使用 Nginx for Windows

下载 Nginx：http://nginx.org/en/download.html

配置示例 (`conf/nginx.conf`)：

```nginx
server {
    listen 80;
    server_name qiyu-terminal.com;  # 你的域名
    
    root C:/wwwroot/qiyu-terminal;  # 网站目录
    index index.html;
    
    location / {
        try_files $uri $uri/ /index.html;
    }
    
    # 静态资源缓存
    location /assets {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

启动 Nginx：
```cmd
cd C:\nginx
start nginx
```

---

## 🔧 常见问题

### 1. PowerShell 脚本无法执行

运行管理员 PowerShell：
```powershell
Set-ExecutionPolicy RemoteSigned -Scope CurrentUser
```

### 2. Git clone 失败

- 检查网络连接
- 如果是私有仓库，配置 Git 凭据或 SSH 密钥
- 使用 Gitee 镜像加速

### 3. npm install 慢

配置淘宝镜像：
```cmd
npm config set registry https://registry.npmmirror.com
```

### 4. 端口被占用

```cmd
netstat -ano | findstr :80
taskkill /PID <进程ID> /F
```

---

## 📁 目录结构

部署后的目录结构：

```
C:\inetpub\wwwroot\qiyu-terminal\
├── index.html
├── favicon.ico
├── logo.png
└── assets/
    ├── *.js
    └── *.css
```

---

## 🔄 回滚

如果新版本有问题，可以快速回滚：

```powershell
# 列出备份
Get-ChildItem C:\inetpub\wwwroot\ -Filter "qiyu-terminal.backup-*"

# 回滚到某个备份
$backup = "C:\inetpub\wwwroot\qiyu-terminal.backup-20240101120000"
$webroot = "C:\inetpub\wwwroot\qiyu-terminal"

Remove-Item $webroot -Recurse -Force
Copy-Item $backup $webroot -Recurse
```
