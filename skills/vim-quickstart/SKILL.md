---
name: Vim 快速上手
description: Vim 模式切换、移动、编辑、搜索替换、多文件操作、常用配置的速查手册
version: 1.0.0
---

# Vim 快速上手

SSH 到服务器后编辑文件的必备技能。

## 模式切换

| 按键 | 动作 |
|------|------|
| `i` | 在光标前插入 |
| `a` | 在光标后插入 |
| `o` | 在下方新建一行并插入 |
| `O` | 在上方新建一行并插入 |
| `Esc` | 返回普通模式 |
| `:` | 进入命令模式 |
| `v` | 可视模式（字符选择） |
| `V` | 可视行模式（整行选择） |

## 保存与退出

| 命令 | 动作 |
|------|------|
| `:w` | 保存 |
| `:q` | 退出（未修改时） |
| `:wq` 或 `:x` | 保存并退出 |
| `:q!` | 强制退出不保存 |
| `:w !sudo tee %` | 以 sudo 保存（忘记 sudo 打开时） |

## 移动

| 按键 | 动作 |
|------|------|
| `h/j/k/l` | 左/下/上/右 |
| `w` / `b` | 下一个/上一个单词 |
| `0` / `$` | 行首/行尾 |
| `^` | 行首非空字符 |
| `gg` / `G` | 文件首/文件尾 |
| `:<n>` 或 `<n>G` | 跳到第 n 行 |
| `Ctrl+d` / `Ctrl+u` | 向下/向上翻半页 |
| `%` | 跳到匹配的括号 |

## 编辑

| 按键 | 动作 |
|------|------|
| `dd` | 删除（剪切）当前行 |
| `<n>dd` | 删除 n 行 |
| `yy` | 复制当前行 |
| `<n>yy` | 复制 n 行 |
| `p` / `P` | 在光标后/前粘贴 |
| `u` | 撤销 |
| `Ctrl+r` | 重做 |
| `x` | 删除光标处字符 |
| `cw` | 修改单词（删除并进入插入模式） |
| `ciw` | 修改整个单词 |
| `ci"` | 修改引号内内容 |
| `>>` / `<<` | 缩进/取消缩进 |
| `.` | 重复上一次操作 |

## 搜索与替换

```
/pattern          向下搜索
?pattern          向上搜索
n / N             下一个/上一个匹配
*                 搜索光标处单词

:s/old/new/       当前行替换第一个
:s/old/new/g      当前行替换所有
:%s/old/new/g     全文替换
:%s/old/new/gc    全文替换（逐个确认）
```

## 多文件操作

```
:e filename       打开文件
:bn / :bp         下一个/上一个 buffer
:ls               列出所有 buffer
:sp filename      水平分屏
:vsp filename     垂直分屏
Ctrl+w w          在分屏间切换
Ctrl+w q          关闭当前分屏
```

## 实用技巧

```
:set number       显示行号
:set nonumber     隐藏行号
:set paste        粘贴模式（防止缩进错乱）
:set nopaste      退出粘贴模式
:set ignorecase   搜索忽略大小写
:noh              清除搜索高亮

# 快速注释多行
Ctrl+v → 选择行首 → I → # → Esc

# 删除空行
:g/^$/d

# 排序
:sort
:sort u           去重排序
```

## 推荐 .vimrc 最小配置

```vim
set number            " 行号
set relativenumber    " 相对行号
set tabstop=4         " Tab 宽度
set shiftwidth=4      " 缩进宽度
set expandtab         " Tab 转空格
set autoindent        " 自动缩进
set hlsearch          " 搜索高亮
set incsearch         " 增量搜索
set ignorecase        " 搜索忽略大小写
set smartcase         " 有大写时区分大小写
set encoding=utf-8    " UTF-8 编码
syntax on             " 语法高亮
```
