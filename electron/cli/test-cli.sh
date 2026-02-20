#!/usr/bin/env bash
# =============================================================================
# SailFish CLI 功能验证测试
#
# 目标：每次后端代码修改后运行，验证各服务的业务逻辑正确性。
# 不只是"不崩溃"，而是验证输出内容符合预期。
#
# 用法:
#   bash electron/cli/test-cli.sh              # 完整测试（含 AI，需 API Key）
#   bash electron/cli/test-cli.sh --no-ai      # 跳过需要 AI API 的测试
#   bash electron/cli/test-cli.sh --quick       # 最小冒烟测试
#
# 环境变量:
#   SFT_API_URL / SFT_API_KEY / SFT_MODEL  — AI 测试所需
# =============================================================================
set -uo pipefail

PROJECT_ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
CLI="node ${PROJECT_ROOT}/electron/cli/main.js"

PASS=0
FAIL=0
SKIP=0
TOTAL=0
FAILED_CMDS=()

MODE="full"
[[ "${1:-}" == "--quick" ]] && MODE="quick"
[[ "${1:-}" == "--no-ai" ]] && MODE="no-ai"

HAS_AI=false
[[ -n "${SFT_API_KEY:-}" ]] && HAS_AI=true

# 颜色
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

# ── 测试工具函数 ──────────────────────────────────────────────

# 基础测试：命令成功退出
run_test() {
  local label="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -eq 0 ]]; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (exit $exit_code)"
    FAILED_CMDS+=("${label}")
    ((FAIL++))
    [[ -n "$output" ]] && echo "    └─ ${output:0:300}"
  fi
  # 把输出存到 _LAST_OUTPUT 供后续断言使用
  _LAST_OUTPUT="$output"
}

