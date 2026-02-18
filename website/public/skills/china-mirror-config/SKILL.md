---
name: 国内镜像源配置
description: 一键切换 npm/pip/Docker/apt/yum/Go/Maven/Homebrew/Rust 等工具的国内镜像源，解决下载慢的问题
version: 1.0.0
---

# 国内镜像源配置

在中国大陆服务器或开发机上配置软件包镜像源，加速下载。

## npm / pnpm / yarn

```bash
# npm
npm config set registry https://registry.npmmirror.com

# pnpm
pnpm config set registry https://registry.npmmirror.com

# yarn
yarn config set registry https://registry.npmmirror.com

# 验证
npm config get registry
```

恢复官方源：`npm config set registry https://registry.npmjs.org`

## pip / conda

```bash
# pip（永久配置）
pip config set global.index-url https://pypi.tuna.tsinghua.edu.cn/simple
pip config set global.trusted-host pypi.tuna.tsinghua.edu.cn

# 临时使用
pip install package -i https://pypi.tuna.tsinghua.edu.cn/simple

# conda
conda config --add channels https://mirrors.tuna.tsinghua.edu.cn/anaconda/pkgs/main
conda config --set show_channel_urls yes
```

备选源：阿里云 `https://mirrors.aliyun.com/pypi/simple/`

## Docker 镜像加速

编辑 `/etc/docker/daemon.json`：
```json
{
  "registry-mirrors": [
    "https://mirror.ccs.tencentyun.com",
    "https://docker.mirrors.ustc.edu.cn"
  ]
}
```

```bash
sudo systemctl daemon-reload
sudo systemctl restart docker
# 验证
docker info | grep -A5 "Registry Mirrors"
```

> 阿里云用户可在容器镜像服务控制台获取专属加速地址。

## apt (Ubuntu/Debian)

```bash
# 备份
sudo cp /etc/apt/sources.list /etc/apt/sources.list.bak

# Ubuntu 22.04 示例（清华源）
sudo sed -i 's|http://archive.ubuntu.com|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list
sudo sed -i 's|http://security.ubuntu.com|https://mirrors.tuna.tsinghua.edu.cn|g' /etc/apt/sources.list

sudo apt update
```

## yum / dnf (CentOS/RHEL)

```bash
# CentOS 7
sudo sed -e 's|^mirrorlist=|#mirrorlist=|g' \
         -e 's|^#baseurl=http://mirror.centos.org|baseurl=https://mirrors.aliyun.com|g' \
         -i /etc/yum.repos.d/CentOS-Base.repo
sudo yum makecache

# Rocky/Alma Linux
sudo sed -e 's|^mirrorlist=|#mirrorlist=|g' \
         -e 's|^#baseurl=http://dl.rockylinux.org|baseurl=https://mirrors.aliyun.com/rockylinux|g' \
         -i /etc/yum.repos.d/rocky*.repo
sudo dnf makecache
```

## Go

```bash
go env -w GOPROXY=https://goproxy.cn,direct
go env -w GOSUMDB=sum.golang.google.cn

# 验证
go env GOPROXY
```

## Maven / Gradle

在 `~/.m2/settings.xml` 中添加阿里云仓库：
```xml
<mirrors>
  <mirror>
    <id>aliyunmaven</id>
    <mirrorOf>*</mirrorOf>
    <name>阿里云公共仓库</name>
    <url>https://maven.aliyun.com/repository/public</url>
  </mirror>
</mirrors>
```

Gradle 在 `build.gradle` 中：
```groovy
repositories {
    maven { url 'https://maven.aliyun.com/repository/public' }
    mavenCentral()
}
```

## Homebrew (macOS)

```bash
# 使用清华源
export HOMEBREW_BREW_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git"
export HOMEBREW_CORE_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/homebrew-core.git"
export HOMEBREW_BOTTLE_DOMAIN="https://mirrors.tuna.tsinghua.edu.cn/homebrew-bottles"

# 写入 shell 配置
echo 'export HOMEBREW_BREW_GIT_REMOTE="https://mirrors.tuna.tsinghua.edu.cn/git/homebrew/brew.git"' >> ~/.zshrc
```

## Rust

```bash
# 在 ~/.cargo/config.toml 中配置
mkdir -p ~/.cargo
cat >> ~/.cargo/config.toml << 'EOF'
[source.crates-io]
replace-with = 'rsproxy'

[source.rsproxy]
registry = "https://rsproxy.cn/crates.io-index"

[registries.rsproxy]
index = "https://rsproxy.cn/crates.io-index"

[net]
git-fetch-with-cli = true
EOF
```

## 操作原则

- 修改前**必须备份**原始配置文件
- 优先使用 HTTPS 源
- 切换后执行一次包管理器的缓存刷新命令验证生效
- 告知用户当前使用的镜像源地址
