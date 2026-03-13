---
title: 'Web 远程访问'
description: '通过浏览器远程访问旗鱼 Agent'
---

# Web 远程访问

旗鱼内置了网关服务（Gateway），你可以通过浏览器远程访问 Agent，获得接近桌面端的完整交互体验。适合在平板、手机或另一台电脑上远程操作。

## 启用网关

1. 打开 设置 → Web 服务
2. 开启「启用网关」开关
3. 配置端口号（默认 `3721`）
4. 设置**访问 Token**（安全凭证，建议使用 16 位以上随机字符串）
5. 点击保存

启用后，旗鱼会在本机启动一个 HTTP 服务，等待来自浏览器的连接。

> 网关启动后，你可以在设置页面看到当前的访问地址和状态。

## 访问方式

### 同一局域网（最简单）

如果你的手机/平板和电脑在同一个 Wi-Fi 或局域网内：

1. 在电脑上查看本机 IP 地址：
   - **macOS**：系统设置 → 网络，或终端执行 `ifconfig | grep "inet "`
   - **Windows**：CMD 执行 `ipconfig`
   - **Linux**：终端执行 `ip addr`
2. 在手机或平板的浏览器中打开 `http://你的IP:3721`（例如 `http://192.168.1.100:3721`）
3. 输入你设置的 Token 验证身份
4. 即可开始与 Agent 对话

> **提示**：手机建议将网页添加到主屏幕，获得类似 App 的体验。

### 外网访问

如果需要从公司外网、出差途中等不同网络访问：

#### 方式一：内网穿透（推荐）

使用内网穿透工具将本地端口暴露到公网：

- **frp**：开源、自建，适合有自己服务器的用户
- **ngrok**：即开即用，免费版有流量限制
- **花生壳**：国内服务，注册即用
- **Cloudflare Tunnel**：免费，稳定

以 ngrok 为例：

```bash
ngrok http 3721
```

会生成一个公网地址（如 `https://xxx.ngrok-free.app`），在任何地方用浏览器打开这个地址即可。

#### 方式二：端口转发

在路由器管理界面中将外部端口（如 13721）转发到电脑的 3721 端口。之后通过 `http://你的公网IP:13721` 访问。

#### 方式三：VPN

通过 WireGuard、OpenVPN 等 VPN 连接到家庭/办公网络后，就和局域网访问一样了。

> **安全提醒**：外网访问请务必：
> - 设置高强度 Token（至少 16 位，包含大小写字母和数字）
> - 优先使用 HTTPS（通过内网穿透工具或反向代理实现）
> - 定期更换 Token

## Web 界面功能

Web 远程界面是一个轻量级的 Agent 交互页面，提供以下功能：

### AI 对话

- 文字输入与 Agent 交流，和桌面端的体验一致
- Agent 可以执行终端命令、操作文件、调用工具
- 支持发送文字消息

### 实时执行过程

- 通过 SSE（Server-Sent Events）技术实时推送 Agent 的执行过程
- 你可以看到 Agent 的思考、工具调用和执行结果
- 无需刷新页面，内容自动更新

### 对话历史

- 查看之前的对话记录
- 跨设备对话——在电脑上开始的任务，可以在手机上查看结果

## Webhook 端点

网关服务还提供了 Webhook 接口，外部系统可以通过 HTTP POST 请求触发觉醒模式的关切执行。

### 调用方式

```
POST http://你的IP:3721/hooks/<watch-token>
```

其中 `<watch-token>` 是创建 Webhook 类型关切时自动生成的唯一 Token。

### 请求体

可以在请求体中附带 JSON 数据，Agent 在执行关切任务时可以读取这些数据：

```json
{
  "event": "deploy_complete",
  "status": "success",
  "commit": "abc123"
}
```

### 常见用途

| 场景 | 做法 |
|------|------|
| CI/CD 部署完成通知 | GitHub Actions / Jenkins 在流水线结束时 POST Webhook |
| 监控告警触发排查 | Prometheus AlertManager 配置 Webhook 到旗鱼 |
| 定时任务完成回调 | crontab 任务结束后用 curl 通知 Agent |
| 表单提交处理 | 第三方表单工具提交时触发 Agent 处理 |

### 示例：GitHub Actions 触发

在 `.github/workflows/deploy.yml` 中添加：

```yaml
- name: Notify SailFish Agent
  if: always()
  run: |
    curl -X POST http://your-ip:3721/hooks/your-watch-token \
      -H "Content-Type: application/json" \
      -d '{"status": "${{ job.status }}", "commit": "${{ github.sha }}"}'
```

## 与 IM 远程访问的对比

| 特性 | Web 远程 | IM 机器人 |
|------|---------|----------|
| 需要公网 IP | 是（或内网穿透） | 否 |
| 交互体验 | 更丰富，接近桌面端 | 文字消息为主 |
| 实时过程展示 | 支持（SSE 推流） | 仅最终结果 |
| 配置复杂度 | 低（开启即用） | 中（需创建 IM 应用） |
| 移动端体验 | 浏览器 | 原生 App |

> 两种方式可以同时使用——日常用 IM 接收通知和简单指令，复杂任务时打开 Web 界面操作。
