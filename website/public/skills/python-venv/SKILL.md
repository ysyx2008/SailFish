---
name: python-venv
description: Python 环境管理。venv 创建、pip freeze/install、pyenv 版本管理、poetry 基础、常见坑。涉及 Python 虚拟环境或依赖管理时使用。
version: 1.0.0
---

# Python 环境管理

## venv

```bash
python3 -m venv .venv
source .venv/bin/activate   # Linux/macOS
# .venv\Scripts\activate    # Windows
deactivate
```

**指定解释器**：`python3.11 -m venv .venv`

## pip 依赖

```bash
pip install -r requirements.txt
pip freeze > requirements.txt
pip list --outdated
```

**推荐**：用 `pip freeze` 前先激活对应 venv，避免混入全局包。

## pyenv（版本管理）

```bash
pyenv install 3.11.6
pyenv local 3.11.6     # 当前目录
pyenv global 3.11.6    # 全局默认
```

**配合 venv**：`pyenv exec python -m venv .venv`

## Poetry

```bash
poetry init
poetry add requests
poetry install
poetry run python main.py
```

**导出 requirements**：`poetry export -f requirements.txt --without-hashes > requirements.txt`

## 常见问题

| 问题 | 处理 |
|------|------|
| `ModuleNotFoundError` | 确认已激活 venv，且包安装在当前环境 |
| 权限错误 | 避免 `sudo pip`，用 venv 或 `--user` |
| 多 Python 冲突 | 用 `python -m venv`、`python -m pip` 明确解释器 |
| lock 文件冲突 | poetry：删 `poetry.lock` 重跑 `poetry install`，谨慎处理 |
