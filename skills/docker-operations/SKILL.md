---
name: Docker 操作指南
description: Docker 容器管理、镜像操作、compose 编排的最佳实践
version: "1.0"
---

# Docker 操作指南

执行 Docker 相关任务时的最佳实践。

## 容器管理

### 查看状态
- 运行中容器：`docker ps`
- 所有容器：`docker ps -a`
- 资源使用：`docker stats`

### 日志排查
- 查看日志：`docker logs -f --tail 100 <container>`
- 带时间戳：`docker logs --timestamps <container>`

### 进入容器
- `docker exec -it <container> /bin/bash`
- Alpine 镜像用 `/bin/sh`

## 镜像管理

### 构建最佳实践
- 使用多阶段构建减小镜像体积
- 合理利用构建缓存（变化频率低的层放前面）
- 使用 `.dockerignore` 排除不需要的文件
- 优先使用 `alpine` 基础镜像

### 清理
- 悬空镜像：`docker image prune`
- 全部未使用：`docker system prune -a`
- 清理前告知用户将回收多少空间

## Docker Compose

### 常用操作
- 启动：`docker compose up -d`
- 停止：`docker compose down`
- 重建单个服务：`docker compose up -d --build <service>`
- 查看日志：`docker compose logs -f <service>`

### 编排建议
- 使用 `depends_on` + `healthcheck` 控制启动顺序
- 敏感信息使用 `secrets` 或环境变量文件
- 为有状态服务配置命名 volume
- 网络：为不同组件创建独立 network

## 故障排查

1. 容器启动失败 → 检查 `docker logs`
2. 端口冲突 → `lsof -i :<port>` 查看占用
3. 磁盘满 → `docker system df` 查看 Docker 磁盘使用
4. 网络不通 → `docker network inspect` 检查网络配置
