# =====================================================
# 旗鱼终端网站一键部署脚本 (Windows PowerShell)
# =====================================================
# 使用方法:
#   1. 在服务器上首次运行：.\deploy.ps1 -Setup
#   2. 日常更新：.\deploy.ps1
#   3. 强制全新部署：.\deploy.ps1 -Force
# =====================================================

param(
    [switch]$Setup,      # 首次安装模式
    [switch]$Force,      # 强制重新部署
    [string]$WebRoot = "C:\inetpub\wwwroot\qiyu-terminal",  # 网站根目录
    [string]$GitRepo = "https://github.com/ysyx2008/SFTerminal.git",  # Git 仓库地址
    [string]$Branch = "feature/main"  # 部署分支
)

$ErrorActionPreference = "Stop"

# 颜色输出函数
function Write-Step { param($msg) Write-Host "`n[*] $msg" -ForegroundColor Cyan }
function Write-Success { param($msg) Write-Host "[✓] $msg" -ForegroundColor Green }
function Write-Warning { param($msg) Write-Host "[!] $msg" -ForegroundColor Yellow }
function Write-Error { param($msg) Write-Host "[✗] $msg" -ForegroundColor Red }

# 检查必要工具
function Test-Prerequisites {
    Write-Step "检查依赖..."
    
    # 检查 Git
    if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
        Write-Error "未找到 Git，请先安装: https://git-scm.com/download/win"
        exit 1
    }
    Write-Success "Git 已安装"
    
    # 检查 Node.js
    if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
        Write-Error "未找到 Node.js，请先安装: https://nodejs.org/"
        exit 1
    }
    $nodeVersion = node -v
    Write-Success "Node.js $nodeVersion 已安装"
    
    # 检查 npm
    if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
        Write-Error "未找到 npm"
        exit 1
    }
    Write-Success "npm 已安装"
}

# 首次安装
function Install-Website {
    Write-Step "首次安装网站..."
    
    # 创建临时目录
    $tempDir = "$env:TEMP\qiyu-website-$(Get-Date -Format 'yyyyMMddHHmmss')"
    
    try {
        # 克隆仓库
        Write-Step "克隆仓库..."
        git clone --depth 1 --branch $Branch $GitRepo $tempDir
        
        # 进入 website 目录
        Set-Location "$tempDir\website"
        
        # 安装依赖
        Write-Step "安装依赖..."
        npm ci
        
        # 构建
        Write-Step "构建网站..."
        npm run build
        
        # 创建目标目录
        if (-not (Test-Path $WebRoot)) {
            New-Item -ItemType Directory -Path $WebRoot -Force | Out-Null
        }
        
        # 复制构建结果
        Write-Step "部署到 $WebRoot..."
        Copy-Item -Path "dist\*" -Destination $WebRoot -Recurse -Force
        
        Write-Success "安装完成！"
        Write-Host "`n网站已部署到: $WebRoot" -ForegroundColor Yellow
        
    } finally {
        # 清理临时目录
        Set-Location $env:TEMP
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# 更新网站
function Update-Website {
    Write-Step "更新网站..."
    
    $tempDir = "$env:TEMP\qiyu-website-$(Get-Date -Format 'yyyyMMddHHmmss')"
    
    try {
        # 克隆仓库
        Write-Step "获取最新代码..."
        git clone --depth 1 --branch $Branch $GitRepo $tempDir
        
        Set-Location "$tempDir\website"
        
        # 安装依赖
        Write-Step "安装依赖..."
        npm ci
        
        # 构建
        Write-Step "构建网站..."
        npm run build
        
        # 备份当前版本
        $backupDir = "$WebRoot.backup-$(Get-Date -Format 'yyyyMMddHHmmss')"
        if (Test-Path $WebRoot) {
            Write-Step "备份当前版本到 $backupDir..."
            Copy-Item -Path $WebRoot -Destination $backupDir -Recurse
        }
        
        # 部署新版本
        Write-Step "部署新版本..."
        if (-not (Test-Path $WebRoot)) {
            New-Item -ItemType Directory -Path $WebRoot -Force | Out-Null
        }
        
        # 清空目标目录
        Get-ChildItem -Path $WebRoot -Recurse | Remove-Item -Recurse -Force
        
        # 复制新文件
        Copy-Item -Path "dist\*" -Destination $WebRoot -Recurse -Force
        
        Write-Success "更新完成！"
        Write-Host "`n新版本已部署到: $WebRoot" -ForegroundColor Yellow
        Write-Host "旧版本备份在: $backupDir" -ForegroundColor Yellow
        
        # 清理旧备份（保留最近3个）
        $backups = Get-ChildItem -Path (Split-Path $WebRoot) -Filter "$((Split-Path $WebRoot -Leaf)).backup-*" -Directory | Sort-Object LastWriteTime -Descending
        if ($backups.Count -gt 3) {
            Write-Step "清理旧备份..."
            $backups | Select-Object -Skip 3 | ForEach-Object {
                Remove-Item $_.FullName -Recurse -Force
                Write-Host "  已删除: $($_.Name)"
            }
        }
        
    } finally {
        Set-Location $env:TEMP
        if (Test-Path $tempDir) {
            Remove-Item -Path $tempDir -Recurse -Force -ErrorAction SilentlyContinue
        }
    }
}

# 主流程
Write-Host @"

╔═══════════════════════════════════════════════╗
║       旗鱼终端网站 - 一键部署工具            ║
╚═══════════════════════════════════════════════╝

"@ -ForegroundColor Cyan

Test-Prerequisites

if ($Setup -or $Force -or -not (Test-Path $WebRoot)) {
    Install-Website
} else {
    Update-Website
}

Write-Host "`n[完成] 部署成功！" -ForegroundColor Green
Write-Host "如果使用 IIS，请确保网站已指向: $WebRoot`n" -ForegroundColor Yellow
