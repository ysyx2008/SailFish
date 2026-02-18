---
name: 阿里云 CLI 操作
description: 阿里云 CLI (aliyun) 安装配置、ECS 管理、OSS 操作、安全组、DNS、SLB 常用命令
version: 1.0.0
---

# 阿里云 CLI 操作

## 安装与配置

```bash
# macOS
brew install aliyun-cli

# Linux
curl -fsSL https://aliyuncli.alicdn.com/aliyun-cli-linux-latest-amd64.tgz | tar xz
sudo mv aliyun /usr/local/bin/

# 配置认证（交互式）
aliyun configure
# 需要 AccessKey ID、AccessKey Secret、Region（如 cn-hangzhou）

# 验证
aliyun ecs DescribeRegions --output cols=RegionId,LocalName
```

> AccessKey 建议使用 RAM 子账号而非主账号，并遵循最小权限原则。

## ECS 实例管理

```bash
# 列出实例
aliyun ecs DescribeInstances --RegionId cn-hangzhou \
  --output cols=InstanceId,InstanceName,Status,PublicIpAddress

# 启动/停止/重启
aliyun ecs StartInstance --InstanceId i-xxx
aliyun ecs StopInstance --InstanceId i-xxx
aliyun ecs RebootInstance --InstanceId i-xxx

# 查看实例详情
aliyun ecs DescribeInstanceAttribute --InstanceId i-xxx

# 查看实例监控
aliyun cms DescribeMetricLast --Namespace acs_ecs_dashboard \
  --MetricName CPUUtilization --Dimensions '[{"instanceId":"i-xxx"}]'
```

## 安全组管理

```bash
# 列出安全组
aliyun ecs DescribeSecurityGroups --RegionId cn-hangzhou \
  --output cols=SecurityGroupId,SecurityGroupName

# 查看规则
aliyun ecs DescribeSecurityGroupAttribute --SecurityGroupId sg-xxx

# 添加入方向规则（开放 8080 端口）
aliyun ecs AuthorizeSecurityGroup \
  --SecurityGroupId sg-xxx \
  --IpProtocol tcp \
  --PortRange 8080/8080 \
  --SourceCidrIp 0.0.0.0/0 \
  --Description "Allow 8080"

# 删除规则
aliyun ecs RevokeSecurityGroup \
  --SecurityGroupId sg-xxx \
  --IpProtocol tcp \
  --PortRange 8080/8080 \
  --SourceCidrIp 0.0.0.0/0
```

## OSS 对象存储

```bash
# 安装 ossutil（独立工具，操作更方便）
curl -fsSL https://gosspublic.alicdn.com/ossutil/install.sh | bash
ossutil config  # 配置 Endpoint、AccessKey

# 列出 Bucket
ossutil ls

# 上传/下载
ossutil cp localfile.tar.gz oss://mybucket/backups/
ossutil cp oss://mybucket/backups/file.tar.gz ./
ossutil cp -r ./dist/ oss://mybucket/static/ --update  # 增量同步目录

# 列出文件
ossutil ls oss://mybucket/backups/ --limited-num 20

# 删除
ossutil rm oss://mybucket/old-backup.tar.gz
```

## DNS 解析管理

```bash
# 列出域名
aliyun alidns DescribeDomains --output cols=DomainName,DomainStatus

# 查看解析记录
aliyun alidns DescribeDomainRecords --DomainName example.com \
  --output cols=RecordId,RR,Type,Value,TTL

# 添加 A 记录
aliyun alidns AddDomainRecord \
  --DomainName example.com \
  --RR www \
  --Type A \
  --Value 1.2.3.4 \
  --TTL 600

# 修改记录
aliyun alidns UpdateDomainRecord \
  --RecordId xxx \
  --RR www \
  --Type A \
  --Value 5.6.7.8

# 删除记录
aliyun alidns DeleteDomainRecord --RecordId xxx
```

## SLB 负载均衡

```bash
# 列出实例
aliyun slb DescribeLoadBalancers --RegionId cn-hangzhou \
  --output cols=LoadBalancerId,LoadBalancerName,Address,LoadBalancerStatus

# 查看后端服务器
aliyun slb DescribeHealthStatus --LoadBalancerId lb-xxx

# 添加后端服务器
aliyun slb AddBackendServers --LoadBalancerId lb-xxx \
  --BackendServers '[{"ServerId":"i-xxx","Weight":"100"}]'
```

## 费用查询

```bash
# 本月账单
aliyun bssopenapi QueryBill --BillingCycle "$(date +%Y-%m)"
```

## 安全建议

- 使用 RAM 子账号 + 精确授权策略
- 定期轮换 AccessKey
- 在 CI/CD 中使用 STS 临时凭证而非长期 AccessKey
- 开启操作审计（ActionTrail）
