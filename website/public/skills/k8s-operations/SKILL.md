---
name: Kubernetes 运维指南
description: Kubernetes 常用操作、Pod 调试、资源排查、HPA 自动扩缩容、ConfigMap/Secret 管理
version: 1.0.0
---

# Kubernetes 运维指南

## 集群信息

```bash
kubectl cluster-info
kubectl get nodes -o wide
kubectl top nodes                    # 需要 metrics-server
kubectl api-resources               # 所有资源类型
```

## 工作负载管理

```bash
# 查看
kubectl get pods -n <ns> -o wide
kubectl get deploy,sts,ds -n <ns>
kubectl describe pod <pod> -n <ns>

# 扩缩容
kubectl scale deploy <name> --replicas=3 -n <ns>

# 滚动更新
kubectl set image deploy/<name> <container>=<image>:<tag> -n <ns>
kubectl rollout status deploy/<name> -n <ns>
kubectl rollout history deploy/<name> -n <ns>

# 回滚
kubectl rollout undo deploy/<name> -n <ns>
kubectl rollout undo deploy/<name> --to-revision=2 -n <ns>
```

## 日志与调试

```bash
# 查看日志
kubectl logs <pod> -n <ns> --tail=100 -f
kubectl logs <pod> -c <container> -n <ns>       # 多容器 Pod
kubectl logs <pod> -n <ns> --previous            # 上一个崩溃的容器

# 进入容器
kubectl exec -it <pod> -n <ns> -- /bin/bash
kubectl exec -it <pod> -c <container> -n <ns> -- /bin/sh

# 临时调试容器（K8s 1.23+）
kubectl debug -it <pod> -n <ns> --image=busybox --target=<container>

# 端口转发
kubectl port-forward svc/<service> 8080:80 -n <ns>
```

## 常见 Pod 状态排查

| 状态 | 排查思路 |
|------|----------|
| Pending | `describe pod` → 检查资源不足、节点亲和性、PVC 未绑定 |
| CrashLoopBackOff | `logs --previous` → 检查启动命令、配置、依赖服务 |
| ImagePullBackOff | 检查镜像名/tag、镜像仓库认证 (imagePullSecrets)、网络 |
| OOMKilled | `describe pod` → 增大 `resources.limits.memory` |
| Evicted | 节点磁盘/内存压力 → `kubectl describe node` 检查 Conditions |
| Terminating 卡住 | `kubectl delete pod <pod> --grace-period=0 --force` |

## ConfigMap 与 Secret

```bash
# 从文件创建
kubectl create configmap app-config --from-file=config.yaml -n <ns>
kubectl create secret generic db-creds --from-literal=password=xxx -n <ns>

# 查看
kubectl get configmap app-config -n <ns> -o yaml
kubectl get secret db-creds -n <ns> -o jsonpath='{.data.password}' | base64 -d

# 热更新（挂载为文件的 ConfigMap 会自动更新，环境变量不会）
kubectl edit configmap app-config -n <ns>
```

## HPA 自动扩缩容

```bash
# 创建 HPA（需要 metrics-server）
kubectl autoscale deploy <name> --min=2 --max=10 --cpu-percent=70 -n <ns>

# 查看
kubectl get hpa -n <ns>
kubectl describe hpa <name> -n <ns>
```

## 常用排障流程

```bash
# 1. 事件排查
kubectl get events -n <ns> --sort-by='.lastTimestamp' | tail -20

# 2. 资源使用
kubectl top pods -n <ns> --sort-by=memory
kubectl top nodes

# 3. 网络连通性
kubectl run tmp-debug --rm -it --image=busybox -- /bin/sh
# 在 Pod 内: nslookup <service>.<ns>.svc.cluster.local

# 4. 查看 Service 端点
kubectl get endpoints <service> -n <ns>

# 5. DNS 排查
kubectl run dns-test --rm -it --image=busybox -- nslookup kubernetes.default
```

## 安全建议

- 使用 RBAC 限制权限，避免使用 cluster-admin
- Secret 不要存入代码仓库，使用 sealed-secrets 或外部密钥管理
- 设置 `resources.requests` 和 `resources.limits`
- 启用 NetworkPolicy 限制 Pod 间通信
- 定期升级集群版本