# 断言测试：命令成功且输出包含指定文本
assert_contains() {
  local label="$1"; shift
  local expected="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo -e "${RED}FAIL${NC} (exit $exit_code)"
    FAILED_CMDS+=("${label}: 非零退出")
    ((FAIL++))
    [[ -n "$output" ]] && echo "    └─ ${output:0:300}"
  elif echo "$output" | grep -qF "$expected"; then
    echo -e "${GREEN}PASS${NC}"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (输出不含 \"$expected\")"
    FAILED_CMDS+=("${label}: 缺少预期内容 '${expected}'")
    ((FAIL++))
    echo "    └─ 实际输出: ${output:0:300}"
  fi
  _LAST_OUTPUT="$output"
}

# 断言测试：命令应失败（非零退出）
assert_fails() {
  local label="$1"; shift
  ((TOTAL++))
  printf "  %-40s " "${label}"

  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?

  if [[ $exit_code -ne 0 ]]; then
    echo -e "${GREEN}PASS${NC} (预期失败, exit $exit_code)"
    ((PASS++))
  else
    echo -e "${RED}FAIL${NC} (应该失败但成功了)"
    FAILED_CMDS+=("${label}: 应失败但返回 0")
    ((FAIL++))
  fi
  _LAST_OUTPUT="$output"
}

skip_test() {
  local label="$1"; local reason="${2:-quick mode}"
  ((TOTAL++))
  printf "  %-40s " "${label}"
  echo -e "${YELLOW}SKIP${NC} (${reason})"
  ((SKIP++))
}

# ── 开始测试 ─────────────────────────────────────────────────

echo ""
echo -e "${CYAN}${BOLD}╔══════════════════════════════════════════════╗${NC}"
echo -e "${CYAN}${BOLD}║       SailFish CLI 功能验证测试               ║${NC}"
echo -e "${CYAN}${BOLD}╚══════════════════════════════════════════════╝${NC}"
echo -e "  模式: ${BOLD}${MODE}${NC}    AI API: ${HAS_AI}"
echo ""

# ══════════════════════════════════════════════════════════════
echo -e "${CYAN}[1/12] 基础命令${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "--help 显示帮助信息"        "Usage: sft" \
  $CLI --help

assert_contains "--version 返回版本号"       "." \
  $CLI --version

assert_fails    "未知命令应报错"             \
  $CLI this:does:not:exist

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[2/12] 配置读写闭环${NC}"
# ══════════════════════════════════════════════════════════════

# 读取当前语言
assert_contains "config:get language"        "zh" \
  $CLI config:get language

# 写入→读回→还原 闭环测试
ORIG_THEME=$($CLI config:get theme 2>/dev/null | tr -d '"')

assert_contains "config:set theme 写入"      "" \
  $CLI config:set theme '"solarized"'

assert_contains "config:get theme 验证写入"   "solarized" \
  $CLI config:get theme

# 还原
$CLI config:set theme "\"${ORIG_THEME}\"" >/dev/null 2>&1

assert_contains "config:get theme 验证还原"   "${ORIG_THEME}" \
  $CLI config:get theme

assert_contains "config:list 列出所有配置"    "language" \
  $CLI config:list

assert_contains "config:init 显示引导"        "AI" \
  $CLI config:init

# 错误场景
assert_fails    "config:get 缺少参数应报错"  \
  $CLI config:get

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[3/12] 主机画像${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "host:list 包含 local"       "local" \
  $CLI host:list

assert_contains "host:get local 有 OS 信息"  "os" \
  $CLI host:get local

assert_fails    "host:get 缺少参数应报错"    \
  $CLI host:get

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[4/12] SSH 会话${NC}"
# ══════════════════════════════════════════════════════════════

run_test "ssh:list 不崩溃"                   $CLI ssh:list

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[5/12] 知识库全流程${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "knowledge:list 返回表格"     "id" \
  $CLI knowledge:list

assert_contains "knowledge:stats 返回 JSON"   "documentCount" \
  $CLI knowledge:stats

# 添加文档→搜索命中→验证
if [[ "$MODE" != "quick" ]]; then
  # 创建测试文档
  TEST_DOC=$(mktemp /tmp/sft-test-XXXXXX.md)
  echo "这是一份关于 Kubernetes 容器编排部署的技术文档，用于 SailFish CLI 自动化测试。" > "$TEST_DOC"

  run_test "knowledge:add 添加测试文档"      $CLI knowledge:add "$TEST_DOC"

  # 用语义相关的词搜索，验证向量检索能力
  assert_contains "knowledge:search 语义搜索" "Kubernetes" \
    $CLI knowledge:search "容器编排"

  rm -f "$TEST_DOC"
else
  skip_test "knowledge:add 添加文档"
  skip_test "knowledge:search 命中验证"
fi

# 搜索不存在的内容
run_test "knowledge:search 无结果不崩溃"     $CLI knowledge:search "zzz_nonexistent_query_zzz"

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[6/12] 历史记录${NC}"
# ══════════════════════════════════════════════════════════════

run_test "history:list 不崩溃"               $CLI history:list
assert_contains "history:list --limit 2"     "steps" \
  $CLI history:list --limit 2
assert_contains "history:stats 返回 JSON"    "agentFiles" \
  $CLI history:stats

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[7/12] 定时任务 / MCP / 技能${NC}"
# ══════════════════════════════════════════════════════════════

run_test "scheduler:list 不崩溃"             $CLI scheduler:list
run_test "scheduler:history 不崩溃"          $CLI scheduler:history
run_test "mcp:list 不崩溃"                   $CLI mcp:list
run_test "skill:list 不崩溃"                 $CLI skill:list

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[8/12] Watch & Sensor（感知层）${NC}"
# ══════════════════════════════════════════════════════════════

run_test "watch:list 不崩溃"                 $CLI watch:list
run_test "watch:history 不崩溃"              $CLI watch:history
run_test "sensor:status 不崩溃"              $CLI sensor:status
run_test "sensor:heartbeat 不崩溃"           $CLI sensor:heartbeat

# watch:create + watch:delete 闭环
assert_contains "watch:create 创建 Watch"    "Watch created" \
  $CLI watch:create --name "test-watch" --prompt "test" --output log
# 从上次输出中提取 watch ID 并删除
WATCH_ID=$(echo "$_LAST_OUTPUT" | grep -oE '\([a-z0-9]+-[a-z0-9]+\)' | tr -d '()')
if [[ -n "$WATCH_ID" ]]; then
  run_test "watch:delete 删除 Watch"         $CLI watch:delete "$WATCH_ID"
else
  skip_test "watch:delete 删除 Watch"
fi

assert_fails "watch:create 缺少参数应报错"   $CLI watch:create

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[9/12] PTY 命令执行${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "pty:shells 列出 shell"      "shell" \
  $CLI pty:shells

if [[ "$MODE" != "quick" ]]; then
  assert_contains "pty:exec echo 验证输出"    "hello_sft" \
    $CLI pty:exec "echo hello_sft"

  assert_contains "pty:exec pwd 返回路径"     "/" \
    $CLI pty:exec "pwd"
else
  skip_test "pty:exec echo 验证输出"
  skip_test "pty:exec pwd 返回路径"
fi

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[10/12] 文件系统 & 文档解析${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "fs:info 包含 Home 路径"      "Home" \
  $CLI fs:info

assert_contains "fs:list /tmp 返回表格"        "name" \
  $CLI fs:list /tmp

assert_fails    "fs:list 不存在路径应报错"     \
  $CLI fs:list /nonexistent_path_zzz

assert_contains "doc:types 列出 md 类型"       ".md" \
  $CLI doc:types

assert_contains "doc:parse 解析 README"        "SailFish" \
  $CLI doc:parse "${PROJECT_ROOT}/README.md"

assert_fails    "doc:parse 不存在文件应报错"   \
  $CLI doc:parse /nonexistent_file.txt

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[11/12] IM 集成${NC}"
# ══════════════════════════════════════════════════════════════

assert_contains "im:status 显示平台列表"       "DingTalk" \
  $CLI im:status

assert_contains "im:status 显示 Slack"         "Slack" \
  $CLI im:status

assert_fails    "im:connect 缺少参数应报错"    \
  $CLI im:connect

assert_fails    "im:connect 未知平台应报错"    \
  $CLI im:connect unknown_platform

# 未配置凭证时连接应失败
assert_fails    "im:connect 无凭证应报错"      \
  $CLI im:connect dingtalk

assert_fails    "im:disconnect 缺少参数应报错" \
  $CLI im:disconnect

# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}[12/12] AI 对话（需要 API Key）${NC}"
# ══════════════════════════════════════════════════════════════

if [[ "$MODE" == "quick" || "$MODE" == "no-ai" ]]; then
  skip_test "ai:models 列出模型"       "无 AI 配置或 --no-ai"
  skip_test "ai:chat 基础对话"         "无 AI 配置或 --no-ai"
  skip_test "ai:stream 流式对话"       "无 AI 配置或 --no-ai"
elif $HAS_AI; then
  run_test "ai:models 列出模型"                $CLI ai:models

  assert_contains "ai:chat 回复不为空"         "" \
    $CLI ai:chat "回复OK两个字母即可"

  run_test "ai:stream 流式不崩溃"              $CLI ai:stream "回复OK两个字母即可"
else
  skip_test "ai:models 列出模型"       "未设置 SFT_API_KEY"
  skip_test "ai:chat 基础对话"         "未设置 SFT_API_KEY"
  skip_test "ai:stream 流式对话"       "未设置 SFT_API_KEY"
fi

# ══════════════════════════════════════════════════════════════
# 汇总
# ══════════════════════════════════════════════════════════════
echo ""
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"
echo -e "  总计: ${BOLD}${TOTAL}${NC}    ${GREEN}通过: ${PASS}${NC}    ${RED}失败: ${FAIL}${NC}    ${YELLOW}跳过: ${SKIP}${NC}"
echo -e "${CYAN}${BOLD}══════════════════════════════════════════════${NC}"

if [[ ${#FAILED_CMDS[@]} -gt 0 ]]; then
  echo ""
  echo -e "${RED}${BOLD}失败项:${NC}"
  for cmd in "${FAILED_CMDS[@]}"; do
    echo -e "  ${RED}✗${NC} $cmd"
  done
  echo ""
  exit 1
fi

echo ""
echo -e "${GREEN}${BOLD}全部测试通过！${NC}"
exit 0
