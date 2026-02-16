#!/usr/bin/env bash
# =============================================================================
# SFTerminal CLI 自动化测试脚本
#
# 测试所有 CLI 命令是否能正常执行（不 crash、不抛出未处理异常）。
# 用法:
#   bash electron/cli/test-cli.sh          # 完整测试
#   bash electron/cli/test-cli.sh --quick  # 仅测试无副作用的只读命令
# =============================================================================
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="node ${PROJECT_ROOT}/electron/cli/main.js"

PASS=0
FAIL=0
SKIP=0
FAILED_CMDS=()

QUICK_MODE=false
[[ "${1:-}" == "--quick" ]] && QUICK_MODE=true

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
NC='\033[0m'

run_test() {
  local label="$1"
  shift
  local cmd="$*"

  printf "  %-35s " "${label}"

  local output
  local exit_code=0
  output=$($cmd 2>&1) || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (exit $exit_code)"
    FAILED_CMDS+=("$label: $cmd")
    ((FAIL++))
    if [[ -n "$output" ]]; then
      echo "    └─ ${output:0:200}"
    fi
  fi
}

skip_test() {
  local label="$1"
  printf "  %-35s " "${label}"
  echo -e "${YELLOW}SKIP${NC} (quick mode)"
  ((SKIP++))
}

echo -e "${CYAN}╔══════════════════════════════════════════╗${NC}"
echo -e "${CYAN}║     SFTerminal CLI 自动化测试             ║${NC}"
echo -e "${CYAN}╚══════════════════════════════════════════╝${NC}"
echo ""

# ------------------------------------------------------------------
echo -e "${CYAN}[1/9] 基础${NC}"
run_test "--help"                 $CLI --help
run_test "--version"              $CLI --version

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[2/9] 配置 (config)${NC}"
run_test "config:list"            $CLI config:list
run_test "config:get language"    $CLI config:get language
run_test "config:get theme"       $CLI config:get theme
run_test "config:init"            $CLI config:init

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[3/9] AI${NC}"
run_test "ai:models"              $CLI ai:models

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[4/9] 知识库 (knowledge)${NC}"
run_test "knowledge:list"         $CLI knowledge:list
run_test "knowledge:stats"        $CLI knowledge:stats
run_test "knowledge:search test"  $CLI knowledge:search test

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[5/9] 历史记录 (history)${NC}"
run_test "history:list"           $CLI history:list
run_test "history:list --limit 3" $CLI history:list --limit 3
run_test "history:stats"          $CLI history:stats

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[6/9] 主机/SSH/MCP/定时/技能${NC}"
run_test "host:list"              $CLI host:list
run_test "host:get local"         $CLI host:get local
run_test "ssh:list"               $CLI ssh:list
run_test "mcp:list"               $CLI mcp:list
run_test "scheduler:list"         $CLI scheduler:list
run_test "scheduler:history"      $CLI scheduler:history
run_test "skill:list"             $CLI skill:list

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[7/9] PTY / 终端${NC}"
run_test "pty:shells"             $CLI pty:shells
if $QUICK_MODE; then
  skip_test "pty:exec echo hi"
else
  run_test "pty:exec echo hi"     $CLI pty:exec "echo hi"
fi

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[8/9] 文件系统${NC}"
run_test "fs:info"                $CLI fs:info
run_test "fs:list /tmp"           $CLI fs:list /tmp

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}[9/9] 文档解析${NC}"
run_test "doc:types"              $CLI doc:types
run_test "doc:parse README.md"    $CLI doc:parse "${PROJECT_ROOT}/README.md"

# ------------------------------------------------------------------
echo ""
echo -e "${CYAN}══════════════════════════════════════════${NC}"
TOTAL=$((PASS + FAIL + SKIP))
echo -e "  总计: ${TOTAL}  ${GREEN}通过: ${PASS}${NC}  ${RED}失败: ${FAIL}${NC}  ${YELLOW}跳过: ${SKIP}${NC}"
echo -e "${CYAN}══════════════════════════════════════════${NC}"

if [[ ${#FAILED_CMDS[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}失败的命令:${NC}"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo "  - $cmd"
  done
  exit 1
fi

echo ""
echo -e "${GREEN}全部测试通过！${NC}"
exit 0
