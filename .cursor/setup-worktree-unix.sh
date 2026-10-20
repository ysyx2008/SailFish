#!/bin/bash
# 给新工作树备好不进 Git 的东西。在工作树根目录里跑。
# APFS 上用写时复制克隆：几秒钟、几乎不占空间，且与主目录那份互不影响（不要软链）。
set -e

ROOT="${ROOT_WORKTREE_PATH:-$(dirname "$(git rev-parse --path-format=absolute --git-common-dir)")}"
HERE="$(pwd -P)"
if [ "$HERE" = "$(cd "$ROOT" && pwd -P)" ]; then
  echo "这里就是主目录，不用初始化" >&2
  exit 1
fi

clone() {
  local rel="$1"
  [ -e "$ROOT/$rel" ] || return 0
  if [ -e "$rel" ] || [ -L "$rel" ]; then
    echo "已有 $rel，跳过"
    return 0
  fi
  mkdir -p "$(dirname "$rel")"
  if [ "$(uname)" = "Darwin" ]; then
    cp -c -R "$ROOT/$rel" "$rel" 2>/dev/null || cp -R "$ROOT/$rel" "$rel"
  else
    cp -R --reflink=auto "$ROOT/$rel" "$rel"
  fi
  echo "已备好 $rel"
}

clone node_modules
clone resources/ripgrep
clone resources/bin

if ! cmp -s "$ROOT/package-lock.json" package-lock.json; then
  echo "依赖与主目录不同，重新安装"
  npm install
fi
