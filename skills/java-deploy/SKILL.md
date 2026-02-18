---
name: Java/Spring Boot 部署
description: Java 应用构建打包、JVM 调优、systemd 部署、Docker 化部署、常见启动故障排查
version: 1.0.0
---

# Java/Spring Boot 部署

## 构建打包

```bash
# Maven
mvn clean package -DskipTests
# 产物：target/<app>.jar

# Gradle
./gradlew bootJar
# 产物：build/libs/<app>.jar

# 验证 jar 是否可运行
java -jar target/<app>.jar --server.port=8080
```

## JVM 参数调优

```bash
# 基础配置
java -Xms512m -Xmx1024m -jar app.jar

# 生产推荐（容器环境）
java \
  -XX:+UseContainerSupport \
  -XX:MaxRAMPercentage=75.0 \
  -XX:+UseG1GC \
  -XX:MaxGCPauseMillis=200 \
  -XX:+HeapDumpOnOutOfMemoryError \
  -XX:HeapDumpPath=/var/log/app/heapdump.hprof \
  -Djava.security.egd=file:/dev/./urandom \
  -jar app.jar
```

**常用 JVM 参数说明**：

| 参数 | 作用 |
|------|------|
| `-Xms` / `-Xmx` | 初始/最大堆内存 |
| `-XX:MaxRAMPercentage` | 容器场景按内存百分比分配（替代固定值） |
| `-XX:+UseG1GC` | G1 垃圾收集器（JDK 9+ 默认） |
| `-XX:+UseZGC` | ZGC 低延迟收集器（JDK 17+ 推荐） |

## systemd 部署

创建 `/etc/systemd/system/myapp.service`：
```ini
[Unit]
Description=My Spring Boot App
After=network.target

[Service]
Type=simple
User=appuser
WorkingDirectory=/opt/myapp
ExecStart=/usr/bin/java -Xms512m -Xmx1024m -jar /opt/myapp/app.jar --spring.profiles.active=prod
SuccessExitStatus=143
Restart=on-failure
RestartSec=10
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now myapp
sudo systemctl status myapp
sudo journalctl -u myapp -f        # 查看日志
```

## Docker 化部署

```dockerfile
# 多阶段构建
FROM maven:3.9-eclipse-temurin-21 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn dependency:go-offline
COPY src ./src
RUN mvn package -DskipTests

FROM eclipse-temurin:21-jre-alpine
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-XX:MaxRAMPercentage=75.0", "-jar", "app.jar"]
```

```bash
docker build -t myapp:latest .
docker run -d -p 8080:8080 --name myapp \
  -e SPRING_PROFILES_ACTIVE=prod \
  -v /var/log/myapp:/var/log/myapp \
  myapp:latest
```

## 日志配置

**logback-spring.xml** 推荐：
- 控制台输出（开发环境）
- 文件输出 + 按天滚动 + 保留 30 天
- 异步 appender 避免 I/O 阻塞

```bash
# 查看 Spring Boot 运行日志
tail -f /var/log/myapp/app.log
journalctl -u myapp --since "1 hour ago"
```

## 常见启动故障

| 问题 | 排查 |
|------|------|
| 端口占用 | `lsof -i :8080` 或 `ss -tlnp \| grep 8080` |
| 数据库连不上 | 检查 `spring.datasource.url`、网络、防火墙 |
| OOM 崩溃 | 增大 `-Xmx`，检查 heapdump 分析内存泄漏 |
| Bean 创建失败 | 看完整堆栈的 `Caused by`，通常是配置项缺失或类型错误 |
| 启动后立即退出 | 确认是 web 项目（有 `spring-boot-starter-web` 依赖） |

## 运行时诊断

```bash
# 查看 Java 进程
jps -lv

# 线程 dump（排查死锁/CPU 高）
jstack <pid> > thread_dump.txt

# 堆内存分析
jmap -heap <pid>
jmap -histo:live <pid> | head -30

# Arthas（阿里开源，推荐）
curl -O https://arthas.aliyun.com/arthas-boot.jar
java -jar arthas-boot.jar
```
