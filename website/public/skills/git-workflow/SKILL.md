---
name: Git 工作流
description: 分支命名、merge 与 rebase、冲突解决、stash 用法、仓库清理（gc、prune）
version: "1.0"
---

# Git 工作流

日常 Git 操作的最佳实践和常见命令。

## 分支命名约定

| 类型 | 示例 |
|------|------|
| 功能 | `feature/user-login`、`feat/api-v2` |
| 修复 | `fix/payment-bug`、`hotfix/security-patch` |
| 发布 | `release/1.2.0` |
| 个人开发 | `dev/username`、`yushen/xxx` |

## Merge 与 Rebase

```bash
# Merge：保留完整历史，产生合并提交
git checkout main
git merge feature-branch

# Rebase：线性历史，适合个人分支整理
git checkout feature-branch
git rebase main
```

**原则**：已推送的公共分支用 merge；个人分支可 rebase 后 force push。

## 冲突解决步骤

```bash
# 1. 拉取/合并触发冲突
git pull origin main
# 或 git merge main

# 2. 查看冲突文件
git status

# 3. 编辑文件，删除 <<<<<<<、=======、>>>>>>> 标记，保留正确内容

# 4. 标记已解决并完成
git add <resolved-files>
git commit   # merge 时
# 或 git rebase --continue   # rebase 时
```

## Stash 用法

```bash
# 暂存工作区（含未跟踪文件用 -u）
git stash push -m "WIP: 描述"
git stash push -u -m "含未跟踪"

# 恢复
git stash pop      # 应用并移除
git stash apply    # 应用但保留

# 列表与操作
git stash list
git stash drop stash@{0}
```

## 仓库清理

```bash
# 垃圾回收与压缩
git gc --aggressive

# 修剪已删除的远程分支引用
git fetch --prune
git remote prune origin

# 清理悬空对象、过期 reflog
git reflog expire --expire=now --all
git gc --prune=now
```
