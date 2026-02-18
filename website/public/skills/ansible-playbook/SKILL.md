---
name: Ansible 批量运维
description: Ansible 安装配置、Inventory 管理、常用模块、Playbook 编写、批量操作最佳实践
version: 1.0.0
---

# Ansible 批量运维

## 安装与配置

```bash
# pip 安装（推荐）
pip install ansible

# Ubuntu
sudo apt install -y ansible

# 验证
ansible --version
```

## Inventory 主机清单

**INI 格式**（`/etc/ansible/hosts` 或项目内 `inventory.ini`）：
```ini
[webservers]
web1 ansible_host=192.168.1.10
web2 ansible_host=192.168.1.11

[dbservers]
db1 ansible_host=192.168.1.20

[all:vars]
ansible_user=admin
ansible_ssh_private_key_file=~/.ssh/id_ed25519
ansible_python_interpreter=/usr/bin/python3
```

**连通性测试**：
```bash
ansible all -i inventory.ini -m ping
ansible webservers -i inventory.ini -m ping
```

## Ad-Hoc 命令（快速批量操作）

```bash
# 执行命令
ansible webservers -i inventory.ini -m shell -a "uptime"
ansible all -i inventory.ini -m shell -a "df -h"

# 复制文件
ansible webservers -i inventory.ini -m copy -a "src=./app.conf dest=/etc/app/app.conf"

# 安装软件
ansible webservers -i inventory.ini -m apt -a "name=nginx state=present" -b

# 管理服务
ansible webservers -i inventory.ini -m service -a "name=nginx state=restarted" -b

# 收集系统信息
ansible all -i inventory.ini -m setup -a "filter=ansible_distribution*"
```

## Playbook 基础

```yaml
# deploy.yml
---
- name: 部署 Web 应用
  hosts: webservers
  become: yes
  vars:
    app_version: "1.2.0"

  tasks:
    - name: 安装依赖
      apt:
        name: [nginx, python3-pip]
        state: present
        update_cache: yes

    - name: 拷贝配置文件
      template:
        src: templates/nginx.conf.j2
        dest: /etc/nginx/sites-available/app.conf
      notify: reload nginx

    - name: 确保服务启动
      service:
        name: nginx
        state: started
        enabled: yes

  handlers:
    - name: reload nginx
      service:
        name: nginx
        state: reloaded
```

```bash
# 执行 playbook
ansible-playbook -i inventory.ini deploy.yml

# 预检（不执行）
ansible-playbook -i inventory.ini deploy.yml --check --diff

# 指定标签
ansible-playbook -i inventory.ini deploy.yml --tags "config"

# 限制目标主机
ansible-playbook -i inventory.ini deploy.yml --limit web1
```

## 常用模块

| 模块 | 用途 | 示例 |
|------|------|------|
| `shell` / `command` | 执行命令 | `-m shell -a "ls -la"` |
| `copy` | 复制文件 | `-m copy -a "src=x dest=y"` |
| `template` | 渲染 Jinja2 模板 | `template: src=x.j2 dest=y` |
| `apt` / `yum` | 包管理 | `-m apt -a "name=x state=present"` |
| `service` | 服务管理 | `-m service -a "name=x state=started"` |
| `user` | 用户管理 | `-m user -a "name=x state=present"` |
| `file` | 文件/目录属性 | `-m file -a "path=x state=directory"` |
| `cron` | 定时任务 | `-m cron -a "name=x job=y minute=0"` |
| `lineinfile` | 修改文件内容 | 确保某行存在或替换 |

## 最佳实践

- 使用 `--check --diff` 预检，确认改动范围后再执行
- 幂等性：任务重复执行不应产生副作用
- 敏感数据使用 `ansible-vault` 加密
- 大规模执行时通过 `--forks` 控制并发数（默认 5）
- 复杂项目使用 Role 组织代码结构
