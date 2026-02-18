---
name: CI/CD 流水线配置
description: GitHub Actions 与 GitLab CI 流水线配置、自动测试、构建部署、缓存优化
version: 1.0.0
---

# CI/CD 流水线配置

## GitHub Actions

### 基础结构

文件位置：`.github/workflows/<name>.yml`

```yaml
name: CI

on:
  push:
    branches: [main, develop]
  pull_request:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: 'npm'

      - run: npm ci
      - run: npm test
      - run: npm run build
```

### 常用优化

```yaml
# 缓存依赖
- uses: actions/cache@v4
  with:
    path: ~/.npm
    key: ${{ runner.os }}-npm-${{ hashFiles('**/package-lock.json') }}
    restore-keys: ${{ runner.os }}-npm-

# 矩阵测试（多版本）
strategy:
  matrix:
    node-version: [18, 20, 22]

# 条件执行
if: github.event_name == 'push' && github.ref == 'refs/heads/main'

# Secret 使用
env:
  API_KEY: ${{ secrets.API_KEY }}
```

### 构建并推送 Docker 镜像

```yaml
deploy:
  needs: test
  runs-on: ubuntu-latest
  if: github.ref == 'refs/heads/main'
  steps:
    - uses: actions/checkout@v4

    - uses: docker/login-action@v3
      with:
        registry: registry.cn-hangzhou.aliyuncs.com
        username: ${{ secrets.REGISTRY_USER }}
        password: ${{ secrets.REGISTRY_PASS }}

    - uses: docker/build-push-action@v5
      with:
        push: true
        tags: registry.cn-hangzhou.aliyuncs.com/myns/app:${{ github.sha }}
```

## GitLab CI

### 基础结构

文件位置：`.gitlab-ci.yml`（项目根目录）

```yaml
stages:
  - test
  - build
  - deploy

variables:
  NODE_VERSION: "20"

test:
  stage: test
  image: node:${NODE_VERSION}
  cache:
    key: ${CI_COMMIT_REF_SLUG}
    paths:
      - node_modules/
  script:
    - npm ci
    - npm test

build:
  stage: build
  image: node:${NODE_VERSION}
  script:
    - npm ci
    - npm run build
  artifacts:
    paths:
      - dist/
    expire_in: 1 week

deploy:
  stage: deploy
  image: alpine:latest
  only:
    - main
  script:
    - apk add --no-cache rsync openssh-client
    - rsync -avz -e "ssh -o StrictHostKeyChecking=no" dist/ $DEPLOY_USER@$DEPLOY_HOST:/var/www/app/
```

### 常用配置

```yaml
# 缓存 Docker 层
build-image:
  stage: build
  image: docker:latest
  services:
    - docker:dind
  script:
    - docker build -t $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA .
    - docker push $CI_REGISTRY_IMAGE:$CI_COMMIT_SHA

# 手动部署（需点击确认）
deploy-prod:
  stage: deploy
  when: manual
  environment:
    name: production

# 规则控制
rules:
  - if: '$CI_PIPELINE_SOURCE == "merge_request_event"'
  - if: '$CI_COMMIT_BRANCH == "main"'
```

## 通用最佳实践

- **快速反馈**：测试阶段应在 5 分钟内完成
- **缓存依赖**：利用 npm cache / pip cache 加速构建
- **最小权限**：CI/CD Secret 使用专用账号，仅授予必要权限
- **制品管理**：构建产物设置过期时间，避免无限增长
- **分支策略**：PR/MR 必须通过 CI 才允许合并
- **通知**：失败时通知相关人员（钉钉/飞书 Webhook）
